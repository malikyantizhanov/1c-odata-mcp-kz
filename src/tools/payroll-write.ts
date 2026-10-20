import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, odataGuid } from "../odata/query.js";
import { resolveNames } from "../odata/accounting.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { dateField, databaseField, guard, organizationField } from "./_shared.js";
import { confirmField, createOrPreview } from "./write.js";
import { prepareDocument } from "./write-documents.js";
import { PAYROLL_SUM_DOCS } from "./payroll-sums.js";
import {
  PAYROLL_FUNDS,
  PERSONS,
  byPerson,
  fromCents,
  fundBalances,
  monthLabel,
  monthStart,
  personOf,
  realRef,
  salaryBalances,
  toCents,
  cleanName,
} from "./payroll-data.js";

/**
 * Ведомость «Зарплата к выплате» и «Перечисление в фонды» (Казахстан) со строками и суммами из 1С: остатки
 * регистров (что 1С посчитала проведением начисления и расчётов) или строки проведённого расчёта-основания.
 * Через OData 1С эти документы сама не заполняет: «Авторасчет» и «ДокументОснование» ничего не дают, пустой
 * документ проводится с нулями (проверено на Aru Market). Проведение — write.document.post_document отдельно.
 */

export const STATEMENT = "Document_ЗарплатаКВыплатеОрганизаций";
const USERS = "Catalog_Пользователи";
const WITHHOLDING = "Document_РасчетУдержанийРаботниковОрганизаций";
const EMPLOYER = "Document_РасчетСНиСО";
const EP = "Document_РасчетЕдиногоПлатежа";
const PERSON_TYPE = `StandardODATA.${PERSONS}`;

/** Документ перечисления по фонду: табличная часть, поле месяца строки, виды операции по видам взносов. */
export const TRANSFERS = {
  opv: {
    entitySet: "Document_ОПВПеречислениеВФонды",
    table: "ПенсионныеВзносы",
    composite: true,
    monthField: undefined as string | undefined,
    kinds: {
      opv: "ПеречислениеОбязательныхПенсионныхВзносов",
      opvr: "ПеречислениеОбязательныхПенсионныхВзносовРаботодателя",
      oppv: "ПеречислениеОбязательныхПрофессиональныхПенсионныхВзносов",
    } as Record<string, string>,
    defaultKind: "opv",
    paymentOperation: "ПеречислениеПенсионныхВзносов",
  },
  so: {
    entitySet: "Document_СОПеречислениеВФонды",
    table: "СоциальныеОтчисления",
    composite: true,
    monthField: "МесяцПериода" as string | undefined,
    kinds: {
      so: "ПеречислениеОбязательныхСоциальныхОтчислений",
      vosms: "ПеречислениеВзносовОСМС",
      oosms: "ПеречислениеОтчисленийОСМС",
    } as Record<string, string>,
    defaultKind: "so",
    paymentOperation: "ПеречислениеСоциальныхОтчислений",
  },
  ep: {
    entitySet: "Document_ЕППеречислениеВФонды",
    table: "ЕдиныеПлатежи",
    composite: false,
    monthField: "МесяцНалоговогоПериода" as string | undefined,
    kinds: { ep: "" } as Record<string, string>,
    defaultKind: "ep",
    paymentOperation: "ПеречислениеЕдиногоПлатежа",
  },
} as const;
export type TransferFund = keyof typeof TRANSFERS;

/** Строки проведённого расчёта, из которых берутся суммы перечисления. */
export const TRANSFER_BASIS: Readonly<Record<string, { entitySet: string; table: string; field: string }>> = {
  opv: { entitySet: WITHHOLDING, table: "ИсчисленныйОПВ", field: "Взнос" },
  vosms: { entitySet: WITHHOLDING, table: "ИсчисленныеВОСМС", field: "Взнос" },
  opvr: { entitySet: EMPLOYER, table: "ИсчисленныйОПВР", field: "Взнос" },
  oppv: { entitySet: EMPLOYER, table: "ИсчисленныйОППВ", field: "Взнос" },
  so: { entitySet: EMPLOYER, table: "ИсчисленныеСО", field: "Отчисление" },
  oosms: { entitySet: EMPLOYER, table: "ИсчисленныеООСМС", field: "Отчисление" },
  ep: { entitySet: EP, table: "ИсчисленныйЕП", field: "СуммаПлатежа" },
};

