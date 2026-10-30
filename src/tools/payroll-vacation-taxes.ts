import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, contains, odataGuid } from "../odata/query.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { dateField, databaseField, guard } from "./_shared.js";
import { confirmField, createOrPreview } from "./write.js";
import { prepareDocument } from "./write-documents.js";
import { PAYROLL_FORM_HINT, PAYROLL_SUM_DOCS } from "./payroll-sums.js";
import { cleanName, fromCents, monthLabel, personOf, realRef, toCents } from "./payroll-data.js";
import { ACCRUAL, calendarDays, responsibleFields, vacationKinds } from "./payroll-vacation.js";

/**
 * Удержания и налоги с отпускных — тем же порядком, что зарплата: после «Начисления зарплаты» (с видом расчёта
 * отпуска) за тот же месяц делаются «Расчёт удержаний работников организаций» (ИПН, ОПВ, ВОСМС) и «Расчёт СН и СО»
 * (СН, СО, ОППВ, ООСМС, ОПВР). Решение пользователя (20.10.2026): суммы начислений и налогов считает 1С. Поэтому,
 * как и в потоке зарплаты, MCP ставок не применяет и сумм не пишет: создаёт НЕПРОВЕДЁННЫЙ документ месяца — шапка
 * (организация, месяц, ответственный) и «Физические лица» из строк отпуска; ИсчисленныйИПН/ОПВ/ВОСМС/СН/СО/… заполняет
 * 1С кнопкой «Заполнить»/«Рассчитать» в форме (или скрипт веб-клиента). post_document пустой расчёт не проводит.
 * Основание — рассчитанное начисление: если сумма отпуска 0 («Рассчитать» не нажимали) — отказ.
 */

export const WITHHOLDING = "Document_РасчетУдержанийРаботниковОрганизаций";
export const EMPLOYER = "Document_РасчетСНиСО";
export const VACATION_TAX_DOCS = {
  withholding: { entitySet: WITHHOLDING, title: "Расчёт удержаний (ИПН, ОПВ, ВОСМС)" },
  employer: { entitySet: EMPLOYER, title: "Расчёт СН и СО (СН, СО, ОППВ, ООСМС, ОПВР)" },
} as const;
export type VacationTaxDoc = keyof typeof VACATION_TAX_DOCS;

