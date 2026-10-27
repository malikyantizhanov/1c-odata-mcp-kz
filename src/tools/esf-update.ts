import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { buildQuery, cmp, odataGuid } from "../odata/query.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, fail, guard, ok } from "./_shared.js";
import { EXCHANGE_FIELDS } from "./esf-create.js";
import {
  addressProblem,
  bankDetails,
  buyerParty,
  checkEsfNumber,
  consignment,
  headerDefaults,
  invoiceExtras,
  partyWarnings,
  planEsfNumber,
  esfNumberField,
  recipientRow,
  supplierParty,
  supplierRow,
  type FillCtx,
} from "./esf-fill.js";
import { confirmField } from "./write.js";
import { writeBlockedMessage, notWritableMessage } from "../write-status.js";

/**
 * write.esf.update_draft — правка черновика исходящего ЭСФ до отправки в ИС ЭСФ: номер документа (вручную или
 * следующий по нумератору), адреса и реквизиты сторон (из карточек или вручную), реквизиты шапки из белого
 * списка, строки товаров. Поля обмена с ИС (рег. номер, идентификатор, статус, состояние, ЭЦП) не меняются
 * никогда. Отказ для входящих, отправленных, зарегистрированных, стоящих в очереди или имеющих историю обмена.
 * Порядок как у всех write.*: предпросмотр «было → станет», запись — confirm=true с operationId из предпросмотра.
 */

const ESF = "Document_ЭСФ";
const INVOICE_OUT = "Document_СчетФактураВыданный";
const REG_ACTUAL = "InformationRegister_АктуальныеЭСФ";
const REG_HISTORY = "InformationRegister_ИсторияЭСФ";
const REG_QUEUE = "InformationRegister_ОчередьОтправкиЭСФ";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const typeOf = (t: unknown) => String(t ?? "").replace(/^StandardODATA\./, "");

/** Черновик — пока ИС ЭСФ о документе не знает: эти статусы/состояния допускают правку. */
export const DRAFT_STATUSES = new Set(["", "Черновик"]);
export const DRAFT_STATES = new Set(["", "Сформирован"]);

/** Реквизиты шапки, которые можно менять (поля обмена с ИС, суммы и связи здесь не правятся). */
export const EDITABLE_HEADER = [
  "ДатаОборота",
  "ДоговорПоставкиНомер",
  "ДоговорПоставкиДата",
  "ДоговорПоставкиУсловияОплаты",
  "ДоговорПоставкиСпособОтправления",
  "ДоговорПоставкиУсловияПоставки",
  "СпособОтправленияПоКлассификатору",
  "ДоверенностьНаПоставкуНомер",
  "ДоверенностьНаПоставкуДата",
  "ПунктНазначения",
  "ДокументПодтверждающийПоставкуНомер",
  "ДокументПодтверждающийПоставкуДата",
  "ГосучреждениеИИК",
  "ГосучреждениеБИК",
  "ГосучреждениеКодТоваров",
  "ГосучреждениеНазначениеПлатежа",
  "ГрузоотправительИдентификатор",
  "ГрузоотправительНаименование",
  "ГрузополучательИдентификатор",
  "ГрузополучательНаименование",
  "ГрузополучательКодСтраны",
  "ДополнительныеСведения",
  "Комментарий",
] as const;

/** Поля строки «Поставщики»/«Получатели», которые можно задать вручную. */
const PARTY_FIELDS = [
  "Адрес",
  "КодСтраны",
  "Нерезидент",
  "КБе",
  "ИИК",
  "БИК",
  "НаименованиеБанка",
  "СерияСвидетельстваПоНДС",
  "НомерСвидетельстваПоНДС",
] as const;

export interface ExchangeState {
  direction: string;
  status: string;
  state: string;
  registrationNumber: string;
  identifier: string;
  history?: number | undefined;
  queued?: number | undefined;
  actualState?: string | undefined;
}

