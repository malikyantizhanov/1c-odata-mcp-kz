import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { REGISTERS } from "../config/mapping.js";
import { resolveNames } from "../odata/accounting.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { buildQuery, cmp, odataGuid, odataString } from "../odata/query.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, fail, guard, ok } from "./_shared.js";
import { getAccount, loadChart, refExists, type AccountInfo } from "./chart.js";
import { rateOn } from "./registers-info.js";
import { confirmField } from "./write.js";

/**
 * Проводки ручной операции (Document_ОперацияБух) — набор записей регистра бухгалтерии
 * (AccountingRegister_Типовой / _Хозрасчетный) с регистратором = документ. Стандартный OData 1С отдаёт набор
 * записей подчинённого регистра по ключу Recorder + Recorder_Type (свойство RecordSet) и позволяет записать
 * его целиком (PUT по тому же ключу) — так же, как это делает форма ручной операции. Строка набора
 * (_RecordType) сама по себе только для чтения.
 *
 * Субконто в строке набора — динамические поля ExtDimensionDr1..3 / ExtDimensionCr1..3 (+ _Type) и
 * ExtDimensionTypeDr1..3_Key / ExtDimensionTypeCr1..3_Key (как их отдаёт RecordsWithExtDimensions). В $metadata
 * строки набора их нет, а неизвестные свойства 1С может молча проигнорировать, поэтому после записи набор
 * перечитывается с субконто; если субконто не сохранились, а набор до записи был пуст — запись откатывается
 * (пустой набор), инструмент сообщает об ошибке.
 */

const DOC = "Document_ОперацияБух";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const guidOf = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const typeOf = (t: unknown) => String(t ?? "").replace(/^StandardODATA\./, "");
const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const fmt = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2 }).replace(/\u00a0/g, " ");

const subValue = z.union([
  z.string().trim().max(150),
  z.object({
    value: z.string().trim().min(1).max(150).describe("Ref_Key элемента или значение перечисления"),
    type: z
      .string()
      .trim()
      .max(150)
      .optional()
      .describe(
        "Тип значения: Catalog_Контрагенты, Document_…, имя перечисления; нужен, если у вида субконто несколько типов",
      ),
  }),
  z.null(),
]);
const sideSub = z
  .array(subValue)
  .max(3)
  .optional()
  .describe(
    "Субконто 1–3 по порядку видов субконто счёта (read.accounting.get_account); null — пропустить слот",
  );

const entrySchema = z.object({
  debit: z
    .string()
    .trim()
    .max(20)
    .optional()
    .describe("Код счёта Дт (напр. 1030). Пусто — только для забалансового Кт"),
  credit: z.string().trim().max(20).optional().describe("Код счёта Кт. Пусто — только для забалансового Дт"),
  amount: z.number().describe("Сумма проводки в тенге (валюта регламентированного учёта)"),
  debitSubconto: sideSub,
  creditSubconto: sideSub,
  debitCurrency: z
    .string()
    .trim()
    .max(60)
    .optional()
    .describe("Валюта Дт (840 / USD) — только для валютного счёта"),
  creditCurrency: z.string().trim().max(60).optional().describe("Валюта Кт — только для валютного счёта"),
  debitCurrencyAmount: z.number().optional().describe("Валютная сумма Дт"),
  creditCurrencyAmount: z.number().optional().describe("Валютная сумма Кт"),
  debitQuantity: z.number().optional().describe("Количество Дт — только для количественного счёта"),
  creditQuantity: z.number().optional().describe("Количество Кт — только для количественного счёта"),
  content: z.string().trim().max(150).optional().describe("Содержание проводки"),
});
type Entry = z.infer<typeof entrySchema>;
type Side = "Dr" | "Cr";

interface Currency {
  ref: string;
  code: string;
  name: string;
}

async function currencies(conn: Connection): Promise<Currency[]> {
  const set = await requireEntity(conn, ["Catalog_Валюты"], "Справочник «Валюты»");
  const { rows } = await fetchAll(
    conn.client,
    set,
    { select: ["Ref_Key", "Code", "Description"] },
    200,
    1000,
  );
  return rows.map((r) => ({
    ref: String(r["Ref_Key"]),
    code: String(r["Code"] ?? "").trim(),
    name: String(r["Description"] ?? "").trim(),
  }));
}

