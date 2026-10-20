import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, odataGuid } from "../odata/query.js";
import { recorderFilter, resolveNames } from "../odata/accounting.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import type { ODataEntity } from "../types/odata.js";
import { dateField, databaseField, guard, ok, organizationField } from "./_shared.js";
import { PAYROLL_SUM_DOCS, checkPayrollSums } from "./payroll-sums.js";
import { getDocumentPostings } from "./registers.js";
import {
  FUND_KEYS,
  PAYROLL_FUNDS,
  PERSONS,
  byPerson,
  fromCents,
  fundBalances,
  monthLabel,
  monthLastDay,
  monthStart,
  personOf,
  realRef,
  salaryBalances,
  toCents,
  cleanName,
} from "./payroll-data.js";

/**
 * Проверка зарплатного месяца (Казахстан) и остатки к перечислению в фонды — только чтение. Суммы считает 1С
 * (форма документа «Заполнить»/«Рассчитать», проведение — бухгалтер в 1С); MCP сверяет результат: документы и
 * проведение, дубли периода, проведённые с нулями, сотрудники без начисления, база ЕП, строки ↔ движения,
 * что осталось выплатить и перечислить.
 */

const ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const WITHHOLDING = "Document_РасчетУдержанийРаботниковОрганизаций";
const EMPLOYER = "Document_РасчетСНиСО";
const EP = "Document_РасчетЕдиногоПлатежа";
const REFLECT = "Document_ОтражениеЗарплатыВРеглУчете";
const STATEMENT = "Document_ЗарплатаКВыплатеОрганизаций";
const EMPLOYEES = "Catalog_СотрудникиОрганизаций";
const EP_INCOME = "AccumulationRegister_ЕПСведенияОДоходах";
const EMPTY_DATE = "0001-01-01T00:00:00";

/** Документы месяца в порядке флоу и поле периода. */
export const MONTH_DOCS: ReadonlyArray<{ entitySet: string; periodField: string }> = [
  { entitySet: ACCRUAL, periodField: "ПериодРегистрации" },
  { entitySet: WITHHOLDING, periodField: "ПериодРегистрации" },
  { entitySet: EMPLOYER, periodField: "ПериодРегистрации" },
  { entitySet: EP, periodField: "ПериодРегистрации" },
  { entitySet: REFLECT, periodField: "ПериодРегистрации" },
  { entitySet: STATEMENT, periodField: "ПериодНачисленияЗарплаты" },
  { entitySet: "Document_ОПВПеречислениеВФонды", periodField: "ПериодРегистрации" },
  { entitySet: "Document_СОПеречислениеВФонды", periodField: "ПериодРегистрации" },
  { entitySet: "Document_ЕППеречислениеВФонды", periodField: "ПериодРегистрации" },
];

/** Строки документа ↔ движения регистра (сверка «как провела 1С»): таблица.поле → регистр.ресурс. */
export const MOVEMENT_CHECKS: Readonly<
  Record<string, Array<{ table: string; field: string; register: string; resource: string }>>