const GUID = /^[{']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[}']?$/i;
const EMPTY_DATE = "0001-01-01T00:00:00";
const day = (v: unknown): string | undefined =>
  typeof v === "string" && v && v !== EMPTY_DATE ? v.slice(0, 10) : undefined;
const ruDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fmt = (c: number) => fromCents(c).toLocaleString("ru-RU", { minimumFractionDigits: 2 });
const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

/** Календарные дни периода по месяцам: [{ month: "2026-12", days: 4 }, { month: "2027-01", days: 10 }]. */
export function daysByMonth(start: string, end: string): Array<{ month: string; days: number }> {
  const out: Array<{ month: string; days: number }> = [];
  let cur = start;
  while (cur <= end) {
    const y = +cur.slice(0, 4);
    const m = +cur.slice(5, 7);
    const last = `${cur.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const stop = last < end ? last : end;
    out.push({ month: cur.slice(0, 7), days: calendarDays(cur, stop) });
    const next = new Date(Date.UTC(y, m, 1));
    cur = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  return out;
}

interface AccrualDoc {
  ref: string;
  number: string;
  date: string;
  posted: boolean;
  org: string;
  month: string;
  responsible?: string;
  lines: Array<{
    person: string;
    employee: string;
    kind: string;
    start?: string;
    end?: string;
    cents: number;
  }>;
}

/** Начисление по Ref_Key или номеру (16, 00000000016). Помеченное на удаление — отказ. */
async function readAccrual(conn: Connection, accrual: string): Promise<AccrualDoc> {
  const q = accrual.trim().replace(/^№\s*/, "");
  const select = [
    "Ref_Key",
    "Number",
    "Date",
    "Posted",
    "DeletionMark",
    "Организация_Key",
    "ПериодРегистрации",
    "Ответственный_Key",
    "Начисления",
  ];
  let d: ODataEntity | undefined;
  if (GUID.test(q)) {
    const ref = q.replace(/[{}']/g, "");
    try {
      d = await conn.client.getEntity(`${ACCRUAL}(guid'${ref}')${buildQuery({ select })}`);
    } catch {
      throw new InputError(`Начисление зарплаты ${ref} не найдено.`);
    }
  } else if (/^\d+$/.test(q)) {
    const { rows } = await fetchAll(
      conn.client,
      ACCRUAL,
      { filter: contains("Number", q.replace(/^0+/, "") || "0"), select },
      conn.behavior.pageSize,
      200,
    );
    const found = (rows as ODataEntity[]).filter(
      (r) =>
        String(r["Number"] ?? "")
          .replace(/\D/g, "")
          .replace(/^0+/, "") === q.replace(/^0+/, ""),
    );
    const live = found.filter((r) => r["DeletionMark"] !== true);
    if (live.length > 1)
      throw new InputError(
        `Начислений с номером ${q} несколько: ${live
          .map((r) => `${String(r["Number"])} от ${String(r["Date"]).slice(0, 10)} (${String(r["Ref_Key"])})`)
          .join("; ")}. Передайте Ref_Key.`,
      );
    d = live[0] ?? found[0];
    if (!d) throw new InputError(`Начисление зарплаты № ${q} не найдено.`);
  } else {
    throw new InputError("accrual: передайте Ref_Key или номер документа «Начисление зарплаты».");
  }
  if (d["DeletionMark"] === true)
    throw new InputError(
      `Начисление № ${String(d["Number"])} помечено на удаление — по нему налоги не считают.`,
    );
  const kinds = new Map((await vacationKinds(conn)).map((k) => [k.ref, k.name]));
  const lines = ((d["Начисления"] as ODataEntity[] | undefined) ?? [])
    .filter((l) => kinds.has(String(l["ВидРасчета_Key"] ?? "")))
    .map((l) => {
      const start = day(l["ДатаНачала"]);
      const end = day(l["ДатаОкончания"]);
      return {
        person: personOf(l) ?? "",
        employee: String(l["Сотрудник_Key"] ?? ""),
        kind: kinds.get(String(l["ВидРасчета_Key"]))!,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        cents: toCents(l["Результат"]),
      };
    });
  return {
    ref: String(d["Ref_Key"]),
    number: String(d["Number"] ?? ""),
    date: String(d["Date"] ?? ""),
    posted: d["Posted"] === true,
    org: String(d["Организация_Key"] ?? ""),
    month: String(d["ПериодРегистрации"] ?? ""),
    ...(realRef(d["Ответственный_Key"]) ? { responsible: String(d["Ответственный_Key"]) } : {}),
    lines,
  };
}

/**
 * Непомеченные расчёты того же вида за месяц: где уже есть эти физлица (в «Физических лицах» или строках налогов)
 * либо пустые — без физлиц и строк (1С при записи через OData очищает «Физические лица», так что созданный этим
 * инструментом и ещё не заполненный расчёт выглядит именно так).
 */
async function sameMonthTaxDocs(
  conn: Connection,
  entitySet: string,
  org: string,
  month: string,
  persons: Set<string>,
): Promise<string[]> {
  const tables = ["ФизическиеЛица", ...Object.keys(PAYROLL_SUM_DOCS[entitySet]?.tables ?? {})];
  const em = (await conn.getMetadata()).entities.get(entitySet);
  const present = tables.filter((t) => !em || em.properties.some((p) => p.name === t));
  const { rows } = await fetchAll(
    conn.client,
    entitySet,
    {
      filter: and(
        cmp("ПериодРегистрации", "eq", `datetime'${month}'`),
        cmp("DeletionMark", "eq", "false"),
        cmp("Организация_Key", "eq", odataGuid(org)),
      ),
      select: ["Ref_Key", "Number", "Date", "Posted", ...present],
    },
    50,
    200,
  );
  const lines = (d: ODataEntity, t: string) => (d[t] as ODataEntity[] | undefined) ?? [];
  return (rows as ODataEntity[]).flatMap((d) => {
    const head = `№ ${String(d["Number"])} от ${String(d["Date"]).slice(0, 10)}${d["Posted"] === true ? " (проведён)" : ""}`;
    if (present.some((t) => lines(d, t).some((r) => persons.has(personOf(r) ?? "")))) return [head];
    if (present.every((t) => !lines(d, t).length)) return [`${head} — пустой, ещё не заполнен`];
    return [];
  });
}

export function registerPayrollVacationTaxTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.payroll.create_vacation_taxes",
    {
      title: "Удержания и налоги с отпускных (расчёт месяца без сумм)",
      description:
        "Казахстан. Следующий шаг после write.payroll.create_vacation_accrual — как при зарплате: по рассчитанному в 1С " +
        "«Начислению зарплаты» с отпуском создаёт НЕПРОВЕДЁННЫЙ расчёт того же месяца: document=withholding — «Расчёт " +
        "удержаний работников организаций» (ИПН, ОПВ, ВОСМС), employer — «Расчёт СН и СО» (СН, СО, ОППВ, ООСМС, ОПВР). " +
        "Пишет шапку (организация, месяц начисления, ответственный); «Физические лица» из строк отпуска передаёт, но 1С при " +
        "записи через OData их очищает — состав заполнит «Заполнить». Суммы и ставки " +
        "MCP НЕ считает (решение: считает 1С): ИсчисленныйИПН/ОПВ/ВОСМС и СН/СО/… заполняет 1С кнопкой «Заполнить»/" +
        "«Рассчитать» в форме; пустой расчёт post_document проводить откажется. Отказ: сумма отпуска 0 (в начислении не " +
        "нажали «Рассчитать»), в начислении нет строк отпуска, за месяц уже есть такой расчёт с этим сотрудником или пустой " +
        "(allowDuplicate=true — всё равно). Предупреждения: начисление не проведено, отпуск переходит на два месяца, " +
        "проведён единый платёж. По умолчанию предпросмотр; создание — confirm=true с operationId после согласия. Каждый " +
        'документ — отдельным вызовом. Пример: {"accrual":"16","document":"withholding"}.',
      inputSchema: {
        database: databaseField,
        accrual: z
          .string()
          .min(1)
          .max(100)
          .describe("Ref_Key или номер «Начисления зарплаты работникам организаций» с отпуском"),
        document: z
          .enum(["withholding", "employer"])
          .default("withholding")
          .describe(
            "withholding — расчёт удержаний (ИПН, ОПВ, ВОСМС); employer — расчёт СН и СО (СН, СО, ОППВ, ООСМС, ОПВР)",
          ),
        date: dateField("Дата документа (по умолчанию — дата начисления)").optional(),
        responsibleRef: z
          .string()
          .optional()
          .describe(
            "Ref_Key пользователя-ответственного (Catalog_Пользователи); по умолчанию — из начисления",
          ),
        comment: z.string().max(500).optional().describe("Комментарий"),
        allowDuplicate: z
          .boolean()
          .optional()
          .describe("true — создать, даже если за месяц уже есть такой расчёт с этим сотрудником или пустой"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.payroll.create_vacation_taxes", async () => {
        const conn = ctx.db(a.database);
        const spec = VACATION_TAX_DOCS[a.document ?? "withholding"];
        const acc = await readAccrual(conn, a.accrual);
        const label = `№ ${acc.number} от ${ruDate(acc.date.slice(0, 10))}`;
        if (!acc.lines.length)
          throw new InputError(
            `В начислении ${label} нет строк с видом расчёта отпуска — для оклада и прочих начислений этот инструмент не нужен.`,
          );
        const zero = acc.lines.filter((l) => !l.cents);
        if (zero.length)
          throw new InputError(
            `В начислении ${label} сумма отпускных 0 (${zero.length} из ${acc.lines.length} строк): в 1С не нажали ` +
              "«Рассчитать». Откройте начисление в 1С → «Рассчитать», проверьте сумму — затем повторите. Удержания и " +
              "налоги с нулевой базы не создаются.",
          );
        if (acc.lines.some((l) => !realRef(l.person)))
          throw new InputError(
            `В начислении ${label} у строки отпуска не заполнено физлицо — заполните в 1С.`,
          );
        const persons = [...new Set(acc.lines.map((l) => l.person))];
        // ФИО для превью.
        const names = new Map<string, string>();
        const { rows: people } = await fetchAll(
          conn.client,
          "Catalog_ФизическиеЛица",
          {
            filter: persons.map((r) => cmp("Ref_Key", "eq", odataGuid(r))).join(" or "),
            select: ["Ref_Key", "Description"],
          },
          conn.behavior.pageSize,
          100,
        ).catch(() => ({ rows: [] as ODataEntity[] }));
        for (const r of people as ODataEntity[])
          names.set(String(r["Ref_Key"]), cleanName(String(r["Description"] ?? "")));
        const name = (p: string) => names.get(p) ?? p;

        const notes: string[] = [];
        notes.push(
          `${spec.title} за ${monthLabel(acc.month)} по начислению ${label}. База из 1С (Результат): ` +
            acc.lines
              .map(
                (l) =>
                  `${name(l.person)} — ${fmt(l.cents)} тенге (${l.kind}${l.start && l.end ? ` ${ruDate(l.start)}–${ruDate(l.end)}` : ""})`,
              )
              .join("; ") +
            ".",
          "Суммы налогов и взносов MCP не считает и строки ИсчисленныйИПН/ОПВ/ВОСМС/СН/СО/ОППВ/ООСМС/ОПВР не пишет. " +
            `${PAYROLL_FORM_HINT} Пока строки пустые, write.document.post_document проводить откажется.`,
        );
        if (!acc.posted)
          notes.push(
            `Начисление ${label} не проведено. Проведите его до «Заполнить»/«Рассчитать» в расчёте — расчёт месяца ` +
              "строится по проведённым начислениям, иначе отпускные в базу не попадут.",
          );
        for (const l of acc.lines) {
          if (!l.start || !l.end) continue;
          const parts = daysByMonth(l.start, l.end);
          if (parts.length > 1)
            notes.push(
              `Внимание: отпуск ${name(l.person)} ${ruDate(l.start)}–${ruDate(l.end)} переходит на ${parts.length} мес. (` +
                parts
                  .map((p) => `${MONTHS[+p.month.slice(5, 7) - 1]} ${p.month.slice(0, 4)} — ${p.days} дн.`)
                  .join(", ") +
                "). Налоги и взносы с такого отпуска распределяются по месяцам пропорционально дням (ответ «Налогового " +
                `консультанта»). MCP суммы по месяцам не делит: расчёт создаётся за ${monthLabel(acc.month)}, как в начислении. ` +
                "После «Рассчитать» проверьте в 1С МесяцНалоговогоПериода и суммы строк; часть следующего месяца — в его расчёте.",
            );
          else if (parts[0] && `${parts[0].month}-01T00:00:00` !== acc.month)
            notes.push(
              `Отпуск ${name(l.person)} (${ruDate(l.start)}–${ruDate(l.end)}) — не в месяце начисления ${monthLabel(acc.month)}: ` +
                "расчёт создаётся за месяц начисления. Проверьте месяц в 1С.",
            );
        }
        const dups = await sameMonthTaxDocs(conn, spec.entitySet, acc.org, acc.month, new Set(persons));
        if (dups.length) {
          const msg =
            `За ${monthLabel(acc.month)} уже есть «${PAYROLL_SUM_DOCS[spec.entitySet]!.title}» с этим сотрудником или пустой: ` +
            `${dups.join(", ")}. Второй расчёт месяца может задвоить налоги — лучше перезаполнить существующий в 1С ` +
            "(«Заполнить»/«Рассчитать»).";
          if (!a.allowDuplicate)
            throw new InputError(`${msg} Если нужен ещё один документ, передайте allowDuplicate=true.`);
          notes.push(`Внимание: ${msg} (allowDuplicate=true).`);
        }
        let responsible: Record<string, string>;
        if (a.responsibleRef) responsible = await responsibleFields(conn, a.responsibleRef, notes);
        else if (acc.responsible) {
          responsible = { Ответственный_Key: acc.responsible };
          notes.push("Ответственный — как в начислении.");
        } else responsible = await responsibleFields(conn, undefined, notes);
        const prepared = await prepareDocument(conn, {
          entitySet: spec.entitySet,
          date: a.date ?? acc.date,
          fields: {
            Организация_Key: acc.org,
            ПериодРегистрации: acc.month,
            ...responsible,
            ...(a.comment ? { Комментарий: a.comment } : {}),
          },
          tables: { ФизическиеЛица: persons.map((p) => ({ ФизическоеЛицо_Key: p })) },
        });
        return createOrPreview(conn, spec.entitySet, prepared.payload, a.confirm ?? false, [
          ...notes,
          ...prepared.notes,
        ]);
      }),
  );
}