const findCurrency = (list: Currency[], q: string) => {
  const s = q.trim().replace(/[{}']/g, "").toLowerCase();
  return list.find((c) => c.ref.toLowerCase() === s || c.code === s || c.name.toLowerCase() === s);
};

/** Ключ набора записей регистра бухгалтерии по регистратору. */
export const recordSetPath = (reg: string, ref: string) =>
  `${reg}(Recorder=${odataGuid(ref)},Recorder_Type=${odataString(`StandardODATA.${DOC}`)})`;

async function readRecordSet(conn: Connection, reg: string, ref: string): Promise<ODataEntity[]> {
  try {
    const e = await conn.client.getEntity(`${recordSetPath(reg, ref)}${buildQuery({})}`);
    return (e["RecordSet"] as ODataEntity[] | undefined) ?? [];
  } catch (e) {
    if (e instanceof ODataError && e.kind === "not_found") return [];
    throw e;
  }
}

/** Поля строки набора, которые пишутся при восстановлении прежних проводок. */
const RESTORE_FIELD_RE =
  /^(Recorder|Recorder_Type|Period|LineNumber|Active|Сумма|Организация_Key|Содержание|НомерЖурнала|Account(Dr|Cr)_Key|ExtDimension(Dr|Cr)\d(_Type)?|ExtDimensionType(Dr|Cr)\d_Key|Валюта(Dr|Cr)_Key|ВалютнаяСумма(Dr|Cr)|Количество(Dr|Cr))$/;

/** Проводки документа с субконто (RecordsWithExtDimensions за день документа, отбор по регистратору). */
async function recordsWithSubconto(
  conn: Connection,
  reg: string,
  ref: string,
  day: string,
  toDay: string = day,
): Promise<ODataEntity[]> {
  const cond = cmp("Recorder", "eq", `cast(${odataGuid(ref)}, ${odataString(DOC)})`);
  const path =
    `${reg}/RecordsWithExtDimensions(StartPeriod=datetime'${day}T00:00:00',EndPeriod=datetime'${toDay}T23:59:59',` +
    `Condition=${odataString(cond)})`;
  const { rows } = await fetchAll(conn.client, path, {}, 500, 5000);
  return rows.filter((r) => same(r["Recorder"], ref));
}

interface PlannedSide {
  account?: AccountInfo | undefined;
  subconto: Array<{
    index: number;
    kind: string;
    kindRef: string;
    value: string;
    type: string;
    text?: string;
  }>;
  currency?: Currency | undefined;
  currencyAmount?: number | undefined;
  quantity?: number | undefined;
}

export function registerOperationEntriesTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.accounting.set_operation_entries",
    {
      title: "Записать проводки ручной операции",
      description:
        "Записывает проводки (Дт/Кт, субконто 1–3, сумма в тенге, валюта и валютная сумма, количество, содержание) " +
        "в ручную операцию «Операция (бухгалтерский учёт)» (Document_ОперацияБух) — набор записей регистра " +
        "бухгалтерии с регистратором = документ (PUT набора целиком; шапку создаёт write.document.create_document). " +
        "Проверки по плану счетов: счёт существует и не группа (запрет проводок), субконто по видам счёта и их типам, " +
        "значения существуют, валюта/валютная сумма — только для валютного счёта (для тенге на валютном счёте " +
        "подставляются KZT и сумма), количество — только для количественного, одна сторона — только для забалансового; " +
        "валютная сумма сверяется с курсом на дату. Набор уже есть — отказ без replaceExisting. Предпросмотр (таблица " +
        "проводок) по умолчанию; запись — confirm=true после согласия бухгалтера. После записи набор перечитывается с " +
        "субконто; не сохранились — откат (если набор был пуст). СуммаОперации шапки приводится к сумме проводок.",
      inputSchema: {
        database: databaseField,
        documentRef: z
          .string()
          .regex(GUID_RE, "Ref_Key — GUID")
          .describe("Ref_Key ручной операции (Document_ОперацияБух)"),
        entries: z.array(entrySchema).min(1).max(200).describe("Проводки"),
        period: dateField("Дата проводок (по умолчанию — дата документа)").optional(),
        replaceExisting: z.boolean().default(false).describe("Заменить уже записанные проводки документа"),
        updateOperationAmount: z
          .boolean()
          .default(true)
          .describe("Привести СуммаОперации шапки к сумме проводок"),
        confirm: confirmField,
      },
      outputSchema: z
        .object({
          database: z.string(),
          documentRef: z.string(),
          entries: z.array(z.object({}).passthrough()),
          checks: z.array(z.string()),
          warnings: z.array(z.string()),
        })
        .passthrough(),
    },
    ({
      database,
      documentRef,
      entries,
      period,
      replaceExisting = false,
      updateOperationAmount = true,
      confirm,
    }) =>
      guard("write.accounting.set_operation_entries", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [DOC], "Документ «Операция (бухгалтерский учёт)»");
        const reg = await requireEntity(conn, REGISTERS.accounting, "Регистр бухгалтерии");
        const ref = guidOf(documentRef);
        let doc: ODataEntity;
        try {
          doc = await conn.client.getEntity(
            `${set}(${odataGuid(ref)})${buildQuery({
              select: [
                "Ref_Key",
                "Number",
                "Date",
                "Posted",
                "DeletionMark",
                "Организация_Key",
                "СпособЗаполнения",
                "СуммаОперации",
                "Содержание",
              ],
            })}`,
          );
        } catch (e) {
          if (e instanceof ODataError && e.kind === "not_found")
            throw new InputError(`Ручная операция ${documentRef} не найдена в базе.`);
          throw e;
        }
        const refuse: string[] = [];
        const warnings: string[] = [];
        const checks: string[] = [];
        const docLabel = `№ ${String(doc["Number"] ?? "").replace(/^0+(?=\d)/, "")} от ${String(doc["Date"] ?? "").slice(0, 10)}`;
        if (doc["DeletionMark"] === true) refuse.push("Ручная операция помечена на удаление.");
        const fill = String(doc["СпособЗаполнения"] ?? "");
        if (fill && fill !== "Вручную")
          refuse.push(
            `Способ заполнения документа — «${fill}»: проводки формирует типовая операция, вручную их не пишем.`,
          );
        const org = isRef(doc["Организация_Key"]) ? String(doc["Организация_Key"]) : undefined;
        if (!org) refuse.push("В ручной операции не указана организация.");
        const day = period ?? String(doc["Date"] ?? "").slice(0, 10);
        const periodValue = period ? `${period}T12:00:00` : String(doc["Date"] ?? "");
        if (!/^\d{4}-\d{2}-\d{2}/.test(day)) refuse.push("У документа нет даты — задайте period.");

        const existing = await readRecordSet(conn, reg, ref);
        if (existing.length && !replaceExisting)
          refuse.push(
            `У документа уже ${existing.length} проводок — для замены передайте replaceExisting=true (набор пишется целиком).`,
          );
        if (existing.length && replaceExisting)
          warnings.push(
            `Будут заменены ${existing.length} существующих проводок документа. Если 1С не сохранит новый набор как задано, прежние проводки будут записаны обратно.`,
          );
        if (doc["Posted"] !== true)
          warnings.push(
            "Документ не проведён: проводки ручной операции хранятся и в непроведённом документе и сразу активны (Active=true) — попадут в отчёты. " +
              "Если затем проводить документ в 1С, сверьте проводки после проведения (read.accounting.get_document_postings).",
          );

        const { chart } = await loadChart(conn);
        const national = chart === "ChartOfAccounts_Типовой" ? "398" : "643";
        const curList = await currencies(conn);
        const nationalCur = curList.find((c) => c.code === national);
        const accountCache = new Map<string, Promise<AccountInfo>>();
        const accountOf = (code: string) => {
          if (!accountCache.has(code)) accountCache.set(code, getAccount(conn, code));
          return accountCache.get(code)!;
        };

        const planned: Array<{ entry: Entry; dr: PlannedSide; cr: PlannedSide; amount: number }> = [];
        for (const [i, e] of entries.entries()) {
          const n = i + 1;
          const where = (side: Side) => `Проводка ${n}, ${side === "Dr" ? "Дт" : "Кт"}`;
          if (!e.debit && !e.credit) {
            refuse.push(`Проводка ${n}: не указан ни счёт Дт, ни счёт Кт.`);
            continue;
          }
          if (!Number.isFinite(e.amount) || e.amount === 0)
            refuse.push(`Проводка ${n}: сумма должна быть ненулевой.`);
          if (e.amount < 0) warnings.push(`Проводка ${n}: отрицательная сумма (сторно) ${fmt(e.amount)}.`);
          const sides: Record<Side, PlannedSide> = { Dr: { subconto: [] }, Cr: { subconto: [] } };
          for (const side of ["Dr", "Cr"] as const) {
            const code = side === "Dr" ? e.debit : e.credit;
            const subs = (side === "Dr" ? e.debitSubconto : e.creditSubconto) ?? [];
            const curQ = side === "Dr" ? e.debitCurrency : e.creditCurrency;
            const curAmount = side === "Dr" ? e.debitCurrencyAmount : e.creditCurrencyAmount;
            const qty = side === "Dr" ? e.debitQuantity : e.creditQuantity;
            if (!code) {
              if (subs.length || curQ || curAmount !== undefined || qty !== undefined)
                refuse.push(`${where(side)}: счёт не указан, а субконто/валюта/количество заданы.`);
              continue;
            }
            let acc: AccountInfo;
            try {
              acc = await accountOf(code);
            } catch (err) {
              refuse.push(`${where(side)}: ${(err as Error).message}`);
              continue;
            }
            sides[side].account = acc;
            if (acc.deleted) refuse.push(`${where(side)}: счёт ${acc.code} помечен на удаление.`);
            if (acc.forbiddenInEntries)
              refuse.push(
                `${where(side)}: на счёт ${acc.code} проводки запрещены (группа) — укажите субсчёт${acc.subaccounts?.length ? `: ${acc.subaccounts.join(", ")}` : ""}.`,
              );
            // Субконто.
            if (
              subs.length > acc.subconto.length &&
              subs.slice(acc.subconto.length).some((s) => s !== null && s !== "")
            )
              refuse.push(
                `${where(side)}: у счёта ${acc.code} ${acc.subconto.length} вид(а) субконто (${acc.subconto.map((s) => s.kind || "?").join(", ") || "нет"}), а задано ${subs.length}.`,
              );
            for (const slot of acc.subconto) {
              const raw = subs[slot.index - 1];
              if (raw === undefined || raw === null || raw === "") {
                if (slot.index === 1)
                  warnings.push(
                    `${where(side)}: субконто 1 «${slot.kind || "?"}» счёта ${acc.code} не заполнено — аналитика будет пустой.`,
                  );
                continue;
              }
              const value = typeof raw === "string" ? raw : raw.value;
              const given = typeof raw === "string" ? undefined : raw.type?.replace(/^StandardODATA\./, "");
              const isGuid = GUID_RE.test(value);
              let type = given;
              if (!type) {
                const candidates = slot.types.filter((t) =>
                  isGuid
                    ? t.startsWith("Catalog_") || t.startsWith("Document_") || t.includes("_")
                    : !t.includes("_"),
                );
                if (candidates.length === 1) type = candidates[0];
                else {
                  refuse.push(
                    `${where(side)}: для субконто ${slot.index} «${slot.kind}» укажите type — допустимы: ${slot.types.join(", ") || "неизвестно (вид субконто не прочитан)"}.`,
                  );
                  continue;
                }
              }
              if (slot.types.length && !slot.types.includes(type!)) {
                refuse.push(
                  `${where(side)}: субконто ${slot.index} «${slot.kind}» счёта ${acc.code} не принимает тип ${type}; допустимы: ${slot.types.join(", ")}.`,
                );
                continue;
              }
              if (isGuid && (type!.startsWith("Catalog_") || type!.startsWith("Document_"))) {
                const exists = await refExists(conn, type!, value);
                if (exists === false) {
                  refuse.push(`${where(side)}: субконто ${slot.index} — ${type} ${value} не найден в базе.`);
                  continue;
                }
                if (exists === undefined)
                  warnings.push(
                    `${where(side)}: ${type} не опубликован — существование значения не проверено.`,
                  );
              } else if (!isGuid && (type!.startsWith("Catalog_") || type!.startsWith("Document_")))
                refuse.push(
                  `${where(side)}: субконто ${slot.index} «${slot.kind}» — нужен Ref_Key (GUID) элемента ${type}.`,
                );
              sides[side].subconto.push({
                index: slot.index,
                kind: slot.kind,
                kindRef: slot.kindRef,
                value: isGuid ? guidOf(value) : value,
                type: type!,
              });
            }
            // Валюта.
            if (acc.currency) {
              let cur = curQ ? findCurrency(curList, curQ) : nationalCur;
              if (curQ && !cur)
                refuse.push(`${where(side)}: валюта «${curQ}» не найдена в справочнике «Валюты».`);
              if (!cur && !curQ)
                refuse.push(
                  `${where(side)}: валюта регламентированного учёта (${national}) не найдена в справочнике.`,
                );
              cur = cur ?? undefined;
              sides[side].currency = cur;
              if (cur && cur.code === national) {
                if (curAmount !== undefined && Math.abs(curAmount - e.amount) > 0.005)
                  warnings.push(
                    `${where(side)}: валюта ${cur.name}, но валютная сумма ${fmt(curAmount)} ≠ сумме ${fmt(e.amount)}.`,
                  );
                sides[side].currencyAmount = curAmount ?? e.amount;
                if (!curQ)
                  checks.push(
                    `${where(side)}: валютный счёт ${acc.code} — валюта ${cur.name}, валютная сумма = сумме`,
                  );
              } else if (cur) {
                if (curAmount === undefined)
                  refuse.push(`${where(side)}: для валюты ${cur.name} укажите валютную сумму.`);
                else {
                  sides[side].currencyAmount = curAmount;
                  const rate = await rateOn(conn, cur.ref, day).catch(() => undefined);
                  if (!rate)
                    warnings.push(
                      `${where(side)}: курса ${cur.name} на ${day} в регистре нет — пересчёт не проверен.`,
                    );
                  else {
                    const expected = Math.round(curAmount * rate.perUnit * 100) / 100;
                    const diff = Math.abs(expected - e.amount);
                    if (diff > Math.max(1, Math.abs(expected) * 0.01))
                      warnings.push(
                        `${where(side)}: ${fmt(curAmount)} ${cur.name} × ${rate.perUnit} (курс на ${rate.period}) = ${fmt(expected)} ₸, а сумма проводки ${fmt(e.amount)} ₸.`,
                      );
                    else
                      checks.push(
                        `${where(side)}: сумма согласуется с курсом ${cur.name} ${rate.perUnit} на ${rate.period}`,
                      );
                  }
                }
              }
            } else if (curQ || curAmount !== undefined)
              refuse.push(
                `${where(side)}: счёт ${acc.code} не ведёт валютный учёт — валюта и валютная сумма не задаются.`,
              );
            // Количество.
            if (acc.quantity) {
              if (qty === undefined)
                warnings.push(`${where(side)}: счёт ${acc.code} количественный — количество не указано.`);
              else sides[side].quantity = qty;
            } else if (qty !== undefined)
              refuse.push(
                `${where(side)}: счёт ${acc.code} не ведёт количественный учёт — количество не задаётся.`,
              );
          }
          // Одна сторона — только забалансовый счёт.
          const one =
            sides.Dr.account && !sides.Cr.account
              ? sides.Dr.account
              : !sides.Dr.account
                ? sides.Cr.account
                : undefined;
          if (one && !one.offBalance && (!e.debit || !e.credit))
            refuse.push(
              `Проводка ${n}: без корреспондирующего счёта можно только по забалансовому счёту, а ${one.code} балансовый.`,
            );
          if (
            sides.Dr.account &&
            sides.Cr.account &&
            sides.Dr.account.offBalance !== sides.Cr.account.offBalance
          )
            refuse.push(
              `Проводка ${n}: забалансовый счёт не корреспондирует с балансовым (${sides.Dr.account.code} / ${sides.Cr.account.code}).`,
            );
          planned.push({ entry: e, dr: sides.Dr, cr: sides.Cr, amount: money(e.amount) });
        }

        const total = Math.round(planned.reduce((s, p) => s + p.amount * 100, 0)) / 100;
        const docTotal = money(doc["СуммаОперации"]);
        if (Math.abs(docTotal - total) > 0.005)
          (updateOperationAmount ? checks : warnings).push(
            `СуммаОперации документа ${fmt(docTotal)} ≠ сумме проводок ${fmt(total)}${updateOperationAmount ? " — будет исправлена" : ""}`,
          );
        if (refuse.length)
          return fail(
            `Проводки не записаны — проверки не пройдены:\n- ${refuse.join("\n- ")}` +
              (warnings.length ? `\nПредупреждения:\n- ${warnings.join("\n- ")}` : ""),
          );
        checks.push("счета, субконто, валюта и количество проверены по плану счетов");

        // Названия значений субконто — для таблицы предпросмотра.
        const bySet = new Map<string, Set<string>>();
        for (const p of planned)
          for (const s of [...p.dr.subconto, ...p.cr.subconto])
            if (s.type.startsWith("Catalog_") && GUID_RE.test(s.value))
              bySet.set(s.type, (bySet.get(s.type) ?? new Set()).add(s.value));
        const names = new Map<string, string>();
        for (const [es, refs] of bySet)
          for (const [k, v] of await resolveNames(conn, es, refs).catch(() => new Map<string, string>()))
            names.set(k.toLowerCase(), v);

        const meta = await conn.getMetadata();
        const rowProps = new Set(
          (meta.entities.get(`${reg}_RecordType`)?.properties ?? []).map((p) => p.name),
        );
        const has = (f: string) => rowProps.size === 0 || rowProps.has(f);
        const recorderType = `StandardODATA.${DOC}`;
        const rows: Array<Record<string, unknown>> = planned.map((p, i) => {
          const row: Record<string, unknown> = {
            Recorder: ref,
            Recorder_Type: recorderType,
            Period: periodValue,
            LineNumber: String(i + 1),
            Active: true,
            Сумма: p.amount,
          };
          if (org && has("Организация_Key")) row["Организация_Key"] = org;
          if (p.entry.content && has("Содержание")) row["Содержание"] = p.entry.content;
          for (const side of ["Dr", "Cr"] as const) {
            const s = side === "Dr" ? p.dr : p.cr;
            row[`Account${side}_Key`] = s.account?.ref ?? EMPTY_GUID;
            if (s.currency && has(`Валюта${side}_Key`)) row[`Валюта${side}_Key`] = s.currency.ref;
            if (s.currencyAmount !== undefined && has(`ВалютнаяСумма${side}`))
              row[`ВалютнаяСумма${side}`] = s.currencyAmount;
            if (s.quantity !== undefined && has(`Количество${side}`)) row[`Количество${side}`] = s.quantity;
            for (const sc of s.subconto) {
              row[`ExtDimension${side}${sc.index}`] = sc.value;
              row[`ExtDimension${side}${sc.index}_Type`] = `StandardODATA.${sc.type}`;
              row[`ExtDimensionType${side}${sc.index}_Key`] = sc.kindRef;
            }
          }
          return row;
        });
        const table = planned.map((p, i) => {
          const sideView = (s: PlannedSide) =>
            s.account
              ? {
                  account: s.account.code,
                  accountName: s.account.description,
                  subconto: s.subconto.map((sc) => ({
                    index: sc.index,
                    kind: sc.kind,
                    type: sc.type,
                    value: sc.value,
                    ...(names.get(sc.value.toLowerCase()) ? { name: names.get(sc.value.toLowerCase()) } : {}),
                  })),
                  ...(s.currency ? { currency: s.currency.name, currencyAmount: s.currencyAmount } : {}),
                  ...(s.quantity !== undefined ? { quantity: s.quantity } : {}),
                }
              : null;
          return {
            line: i + 1,
            debit: sideView(p.dr),
            credit: sideView(p.cr),
            amount: p.amount,
            ...(p.entry.content ? { content: p.entry.content } : {}),
          };
        });
        const info = {
          database: conn.cfg.name,
          document: `Операция (БУ) ${docLabel}`,
          documentRef: ref,
          register: reg,
          period: day,
          total,
          entries: table,
          existingEntries: existing.length,
          checks,
          warnings,
        };
        const willPut = recordSetPath(reg, ref);
        if (!confirm)
          return ok({
            dryRun: true,
            ...info,
            willPut,
            ...(updateOperationAmount && Math.abs(docTotal - total) > 0.005
              ? { willPatch: { [`${set}(${ref})`]: { СуммаОперации: total } } }
              : {}),
            note: conn.cfg.writable
              ? "Предпросмотр. Будет записан весь набор проводок документа; для записи повторите вызов с confirm=true после согласия бухгалтера."
              : `Предпросмотр. ВНИМАНИЕ: запись в базу "${conn.cfg.name}" запрещена — задайте writable: true для этой базы.`,
          });
        if (conn.behavior.readOnly)
          return fail(
            "Запись запрещена: включён режим READ_ONLY=true. Уберите его (или задайте READ_ONLY=false).",
          );
        if (!conn.cfg.writable)
          return fail(`Запись в базу "${conn.cfg.name}" запрещена: у базы нет writable: true.`);

        // Прежние проводки с субконто — чтобы вернуть их, если 1С не сохранит новый набор как задано.
        let previous: ODataEntity[] = [];
        if (existing.length) {
          const days = existing
            .map((r) => String(r["Period"] ?? "").slice(0, 10))
            .filter(Boolean)
            .sort();
          previous = await recordsWithSubconto(
            conn,
            reg,
            ref,
            days[0] ?? day,
            days[days.length - 1] ?? day,
          ).catch(() => []);
        }
        await conn.client.put(`${willPut}?$format=json`, {
          Recorder: ref,
          Recorder_Type: recorderType,
          RecordSet: rows,
        });

        // Проверка: перечитываем с субконто.
        const after = await recordsWithSubconto(conn, reg, ref, day);
        const problems: string[] = [];
        if (after.length !== rows.length)
          problems.push(`в регистре ${after.length} проводок вместо ${rows.length}`);
        rows.forEach((r, i) => {
          const a = after.find((x) => Number(x["LineNumber"]) === i + 1);
          if (!a) return;
          for (const [k, v] of Object.entries(r)) {
            if (
              !/^(Account(Dr|Cr)_Key|Сумма|ExtDimension(Dr|Cr)\d(_Type)?|Валюта(Dr|Cr)_Key|ВалютнаяСумма(Dr|Cr)|Количество(Dr|Cr))$/.test(
                k,
              )
            )
              continue;
            const got = a[k];
            const okv = k.endsWith("_Type")
              ? typeOf(got) === typeOf(v)
              : typeof v === "number"
                ? Math.abs(Number(got ?? 0) - v) < 0.005
                : same(got, v) || (v === EMPTY_GUID && !isRef(got));
            if (!okv) problems.push(`строка ${i + 1}: ${k}`);
          }
        });
        if (problems.length) {
          const restore =
            existing.length === 0
              ? []
              : previous.length === existing.length
                ? previous.map((r) =>
                    Object.fromEntries(Object.entries(r).filter(([k]) => RESTORE_FIELD_RE.test(k))),
                  )
                : undefined;
          let rolledBack = false;
          if (restore) {
            try {
              await conn.client.put(`${willPut}?$format=json`, {
                Recorder: ref,
                Recorder_Type: recorderType,
                RecordSet: restore,
              });
              rolledBack = true;
            } catch {
              /* сообщим ниже */
            }
          }
          return fail(
            `1С приняла набор проводок, но при перечитывании не совпало: ${problems.slice(0, 20).join("; ")}. ` +
              (rolledBack
                ? existing.length === 0
                  ? "Запись откатана (набор проводок документа снова пуст). Проводки внесите в 1С вручную."
                  : `Запись откатана: возвращены прежние ${existing.length} проводок — сверьте их в 1С (read.accounting.get_document_postings).`
                : "ВНИМАНИЕ: откатить не удалось — проверьте проводки документа в 1С (read.accounting.get_document_postings)."),
          );
        }
        let amountUpdated = false;
        if (updateOperationAmount && Math.abs(docTotal - total) > 0.005) {
          await conn.client.patch(`${set}(${odataGuid(ref)})?$format=json`, { СуммаОперации: total });
          amountUpdated = true;
        }
        return ok({
          updated: true,
          ...info,
          verified: true,
          ...(amountUpdated ? { operationAmountUpdated: total } : {}),
          note: "Проводки записаны и проверены повторным чтением (с субконто).",
        });
      }),
  );
}