/** Можно ли править ЭСФ: только исходящий черновик, о котором ИС ЭСФ ещё ничего не знает. */
export function draftVerdict(f: ExchangeState): string[] {
  const refuse: string[] = [];
  if (f.direction !== "Исходящий")
    refuse.push(
      `ЭСФ ${f.direction ? `«${f.direction}»` : "без направления"}: править можно только исходящий черновик (входящий получен из ИС ЭСФ).`,
    );
  if (f.registrationNumber)
    refuse.push(
      `У ЭСФ есть регистрационный номер ИС ЭСФ ${f.registrationNumber} — документ зарегистрирован, менять его нельзя (только исправленный/дополнительный ЭСФ в 1С).`,
    );
  if (f.identifier)
    refuse.push(
      `У ЭСФ есть идентификатор ИС ЭСФ (${f.identifier}) — документ уже передан в ИС, правка только в 1С.`,
    );
  if (!DRAFT_STATUSES.has(f.status))
    refuse.push(`Статус ЭСФ «${f.status}» — это не черновик; правка только в 1С.`);
  if (!DRAFT_STATES.has(f.state))
    refuse.push(`Состояние ЭСФ «${f.state}» — документ уже в обмене с ИС ЭСФ; правка только в 1С.`);
  if (f.queued)
    refuse.push("ЭСФ стоит в очереди отправки (ОчередьОтправкиЭСФ) — снимите его с отправки в 1С.");
  if (f.history)
    refuse.push(`По ЭСФ есть история обмена с ИС ЭСФ (${f.history} записей) — документ уже отправлялся.`);
  if (f.actualState && !DRAFT_STATES.has(f.actualState))
    refuse.push(`В регистре АктуальныеЭСФ состояние «${f.actualState}» — документ уже в обмене с ИС ЭСФ.`);
  return refuse;
}

export interface LineEdit {
  lineNumber: number;
  name?: string | undefined;
  quantity?: number | undefined;
  price?: number | undefined;
  unitName?: string | undefined;
  unitCode?: string | undefined;
  originMark?: string | undefined;
  tnved?: string | undefined;
  additionalData?: string | undefined;
}

/** Строка ТЧ для PATCH: без служебных ключей OData и ссылки на документ (1С заменяет ТЧ целиком). */
export function rowForPatch(r: Record<string, unknown>, i: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "Ref_Key" || k.includes("@") || k.startsWith("odata.")) continue;
    out[k] = v;
  }
  out["LineNumber"] = i + 1;
  return out;
}

/**
 * Правка строк «Товары»: наименование, единица, признак происхождения, ТН ВЭД, доп. данные; при новом количестве
 * или цене — пересчёт суммы без налогов (= оборот), НДС по ставке строки и суммы с НДС, как в форме ЭСФ.
 */
export function applyLineEdits(
  rows: Array<Record<string, unknown>>,
  edits: LineEdit[],
  warnings: string[],
): Array<Record<string, unknown>> {
  const out = rows.map((r, i) => rowForPatch(r, i));
  for (const e of edits) {
    const row = out[e.lineNumber - 1];
    if (!row) throw new InputError(`В ЭСФ нет строки ${e.lineNumber} (строк: ${out.length}).`);
    if (e.name !== undefined) row["ТоварНаименование"] = e.name;
    if (e.unitName !== undefined) row["ЕдиницаИзмеренияНаименование"] = e.unitName;
    if (e.unitCode !== undefined) row["ЕдиницаИзмеренияКод"] = e.unitCode;
    if (e.originMark !== undefined) row["ПризнакПроисхождения"] = e.originMark;
    if (e.tnved !== undefined) row["КодТНВЭД"] = e.tnved;
    if (e.additionalData !== undefined) row["ДополнительныеДанные"] = e.additionalData;
    if (e.quantity !== undefined || e.price !== undefined) {
      const q = e.quantity ?? Number(row["Количество"] ?? 0);
      const p = e.price ?? Number(row["Цена"] ?? 0);
      const base = money(q * p);
      const excise = money(row["СуммаАкциза"]);
      const rate = row["БезНДС"] === true ? 0 : Number(row["СтавкаНДСЧисло"] ?? 0);
      const vat = money(((base + excise) * rate) / 100);
      Object.assign(row, {
        Количество: q,
        Цена: p,
        СуммаБезНалогов: base,
        ОборотПоРеализации: money(base + excise),
        СуммаНДС: vat,
        Сумма: money(base + excise + vat),
      });
      if (excise)
        warnings.push(`Строка ${e.lineNumber}: есть акциз — сумма акциза не пересчитана, проверьте её в 1С.`);
    }
  }
  return out;
}

interface Change {
  field: string;
  was: unknown;
  will: unknown;
}

