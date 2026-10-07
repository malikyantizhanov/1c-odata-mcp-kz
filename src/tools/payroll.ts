import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, organizationField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, contains, odataGuid } from "../odata/query.js";
import { resolveNames } from "../odata/accounting.js";
import { CATALOGS } from "../config/mapping.js";
import type { ODataEntity } from "../types/odata.js";

/**
 * Зарплата в 1С:Бухгалтерии для Казахстана: сотрудники организаций, начисления и расчёты с работниками.
 * Долг по зарплате берётся из регистра «Взаиморасчёты с работниками организаций» (остаток к выплате
 * по физлицу и месяцу), а не из сальдо счёта 3350, — так он виден по каждому человеку.
 */
const EMPLOYEES = ["Catalog_СотрудникиОрганизаций"] as const;
const SETTLEMENTS = ["AccumulationRegister_ВзаиморасчетыСРаботникамиОрганизаций"] as const;
const ACCRUALS = ["Document_НачислениеЗарплатыРаботникамОрганизаций"] as const;
const ACCRUAL_KINDS = ["ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций"] as const;
const EMPTY_DATE = "0001-01-01T00:00:00";

const toCents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const fromCents = (c: number): number => c / 100;
const day = (v: unknown): string | undefined => (typeof v === "string" && v !== EMPTY_DATE ? v.slice(0, 10) : undefined);

/** Организация для фильтра: указана — по названию; нет — без фильтра (все организации базы). */
async function orgFilterKey(conn: Connection, organization: string | undefined): Promise<{ key?: string; name?: string }> {
  if (!organization) return {};
  const o = await resolveOrgOrDefault(conn, organization);
  return { key: o.ref, name: o.name };
}

