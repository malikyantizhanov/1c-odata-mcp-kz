import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, contains, odataGuid } from "../odata/query.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { dateField, databaseField, guard, ok, organizationField } from "./_shared.js";
import { confirmField, createOrPreview } from "./write.js";
import { prepareDocument } from "./write-documents.js";
import { cleanName, fromCents, monthLabel, monthStart, realRef, toCents } from "./payroll-data.js";

/**
 * Отпускные (Казахстан, 1С:Бухгалтерия 3.0 для РК). Отдельного документа «Отпуск» в БК нет (проверено по
 * $metadata Aru Market): отпускные — документ «Начисление зарплаты работникам организаций» с видом расчёта
 * «Оплата отпуска» (ОплатаПоСреднемуОтп, способ расчёта ПоСреднемуЗаработкуДляОтпуска) в шапке и строках,
 * период отпуска — ДатаНачала/ДатаОкончания строки «Начисления». Компенсация — «Компенсация отпуска»
 * (КомпенсацияОтпускаБезУвольнения) и «Компенсация отпуска при увольнении» (КомпенсацияОтпуска).
 * Решение пользователя: суммы считает 1С. MCP создаёт НЕПРОВЕДЁННЫЙ документ (шапка, сотрудники, период отпуска)
 * без «Результат»; средний заработок и сумму считает 1С в форме («Рассчитать»), удержания ИПН/ОПВ/ВОСМС и
 * СН/СО/ОПВР/ООСМС (или ЕП) — расчётные документы месяца, тоже в 1С. Проведение — бухгалтер (post_document
 * документ с пустым «Результат» не проводит).
 */

export const ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
export const ACCRUAL_KINDS = "ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций";
const EMPLOYEES = "Catalog_СотрудникиОрганизаций";
const USERS = "Catalog_Пользователи";
const EMPTY_DATE = "0001-01-01T00:00:00";
/** Способ расчёта видов «по среднему для отпуска» — по нему узнаются и свои (непредопределённые) виды. */
export const VACATION_METHOD = "ПоСреднемуЗаработкуДляОтпуска";

/** Предопределённые виды расчёта отпуска в БК для РК. */
export const VACATION_KINDS = {
  vacation: { predefined: "ОплатаПоСреднемуОтп", title: "Оплата отпуска" },
  compensation: { predefined: "КомпенсацияОтпускаБезУвольнения", title: "Компенсация отпуска" },
  dismissal: { predefined: "КомпенсацияОтпуска", title: "Компенсация отпуска при увольнении" },
} as const;
export type VacationKind = keyof typeof VACATION_KINDS;