/** «Было → станет» по шапке; для табличных частей — по каждому изменённому полю строки. */
export function diff(current: ODataEntity, fields: Record<string, unknown>): Change[] {
  const changes: Change[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      const before = ((current[k] as Array<Record<string, unknown>> | undefined) ?? []).map((r, i) =>
        rowForPatch(r, i),
      );
      if (before.length !== v.length)
        changes.push({ field: k, was: `${before.length} строк`, will: `${v.length} строк` });
      v.forEach((row: Record<string, unknown>, i) => {
        for (const [rk, rv] of Object.entries(row)) {
          if (rk === "LineNumber") continue;
          const was = before[i]?.[rk];
          if (String(was ?? "") !== String(rv ?? "") && !(rk.endsWith("_Type") && typeOf(was) === typeOf(rv)))
            changes.push({ field: `${k}[${i + 1}].${rk}`, was: was ?? null, will: rv });
        }
      });
      continue;
    }
    const was = current[k];
    if (
      k.endsWith("_Type")
        ? typeOf(was) === typeOf(v)
        : String(was ?? "").toLowerCase() === String(v ?? "").toLowerCase()
    )
      continue;
    changes.push({ field: k, was: was ?? null, will: v });
  }
  return changes;
}

async function countRows(
  conn: Connection,
  set: string,
  esfRef: string,
  select: string[],
  label: string,
  warnings: string[],
): Promise<ODataEntity[] | undefined> {
  if (!(await conn.available()).has(set)) return [];
  try {
    const { rows } = await fetchAll(
      conn.client,
      set,
      { filter: cmp("ЭСФ_Key", "eq", odataGuid(guidOf(esfRef))), select },
      50,
      200,
    );
    return rows;
  } catch (e) {
    warnings.push(
      `Не удалось проверить регистр «${label}» (${e instanceof ODataError ? e.kind : "ошибка"}) — проверьте в 1С, что ЭСФ не отправлялся.`,
    );
    return undefined;
  }
}

const partyEdit = z
  .object({
    Адрес: z.string().optional(),
    КодСтраны: z.string().length(2).optional(),
    Нерезидент: z.boolean().optional(),
    КБе: z.string().optional(),
    ИИК: z.string().optional(),
    БИК: z.string().optional(),
    НаименованиеБанка: z.string().optional(),
    СерияСвидетельстваПоНДС: z.string().optional(),
    НомерСвидетельстваПоНДС: z.string().optional(),
  })
  .strict();

const lineEdit = z
  .object({
    lineNumber: z.number().int().positive().describe("Номер строки «Товары» (с 1)"),
    name: z.string().min(1).optional().describe("Наименование товара/услуги"),
    quantity: z.number().positive().optional().describe("Количество (суммы и НДС строки пересчитываются)"),
    price: z.number().nonnegative().optional().describe("Цена без НДС (суммы и НДС строки пересчитываются)"),
    unitName: z.string().optional().describe("Единица измерения — наименование"),
    unitCode: z.string().optional().describe("Единица измерения — код"),
    originMark: z
      .enum(["1", "2", "3", "4", "5", "6"])
      .optional()
      .describe("Признак происхождения (1–5 товары, 6 — услуги)"),
    tnved: z.string().optional().describe("Код ТН ВЭД"),
    additionalData: z.string().optional().describe("Дополнительные данные строки"),
  })
  .strict();