> = {
  [ACCRUAL]: [
    {
      table: "Начисления",
      field: "Результат",
      register: "AccumulationRegister_ВзаиморасчетыСРаботникамиОрганизаций",
      resource: "СуммаВзаиморасчетов",
    },
  ],
  [WITHHOLDING]: [
    { table: "ИсчисленныйОПВ", field: "Взнос", register: PAYROLL_FUNDS["opv"]!.register, resource: "Взнос" },
    {
      table: "ИсчисленныеВОСМС",
      field: "Взнос",
      register: PAYROLL_FUNDS["vosms"]!.register,
      resource: "Взнос",
    },
    { table: "ИсчисленныйИПН", field: "Налог", register: PAYROLL_FUNDS["ipn"]!.register, resource: "Налог" },
  ],
  [EMPLOYER]: [
    {
      table: "ИсчисленныеСО",
      field: "Отчисление",
      register: PAYROLL_FUNDS["so"]!.register,
      resource: "Отчисление",
    },
    {
      table: "ИсчисленныйОПВР",
      field: "Взнос",
      register: PAYROLL_FUNDS["opvr"]!.register,
      resource: "Взнос",
    },
    {
      table: "ИсчисленныеООСМС",
      field: "Отчисление",
      register: PAYROLL_FUNDS["oosms"]!.register,
      resource: "Отчисление",
    },
    {
      table: "ИсчисленныйОППВ",
      field: "Взнос",
      register: PAYROLL_FUNDS["oppv"]!.register,
      resource: "Взнос",
    },
  ],
  [EP]: [
    {
      table: "ИсчисленныйЕП",
      field: "СуммаПлатежа",
      register: PAYROLL_FUNDS["ep"]!.register,
      resource: "СуммаПлатежа",
    },
  ],
};

export interface MonthIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}

type Doc = ODataEntity;
const rowsOf = (d: Doc, table: string): Array<Record<string, unknown>> =>
  Array.isArray(d[table]) ? (d[table] as Array<Record<string, unknown>>) : [];
const live = (d: Doc) => d["DeletionMark"] !== true;
const posted = (d: Doc) => live(d) && d["Posted"] === true;
const no = (d: Doc) => `№ ${String(d["Number"] ?? "").replace(/^0+/, "") || "?"}`;
const sumField = (rows: Array<Record<string, unknown>>, f: string) =>
  rows.reduce((a, r) => a + toCents(r[f]), 0);

/** Физлица документа: все табличные части. */
function personsOf(d: Doc): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(d))
    if (Array.isArray(v))
      for (const r of v as Array<Record<string, unknown>>) {
        const p = personOf(r);
        if (p) out.add(p);
      }
  return out;
}

/** Ключи для поиска дублей периода: начисление — сотрудник + вид расчёта; перечисления — вид операции + физлицо. */
function duplicateKeys(entitySet: string, d: Doc): Set<string> {
  if (entitySet === ACCRUAL)
    return new Set(
      rowsOf(d, "Начисления").map(
        (r) => `${realRef(r["Сотрудник_Key"]) ?? personOf(r) ?? "?"}:${String(r["ВидРасчета_Key"] ?? "")}`,
      ),
    );
  const op = String(d["ВидОперации"] ?? "");
  return new Set([...personsOf(d)].map((p) => `${op}:${p}`));
}

/** Суммы документа по полям из реестра зарплатных документов: «Начисления.Результат» → 600 000. */
function docSums(entitySet: string, d: Doc): Record<string, number> {
  const spec = PAYROLL_SUM_DOCS[entitySet];
  const out: Record<string, number> = {};
  if (!spec) return out;
  for (const [table, fields] of Object.entries(spec.tables))
    for (const f of fields) {
      const c = sumField(rowsOf(d, table), f);
      if (c) out[`${table}.${f}`] = fromCents(c);
    }
  for (const f of spec.header ?? []) {
    const c = toCents(d[f]);
    if (c) out[f] = fromCents(c);
  }
  return out;
}