const GUID = /^[{']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[}']?$/i;
const guidOf = (v: string) => v.trim().replace(/[{}']/g, "");
const day = (v: unknown): string | undefined =>
  typeof v === "string" && v && v !== EMPTY_DATE ? v.slice(0, 10) : undefined;
const ruDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** Календарные дни периода включительно (только для показа; оплачиваемые дни и сумму считает 1С). */
export function calendarDays(start: string, end: string): number {
  const a = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const b = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Сдвиг начала месяца на n месяцев (n может быть отрицательным). */
export function shiftMonth(month: string, n: number): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00`;
}

interface KindRow {
  ref: string;
  name: string;
  predefined: string;
  method: string;
}

/** Виды расчёта «по среднему для отпуска» из плана видов расчёта (свои и предопределённые). */
export async function vacationKinds(conn: Connection): Promise<KindRow[]> {
  if (!(await conn.available()).has(ACCRUAL_KINDS))
    throw new InputError(
      `План видов расчёта ${ACCRUAL_KINDS} не опубликован в OData — вид «Оплата отпуска» взять неоткуда.`,
    );
  const { rows } = await fetchAll(
    conn.client,
    ACCRUAL_KINDS,
    {
      filter: cmp("DeletionMark", "eq", "false"),
      select: ["Ref_Key", "Description", "PredefinedDataName", "СпособРасчета"],
    },
    conn.behavior.pageSize,
    1000,
  );
  return (rows as ODataEntity[])
    .map((r) => ({
      ref: String(r["Ref_Key"]),
      name: String(r["Description"] ?? ""),
      predefined: String(r["PredefinedDataName"] ?? ""),
      method: String(r["СпособРасчета"] ?? ""),
    }))
    .filter(
      (k) =>
        k.method === VACATION_METHOD ||
        Object.values(VACATION_KINDS).some((v) => v.predefined === k.predefined),
    );
}

async function pickKind(conn: Connection, kind: VacationKind, calculationTypeRef?: string): Promise<KindRow> {
  const kinds = await vacationKinds(conn);
  if (calculationTypeRef) {
    const ref = guidOf(calculationTypeRef);
    const k = kinds.find((x) => x.ref === ref);
    if (!k)
      throw new InputError(
        `calculationTypeRef=${ref}: это не вид расчёта отпуска (способ «${VACATION_METHOD}») или он помечен на удаление. ` +
          `Доступны: ${kinds.map((x) => `${x.name} (${x.ref})`).join("; ") || "нет"}.`,
      );
    return k;
  }
  const want = VACATION_KINDS[kind].predefined;
  const k = kinds.find((x) => x.predefined === want);
  if (!k)
    throw new InputError(
      `Вид расчёта «${VACATION_KINDS[kind].title}» (${want}) не найден в плане видов расчёта. Передайте calculationTypeRef. ` +
        `Виды по среднему для отпуска: ${kinds.map((x) => `${x.name} (${x.ref})`).join("; ") || "нет"}.`,
    );
  return k;
}

interface Employee {
  ref: string;
  name: string;
  person?: string;
  department?: string;
  hired?: string;
  dismissed?: string;
}

const EMP_SELECT = [
  "Ref_Key",
  "Description",
  "Физлицо_Key",
  "Организация_Key",
  "ТекущееПодразделениеОрганизации_Key",
  "ДатаПриемаНаРаботу",
  "ДатаУвольнения",
  "DeletionMark",
];
const toEmployee = (r: ODataEntity): Employee => ({
  ref: String(r["Ref_Key"]),
  name: cleanName(String(r["Description"] ?? "")),
  person: realRef(r["Физлицо_Key"]),
  department: realRef(r["ТекущееПодразделениеОрганизации_Key"]),
  hired: day(r["ДатаПриемаНаРаботу"]),
  dismissed: day(r["ДатаУвольнения"]),
});

/** Сотрудник организации по Ref_Key или части ФИО (ровно один, не помеченный на удаление). */
async function resolveEmployee(conn: Connection, orgRef: string, employee: string): Promise<Employee> {
  const q = employee.trim();
  if (!q) throw new InputError("employee: пустое значение — передайте Ref_Key или ФИО сотрудника.");
  const meta = (await conn.getMetadata()).entities.get(EMPLOYEES);
  const has = (f: string) => !meta || meta.properties.some((p) => p.name === f) || f === "Ref_Key";
  const select = EMP_SELECT.filter(has);
  if (GUID.test(q)) {
    const ref = guidOf(q);
    let r: ODataEntity;
    try {
      r = await conn.client.getEntity(`${EMPLOYEES}(guid'${ref}')${buildQuery({ select })}`);
    } catch {
      throw new InputError(`Сотрудник ${ref} не найден в справочнике «Сотрудники организаций».`);
    }
    if (r["DeletionMark"] === true) throw new InputError(`Сотрудник ${ref} помечен на удаление.`);
    if (realRef(r["Организация_Key"]) && r["Организация_Key"] !== orgRef)
      throw new InputError(`Сотрудник ${String(r["Description"] ?? ref)} — другой организации.`);
    return toEmployee(r);
  }
  const { rows } = await fetchAll(
    conn.client,
    EMPLOYEES,
    {
      filter: and(
        cmp("DeletionMark", "eq", "false"),
        cmp("IsFolder", "eq", "false"),
        cmp("Организация_Key", "eq", odataGuid(orgRef)),
        contains("Description", q),
      ),
      select,
    },
    conn.behavior.pageSize,
    50,
  );
  const found = (rows as ODataEntity[]).map(toEmployee);
  const working = found.filter((e) => !e.dismissed);
  const list = working.length ? working : found;
  if (list.length === 1) return list[0]!;
  if (!list.length)
    throw new InputError(`Сотрудник «${q}» не найден в организации. Проверьте read.payroll.list_employees.`);
  throw new InputError(
    `По «${q}» найдено несколько сотрудников: ${list
      .map((e) => `${e.name} (${e.ref}${e.dismissed ? `, уволен ${e.dismissed}` : ""})`)
      .join("; ")}. Передайте Ref_Key.`,
  );
}

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

export interface VacationLine {
  document: string;
  ref: string;
  date: string;
  period: string;
  posted: boolean;
  employee: string;
  employeeRef: string;
  personRef?: string;
  kind: string;
  kindRef: string;
  startDate?: string;
  endDate?: string;
  calendarDays?: number;
  amount: number;
  status: "posted" | "draft" | "not_calculated";
}

/** Строки отпуска (вид расчёта по среднему для отпуска) непомеченных начислений за окно месяцев регистрации. */
async function vacationLines(
  conn: Connection,
  opts: { orgRef?: string; fromMonth: string; toMonth: string; kinds: Map<string, string> },
): Promise<VacationLine[]> {
  const { rows } = await fetchAll(
    conn.client,
    ACCRUAL,
    {
      filter: and(
        cmp("DeletionMark", "eq", "false"),
        cmp("ПериодРегистрации", "ge", `datetime'${opts.fromMonth}'`),
        cmp("ПериодРегистрации", "le", `datetime'${opts.toMonth}'`),
        opts.orgRef ? cmp("Организация_Key", "eq", odataGuid(opts.orgRef)) : undefined,
      ),
      select: ["Ref_Key", "Number", "Date", "Posted", "ПериодРегистрации", "Начисления"],
    },
    conn.behavior.pageSize,
    conn.behavior.analyticsMaxRows,
  );
  const out: VacationLine[] = [];
  for (const d of rows as ODataEntity[]) {
    for (const l of (d["Начисления"] as ODataEntity[] | undefined) ?? []) {
      const kindRef = String(l["ВидРасчета_Key"] ?? "");
      if (!opts.kinds.has(kindRef)) continue;
      const start = day(l["ДатаНачала"]);
      const end = day(l["ДатаОкончания"]);
      const cents = toCents(l["Результат"]);
      out.push({
        document: String(d["Number"] ?? ""),
        ref: String(d["Ref_Key"]),
        date: String(d["Date"] ?? "").slice(0, 10),
        period: monthLabel(String(d["ПериодРегистрации"] ?? "")),
        posted: d["Posted"] === true,
        employee: "",
        employeeRef: String(l["Сотрудник_Key"] ?? ""),
        ...(realRef(l["Физлицо_Key"]) ? { personRef: String(l["Физлицо_Key"]) } : {}),
        kind: opts.kinds.get(kindRef)!,
        kindRef,
        ...(start ? { startDate: start } : {}),
        ...(end ? { endDate: end } : {}),
        ...(start && end ? { calendarDays: calendarDays(start, end) } : {}),
        amount: fromCents(cents),
        status: !cents ? "not_calculated" : d["Posted"] === true ? "posted" : "draft",
      });
    }
  }
  return out;
}

const overlaps = (a1: string, a2: string, b1?: string, b2?: string) => !!b1 && !!b2 && a1 <= b2 && b1 <= a2;

export function registerPayrollVacationTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.payroll.create_vacation_accrual",
    {
      title: "Начисление отпускных (документ без расчёта)",
      description:
        "Казахстан. Создаёт НЕПРОВЕДЁННОЕ «Начисление зарплаты работникам организаций» с видом расчёта «Оплата " +
        "отпуска» (kind=vacation; compensation — «Компенсация отпуска», dismissal — «Компенсация отпуска при " +
        "увольнении»; свой вид — calculationTypeRef): шапка (организация, месяц начисления, вид расчёта), строки — " +
        "сотрудник, физлицо, подразделение, период отпуска ДатаНачала–ДатаОкончания. Отдельного документа «Отпуск» в " +
        "БК для РК нет. Сумму по среднему заработку MCP НЕ считает и «Результат» не пишет: бухгалтер открывает документ " +
        "в 1С → «Рассчитать», проверяет и проводит (post_document пустой документ проводить откажется). Удержания ИПН, " +
        "ОПВ, ВОСМС и СН/СО/ОПВР/ООСМС (или ЕП) — расчётные документы месяца в 1С. Отпуск, пересекающийся с уже " +
        "начисленным тому же сотруднику, — отказ (allowDuplicate=true — всё равно). По умолчанию предпросмотр; " +
        "создание — confirm=true с operationId после согласия. Посмотреть — read.payroll.get_vacations. " +
        'Пример: {"employees":[{"employee":"Касымова","startDate":"2026-12-01","endDate":"2026-12-24"}]}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        employees: z
          .array(
            z.object({
              employee: z
                .string()
                .describe("Ref_Key сотрудника (Catalog_СотрудникиОрганизаций) или часть ФИО"),
              startDate: dateField("Первый день отпуска"),
              endDate: dateField("Последний день отпуска"),
            }),
          )
          .min(1)
          .max(50)
          .describe("Сотрудники и периоды отпуска"),
        kind: z
          .enum(["vacation", "compensation", "dismissal"])
          .default("vacation")
          .describe(
            "vacation — оплата отпуска, compensation — компенсация отпуска, dismissal — компенсация при увольнении",
          ),
        calculationTypeRef: z
          .string()
          .optional()
          .describe(
            "Ref_Key своего вида расчёта по среднему для отпуска (ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций)",
          ),
        period: z
          .string()
          .optional()
          .describe(
            "Месяц начисления (ПериодРегистрации) YYYY-MM; по умолчанию — месяц начала первого отпуска",
          ),
        date: dateField("Дата документа (по умолчанию — сейчас)").optional(),
        responsibleRef: z
          .string()
          .optional()
          .describe("Ref_Key пользователя-ответственного (Catalog_Пользователи)"),
        comment: z.string().max(500).optional().describe("Комментарий"),
        allowDuplicate: z
          .boolean()
          .optional()
          .describe("true — создать, даже если у сотрудника уже есть отпуск на эти даты"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.payroll.create_vacation_accrual", async () => {
        const conn = ctx.db(a.database);
        const org = await resolveOrgOrDefault(conn, a.organization);
        for (const e of a.employees)
          if (e.endDate < e.startDate)
            throw new InputError(
              `${e.employee}: последний день отпуска ${e.endDate} раньше первого ${e.startDate}.`,
            );
        const kind = await pickKind(conn, a.kind ?? "vacation", a.calculationTypeRef);
        const month = monthStart(a.period ?? a.employees[0]!.startDate);
        const notes: string[] = [];
        const lines: Array<{ emp: Employee; start: string; end: string }> = [];
        for (const e of a.employees) {
          const emp = await resolveEmployee(conn, org.ref, e.employee);
          if (!emp.person)
            throw new InputError(`У сотрудника ${emp.name} не заполнено физлицо — заполните карточку в 1С.`);
          if (a.kind !== "dismissal" && emp.dismissed && emp.dismissed < e.startDate)
            throw new InputError(
              `${emp.name} уволен ${ruDate(emp.dismissed)} — отпуск с ${ruDate(e.startDate)} начислить нельзя.`,
            );
          if (emp.hired && e.startDate < emp.hired)
            notes.push(`Внимание: отпуск ${emp.name} начинается раньше даты приёма (${ruDate(emp.hired)}).`);
          if (lines.some((l) => l.emp.ref === emp.ref && overlaps(e.startDate, e.endDate, l.start, l.end)))
            throw new InputError(`${emp.name}: периоды отпуска в запросе пересекаются.`);
          lines.push({ emp, start: e.startDate, end: e.endDate });
        }
        const minStart = monthStart(lines.map((l) => l.start).sort()[0]!);
        const maxEnd = monthStart(
          lines
            .map((l) => l.end)
            .sort()
            .at(-1)!,
        );
        const existing = await vacationLines(conn, {
          orgRef: org.ref,
          fromMonth: shiftMonth(minStart < month ? minStart : month, -3),
          toMonth: shiftMonth(maxEnd > month ? maxEnd : month, 3),
          kinds: new Map((await vacationKinds(conn)).map((k) => [k.ref, k.name])),
        });
        const clashes = existing.filter((x) =>
          lines.some((l) => x.employeeRef === l.emp.ref && overlaps(l.start, l.end, x.startDate, x.endDate)),
        );
        if (clashes.length) {
          const list = [...new Map(clashes.map((c) => [c.ref, c])).values()]
            .map(
              (c) =>
                `№ ${c.document} от ${c.date} (${c.kind} ${c.startDate ? ruDate(c.startDate) : "?"}–${c.endDate ? ruDate(c.endDate) : "?"}${c.posted ? ", проведён" : ""})`,
            )
            .join(", ");
          if (!a.allowDuplicate)
            throw new InputError(
              `На эти даты отпуск уже начислен: ${list}. Проверьте его (read.payroll.get_vacations); если нужен ещё один документ, передайте allowDuplicate=true.`,
            );
          notes.push(`Внимание: на эти даты отпуск уже начислен: ${list} (allowDuplicate=true).`);
        }
        notes.unshift(
          `${kind.name} за ${monthLabel(month)}: ` +
            lines
              .map(
                (l) =>
                  `${l.emp.name} — ${ruDate(l.start)}–${ruDate(l.end)} (${calendarDays(l.start, l.end)} календ. дн.)`,
              )
              .join("; ") +
            ".",
          "Сумму (средний заработок × оплачиваемые дни) MCP не считает и «Результат» не заполняет: откройте документ " +
            "в 1С → «Рассчитать», проверьте сумму и проведите. Пока «Результат» = 0, write.document.post_document " +
            "проводить откажется. Удержания и взносы с отпускных 1С считает расчётными документами месяца (облагаемость — по настройкам вида расчёта); " +
            "проверка — read.payroll.check_month.",
        );
        const responsible = await responsibleFields(conn, a.responsibleRef, notes);
        const prepared = await prepareDocument(conn, {
          organization: org.name,
          entitySet: ACCRUAL,
          date: a.date,
          fields: {
            Организация_Key: org.ref,
            ПериодРегистрации: month,
            ВидРасчета_Key: kind.ref,
            ...responsible,
            ...(a.comment ? { Комментарий: a.comment } : {}),
          },
          tables: {
            Начисления: lines.map((l) => ({
              Сотрудник_Key: l.emp.ref,
              Физлицо_Key: l.emp.person!,
              ВидРасчета_Key: kind.ref,
              ДатаНачала: `${l.start}T00:00:00`,
              ДатаОкончания: `${l.end}T00:00:00`,
              ...(l.emp.department ? { ПодразделениеОрганизации_Key: l.emp.department } : {}),
            })),
          },
        });
        // Общая подсказка «оклад повторно не начисляйте» к отпуску не относится — заменяем своей.
        const other = prepared.notes.filter((n) => n.startsWith("У этих сотрудников уже есть начисление"));
        if (other.length)
          notes.push(
            "У этих сотрудников есть и другие начисления за этот месяц (оклад и т. п.) — для отпуска это обычно; " +
              "проверьте в 1С, что дни отпуска не оплачены окладом.",
          );
        return createOrPreview(conn, ACCRUAL, prepared.payload, a.confirm ?? false, [
          ...notes,
          ...prepared.notes.filter((n) => !other.includes(n)),
        ]);
      }),
  );

  server.registerTool(
    "read.payroll.get_vacations",
    {
      title: "Начисленные отпуска",
      description:
        "Казахстан. Отпуска и компенсации отпуска по документам «Начисление зарплаты работникам организаций» (строки " +
        "с видом расчёта по среднему для отпуска): сотрудник, период отпуска, календарные дни, сумма (Результат, её " +
        "посчитала 1С), документ и статус — posted (проведён), draft (рассчитан, не проведён), not_calculated (сумма 0 — " +
        "в 1С не нажали «Рассчитать»). Фильтр: даты отпуска пересекаются с from..to; employee — Ref_Key или часть ФИО. " +
        "Ищет в документах с месяцем начисления от from−3 до to+3 месяцев. Помеченные на удаление не показываются.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        from: dateField("Начало периода (даты отпуска)"),
        to: dateField("Конец периода (даты отпуска)"),
        employee: z.string().max(200).optional().describe("Ref_Key сотрудника или часть ФИО"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          period: z.object({ from: z.string(), to: z.string() }),
          count: z.number(),
          totalPosted: z.number(),
          vacations: z.array(
            z
              .object({ employee: z.string(), document: z.string(), amount: z.number(), status: z.string() })
              .passthrough(),
          ),
        })
        .passthrough(),
    },
    ({ database, organization, from, to, employee }) =>
      guard("read.payroll.get_vacations", async () => {
        const conn = ctx.db(database);
        if (to < from) throw new InputError(`to=${to} раньше from=${from}.`);
        const org = organization ? await resolveOrgOrDefault(conn, organization) : undefined;
        const kinds = new Map((await vacationKinds(conn)).map((k) => [k.ref, k.name]));
        const all = await vacationLines(conn, {
          orgRef: org?.ref,
          fromMonth: shiftMonth(monthStart(from), -3),
          toMonth: shiftMonth(monthStart(to), 3),
          kinds,
        });
        const empRefs = [...new Set(all.map((v) => v.employeeRef).filter((r) => realRef(r)))];
        const names = new Map<string, string>();
        for (let i = 0; i < empRefs.length; i += 20) {
          const chunk = empRefs.slice(i, i + 20);
          const { rows } = await fetchAll(
            conn.client,
            EMPLOYEES,
            {
              filter: chunk.map((r) => cmp("Ref_Key", "eq", odataGuid(r))).join(" or "),
              select: ["Ref_Key", "Description"],
            },
            conn.behavior.pageSize,
            100,
          );
          for (const r of rows as ODataEntity[])
            names.set(String(r["Ref_Key"]), cleanName(String(r["Description"] ?? "")));
        }
        const q = employee?.trim();
        const byRef = q && GUID.test(q) ? guidOf(q) : undefined;
        const vacations = all
          .map((v) => ({ ...v, employee: names.get(v.employeeRef) ?? v.employeeRef }))
          .filter((v) => !v.startDate || !v.endDate || overlaps(from, to, v.startDate, v.endDate))
          .filter((v) =>
            !q ? true : byRef ? v.employeeRef === byRef : v.employee.toLowerCase().includes(q.toLowerCase()),
          )
          .sort(
            (x, y) =>
              (x.startDate ?? "").localeCompare(y.startDate ?? "") || x.employee.localeCompare(y.employee),
          );
        const totalPosted = vacations.filter((v) => v.posted).reduce((s, v) => s + toCents(v.amount), 0);
        const pending = vacations.filter((v) => v.status === "not_calculated").length;
        return ok({
          database: conn.cfg.name,
          ...(org ? { organization: org.name } : {}),
          period: { from, to },
          count: vacations.length,
          totalPosted: fromCents(totalPosted),
          vacations,
          note:
            "Суммы — «Результат» строк, их посчитала 1С («Рассчитать» в форме). totalPosted — только проведённые. " +
            (pending
              ? `${pending} строк(и) с суммой 0: в 1С не нажали «Рассчитать» — до расчёта не проводите.`
              : "Удержания и взносы с отпускных — в расчётных документах месяца (read.payroll.check_month)."),
        });
      }),
  );
}