const resultSchema = z
  .object({
    dryRun: z.boolean().optional(),
    updated: z.boolean().optional(),
    verified: z.boolean().optional(),
    database: z.string(),
    entitySet: z.string(),
    ref: z.string(),
    fields: z.record(z.string(), z.unknown()),
    changes: z.array(z.object({ field: z.string() }).passthrough()),
    checks: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .passthrough();

export function registerEsfUpdateTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.esf.update_draft",
    {
      title: "Изменить черновик исходящего ЭСФ до отправки",
      description:
        "Правит черновик исходящего ЭСФ (Document_ЭСФ) до отправки в ИС ЭСФ. Что можно: номер документа — number " +
        "или assignNumber=true (следующий по нумератору ЭСФ, как ставит форма 1С; проверка дубля в году); " +
        "refreshParties=true — заново заполнить поставщика и получателя из карточек (БИН/ИИН, наименование, адрес из " +
        "контактной информации, свидетельство НДС, ИИК/БИК/банк, КБе, код страны, нерезидент, госучреждение), " +
        "грузоотправителя/грузополучателя с адресами и условия поставки из счёта-фактуры, ТипПодписи и СпособРасчета " +
        "по умолчанию, курс 1 для ЭСФ в тенге — как в ЭСФ, созданном в 1С; supplier / " +
        "recipient — поля строк «Поставщики»/«Получатели» вручную (Адрес, КодСтраны, Нерезидент, КБе, ИИК, БИК, " +
        "НаименованиеБанка, свидетельство НДС); shipFromAddress / deliveryAddress; header — реквизиты шапки из " +
        "белого списка (дата оборота, договор поставки, условия, доверенность, пункт назначения, документ поставки, " +
        "госучреждение, доп. сведения, комментарий); lines — строки «Товары» (наименование, количество и цена с " +
        "пересчётом сумм и НДС строки, единица, признак происхождения, ТН ВЭД). Регистрационный номер, идентификатор, " +
        "статус, состояние и ЭЦП не меняет никогда. Отказ: входящий ЭСФ, есть рег. номер или идентификатор ИС, статус " +
        "не «Черновик»/пустой, состояние не «Сформирован»/пустое, очередь отправки, история обмена (регистры " +
        "ОчередьОтправкиЭСФ, ИсторияЭСФ, АктуальныеЭСФ), помечен на удаление, номер занят. Проведённый черновик — " +
        "только с repost=true (отмена проведения → запись → проведение). Предпросмотр «было → станет» по умолчанию; " +
        "запись — confirm=true с operationId из предпросмотра после согласия бухгалтера.",
      inputSchema: {
        database: databaseField,
        esfRef: GUID.describe("Ref_Key ЭСФ (исходящий черновик)"),
        number: esfNumberField.optional().describe("Новый номер ЭСФ (номер учётной системы)"),
        assignNumber: z
          .boolean()
          .default(false)
          .describe("Поставить следующий номер по нумератору ЭСФ (если номер пуст; с number не сочетается)"),
        refreshParties: z
          .boolean()
          .default(false)
          .describe(
            "Перезаполнить поставщика, получателя (и для товаров — грузоотправителя/грузополучателя) из карточек",
          ),
        supplier: partyEdit.optional().describe("Поля строки «Поставщики» вручную (поверх refreshParties)"),
        recipient: partyEdit.optional().describe("Поля строки «Получатели» вручную (поверх refreshParties)"),
        shipFromAddress: z.string().optional().describe("Адрес отправки (грузоотправитель)"),
        deliveryAddress: z.string().optional().describe("Адрес доставки (грузополучатель)"),
        header: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            `Реквизиты шапки: ${EDITABLE_HEADER.join(", ")}. Даты — 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:MM:SS'.`,
          ),
        lines: z.array(lineEdit).optional().describe("Правки строк «Товары» по номеру строки"),
        repost: z
          .boolean()
          .default(false)
          .describe(
            "Проведённый черновик: отменить проведение → записать → провести заново (по умолчанию отказ)",
          ),
        confirm: confirmField,
      },
      outputSchema: resultSchema,
    },
    (args) =>
      guard("write.esf.update_draft", async () => {
        const {
          database,
          esfRef,
          number,
          assignNumber,
          refreshParties,
          supplier,
          recipient,
          shipFromAddress,
          deliveryAddress,
          header,
          lines,
          repost,
          confirm,
        } = args;
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [ESF], "Документ «ЭСФ»");
        if (number && assignNumber)
          throw new InputError("Номер: задайте что-то одно — number или assignNumber.");
        let esf: ODataEntity;
        try {
          esf = await conn.client.getEntity<ODataEntity>(`${set}(guid'${guidOf(esfRef)}')${buildQuery({})}`);
        } catch (e) {
          if (e instanceof ODataError && e.kind === "not_found")
            throw new InputError(`ЭСФ ${esfRef} не найден в базе.`);
          throw e;
        }
        const warnings: string[] = [];
        const checks: string[] = [];
        const refuse: string[] = [];
        if (esf["DeletionMark"] === true) refuse.push("ЭСФ помечен на удаление.");

        // Обмен с ИС ЭСФ.
        const history = await countRows(
          conn,
          REG_HISTORY,
          esfRef,
          ["ЭСФ_Key", "НомерЗаписи"],
          "ИсторияЭСФ",
          warnings,
        );
        const queue = await countRows(conn, REG_QUEUE, esfRef, ["ЭСФ_Key"], "ОчередьОтправкиЭСФ", warnings);
        const actual = await countRows(
          conn,
          REG_ACTUAL,
          esfRef,
          ["ЭСФ_Key", "Состояние"],
          "АктуальныеЭСФ",
          warnings,
        );
        const verdict = draftVerdict({
          direction: str(esf["Направление"]),
          status: str(esf["Статус"]),
          state: str(esf["Состояние"]),
          registrationNumber: str(esf["РегистрационныйНомер"]),
          identifier: str(esf["Идентификатор"]),
          history: history?.length,
          queued: queue?.length,
          actualState: actual?.[0] ? str(actual[0]["Состояние"]) : undefined,
        });
        refuse.push(...verdict);
        if (!verdict.length)
          checks.push(
            "черновик исходящего ЭСФ: нет рег. номера и идентификатора ИС, статус/состояние черновика, нет очереди и истории обмена",
          );
        const posted = esf["Posted"] === true;
        if (posted && !repost)
          refuse.push(
            "ЭСФ проведён. Передайте repost=true: инструмент отменит проведение, запишет изменения и проведёт ЭСФ заново.",
          );

        const fields: Record<string, unknown> = {};
        const date = str(esf["Date"]) || new Date().toISOString().slice(0, 19);
        const orgRef = isRef(esf["Организация_Key"]) ? String(esf["Организация_Key"]) : undefined;
        if ((number || assignNumber) && !orgRef)
          refuse.push("В ЭСФ не указана организация — номер по нумератору не определить.");

        // Номер.
        let newNumber = number;
        if (assignNumber) {
          if (str(esf["Number"]))
            checks.push(
              `номер уже есть (${str(esf["Number"])}) — assignNumber его не меняет; для замены передайте number`,
            );
          else if (orgRef) {
            const planned = await planEsfNumber(conn, set, date, orgRef);
            newNumber = planned.number;
            checks.push(`номер ${newNumber}: ${planned.how}`);
          }
        }
        if (newNumber && orgRef && newNumber !== str(esf["Number"])) {
          const dup = await checkEsfNumber(conn, set, newNumber, date, orgRef, esfRef);
          if (dup.refuse) refuse.push(dup.refuse);
          else checks.push(`номер ${newNumber} не занят другим исходящим ЭСФ организации в этом году`);
          warnings.push(...dup.warnings);
          fields["Number"] = newNumber;
        }

        // Стороны.
        const fill: FillCtx = { warnings, checks };
        const supplierRows = ((esf["Поставщики"] as Array<Record<string, unknown>> | undefined) ?? []).map(
          (r, i) => rowForPatch(r, i),
        );
        const recipientRows = ((esf["Получатели"] as Array<Record<string, unknown>> | undefined) ?? []).map(
          (r, i) => rowForPatch(r, i),
        );
        let partiesTouched = false;
        if (refreshParties) {
          const org = isRef(esf["Организация_Key"]) ? String(esf["Организация_Key"]) : undefined;
          const cp = isRef(esf["Контрагент_Key"]) ? String(esf["Контрагент_Key"]) : undefined;
          if (!org) refuse.push("В ЭСФ не указана организация — реквизиты поставщика взять неоткуда.");
          if (!cp) refuse.push("В ЭСФ не указан контрагент — реквизиты получателя взять неоткуда.");
          if (supplierRows.length > 1 || recipientRows.length > 1)
            refuse.push(
              "В ЭСФ несколько поставщиков/получателей (совместная деятельность) — перезаполнение из карточек не поддерживается, правьте поля вручную.",
            );
          if (org && cp && supplierRows.length <= 1 && recipientRows.length <= 1) {
            const sup = await supplierParty(conn, org, fill);
            const buy = await buyerParty(conn, cp, fill);
            partyWarnings(sup, buy, fill);
            const inv =
              isRef(esf["СчетФактура"]) && typeOf(esf["СчетФактура_Type"]) === INVOICE_OUT
                ? await conn.client
                    .getEntity<ODataEntity>(
                      `${INVOICE_OUT}(guid'${guidOf(String(esf["СчетФактура"]))}')${buildQuery({})}`,
                    )
                    .catch(() => undefined)
                : undefined;
            if (!inv)
              warnings.push(
                "Счёт-фактура выданный в ЭСФ не указан или не найден — условия поставки, грузоотправитель/грузополучатель не перезаполнены.",
              );
            const bank = await bankDetails(
              conn,
              isRef(inv?.["СчетОрганизации_Key"]) ? inv!["СчетОрганизации_Key"] : sup.mainBankAccount,
            );
            supplierRows[0] = { ...(supplierRows[0] ?? { LineNumber: 1 }), ...supplierRow(sup, bank) };
            recipientRows[0] = { ...(recipientRows[0] ?? { LineNumber: 1 }), ...recipientRow(buy) };
            partiesTouched = true;
            if (inv) {
              Object.assign(fields, await invoiceExtras(conn, inv, buy));
              Object.assign(fields, await consignment(conn, inv, sup, buy, fill));
            }
            const defaults = headerDefaults(
              str(esf["ВалютаКод"]) || undefined,
              Number(esf["КурсВалюты"] ?? 1),
            );
            fields["ТипПодписи"] = str(esf["ТипПодписи"]) || defaults["ТипПодписи"];
            fields["СпособРасчета"] = str(esf["СпособРасчета"]) || defaults["СпособРасчета"];
            if (defaults["КурсВалюты"] === 1 && Number(esf["КурсВалюты"] ?? 1) !== 1) {
              fields["КурсВалюты"] = 1;
              warnings.push(
                "ЭСФ в тенге с курсом, отличным от 1 (взят курс валютного договора) — курс исправляется на 1, как в ЭСФ из 1С.",
              );
            }
          }
        }
        const manual = (
          rows: Array<Record<string, unknown>>,
          edit: z.infer<typeof partyEdit> | undefined,
          label: string,
        ) => {
          if (!edit) return;
          if (rows.length !== 1) {
            refuse.push(
              `«${label}»: ручная правка поддерживается для одной строки (в ЭСФ строк: ${rows.length}).`,
            );
            return;
          }
          const p = addressProblem(label, edit.Адрес);
          if (p) refuse.push(p);
          for (const k of PARTY_FIELDS) if (edit[k] !== undefined) rows[0]![k] = edit[k];
          partiesTouched = true;
        };
        manual(supplierRows, supplier, "Поставщики");
        manual(recipientRows, recipient, "Получатели");
        if (partiesTouched) {
          fields["Поставщики"] = supplierRows;
          fields["Получатели"] = recipientRows;
        }
        for (const [k, v, label] of [
          ["АдресОтправки", shipFromAddress, "Адрес отправки"],
          ["АдресДоставки", deliveryAddress, "Адрес доставки"],
        ] as const) {
          if (v === undefined) continue;
          const p = addressProblem(label, v);
          if (p) refuse.push(p);
          fields[k] = v.trim();
        }

        // Шапка.
        for (const [k, v] of Object.entries(header ?? {})) {
          if (EXCHANGE_FIELDS.has(k) || k === "Number" || k === "Date")
            refuse.push(
              `Поле ${k} этим инструментом не меняется${k === "Number" ? " (номер — параметр number)" : " (поле обмена с ИС ЭСФ)"}.`,
            );
          else if (!(EDITABLE_HEADER as readonly string[]).includes(k))
            refuse.push(`Поле ${k} не входит в список изменяемых: ${EDITABLE_HEADER.join(", ")}.`);
          else
            fields[k] =
              /Дата$/.test(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v;
        }

        // Строки.
        if (lines?.length) {
          const goods = (esf["Товары"] as Array<Record<string, unknown>> | undefined) ?? [];
          const edited = applyLineEdits(goods, lines, warnings);
          fields["Товары"] = edited;
          if (lines.some((l) => l.quantity !== undefined || l.price !== undefined)) {
            const total = money(edited.reduce((s, r) => s + money(r["Сумма"]), 0));
            fields["СуммаДокумента"] = total;
            if (
              ((esf["ТоварыПоПоставщикам"] as unknown[]) ?? []).length ||
              ((esf["ТоварыПоПолучателям"] as unknown[]) ?? []).length
            )
              warnings.push(
                "В ЭСФ заполнены «Товары по поставщикам/получателям» — после пересчёта строк проверьте их в 1С.",
              );
          }
        }

        for (const k of Object.keys(fields))
          if (EXCHANGE_FIELDS.has(k)) throw new Error(`Внутренняя ошибка: поле обмена ${k} в правке ЭСФ.`);
        if (refuse.length)
          return fail(
            `Изменение ЭСФ не выполнено — проверки не пройдены:\n- ${refuse.join("\n- ")}` +
              (warnings.length ? `\nПредупреждения:\n- ${warnings.join("\n- ")}` : "") +
              (checks.length ? `\nПройдено:\n- ${checks.join("\n- ")}` : ""),
          );
        const changes = diff(esf, fields);
        if (!changes.length) return fail("Менять нечего: значения в ЭСФ уже такие.");
        const changed = Object.fromEntries(
          Object.entries(fields).filter(([k]) =>
            changes.some((c) => c.field === k || c.field.startsWith(`${k}[`)),
          ),
        );
        // Только существующие в $metadata поля (в другой версии конфигурации части полей может не быть).
        const meta = await conn.getMetadata();
        const props = new Set((meta.entities.get(set)?.properties ?? []).map((p) => p.name));
        if (props.size) {
          const missing = Object.keys(changed).filter((k) => !props.has(k));
          if (missing.length) {
            for (const k of missing) delete changed[k];
            warnings.push(`В этой базе у ЭСФ нет полей ${missing.join(", ")} — пропущены.`);
          }
        }
        const info = {
          database: conn.cfg.name,
          title: `ЭСФ № ${str(esf["Number"]) || "без номера"} от ${str(esf["Date"]).slice(0, 10)}`,
          entitySet: set,
          ref: guidOf(esfRef),
          fields: changed,
          changes,
          checks,
          warnings,
        };
        const g = guidOf(esfRef);
        const key = { ref: g };
        if (!confirm) {
          await conn.client.prepareCreate(set, key, { withRefKey: false });
          return ok({
            dryRun: true,
            ...info,
            ...(posted
              ? {
                  repost: true,
                  steps: [
                    `1) отменить проведение`,
                    `2) записать: ${Object.keys(changed).join(", ")}`,
                    `3) провести заново`,
                  ],
                }
              : {}),
            willPatch: `${set}(${g})`,
            note: conn.cfg.writable
              ? "Предпросмотр. Будут записаны только перечисленные поля (табличные части — целиком, как требует 1С). Для записи повторите вызов с теми же аргументами, confirm=true и operationId из этого ответа после согласия бухгалтера."
              : `Предпросмотр. ВНИМАНИЕ: ${notWritableMessage(conn.cfg)}`,
          });
        }
        if (writeBlockedMessage(conn)) return fail(writeBlockedMessage(conn)!);
        const postedNow = async () =>
          (await conn.client.getEntity(`${set}(guid'${g}')${buildQuery({ select: ["Posted"] })}`))[
            "Posted"
          ] === true;
        if (posted) {
          await conn.client.action(`${set}(guid'${g}')/Unpost?$format=json`);
          if (await postedNow()) return fail("1С не отменила проведение ЭСФ — изменения не записаны.");
        }
        try {
          await conn.client.patchOnce(`${set}(guid'${g}')?$format=json`, changed, set, key);
        } catch (e) {
          if (posted) {
            await conn.client.action(`${set}(guid'${g}')/Post?$format=json`).catch(() => undefined);
            const back = await postedNow().catch(() => false);
            throw new InputError(
              `ЭСФ не изменён: ${(e as Error).message}. ${back ? "ЭСФ проведён обратно без изменений." : "ВНИМАНИЕ: ЭСФ остался НЕпроведённым — проведите его в 1С."}`,
            );
          }
          throw e;
        }
        let postError = "";
        if (posted) {
          try {
            await conn.client.action(`${set}(guid'${g}')/Post?$format=json`);
          } catch (e) {
            postError = (e as Error).message;
          }
          if (!(await postedNow()))
            return fail(
              `Изменения записаны, но ЭСФ НЕ проведён заново${postError ? ` (1С: ${postError})` : ""}. Проведите ЭСФ в 1С.`,
            );
        }
        const after = await conn.client.getEntity<ODataEntity>(`${set}(guid'${g}')${buildQuery({})}`);
        const notVerified = diff(after, changed).map((c) => c.field);
        return ok({
          updated: true,
          ...info,
          verified: notVerified.length === 0,
          ...(notVerified.length ? { notVerified } : {}),
          note: notVerified.length
            ? "1С приняла изменения, но после перечитывания часть полей отличается — проверьте ЭСФ в 1С."
            : "Записано и проверено повторным чтением. Подписание и отправка в ИС ЭСФ — в 1С.",
        });
      }),
  );
}
