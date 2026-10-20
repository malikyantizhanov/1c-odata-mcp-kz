import type { Connection } from "../context.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, endOfDayBalancePeriod, odataGuid } from "../odata/query.js";
import type { ODataEntity } from "../types/odata.js";

/**
 * Данные зарплаты, которые уже посчитала 1С: остатки регистров «Взаиморасчёты с работниками организаций»,
 * «… расчёты с фондами» и «ИПН расчёты с бюджетом» (виртуальная таблица Balance). MCP суммы не считает —
 * только читает результат проведённых документов (решение пользователя: суммы считает 1С).
 */

export const EMPTY_REF = "00000000-0000-0000-0000-000000000000";
export const PERSONS = "Catalog_ФизическиеЛица";
export const SALARY_REGISTER = "AccumulationRegister_ВзаиморасчетыСРаботникамиОрганизаций";

export const realRef = (v: unknown): string | undefined =>
  typeof v === "string" && v && v !== EMPTY_REF ? v : undefined;
export const toCents = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : 0;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const fromCents = (c: number): number => c / 100;

/** Физлицо строки регистра/документа: ФизЛицо_Key, Физлицо_Key, ФизическоеЛицо_Key или составное ФизЛицо. */
export const personOf = (r: Record<string, unknown>): string | undefined =>
  realRef(r["ФизЛицо_Key"]) ??
  realRef(r["Физлицо_Key"]) ??
  realRef(r["ФизическоеЛицо_Key"]) ??
  (String(r["ФизЛицо_Type"] ?? PERSONS).endsWith(PERSONS) ? realRef(r["ФизЛицо"]) : undefined);

/** Месяц «2026-09» или любая дата месяца → начало месяца в формате 1С. */
export function monthStart(period: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?(?:T.*)?$/.exec(period.trim());
  if (!m) throw new InputError(`Месяц «${period}»: ожидается YYYY-MM (напр. 2026-09).`);
  return `${m[1]}-${m[2]}-01T00:00:00`;
}

/** Последний день месяца (YYYY-MM-DD). */
export function monthLastDay(period: string): string {
  const start = monthStart(period);
  const y = Number(start.slice(0, 4));
  const mo = Number(start.slice(5, 7));
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${start.slice(0, 8)}${String(last).padStart(2, "0")}`;
}

/** «2026-09-01T00:00:00» → «09.2026». */
export const monthLabel = (m: string): string => `${m.slice(5, 7)}.${m.slice(0, 4)}`;

export interface FundSpec {
  key: string;
  title: string;
  register: string;
  resource: string;
}

/** Регистры расчётов с фондами и бюджетом (Казахстан). Ключи — для get_fund_debts и create_fund_transfer. */
export const PAYROLL_FUNDS: Readonly<Record<string, FundSpec>> = {
  opv: { key: "opv", title: "ОПВ", register: "AccumulationRegister_ОПВРасчетыСФондами", resource: "Взнос" },
  vosms: {
    key: "vosms",
    title: "ВОСМС",
    register: "AccumulationRegister_ВОСМСРасчетыСФондами",
    resource: "Взнос",
  },
  so: { key: "so", title: "СО", register: "AccumulationRegister_СОРасчетыСФондами", resource: "Отчисление" },
  oosms: {
    key: "oosms",
    title: "ООСМС",
    register: "AccumulationRegister_ООСМСРасчетыСФондами",
    resource: "Отчисление",
  },
  opvr: {
    key: "opvr",
    title: "ОПВР",
    register: "AccumulationRegister_ОПВРРасчетыСФондами",
    resource: "Взнос",
  },
  oppv: {
    key: "oppv",
    title: "ОППВ",
    register: "AccumulationRegister_ОППВРасчетыСФондами",
    resource: "Взнос",
  },
  ep: {
    key: "ep",
    title: "ЕП",
    register: "AccumulationRegister_ЕПРасчетыСФондами",
    resource: "СуммаПлатежа",
  },
  ipn: { key: "ipn", title: "ИПН", register: "AccumulationRegister_ИПНРасчетыСБюджетом", resource: "Налог" },
};
export const FUND_KEYS = Object.keys(PAYROLL_FUNDS) as [string, ...string[]];

export interface BalanceRow {
  person: string;
  month: string;
  /** ВидПлатежа (Налог, ПениСам …); у взаиморасчётов с работниками — пусто. */
  kind: string;
  cents: number;
}

async function balanceRows(
  conn: Connection,
  register: string,
  resource: string,
  monthField: string,
  opts: { orgKey?: string | undefined; month?: string | undefined; asOf?: string | undefined },
): Promise<BalanceRow[] | undefined> {
  if (!(await conn.available()).has(register)) return undefined;
  const path = opts.asOf
    ? `${register}/Balance(Period=${endOfDayBalancePeriod(opts.asOf)})`
    : `${register}/Balance`;
  const { rows } = await fetchAll(
    conn.client,
    path,
    {
      filter: and(
        opts.orgKey ? cmp("Организация_Key", "eq", odataGuid(opts.orgKey)) : undefined,
        opts.month ? cmp(monthField, "eq", `datetime'${opts.month}'`) : undefined,
      ),
    },
    conn.behavior.pageSize,
    conn.behavior.analyticsMaxRows,
  );
  return (rows as ODataEntity[])
    .map((r) => ({
      person: personOf(r) ?? "",
      month: String(r[monthField] ?? ""),
      kind: String(r["ВидПлатежа"] ?? ""),
      cents: toCents(r[`${resource}Balance`]),
    }))
    .filter((r) => r.cents !== 0);
}

/** Остаток к перечислению по фонду (положительный — долг организации). undefined — регистр не опубликован. */
export function fundBalances(
  conn: Connection,
  fund: FundSpec,
  opts: { orgKey?: string | undefined; month?: string | undefined; asOf?: string | undefined },
): Promise<BalanceRow[] | undefined> {
  return balanceRows(conn, fund.register, fund.resource, "МесяцНалоговогоПериода", opts);
}

/** Остаток к выплате работникам (начислено − удержано − выплачено) по месяцу взаиморасчётов. */
export function salaryBalances(
  conn: Connection,
  opts: { orgKey?: string | undefined; month?: string | undefined; asOf?: string | undefined },
): Promise<BalanceRow[] | undefined> {
  return balanceRows(conn, SALARY_REGISTER, "СуммаВзаиморасчетов", "ПериодВзаиморасчетов", opts);
}

/** Сумма по физлицу (центы) — положительные остатки, отбор personRefs. */
export function byPerson(rows: BalanceRow[], personRefs?: string[]): Map<string, number> {
  const only = personRefs?.length ? new Set(personRefs.map((p) => p.replace(/[{}]/g, ""))) : undefined;
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.person || (only && !only.has(r.person))) continue;
    out.set(r.person, (out.get(r.person) ?? 0) + r.cents);
  }
  return out;
}

/** ФИО без точки в конце (так 1С хранит наименование физлица). */
export const cleanName = (s: string): string => s.trim().replace(/\.$/, "");