export function registerPayrollTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.payroll.list_employees",
    {
      title: "Сотрудники организации",
      description:
        "Сотрудники организаций (Казахстан: справочник «Сотрудники организаций»): ФИО, физлицо, даты приёма и " +
        "увольнения. По умолчанию — только работающие; includeDismissed=true — со уволенными. query — поиск по ФИО.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        query: z.string().max(200).default("").describe("Часть ФИО; пусто — все"),
        includeDismissed: z.boolean().default(false).describe("true — показать и уволенных"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          count: z.number(),
          truncated: z.boolean(),
          employees: z.array(z.object({ name: z.string(), ref: z.string() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, query, includeDismissed }) =>
      guard("read.payroll.list_employees", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, EMPLOYEES, "Справочник «Сотрудники организаций»");
        const org = await orgFilterKey(conn, organization);
        const { rows, truncated } = await fetchAll(
          conn.client,
          set,
          {
            filter: and(
              cmp("DeletionMark", "eq", "false"),
              cmp("IsFolder", "eq", "false"),
              org.key ? cmp("Организация_Key", "eq", odataGuid(org.key)) : undefined,
              query.trim() ? contains("Description", query.trim()) : undefined,
            ),
            select: ["Ref_Key", "Description", "Физлицо_Key", "ДатаПриемаНаРаботу", "ДатаУвольнения"],
            orderby: "Description",
          },
          conn.behavior.pageSize,
          conn.behavior.maxRows,
        );
        const today = new Date().toISOString().slice(0, 10);
        const employees = rows
          .map((r) => ({
            name: String(r["Description"] ?? "").replace(/\.$/, ""),
            ref: String(r["Ref_Key"]),
            personRef: String(r["Физлицо_Key"] ?? ""),
            hired: day(r["ДатаПриемаНаРаботу"]),
            dismissed: day(r["ДатаУвольнения"]),
          }))
          .filter((e) => includeDismissed || !e.dismissed || e.dismissed > today);
        return ok({ database: conn.cfg.name, ...(org.name ? { organization: org.name } : {}), count: employees.length, truncated, employees });
      }),
  );

  server.registerTool(
    "read.payroll.get_salary_debts",
    {
      title: "Долги по зарплате",
      description:
        "Задолженность по зарплате перед каждым работником (Казахстан: остаток регистра «Взаиморасчёты с " +
        "работниками организаций» — начислено к выплате минус выплачено). Положительная сумма — организация " +
        "должна работнику, отрицательная — выплачено больше начисленного. asOf — на конец даты (без него — " +
        "текущий остаток); byMonth=true — с разбивкой по месяцам, за которые долг.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        asOf: dateField("Дата остатка — на конец этой даты (без параметра — текущий)").optional(),
        byMonth: z.boolean().default(false).describe("true — показать месяцы, за которые числится долг"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          totalOwed: z.number(),
          count: z.number(),
          people: z.array(z.object({ person: z.string(), ref: z.string(), amount: z.number() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, asOf, byMonth }) =>
      guard("read.payroll.get_salary_debts", async () => {
        const conn = ctx.db(database);
        const reg = await requireEntity(conn, SETTLEMENTS, "Регистр «Взаиморасчёты с работниками организаций»");
        const org = await orgFilterKey(conn, organization);
        const path = asOf ? `${reg}/Balance(Period=datetime'${asOf}T23:59:59')` : `${reg}/Balance`;
        const { rows } = await fetchAll(
          conn.client,
          path,
          { filter: org.key ? cmp("Организация_Key", "eq", odataGuid(org.key)) : undefined },
          conn.behavior.pageSize,
          conn.behavior.analyticsMaxRows,
        );
        const byPerson = new Map<string, { cents: number; months: Map<string, number> }>();
        for (const r of rows) {
          const ref = String(r["Физлицо_Key"] ?? "");
          const cents = toCents(r["СуммаВзаиморасчетовBalance"]);
          if (!ref || !cents) continue;
          const acc = byPerson.get(ref) ?? { cents: 0, months: new Map<string, number>() };
          acc.cents += cents;
          const month = String(r["ПериодВзаиморасчетов"] ?? "").slice(0, 7);
          acc.months.set(month, (acc.months.get(month) ?? 0) + cents);
          byPerson.set(ref, acc);
        }
        const names = await resolveNames(conn, (await requireEntity(conn, CATALOGS.physicalPersons, "Справочник «Физические лица»")), byPerson.keys());
        const people = [...byPerson.entries()]
          .filter(([, v]) => v.cents !== 0)
          .map(([ref, v]) => ({
            person: (names.get(ref) ?? ref).replace(/\.$/, ""),
            ref,
            amount: fromCents(v.cents),
            ...(byMonth
              ? { months: [...v.months.entries()].filter(([, c]) => c !== 0).sort().map(([month, c]) => ({ month, amount: fromCents(c) })) }
              : {}),
          }))
          .sort((a, b) => b.amount - a.amount);
        const owed = people.filter((p) => p.amount > 0).reduce((s, p) => s + toCents(p.amount), 0);
        return ok({
          database: conn.cfg.name,
          ...(org.name ? { organization: org.name } : {}),
          ...(asOf ? { asOf } : {}),
          totalOwed: fromCents(owed),
          count: people.length,
          people,
        });
      }),
  );

  server.registerTool(
    "read.payroll.get_accruals",
    {
      title: "Начисления зарплаты за период",
      description:
        "Начисленная зарплата по проведённым документам «Начисление зарплаты работникам организаций» " +
        "(Казахстан) за месяцы регистрации from..to: итог, по сотрудникам и видам начислений. Суммы — начисления " +
        "до удержаний (ИПН, ОПВ и др. сюда не входят).",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        from: dateField("Начало периода (месяц регистрации)"),
        to: dateField("Конец периода (месяц регистрации)"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          period: z.object({ from: z.string(), to: z.string() }),
          total: z.number(),
          documents: z.number(),
          employees: z.array(z.object({ employee: z.string(), ref: z.string(), total: z.number() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, from, to }) =>
      guard("read.payroll.get_accruals", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, ACCRUALS, "Документ «Начисление зарплаты работникам организаций»");
        const org = await orgFilterKey(conn, organization);
        const { rows: docs } = await fetchAll(
          conn.client,
          set,
          {
            filter: and(
              cmp("Posted", "eq", "true"),
              cmp("ПериодРегистрации", "ge", `datetime'${from.slice(0, 7)}-01T00:00:00'`),
              cmp("ПериодРегистрации", "le", `datetime'${to}T23:59:59'`),
              org.key ? cmp("Организация_Key", "eq", odataGuid(org.key)) : undefined,
            ),
            select: ["Ref_Key", "Number", "ПериодРегистрации", "Начисления"],
          },
          conn.behavior.pageSize,
          conn.behavior.analyticsMaxRows,
        );
        const perEmployee = new Map<string, { cents: number; kinds: Map<string, number> }>();
        let total = 0;
        for (const d of docs) {
          for (const line of (d["Начисления"] as ODataEntity[] | undefined) ?? []) {
            const ref = String(line["Сотрудник_Key"] ?? "");
            const kind = String(line["ВидРасчета_Key"] ?? "");
            const cents = toCents(line["Результат"]);
            if (!ref || !cents) continue;
            total += cents;
            const acc = perEmployee.get(ref) ?? { cents: 0, kinds: new Map<string, number>() };
            acc.cents += cents;
            acc.kinds.set(kind, (acc.kinds.get(kind) ?? 0) + cents);
            perEmployee.set(ref, acc);
          }
        }
        const employeeNames = await resolveNames(conn, (await requireEntity(conn, EMPLOYEES, "Справочник «Сотрудники организаций»")), perEmployee.keys());
        const kindRefs = new Set([...perEmployee.values()].flatMap((v) => [...v.kinds.keys()]));
        const kindSet = (await conn.available()).has(ACCRUAL_KINDS[0]) ? ACCRUAL_KINDS[0] : undefined;
        const kindNames = kindSet ? await resolveNames(conn, kindSet, kindRefs) : new Map<string, string>();
        const employees = [...perEmployee.entries()]
          .map(([ref, v]) => ({
            employee: (employeeNames.get(ref) ?? ref).replace(/\.$/, ""),
            ref,
            total: fromCents(v.cents),
            kinds: [...v.kinds.entries()].map(([k, c]) => ({ kind: kindNames.get(k) ?? k, amount: fromCents(c) })),
          }))
          .sort((a, b) => b.total - a.total);
        return ok({
          database: conn.cfg.name,
          ...(org.name ? { organization: org.name } : {}),
          period: { from, to },
          total: fromCents(total),
          documents: docs.length,
          employees,
        });
      }),
  );
}