async function monthDocs(
  conn: Connection,
  entitySet: string,
  periodField: string,
  month: string,
  orgKey: string,
): Promise<Doc[] | undefined> {
  if (!(await conn.available()).has(entitySet)) return undefined;
  const { rows } = await fetchAll(
    conn.client,
    entitySet,
    {
      filter: and(
        cmp(periodField, "eq", `datetime'${month}'`),
        cmp("Организация_Key", "eq", odataGuid(orgKey)),
      ),
      orderby: "Date",
    },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  return rows as Doc[];
}

/** Сумма ресурса в движениях документа по регистру (по модулю; undefined — набор записей не опубликован). */
async function recorderTotal(
  conn: Connection,
  register: string,
  resource: string,
  entitySet: string,
  ref: string,
): Promise<number | undefined> {
  const set = `${register}_RecordType`;
  if (!(await conn.getMetadata()).entities.has(set)) return undefined;
  const { rows } = await fetchAll(
    conn.client,
    set,
    { filter: recorderFilter(entitySet, ref) },
    conn.behavior.pageSize,
    conn.behavior.analyticsMaxRows,
  );
  return Math.abs((rows as ODataEntity[]).reduce((a, r) => a + toCents(r[resource]), 0));
}

/** Работающие в месяце сотрудники организации (приём ≤ конца месяца, увольнения нет или ≥ начала). */
async function activeEmployees(
  conn: Connection,
  orgKey: string,
  month: string,
  lastDay: string,
): Promise<Array<{ ref: string; person?: string; name: string }> | undefined> {
  if (!(await conn.available()).has(EMPLOYEES)) return undefined;
  const { rows } = await fetchAll(
    conn.client,
    EMPLOYEES,
    {
      filter: and(
        cmp("DeletionMark", "eq", "false"),
        cmp("IsFolder", "eq", "false"),
        cmp("Организация_Key", "eq", odataGuid(orgKey)),
      ),
      select: ["Ref_Key", "Description", "Физлицо_Key", "ДатаПриемаНаРаботу", "ДатаУвольнения"],
    },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  const d = (v: unknown) => (typeof v === "string" && v !== EMPTY_DATE ? v.slice(0, 10) : undefined);
  return (rows as ODataEntity[])
    .filter((r) => {
      const hired = d(r["ДатаПриемаНаРаботу"]);
      const fired = d(r["ДатаУвольнения"]);
      return !!hired && hired <= lastDay && (!fired || fired >= month.slice(0, 10));
    })
    .map((r) => ({
      ref: String(r["Ref_Key"]),
      ...(realRef(r["Физлицо_Key"]) ? { person: String(r["Физлицо_Key"]) } : {}),
      name: String(r["Description"] ?? "").replace(/\.$/, ""),
    }));
}

/** Проверка месяца целиком; экспорт — для тестов и для подсказок записи. */
export async function checkMonth(
  conn: Connection,
  args: { organization?: string | undefined; period: string; movements?: boolean },
) {
  const month = monthStart(args.period);
  const lastDay = monthLastDay(args.period);
  const org = await resolveOrgOrDefault(conn, args.organization);
  const issues: MonthIssue[] = [];
  const docsBySet = new Map<string, Doc[]>();
  const notPublished: string[] = [];
  for (const { entitySet, periodField } of MONTH_DOCS) {
    const docs = await monthDocs(conn, entitySet, periodField, month, org.ref);
    if (docs === undefined) notPublished.push(entitySet);
    else docsBySet.set(entitySet, docs);
  }
  const title = (s: string) => PAYROLL_SUM_DOCS[s]?.title ?? s;

  // Проведение, нули, дубли.
  for (const [set, docs] of docsBySet) {
    for (const d of docs.filter(live)) {
      if (d["Posted"] !== true)
        issues.push({
          level: "info",
          code: "not_posted",
          message: `${title(set)} ${no(d)}: документ не проведён — суммы и проведение делает бухгалтер в форме 1С.`,
        });
      else if (checkPayrollSums(set, d)?.empty)
        issues.push({
          level: "error",
          code: "posted_zero",
          message: `${title(set)} ${no(d)}: документ проведён с пустыми или нулевыми суммами — движений нет. Откройте в 1С: «Заполнить»/«Рассчитать» и проведите заново (или отмените проведение и пометьте на удаление).`,
        });
    }
    const seen = new Map<string, Doc>();
    const dup = new Map<string, Set<string>>();
    for (const d of docs.filter(posted).filter((x) => !checkPayrollSums(set, x)?.empty)) {
      for (const k of duplicateKeys(set, d)) {
        const prev = seen.get(k);
        if (prev && prev !== d) {
          const s = dup.get(no(prev)) ?? new Set<string>();
          s.add(no(d));
          dup.set(no(prev), s);
        } else seen.set(k, d);
      }
    }
    for (const [first, others] of dup)
      issues.push({
        level: "warning",
        code: "duplicate_period",
        message: `${title(set)}: ${first} и ${[...others].join(", ")} проведены за ${monthLabel(month)} по тем же работникам${set === ACCRUAL ? " и видам расчёта" : ""} — возможен двойной учёт.`,
      });
  }

  // ЕП и классический режим за один месяц по одному физлицу.
  const postedPersons = (s: string) =>
    new Set((docsBySet.get(s) ?? []).filter(posted).flatMap((d) => [...personsOf(d)]));
  const epPersons = postedPersons(EP);
  const classic = new Set([...postedPersons(WITHHOLDING), ...postedPersons(EMPLOYER)]);
  const both = [...epPersons].filter((p) => classic.has(p));

  // Сотрудники без начисления.
  const accrualDocs = (docsBySet.get(ACCRUAL) ?? []).filter(posted);
  const accruedEmployees = new Set(
    accrualDocs.flatMap((d) => rowsOf(d, "Начисления").map((r) => realRef(r["Сотрудник_Key"]) ?? "")),
  );
  const accruedPersons = new Set(accrualDocs.flatMap((d) => [...personsOf(d)]));
  const employees = await activeEmployees(conn, org.ref, month, lastDay);
  const withoutAccrual = (employees ?? []).filter(
    (e) => !accruedEmployees.has(e.ref) && !(e.person && accruedPersons.has(e.person)),
  );
  if (withoutAccrual.length)
    issues.push({
      level: "warning",
      code: "employee_without_accrual",
      message: `Работают в ${monthLabel(month)}, но нет проведённого начисления: ${withoutAccrual.map((e) => e.name).join(", ")}.`,
    });

  // База ЕП: доход из начисления (ЕП сведения о доходах) = облагаемая база в расчёте ЕП.
  const epDocs = (docsBySet.get(EP) ?? []).filter(posted);
  const epBase: Array<{ person: string; income: number; base: number }> = [];
  if (epDocs.length && (await conn.getMetadata()).entities.has(`${EP_INCOME}_RecordType`)) {
    const { rows } = await fetchAll(
      conn.client,
      `${EP_INCOME}_RecordType`,
      {
        filter: and(
          cmp("ПериодРегистрации", "eq", `datetime'${month}'`),
          cmp("Организация_Key", "eq", odataGuid(org.ref)),
        ),
      },
      conn.behavior.pageSize,
      conn.behavior.analyticsMaxRows,
    );
    const income = new Map<string, number>();
    for (const r of rows as ODataEntity[]) {
      const p = personOf(r);
      if (p && r["Active"] !== false) income.set(p, (income.get(p) ?? 0) + toCents(r["СуммаДохода"]));
    }
    const base = new Map<string, number>();
    for (const d of epDocs)
      for (const r of rowsOf(d, "ИсчисленныйЕП")) {
        const p = personOf(r);
        if (p) base.set(p, (base.get(p) ?? 0) + toCents(r["ОблагаемаяБаза"]));
      }
    for (const p of new Set([...income.keys(), ...base.keys()]))
      epBase.push({ person: p, income: income.get(p) ?? 0, base: base.get(p) ?? 0 });
  }

  // Строки документов ↔ движения.
  const movements: Array<{ document: string; check: string; lines: number; movements: number }> = [];
  if (args.movements !== false) {
    for (const [set, checks] of Object.entries(MOVEMENT_CHECKS))
      for (const d of (docsBySet.get(set) ?? []).filter(posted))
        for (const c of checks) {
          const lines = Math.abs(sumField(rowsOf(d, c.table), c.field));
          const moved = await recorderTotal(conn, c.register, c.resource, set, String(d["Ref_Key"]));
          if (moved === undefined || (lines === 0 && moved === 0)) continue;
          movements.push({
            document: `${title(set)} ${no(d)}`,
            check: `${c.table}.${c.field} ↔ ${c.register.replace("AccumulationRegister_", "")}.${c.resource}`,
            lines: fromCents(lines),
            movements: fromCents(moved),
          });
        }
    for (const d of (docsBySet.get(REFLECT) ?? []).filter(posted)) {
      const lines = Math.abs(sumField(rowsOf(d, "ОтражениеВУчете"), "Сумма"));
      try {
        const p = await getDocumentPostings(conn, REFLECT, String(d["Ref_Key"]));
        movements.push({
          document: `${title(REFLECT)} ${no(d)}`,
          check: "ОтражениеВУчете.Сумма ↔ проводки (Дт)",
          lines: fromCents(lines),
          movements: Math.abs(Number(p.debitTotal ?? 0)),
        });
      } catch {
        /* проводки не опубликованы — пропуск */
      }
    }
  }
  for (const m of movements)
    if (Math.round(m.lines * 100) !== Math.round(m.movements * 100))
      issues.push({
        level: "warning",
        code: "lines_vs_movements",
        message: `${m.document}: ${m.check} — в строках ${m.lines}, в движениях ${m.movements}. Перепроведите документ в 1С или проверьте ручные правки.`,
      });

  // Что осталось выплатить и перечислить (остатки регистров 1С за месяц).
  const salary = await salaryBalances(conn, { orgKey: org.ref, month });
  const toPay = salary ? byPerson(salary) : new Map<string, number>();
  const funds: Array<{ fund: string; title: string; amount: number }> = [];
  for (const key of FUND_KEYS) {
    const f = PAYROLL_FUNDS[key]!;
    const rows = await fundBalances(conn, f, { orgKey: org.ref, month });
    if (!rows) continue;
    const c = rows.reduce((a, r) => a + r.cents, 0);
    if (c) funds.push({ fund: key, title: f.title, amount: fromCents(c) });
  }

  // Имена физлиц — одним запросом.
  const refs = new Set<string>([...toPay.keys(), ...both, ...epBase.map((e) => e.person)]);
  const names =
    refs.size && (await conn.available()).has(PERSONS)
      ? await resolveNames(conn, PERSONS, refs)
      : new Map<string, string>();
  const nm = (p: string) => cleanName(names.get(p) ?? p);
  if (both.length)
    issues.push({
      level: "warning",
      code: "ep_and_classic",
      message: `За ${monthLabel(month)} проведены и расчёт ЕП, и классические удержания/СН-СО по: ${both.map(nm).join(", ")} — возможно задвоение.`,
    });
  for (const e of epBase)
    if (e.income !== e.base)
      issues.push({
        level: "warning",
        code: "ep_base",
        message: `База ЕП ${nm(e.person)}: доход из начисления ${fromCents(e.income)}, облагаемая база в расчёте ЕП ${fromCents(e.base)}. Проверьте расчёт ЕП в форме 1С (порядок исчисления базы — уточнить у «Налогового консультанта»).`,
      });
  const negative = [...toPay.entries()].filter(([, c]) => c < 0);
  for (const [p, c] of negative)
    issues.push({
      level: "warning",
      code: "overpaid",
      message: `${nm(p)}: выплачено больше начисленного за ${monthLabel(month)} на ${fromCents(-c)}.`,
    });
  const toPayList = [...toPay.entries()]
    .filter(([, c]) => c > 0)
    .map(([p, c]) => ({ person: nm(p), ref: p, amount: fromCents(c) }));

  const level = issues.some((i) => i.level === "error")
    ? "error"
    : issues.some((i) => i.level === "warning")
      ? "warning"
      : "ok";
  const documents = MONTH_DOCS.filter((m) => docsBySet.has(m.entitySet)).map((m) => ({
    entitySet: m.entitySet,
    title: title(m.entitySet),
    documents: (docsBySet.get(m.entitySet) ?? []).map((d) => ({
      ref: String(d["Ref_Key"]),
      number: String(d["Number"] ?? ""),
      date: String(d["Date"] ?? "").slice(0, 10),
      posted: d["Posted"] === true,
      deletionMark: d["DeletionMark"] === true,
      sums: docSums(m.entitySet, d),
    })),
  }));
  return {
    database: conn.cfg.name,
    organization: org.name,
    period: monthLabel(month),
    status: level,
    issues,
    documents,
    employees:
      employees === undefined
        ? undefined
        : { active: employees.length, withoutAccrual: withoutAccrual.length },
    epBase: epBase.map((e) => ({
      person: nm(e.person),
      income: fromCents(e.income),
      base: fromCents(e.base),
    })),
    movements,
    toPay: {
      total: fromCents(toPayList.reduce((a, r) => a + Math.round(r.amount * 100), 0)),
      people: toPayList,
      ...(salary === undefined
        ? { note: "Регистр «Взаиморасчёты с работниками организаций» не опубликован." }
        : {}),
    },
    toTransfer: funds,
    ...(notPublished.length ? { notPublished } : {}),
    note:
      "Суммы считает 1С: «Заполнить»/«Рассчитать» и «Провести» бухгалтер делает в форме документа. Остатки — из " +
      "регистров 1С на текущий момент. Ведомость — write.payroll.create_payroll_statement, перечисление в фонды — " +
      "write.payroll.create_fund_transfer; долг перед фондами гасит платёжное поручение исходящее.",
  };
}

export function registerPayrollMonthTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.payroll.check_month",
    {
      title: "Проверка зарплатного месяца",
      description:
        "Казахстан. Проверяет зарплату за месяц по данным 1С (только чтение): документы месяца и их проведение " +
        "(начисление, удержания, СН/СО, ЕП, отражение, ведомость, перечисления ОПВ/СО/ЕП), дубли периода, проведённые " +
        "с пустыми суммами, работающих сотрудников без начисления, ЕП вместе с классическими удержаниями, базу ЕП " +
        "(доход из начисления = облагаемая база в расчёте ЕП), строки документов ↔ движения регистров (проводки " +
        "отражения), что осталось выплатить работникам и перечислить в фонды. Суммы не считает — их считает 1С в форме. " +
        'Пример: {"period":"2026-09"}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        period: z.string().describe("Месяц: YYYY-MM (напр. 2026-09) или любая дата месяца"),
        movements: z
          .boolean()
          .default(true)
          .describe("Сверять строки проведённых документов с движениями регистров (дольше)"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          period: z.string(),
          status: z.enum(["ok", "warning", "error"]),
          issues: z.array(z.object({ level: z.string(), code: z.string(), message: z.string() })),
        })
        .passthrough(),
    },
    ({ database, organization, period, movements }) =>
      guard("read.payroll.check_month", async () =>
        ok(await checkMonth(ctx.db(database), { organization, period, movements })),
      ),
  );

  server.registerTool(
    "read.payroll.get_fund_debts",
    {
      title: "Остатки к перечислению в фонды и бюджет",
      description:
        "Казахстан. Сколько осталось перечислить по ОПВ, ВОСМС, СО, ООСМС, ОПВР, ОППВ, ЕП и ИПН — остатки регистров " +
        "1С «… расчёты с фондами» и «ИПН расчёты с бюджетом» (их пишет проведение расчётов, гасит — платёжное " +
        "поручение). Положительная сумма — долг организации, отрицательная — переплата. Фильтры: period (месяц " +
        "налогового периода), fund, asOf (на конец даты). По месяцам и физлицам.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        period: z.string().optional().describe("Месяц налогового периода YYYY-MM; без него — все месяцы"),
        fund: z
          .enum(FUND_KEYS)
          .optional()
          .describe("opv, vosms, so, oosms, opvr, oppv, ep, ipn; без него — все"),
        asOf: dateField("Остаток на конец даты (без параметра — текущий)").optional(),
        byPerson: z.boolean().default(true).describe("Показать физлиц"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          totalOwed: z.number(),
          funds: z.array(z.object({ fund: z.string(), title: z.string(), total: z.number() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, period, fund, asOf, byPerson: withPeople }) =>
      guard("read.payroll.get_fund_debts", async () => {
        const conn = ctx.db(database);
        const org = organization ? await resolveOrgOrDefault(conn, organization) : undefined;
        const month = period ? monthStart(period) : undefined;
        const keys = fund ? [fund] : FUND_KEYS;
        const notPublished: string[] = [];
        const out: Array<{
          fund: string;
          title: string;
          total: number;
          months: Array<{ month: string; amount: number }>;
          other?: Array<{ kind: string; amount: number }>;
          people?: Array<{ person: string; ref: string; month: string; amount: number }>;
        }> = [];
        const people = new Set<string>();
        const raw = new Map<string, Awaited<ReturnType<typeof fundBalances>>>();
        for (const k of keys) {
          const f = PAYROLL_FUNDS[k]!;
          const rows = await fundBalances(conn, f, { orgKey: org?.ref, month, asOf });
          if (!rows) {
            notPublished.push(f.register);
            continue;
          }
          raw.set(k, rows);
          rows.forEach((r) => r.person && people.add(r.person));
        }
        const names =
          withPeople !== false && people.size && (await conn.available()).has(PERSONS)
            ? await resolveNames(conn, PERSONS, people)
            : new Map<string, string>();
        let total = 0;
        for (const [k, rows] of raw) {
          const tax = rows!.filter((r) => !r.kind || r.kind === "Налог");
          const other = rows!.filter((r) => r.kind && r.kind !== "Налог");
          const months = new Map<string, number>();
          tax.forEach((r) => months.set(r.month, (months.get(r.month) ?? 0) + r.cents));
          const c = tax.reduce((a, r) => a + r.cents, 0);
          if (!c && !other.length) continue;
          total += c;
          const otherByKind = new Map<string, number>();
          other.forEach((r) => otherByKind.set(r.kind, (otherByKind.get(r.kind) ?? 0) + r.cents));
          out.push({
            fund: k,
            title: PAYROLL_FUNDS[k]!.title,
            total: fromCents(c),
            months: [...months.entries()]
              .filter(([, v]) => v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([m, v]) => ({ month: monthLabel(m), amount: fromCents(v) })),
            ...(other.length
              ? { other: [...otherByKind.entries()].map(([kind, v]) => ({ kind, amount: fromCents(v) })) }
              : {}),
            ...(withPeople !== false
              ? {
                  people: tax
                    .sort((a, b) => a.month.localeCompare(b.month))
                    .map((r) => ({
                      person: cleanName(names.get(r.person) ?? r.person),
                      ref: r.person,
                      month: monthLabel(r.month),
                      amount: fromCents(r.cents),
                    })),
                }
              : {}),
          });
        }
        return ok({
          database: conn.cfg.name,
          ...(org ? { organization: org.name } : {}),
          ...(month ? { period: monthLabel(month) } : {}),
          ...(asOf ? { asOf } : {}),
          totalOwed: fromCents(total),
          funds: out,
          ...(notPublished.length ? { notPublished } : {}),
          note:
            "Остатки посчитала 1С проведением расчётов (удержания, СН/СО, ЕП). Долг гасит платёжное поручение " +
            "исходящее; документ «Перечисление в фонды» в опубликованных регистрах долг не уменьшает (проверено для ЕП). " +
            "Пени и штрафы (ВидПлатежа не «Налог») — в other, в totalOwed не входят.",
        });
      }),
  );
}