const guidOf = (v: string) => v.trim().replace(/[{}']/g, "");
const fmt = (c: number) => fromCents(c).toLocaleString("ru-RU", { minimumFractionDigits: 2 });

async function personNames(conn: Connection, refs: Iterable<string>): Promise<Map<string, string>> {
  return (await conn.available()).has(PERSONS)
    ? resolveNames(conn, PERSONS, refs)
    : new Map<string, string>();
}

/** Ответственный: проверка, что пользователь есть; без него 1С поставит пользователя OData. */
async function responsibleFields(
  conn: Connection,
  responsibleRef: string | undefined,
  notes: string[],
): Promise<Record<string, string>> {
  if (!responsibleRef) {
    notes.push(
      "Ответственный не передан — 1С поставит пользователя, под которым MCP подключён к OData. Чтобы стоял " +
        "бухгалтер, передайте responsibleRef (Ref_Key из справочника «Пользователи»).",
    );
    return {};
  }
  const ref = guidOf(responsibleRef);
  try {
    const u = await conn.client.getEntity(`${USERS}(guid'${ref}')${buildQuery({ select: ["Description"] })}`);
    notes.push(`Ответственный: ${String(u["Description"] ?? ref)}.`);
  } catch {
    throw new InputError(`Пользователь responsibleRef=${ref} не найден в справочнике «Пользователи».`);
  }
  return { Ответственный_Key: ref };
}

/** Документы того же вида за месяц по организации (не помеченные на удаление). */
async function sameMonth(
  conn: Connection,
  entitySet: string,
  periodField: string,
  month: string,
  orgKey: string,
): Promise<ODataEntity[]> {
  const { rows } = await fetchAll(
    conn.client,
    entitySet,
    {
      filter: and(
        cmp(periodField, "eq", `datetime'${month}'`),
        cmp("Организация_Key", "eq", odataGuid(orgKey)),
        cmp("DeletionMark", "eq", "false"),
      ),
    },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  return rows as ODataEntity[];
}

/** Повтор по тем же физлицам — отказ (без allowDuplicate): документ сам остаток не уменьшает, суммы задвоятся. */
function duplicateGuard(
  existing: ODataEntity[],
  table: string,
  persons: Set<string>,
  what: string,
  allowDuplicate: boolean | undefined,
  notes: string[],
): void {
  const hits = existing.filter((d) =>
    ((d[table] as Array<Record<string, unknown>> | undefined) ?? []).some((r) => {
      const p = personOf(r);
      return !!p && persons.has(p);
    }),
  );
  if (!hits.length) return;
  const list = hits
    .map(
      (d) =>
        `№ ${String(d["Number"] ?? "")} от ${String(d["Date"] ?? "").slice(0, 10)}${d["Posted"] === true ? " (проведён)" : ""}`,
    )
    .join(", ");
  if (!allowDuplicate)
    throw new InputError(
      `${what} за этот месяц по тем же работникам уже есть: ${list}. Остаток в 1С уменьшит выплата/платёжка, а не этот документ — новый задвоит суммы. Проверьте существующий; если нужен ещё один, передайте allowDuplicate=true.`,
    );
  notes.push(`Внимание: ${what} за этот месяц по тем же работникам уже есть: ${list} (allowDuplicate=true).`);
}

export function registerPayrollWriteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.payroll.create_payroll_statement",
    {
      title: "Ведомость «Зарплата к выплате» из остатка 1С",
      description:
        "Казахстан. Создаёт НЕПРОВЕДЁННУЮ ведомость «Зарплата к выплате организаций» за месяц: строки (физлицо, " +
        "сумма к выплате) и итог MCP заполняет из остатка к выплате в 1С — регистр «Взаиморасчёты с работниками " +
        "организаций» за месяц (начислено − удержано − уже выплачено; это посчитала 1С проведением начисления и " +
        "удержаний/ЕП). Сам MCP суммы не считает. Через OData 1С ведомость не заполняет («Авторасчет» не работает). " +
        "Ведомость по тем же работникам за месяц уже есть — отказ (allowDuplicate=true — создать всё равно). " +
        "responsibleRef — ответственный (иначе 1С поставит пользователя OData). По умолчанию предпросмотр; создание — " +
        "confirm=true с operationId после согласия. Провести — write.document.post_document; выплата — РКО/ПП. " +
        'Пример: {"period":"2026-09","paymentMethod":"cash"}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        period: z.string().describe("Месяц начисления зарплаты: YYYY-MM"),
        date: dateField("Дата ведомости (по умолчанию — сейчас)").optional(),
        paymentMethod: z
          .enum(["cash", "bank"])
          .default("cash")
          .describe("cash — через кассу (ЧерезКассу), bank — через банк (ЧерезБанк)"),
        personRefs: z
          .array(z.string())
          .optional()
          .describe("Только эти физлица (Ref_Key); без него — все с остатком"),
        responsibleRef: z
          .string()
          .optional()
          .describe("Ref_Key пользователя-ответственного (Catalog_Пользователи)"),
        comment: z.string().max(500).optional().describe("Комментарий"),
        allowDuplicate: z
          .boolean()
          .optional()
          .describe("true — создать, даже если ведомость за месяц по ним уже есть"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.payroll.create_payroll_statement", async () => {
        const conn = ctx.db(a.database);
        const month = monthStart(a.period);
        const org = await resolveOrgOrDefault(conn, a.organization);
        const balances = await salaryBalances(conn, { orgKey: org.ref, month });
        if (!balances)
          throw new InputError(
            "Регистр «Взаиморасчёты с работниками организаций» не опубликован в OData — остаток к выплате взять неоткуда.",
          );
        const owed = [...byPerson(balances, a.personRefs).entries()].filter(([, c]) => c > 0);
        if (!owed.length)
          throw new InputError(
            `Нечего выплачивать за ${monthLabel(month)}: остаток к выплате в 1С (регистр «Взаиморасчёты с работниками организаций») равен 0 или отрицателен. Проверьте, проведены ли начисление и удержания/ЕП (read.payroll.check_month).`,
          );
        const notes: string[] = [];
        duplicateGuard(
          await sameMonth(conn, STATEMENT, "ПериодНачисленияЗарплаты", month, org.ref),
          "Зарплата",
          new Set(owed.map(([p]) => p)),
          "Ведомость",
          a.allowDuplicate,
          notes,
        );
        const names = await personNames(
          conn,
          owed.map(([p]) => p),
        );
        const total = owed.reduce((s, [, c]) => s + c, 0);
        notes.unshift(
          `Суммы — остаток к выплате за ${monthLabel(month)} из регистра 1С «Взаиморасчёты с работниками организаций»: ` +
            owed.map(([p, c]) => `${cleanName(names.get(p) ?? p)} — ${fmt(c)}`).join("; ") +
            `. Итого ${fmt(total)}.`,
        );
        const responsible = await responsibleFields(conn, a.responsibleRef, notes);
        notes.push(
          "Ведомость сама остаток не уменьшает — его гасит выплата (РКО или платёжное поручение по ведомости). " +
            "Проведение — write.document.post_document отдельным согласием.",
        );
        const prepared = await prepareDocument(conn, {
          organization: org.name,
          entitySet: STATEMENT,
          date: a.date,
          fields: {
            Организация_Key: org.ref,
            ПериодНачисленияЗарплаты: month,
            СпособВыплаты: a.paymentMethod === "bank" ? "ЧерезБанк" : "ЧерезКассу",
            СпособРасчетаСуммКВыплате: "ЗарплатаЗаМесяц",
            ПроцентВыплаты: 100,
            РазмерОкругления: 1,
            СуммаДокумента: fromCents(total),
            ...responsible,
            ...(a.comment ? { Комментарий: a.comment } : {}),
          },
          tables: {
            Зарплата: owed.map(([p, c]) => ({
              Физлицо_Key: p,
              Сумма: fromCents(c),
              СуммаКВыплате: fromCents(c),
              ДепонированнаяСумма: 0,
              ВыплаченностьЗарплаты: "Выплачено",
              Авторасчет: false,
            })),
          },
        });
        return createOrPreview(conn, STATEMENT, prepared.payload, a.confirm ?? false, [
          ...notes,
          ...prepared.notes,
        ]);
      }),
  );

  server.registerTool(
    "write.payroll.create_fund_transfer",
    {
      title: "Перечисление в фонды (ОПВ / СО / ЕП) из остатка или расчёта 1С",
      description:
        "Казахстан. Создаёт НЕПРОВЕДЁННЫЙ документ перечисления в фонды за месяц: fund=opv — «ОПВ перечисление в " +
        "фонды» (kind: opv, opvr, oppv), fund=so — «СО перечисление в фонды» (kind: so, vosms, oosms), fund=ep — " +
        "«ЕП перечисление в фонды». Строки (физлицо, сумма) MCP заполняет из 1С: по умолчанию — остаток к " +
        "перечислению за месяц (регистр «… расчёты с фондами», ВидПлатежа «Налог»), с basisRef — строки " +
        "проведённого расчёта (удержания, СН/СО или ЕП). Сам MCP суммы не считает. ВАЖНО: долг перед фондом гасит " +
        "платёжное поручение исходящее — уже существующая команда write.document.create_document " +
        "(Document_ПлатежноеПоручениеИсходящее, ВидОперации «ПеречислениеПенсионныхВзносов» / " +
        "«ПеречислениеСоциальныхОтчислений» / «ПеречислениеЕдиногоПлатежа»); сам документ перечисления остаток в " +
        "опубликованных регистрах не уменьшает (проверено для ЕП). Перечисление за месяц по тем же физлицам уже " +
        "есть — отказ (allowDuplicate=true). По умолчанию предпросмотр; создание — confirm=true с operationId. " +
        'Пример: {"fund":"ep","period":"2026-09"}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        fund: z
          .enum(["opv", "so", "ep"])
          .describe("opv — пенсионные взносы, so — СО и ОСМС, ep — единый платёж"),
        kind: z
          .enum(["opv", "opvr", "oppv", "so", "vosms", "oosms", "ep"])
          .optional()
          .describe(
            "Вид взноса: для opv — opv/opvr/oppv (по умолчанию opv), для so — so/vosms/oosms (по умолчанию so)",
          ),
        period: z
          .string()
          .optional()
          .describe("Месяц налогового периода YYYY-MM (с basisRef — по умолчанию его период)"),
        basisRef: z
          .string()
          .optional()
          .describe(
            "Ref_Key проведённого расчёта (удержания — opv/vosms, СН/СО — so/opvr/oppv/oosms, ЕП — ep): строки из него",
          ),
        counterpartyRef: z
          .string()
          .optional()
          .describe(
            "Получатель (контрагент-фонд); без него — из последнего проведённого перечисления того же вида",
          ),
        date: dateField("Дата документа (по умолчанию — сейчас)").optional(),
        personRefs: z.array(z.string()).optional().describe("Только эти физлица (Ref_Key)"),
        responsibleRef: z
          .string()
          .optional()
          .describe("Ref_Key пользователя-ответственного (Catalog_Пользователи)"),
        comment: z.string().max(500).optional().describe("Комментарий"),
        allowDuplicate: z
          .boolean()
          .optional()
          .describe("true — создать, даже если перечисление за месяц по ним уже есть"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.payroll.create_fund_transfer", async () => {
        const conn = ctx.db(a.database);
        const t = TRANSFERS[a.fund];
        const kind = a.kind ?? t.defaultKind;
        if (!(kind in t.kinds))
          throw new InputError(
            `kind=${kind} не относится к fund=${a.fund}: допустимо ${Object.keys(t.kinds).join(", ")}.`,
          );
        const fund = PAYROLL_FUNDS[kind]!;
        const org = await resolveOrgOrDefault(conn, a.organization);
        const notes: string[] = [];
        let month = a.period ? monthStart(a.period) : undefined;
        let sums = new Map<string, number>();
        let source: string;
        if (a.basisRef) {
          const b = TRANSFER_BASIS[kind]!;
          const ref = guidOf(a.basisRef);
          let basis: ODataEntity;
          try {
            basis = await conn.client.getEntity(`${b.entitySet}(guid'${ref}')?$format=json`);
          } catch {
            throw new InputError(
              `basisRef=${ref}: не найден ${PAYROLL_SUM_DOCS[b.entitySet]?.title ?? b.entitySet} — для ${fund.title} основанием служит этот документ.`,
            );
          }
          if (basis["DeletionMark"] === true || basis["Posted"] !== true)
            throw new InputError(
              "Основание должно быть проведённым и не помеченным на удаление (суммы — результат 1С).",
            );
          if (realRef(basis["Организация_Key"]) && basis["Организация_Key"] !== org.ref)
            throw new InputError("Основание другой организации.");
          month ??= monthStart(String(basis["ПериодРегистрации"] ?? ""));
          const only = a.personRefs?.length ? new Set(a.personRefs.map(guidOf)) : undefined;
          for (const r of (basis[b.table] as Array<Record<string, unknown>> | undefined) ?? []) {
            const p = personOf(r);
            const rm = r["МесяцНалоговогоПериода"];
            if (!p || (only && !only.has(p))) continue;
            if (
              typeof rm === "string" &&
              rm.slice(0, 7) !== month.slice(0, 7) &&
              rm !== "0001-01-01T00:00:00"
            )
              continue;
            sums.set(p, (sums.get(p) ?? 0) + toCents(r[b.field]));
          }
          source = `строки ${b.table}.${b.field} проведённого документа «${PAYROLL_SUM_DOCS[b.entitySet]?.title ?? b.entitySet}» № ${String(basis["Number"] ?? "")}`;
          notes.push(
            "ДокументОснование в OData опубликован как ссылка на «Расчёт пени ОПВ и СО» — основание не записывается " +
              "(иначе получится битая ссылка); при необходимости укажите его в форме 1С.",
          );
        } else {
          if (!month) throw new InputError("Передайте period (YYYY-MM) или basisRef — проведённый расчёт.");
          const rows = await fundBalances(conn, fund, { orgKey: org.ref, month });
          if (!rows)
            throw new InputError(`Регистр ${fund.register} не опубликован в OData — остаток взять неоткуда.`);
          const other = rows.filter((r) => r.kind && r.kind !== "Налог");
          if (other.length)
            notes.push(
              `Пени/штрафы (${[...new Set(other.map((r) => r.kind))].join(", ")}) не включены — только ВидПлатежа «Налог».`,
            );
          sums = byPerson(
            rows.filter((r) => !r.kind || r.kind === "Налог"),
            a.personRefs,
          );
          source = `остаток к перечислению ${fund.title} за ${monthLabel(month)} из регистра 1С ${fund.register.replace("AccumulationRegister_", "")}`;
        }
        const owed = [...sums.entries()].filter(([, c]) => c > 0);
        if (!owed.length)
          throw new InputError(
            `Нечего перечислять по ${fund.title} за ${monthLabel(month)}: ${source} — сумма 0 или переплата. Проверьте read.payroll.get_fund_debts.`,
          );
        duplicateGuard(
          (await sameMonth(conn, t.entitySet, "ПериодРегистрации", month, org.ref)).filter(
            (d) => !t.kinds[kind] || d["ВидОперации"] === t.kinds[kind],
          ),
          t.table,
          new Set(owed.map(([p]) => p)),
          `Перечисление ${fund.title}`,
          a.allowDuplicate,
          notes,
        );
        const names = await personNames(
          conn,
          owed.map(([p]) => p),
        );
        const total = owed.reduce((s, [, c]) => s + c, 0);
        notes.unshift(
          `Суммы — ${source}: ` +
            owed.map(([p, c]) => `${cleanName(names.get(p) ?? p)} — ${fmt(c)}`).join("; ") +
            `. Итого ${fmt(total)}.`,
        );
        let counterparty = a.counterpartyRef ? guidOf(a.counterpartyRef) : undefined;
        if (!counterparty) {
          const { rows } = await fetchAll(
            conn.client,
            t.entitySet,
            {
              filter: and(cmp("Posted", "eq", "true"), cmp("Организация_Key", "eq", odataGuid(org.ref))),
              select: ["Number", "Date", "Контрагент_Key"],
              orderby: "Date desc",
            },
            conn.behavior.pageSize,
            50,
          );
          const prev = (rows as ODataEntity[]).find((r) => realRef(r["Контрагент_Key"]));
          if (prev) {
            counterparty = String(prev["Контрагент_Key"]);
            notes.push(
              `Получатель взят из перечисления № ${String(prev["Number"] ?? "")} от ${String(prev["Date"] ?? "").slice(0, 10)}.`,
            );
          } else
            notes.push(
              "Получатель (контрагент-фонд) не задан и прошлых перечислений нет — передайте counterpartyRef.",
            );
        }
        const responsible = await responsibleFields(conn, a.responsibleRef, notes);
        notes.push(
          `Долг перед фондом гасит платёжное поручение исходящее: write.document.create_document ` +
            `Document_ПлатежноеПоручениеИсходящее, ВидОперации «${t.paymentOperation}» (с согласия; проводится при ` +
            "Оплачено=true по выписке). Проведение этого документа — write.document.post_document отдельно.",
        );
        const row = (p: string, c: number): Record<string, string | number | boolean> => ({
          ...(t.composite ? { ФизЛицо: p, ФизЛицо_Type: PERSON_TYPE } : { ФизЛицо_Key: p }),
          ...(t.monthField ? { [t.monthField]: month! } : {}),
          Сумма: fromCents(c),
          ...(a.fund === "ep"
            ? {
                СуммаПлатежа: 0,
                ВключаетОПВ: true,
                ВключаетВОСМС: true,
                ВключаетИПН: true,
                ВключаетСО: true,
                ВключаетООСМС: true,
                ВключаетОПВР: true,
              }
            : {}),
        });
        const prepared = await prepareDocument(conn, {
          organization: org.name,
          entitySet: t.entitySet,
          date: a.date,
          fields: {
            Организация_Key: org.ref,
            ПериодРегистрации: month,
            ВидПлатежа: "Налог",
            СпособРасчетаСуммКПеречислению: "ПоЗадолженностиЗаМесяц",
            ...(t.kinds[kind] ? { ВидОперации: t.kinds[kind]! } : {}),
            ...(counterparty ? { Контрагент_Key: counterparty } : {}),
            СуммаДокумента: fromCents(total),
            ...responsible,
            ...(a.comment ? { Комментарий: a.comment } : {}),
          },
          tables: { [t.table]: owed.map(([p, c]) => row(p, c)) },
        });
        return createOrPreview(conn, t.entitySet, prepared.payload, a.confirm ?? false, [
          ...notes,
          ...prepared.notes,
        ]);
      }),
  );
}
