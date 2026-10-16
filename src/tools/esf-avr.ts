import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { catalogFields } from "../odata/catalog-fields.js";
import { resolveNames } from "../odata/accounting.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, odataGuid, odataString } from "../odata/query.js";
import { databaseField, dateField, guard, ok, organizationField } from "./_shared.js";

/**
 * ЭАВР (электронный акт выполненных работ) и ЭСФ: чтение и подбор связей. Только чтение.
 *
 * Связи в 1С (проверено на базе Казахстана):
 *  • ЭАВР → первичный документ: ДокументОснование + ДокументОснование_Type (Document_ПоступлениеТоваровУслуг для
 *    входящих, реализация — для исходящих); зеркало — InformationRegister_АктуальныеЭАВР.
 *  • ЭСФ → счёт-фактура: Document_ЭСФ.СчетФактура + СчетФактура_Type (Document_СчетФактураПолученный для входящих,
 *    Document_СчетФактураВыданный для исходящих); зеркало — InformationRegister_АктуальныеЭСФ.
 * Подбор — по контрагенту, организации, сумме и дате; договор усиливает совпадение, но не требуется (в реальных
 * данных договор в ЭАВР часто отличается от договора документа). Результат — кандидаты и вердикт, не запись.
 */

const AVR = "Document_ЭлектронныйАктВыполненныхРабот";
const ESF = "Document_ЭСФ";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}]/g, "");
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const dayNum = (s: unknown): number | undefined => {
  const t = Date.parse(String(s ?? ""));
  return Number.isFinite(t) && !String(s).startsWith("0001") ? t / 86_400_000 : undefined;
};
const money = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const typeOf = (t: unknown): string => String(t ?? "").replace(/^StandardODATA\./, "");

/** Документы-основания ЭАВР по направлению ЭАВР. */
const BASIS_BY_DIRECTION: Record<string, string> = {
  Входящий: "Document_ПоступлениеТоваровУслуг",
  Исходящий: "Document_РеализацияТоваровУслуг",
};
/** Счета-фактуры по направлению ЭСФ. */
const INVOICE_BY_DIRECTION: Record<string, string> = {
  Входящий: "Document_СчетФактураПолученный",
  Исходящий: "Document_СчетФактураВыданный",
};

export type Verdict = "unique" | "ambiguous" | "none" | "no_counterparty";

export interface Candidate {
  ref: string;
  number: string;
  date: string;
  posted: boolean;
  amount: number;
  dateDiffDays: number;
  contractMatches: boolean;
  score: number;
  matchedBy: string[];
}

interface Subject {
  org?: string | undefined;
  counterparty?: string | undefined;
  contract?: string | undefined;
  amounts: number[];
  dates: number[];
}
interface Doc {
  ref: string;
  number: string;
  date: string;
  posted: boolean;
  deleted: boolean;
  org?: string | undefined;
  counterparty?: string | undefined;
  contract?: string | undefined;
  amount: number;
  dates: number[];
}

/**
 * Подбор документа к ЭАВР/ЭСФ. Жёсткие условия: организация, контрагент (если известен), сумма (любая из amounts в
 * пределах tolerance), дата в окне windowDays, документ не занят другим. Договор и точность даты — только в score.
 * Вердикт: один подходящий — unique; несколько — ambiguous (решает человек); ни одного — none.
 */
export function rankCandidates(
  subject: Subject,
  docs: Doc[],
  opts: { windowDays: number; tolerance: number; taken: ReadonlySet<string> },
): { candidates: Candidate[]; verdict: Verdict } {
  if (!subject.counterparty) {
    // Без контрагента подбор не однозначен по определению: показываем кандидатов по сумме и дате.
  }
  const out: Candidate[] = [];
  for (const d of docs) {
    if (d.deleted || opts.taken.has(d.ref)) continue;
    if (subject.org && d.org && subject.org !== d.org) continue;
    if (subject.counterparty && d.counterparty !== subject.counterparty) continue;
    const amountOk = subject.amounts.some((a) => Math.abs(a - d.amount) <= opts.tolerance);
    if (!amountOk) continue;
    const diffs = subject.dates.flatMap((s) => d.dates.map((x) => Math.abs(x - s)));
    const dateDiff = diffs.length ? Math.min(...diffs) : 0;
    if (dateDiff > opts.windowDays) continue;
    const contractMatches = !!subject.contract && d.contract === subject.contract;
    const matchedBy = ["сумма"];
    if (subject.counterparty) matchedBy.push("контрагент");
    if (subject.org && d.org) matchedBy.push("организация");
    if (contractMatches) matchedBy.push("договор");
    if (dateDiff <= 1) matchedBy.push("дата ±1 день");
    out.push({
      ref: d.ref,
      number: d.number,
      date: d.date.slice(0, 10),
      posted: d.posted,
      amount: d.amount,
      dateDiffDays: Math.round(dateDiff * 10) / 10,
      contractMatches,
      score: Math.round((100 + (contractMatches ? 20 : 0) + (d.posted ? 5 : 0) - dateDiff) * 10) / 10,
      matchedBy,
    });
  }
  out.sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
  const verdict: Verdict = !subject.counterparty
    ? out.length
      ? "no_counterparty"
      : "none"
    : out.length === 0
      ? "none"
      : out.length === 1
        ? "unique"
        : "ambiguous";
  return { candidates: out, verdict };
}

const toDoc = (r: Record<string, unknown>, contractField: string, dateFields: string[]): Doc => ({
  ref: String(r["Ref_Key"]),
  number: String(r["Number"] ?? ""),
  date: String(r["Date"] ?? ""),
  posted: r["Posted"] === true,
  deleted: r["DeletionMark"] === true,
  org: isRef(r["Организация_Key"]) ? String(r["Организация_Key"]) : undefined,
  counterparty: isRef(r["Контрагент_Key"]) ? String(r["Контрагент_Key"]) : undefined,
  contract: isRef(r[contractField]) ? String(r[contractField]) : undefined,
  amount: money(r["СуммаДокумента"]),
  dates: [r["Date"], ...dateFields.map((f) => r[f])].map(dayNum).filter((x): x is number => x !== undefined),
});

const AVR_SELECT = [
  "Ref_Key",
  "Number",
  "Date",
  "DeletionMark",
  "Posted",
  "Организация_Key",
  "ДатаВыполненияРабот",
  "РегистрационныйНомер",
  "БезДоговора",
  "Договор_Key",
  "НомерДоговора",
  "ДатаДоговора",
  "Валюта_Key",
  "КодВалюты",
  "ИтогоСуммаНДС",
  "ИтогоСтоимостьСУчетомКосвенныхНалогов",
  "ИтогоСтоимостьБезУчетаКосвенныхНалогов",
  "ДокументОснование",
  "ДокументОснование_Type",
  "Направление",
  "Статус",
  "Состояние",
  "ТипАВР",
  "Контрагент",
  "Контрагент_Type",
];

async function loadAvr(
  conn: Connection,
  opts: {
    orgKey?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    direction?: string | undefined;
    status?: string | undefined;
    counterpartyRef?: string | undefined;
    ref?: string | undefined;
    limit: number;
    offset: number;
  },
) {
  const set = await requireEntity(conn, [AVR], "Документ «Электронный акт выполненных работ» (ЭАВР)");
  if (opts.ref) {
    const e = await conn.client.getEntity(
      `${set}(guid'${guidOf(opts.ref)}')${buildQuery({ select: AVR_SELECT })}`,
    );
    return { set, rows: [e], truncated: false };
  }
  const { rows, truncated } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        cmp("DeletionMark", "eq", "false"),
        opts.orgKey ? cmp("Организация_Key", "eq", odataGuid(opts.orgKey)) : undefined,
        opts.from ? cmp("Date", "ge", `datetime'${opts.from}T00:00:00'`) : undefined,
        opts.to ? cmp("Date", "le", `datetime'${opts.to}T23:59:59'`) : undefined,
        opts.direction ? cmp("Направление", "eq", odataString(opts.direction)) : undefined,
        opts.status ? cmp("Статус", "eq", odataString(opts.status)) : undefined,
        opts.counterpartyRef ? cmp("Контрагент", "eq", odataGuid(guidOf(opts.counterpartyRef))) : undefined,
      ),
      select: AVR_SELECT,
      orderby: "Date desc",
      skip: opts.offset,
    },
    conn.behavior.pageSize,
    Math.min(opts.limit, conn.behavior.maxRows),
  );
  return { set, rows, truncated };
}

const avrHasBasis = (r: Record<string, unknown>): boolean =>
  isRef(r["ДокументОснование"]) && typeOf(r["ДокументОснование_Type"]) !== "Undefined";
const avrCounterparty = (r: Record<string, unknown>): string | undefined =>
  isRef(r["Контрагент"]) && typeOf(r["Контрагент_Type"]) === "Catalog_Контрагенты"
    ? String(r["Контрагент"])
    : undefined;

/** Занятые основания: все документы, на которые уже ссылаются ЭАВР (кроме исключённого). */
async function takenBases(conn: Connection, set: string, except?: string): Promise<Set<string>> {
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: cmp("DeletionMark", "eq", "false"),
      select: ["Ref_Key", "ДокументОснование", "ДокументОснование_Type"],
    },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  return new Set(
    rows
      .filter((r) => r["Ref_Key"] !== except && avrHasBasis(r))
      .map((r) => String(r["ДокументОснование"]).toLowerCase()),
  );
}

/** Контрагент по БИН первого поставщика ЭАВР — когда в «Контрагент» ссылки нет. */
export async function counterpartyByBin(
  conn: Connection,
  avrSet: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const full = await conn.client.getEntity(`${avrSet}(guid'${ref}')${buildQuery({})}`);
    const sup = (full["Поставщики"] as Array<Record<string, unknown>> | undefined) ?? [];
    const bin = sup.map((s) => String(s["ПоставщикИдентификатор"] ?? "")).find((x) => /^\d{12}$/.test(x));
    if (!bin) return undefined;
    const set = "Catalog_Контрагенты";
    if (!(await conn.available()).has(set)) return undefined;
    const f = await catalogFields(conn, set);
    if (!f.inn) return undefined;
    const { rows } = await fetchAll(
      conn.client,
      set,
      { filter: cmp(f.inn, "eq", odataString(bin)), select: [f.ref] },
      5,
      5,
    );
    return rows.length === 1 ? String(rows[0]![f.ref]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Разметка пакета: кандидат, который подходит сразу нескольким документам пакета, получает sharedWith (сколько ещё);
 * при неоднозначности лидер выставляется, только если его оценка выше второй не менее чем на 10 (дата/договор).
 */
export function annotateBatch(items: Array<Record<string, unknown>>): void {
  const seen = new Map<string, number>();
  for (const it of items)
    for (const c of (it["candidates"] as Candidate[]) ?? []) seen.set(c.ref, (seen.get(c.ref) ?? 0) + 1);
  for (const it of items) {
    const cands = (it["candidates"] as Array<Candidate & { sharedWith?: number }>) ?? [];
    for (const c of cands) if ((seen.get(c.ref) ?? 1) > 1) c.sharedWith = (seen.get(c.ref) ?? 1) - 1;
    if (it["verdict"] === "ambiguous" && cands.length > 1 && cands[0]!.score - cands[1]!.score >= 10)
      it["leader"] = cands[0]!.ref;
  }
}

const candidateSchema = z
  .object({ ref: z.string(), number: z.string(), date: z.string(), score: z.number() })
  .passthrough();

export function registerEsfAvrTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.esf.list_avr",
    {
      title: "Электронные акты выполненных работ (ЭАВР)",
      description:
        "Список ЭАВР (Казахстан, документ «Электронный акт выполненных работ»): номер, дата, дата выполнения, " +
        "направление, статус и состояние, контрагент, договор (или «без договора»), валюта, суммы с учётом и без " +
        "косвенных налогов, НДС, и основание — первичный документ (поступление/реализация), к которому привязан ЭАВР. " +
        "hasBasis=false — ЭАВР без основания (кандидатов подбирает read.esf.find_avr_basis). Фильтры: период, " +
        "direction/status как в 1С, counterpartyRef, hasBasis. Сначала новые. Только чтение.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        from: dateField("Начало периода").optional(),
        to: dateField("Конец периода").optional(),
        direction: z.string().max(100).optional().describe("Направление: «Входящий» / «Исходящий»"),
        status: z.string().max(100).optional().describe("Статус — значение как в 1С"),
        counterpartyRef: GUID.optional().describe("Ref_Key контрагента"),
        hasBasis: z.boolean().optional().describe("true — только с основанием, false — только без"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).max(1000000).default(0),
      },
      outputSchema: z
        .object({
          database: z.string(),
          count: z.number(),
          truncated: z.boolean(),
          avr: z.array(z.object({ ref: z.string(), hasBasis: z.boolean() }).passthrough()),
        })
        .passthrough(),
    },
    ({
      database,
      organization,
      from,
      to,
      direction,
      status,
      counterpartyRef,
      hasBasis,
      limit = 50,
      offset = 0,
    }) =>
      guard("read.esf.list_avr", async () => {
        const conn = ctx.db(database);
        const org = organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
        const { rows, truncated } = await loadAvr(conn, {
          orgKey: org,
          from,
          to,
          direction,
          status,
          counterpartyRef,
          limit,
          offset,
        });
        const shown = hasBasis === undefined ? rows : rows.filter((r) => avrHasBasis(r) === hasBasis);
        const cpNames = await resolveNames(
          conn,
          "Catalog_Контрагенты",
          shown.map((r) => avrCounterparty(r) ?? ""),
        );
        const ctrNames = await resolveNames(
          conn,
          "Catalog_ДоговорыКонтрагентов",
          shown.map((r) => (isRef(r["Договор_Key"]) ? String(r["Договор_Key"]) : "")),
        );
        const basisInfo = new Map<string, { number?: string; date?: string; posted?: boolean }>();
        for (const r of shown.filter(avrHasBasis).slice(0, 100)) {
          const t = typeOf(r["ДокументОснование_Type"]);
          if (!/^Document_[\p{L}\p{N}_]+$/u.test(t)) continue;
          try {
            const d = await conn.client.getEntity(
              `${t}(guid'${String(r["ДокументОснование"])}')${buildQuery({ select: ["Number", "Date", "Posted"] })}`,
            );
            basisInfo.set(String(r["Ref_Key"]), {
              number: String(d["Number"] ?? ""),
              date: String(d["Date"] ?? "").slice(0, 10),
              posted: d["Posted"] === true,
            });
          } catch {
            // основание не прочитано — остаётся ссылка
          }
        }
        const avr = shown.map((r) => {
          const based = avrHasBasis(r);
          const cp = avrCounterparty(r);
          return {
            ref: String(r["Ref_Key"]),
            number: String(r["Number"] ?? ""),
            registrationNumber: String(r["РегистрационныйНомер"] ?? "") || undefined,
            date: String(r["Date"] ?? "").slice(0, 10),
            workDate: String(r["ДатаВыполненияРабот"] ?? "").slice(0, 10) || undefined,
            direction: String(r["Направление"] ?? "") || undefined,
            status: String(r["Статус"] ?? "") || undefined,
            state: String(r["Состояние"] ?? "") || undefined,
            kind: String(r["ТипАВР"] ?? "") || undefined,
            counterpartyRef: cp,
            counterparty: cp ? cpNames.get(cp) : undefined,
            withoutContract: r["БезДоговора"] === true,
            contractRef: isRef(r["Договор_Key"]) ? String(r["Договор_Key"]) : undefined,
            contract: isRef(r["Договор_Key"]) ? ctrNames.get(String(r["Договор_Key"])) : undefined,
            contractText:
              [r["НомерДоговора"], String(r["ДатаДоговора"] ?? "").slice(0, 10)]
                .filter((x) => x && x !== "0001-01-01")
                .join(" от ") || undefined,
            currency: String(r["КодВалюты"] ?? "") || undefined,
            amountWithVat: money(r["ИтогоСтоимостьСУчетомКосвенныхНалогов"]),
            amountWithoutVat: money(r["ИтогоСтоимостьБезУчетаКосвенныхНалогов"]),
            vat: money(r["ИтогоСуммаНДС"]),
            hasBasis: based,
            ...(based
              ? {
                  basis: {
                    type: typeOf(r["ДокументОснование_Type"]),
                    ref: String(r["ДокументОснование"]),
                    ...(basisInfo.get(String(r["Ref_Key"])) ?? {}),
                  },
                }
              : {}),
          };
        });
        return ok({
          database: conn.cfg.name,
          count: avr.length,
          truncated,
          ...(truncated ? { nextOffset: offset + rows.length } : {}),
          avr,
        });
      }),
  );

  server.registerTool(
    "read.esf.find_avr_basis",
    {
      title: "Подбор основания (поступления) для ЭАВР",
      description:
        "Для ЭАВР без основания подбирает документы-кандидаты: поступление товаров и услуг (входящий ЭАВР) или " +
        "реализацию (исходящий) — тот же контрагент и организация, сумма равна сумме ЭАВР (с налогами или без), " +
        "дата в окне windowDays (по умолчанию ±31 день от даты акта или даты выполнения), документ не занят другим " +
        "ЭАВР. Договор в ЭАВР часто не совпадает с договором документа — он только повышает оценку. Вердикт: " +
        "unique — один кандидат; ambiguous — несколько (решает бухгалтер, в matchedBy видно, чем отличаются); " +
        "none — нет; no_counterparty — контрагента ЭАВР не определить. Передайте avrRef (один ЭАВР) или без него — " +
        "пакет из limit ЭАВР без основания, сначала новые. Ничего не записывает: привязку делает бухгалтер в 1С.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        avrRef: GUID.optional().describe("Ref_Key ЭАВР; без него — пакет ЭАВР без основания"),
        from: dateField("Начало периода ЭАВР (для пакета)").optional(),
        to: dateField("Конец периода ЭАВР (для пакета)").optional(),
        windowDays: z.number().int().min(0).max(365).default(31).describe("Окно дат, дней"),
        tolerance: z.number().min(0).max(1000).default(0.01).describe("Допуск по сумме"),
        maxCandidates: z.number().int().min(1).max(20).default(5),
        limit: z.number().int().min(1).max(200).default(50).describe("Сколько ЭАВР без основания обработать"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          summary: z.object({
            unique: z.number(),
            ambiguous: z.number(),
            none: z.number(),
            noCounterparty: z.number(),
          }),
          items: z.array(
            z
              .object({
                avrRef: z.string(),
                verdict: z.enum(["unique", "ambiguous", "none", "no_counterparty"]),
                candidates: z.array(candidateSchema),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    },
    ({
      database,
      organization,
      avrRef,
      from,
      to,
      windowDays = 31,
      tolerance = 0.01,
      maxCandidates = 5,
      limit = 50,
    }) =>
      guard("read.esf.find_avr_basis", async () => {
        const conn = ctx.db(database);
        const org = organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
        const loaded = await loadAvr(conn, {
          orgKey: org,
          from,
          to,
          ref: avrRef,
          limit: avrRef ? 1 : conn.behavior.maxRows,
          offset: 0,
        });
        const todo = (
          avrRef ? loaded.rows : loaded.rows.filter((r) => !avrHasBasis(r) && r["Статус"] !== "Отозванный")
        ).slice(0, limit);
        if (avrRef && todo[0] && avrHasBasis(todo[0]))
          throw new InputError(
            "У этого ЭАВР основание уже задано — подбор не нужен (read.esf.list_avr покажет его).",
          );
        const taken = await takenBases(conn, loaded.set);
        const items: Array<Record<string, unknown>> = [];
        const summary = { unique: 0, ambiguous: 0, none: 0, noCounterparty: 0 };
        for (const r of todo) {
          const direction = String(r["Направление"] ?? "Входящий");
          const basisSet = BASIS_BY_DIRECTION[direction];
          const ref = String(r["Ref_Key"]);
          const base = {
            avrRef: ref,
            number: String(r["Number"] ?? ""),
            date: String(r["Date"] ?? "").slice(0, 10),
            direction,
          };
          if (!basisSet || !(await conn.available()).has(basisSet)) {
            items.push({
              ...base,
              verdict: "none",
              candidates: [],
              note: `Документ-основание для направления «${direction}» не опубликован.`,
            });
            summary.none++;
            continue;
          }
          const counterparty = avrCounterparty(r) ?? (await counterpartyByBin(conn, loaded.set, ref));
          const amounts = [
            money(r["ИтогоСтоимостьСУчетомКосвенныхНалогов"]),
            money(r["ИтогоСтоимостьБезУчетаКосвенныхНалогов"]),
          ];
          const dates = [r["Date"], r["ДатаВыполненияРабот"]]
            .map(dayNum)
            .filter((x): x is number => x !== undefined);
          const lo = Math.min(...dates) - windowDays;
          const hi = Math.max(...dates) + windowDays;
          const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
          const docRows = dates.length
            ? (
                await fetchAll(
                  conn.client,
                  basisSet,
                  {
                    filter: and(
                      cmp("DeletionMark", "eq", "false"),
                      cmp("Date", "ge", `datetime'${iso(lo)}T00:00:00'`),
                      cmp("Date", "le", `datetime'${iso(hi)}T23:59:59'`),
                      counterparty ? cmp("Контрагент_Key", "eq", odataGuid(counterparty)) : undefined,
                      isRef(r["Организация_Key"])
                        ? cmp("Организация_Key", "eq", odataGuid(String(r["Организация_Key"])))
                        : undefined,
                    ),
                    select: [
                      "Ref_Key",
                      "Number",
                      "Date",
                      "Posted",
                      "DeletionMark",
                      "Организация_Key",
                      "Контрагент_Key",
                      "ДоговорКонтрагента_Key",
                      "СуммаДокумента",
                    ],
                  },
                  100,
                  conn.behavior.maxRows,
                )
              ).rows
            : [];
          const { candidates, verdict } = rankCandidates(
            {
              org: isRef(r["Организация_Key"]) ? String(r["Организация_Key"]) : undefined,
              counterparty,
              contract: isRef(r["Договор_Key"]) ? String(r["Договор_Key"]) : undefined,
              amounts,
              dates,
            },
            docRows.map((d) => toDoc(d, "ДоговорКонтрагента_Key", [])),
            { windowDays, tolerance, taken },
          );
          if (verdict === "unique") summary.unique++;
          else if (verdict === "ambiguous") summary.ambiguous++;
          else if (verdict === "no_counterparty") summary.noCounterparty++;
          else summary.none++;
          items.push({
            ...base,
            basisEntity: basisSet,
            amounts: { withVat: amounts[0], withoutVat: amounts[1] },
            verdict,
            candidates: candidates.slice(0, maxCandidates),
            ...(candidates.length > maxCandidates
              ? { moreCandidates: candidates.length - maxCandidates }
              : {}),
            ...(verdict === "no_counterparty"
              ? {
                  note: "Контрагент ЭАВР не определён (нет ссылки и БИН поставщика не найден в справочнике) — кандидаты только по сумме и дате.",
                }
              : verdict === "ambiguous"
                ? {
                    note: "Подходит несколько документов — выберите по номеру, договору и дате; сервер не выбирает за вас.",
                  }
                : verdict === "none"
                  ? {
                      note: "Подходящего документа нет: возможно, поступление ещё не введено (тогда его создают из ЭАВР в 1С) или сумма/дата отличаются.",
                    }
                  : {}),
          });
        }
        annotateBatch(items);
        return ok({ database: conn.cfg.name, summary, count: items.length, items });
      }),
  );

  server.registerTool(
    "read.esf.find_esf_invoice",
    {
      title: "Подбор счёта-фактуры для ЭСФ без связи",
      description:
        "Находит ЭСФ без привязанного счёта-фактуры и подбирает кандидатов: счёт-фактуру полученный (входящий ЭСФ) или " +
        "выданный (исходящий) — та же организация и контрагент, сумма равна сумме ЭСФ, дата в окне windowDays, " +
        "счёт-фактура не занята другим ЭСФ. Отозванные и аннулированные ЭСФ помечаются notNeeded: связывать их не " +
        "нужно. Вердикты как у find_avr_basis (unique / ambiguous / none / no_counterparty). Передайте esfRef или " +
        "возьмите пакет (limit). Ничего не записывает.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        esfRef: GUID.optional().describe("Ref_Key ЭСФ; без него — пакет ЭСФ без счёта-фактуры"),
        from: dateField("Начало периода ЭСФ (для пакета)").optional(),
        to: dateField("Конец периода ЭСФ (для пакета)").optional(),
        windowDays: z.number().int().min(0).max(365).default(31),
        tolerance: z.number().min(0).max(1000).default(0.01),
        maxCandidates: z.number().int().min(1).max(20).default(5),
        limit: z.number().int().min(1).max(200).default(50),
      },
      outputSchema: z
        .object({
          database: z.string(),
          summary: z.object({
            unique: z.number(),
            ambiguous: z.number(),
            none: z.number(),
            noCounterparty: z.number(),
            notNeeded: z.number(),
          }),
          items: z.array(z.object({ esfRef: z.string(), verdict: z.string() }).passthrough()),
        })
        .passthrough(),
    },
    ({
      database,
      organization,
      esfRef,
      from,
      to,
      windowDays = 31,
      tolerance = 0.01,
      maxCandidates = 5,
      limit = 50,
    }) =>
      guard("read.esf.find_esf_invoice", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [ESF], "Документ «ЭСФ»");
        const org = organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
        const select = [
          "Ref_Key",
          "Number",
          "Date",
          "DeletionMark",
          "Организация_Key",
          "Контрагент_Key",
          "Направление",
          "Статус",
          "Вид",
          "СуммаДокумента",
          "ДатаОборота",
          "РегистрационныйНомер",
          "СчетФактура",
          "СчетФактура_Type",
        ];
        const rows = esfRef
          ? [await conn.client.getEntity(`${set}(guid'${guidOf(esfRef)}')${buildQuery({ select })}`)]
          : (
              await fetchAll(
                conn.client,
                set,
                {
                  filter: and(
                    cmp("DeletionMark", "eq", "false"),
                    org ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined,
                    from ? cmp("Date", "ge", `datetime'${from}T00:00:00'`) : undefined,
                    to ? cmp("Date", "le", `datetime'${to}T23:59:59'`) : undefined,
                  ),
                  select,
                  orderby: "Date desc",
                },
                conn.behavior.pageSize,
                conn.behavior.maxRows,
              )
            ).rows;
        const linked = (r: Record<string, unknown>) =>
          isRef(r["СчетФактура"]) && typeOf(r["СчетФактура_Type"]) !== "Undefined";
        const takenByType = new Map<string, Set<string>>();
        const all = esfRef
          ? (
              await fetchAll(
                conn.client,
                set,
                {
                  filter: cmp("DeletionMark", "eq", "false"),
                  select: ["Ref_Key", "СчетФактура", "СчетФактура_Type"],
                },
                conn.behavior.pageSize,
                conn.behavior.maxRows,
              )
            ).rows
          : rows;
        for (const r of all.filter(linked)) {
          const t = typeOf(r["СчетФактура_Type"]);
          if (!takenByType.has(t)) takenByType.set(t, new Set());
          if (r["Ref_Key"] !== esfRef) takenByType.get(t)!.add(String(r["СчетФактура"]).toLowerCase());
        }
        const todo = (esfRef ? rows : rows.filter((r) => !linked(r))).slice(0, limit);
        if (esfRef && todo[0] && linked(todo[0]))
          throw new InputError("У этого ЭСФ счёт-фактура уже привязана.");
        const items: Array<Record<string, unknown>> = [];
        const summary = { unique: 0, ambiguous: 0, none: 0, noCounterparty: 0, notNeeded: 0 };
        for (const r of todo) {
          const direction = String(r["Направление"] ?? "Входящий");
          const invSet = INVOICE_BY_DIRECTION[direction];
          const status = String(r["Статус"] ?? "");
          const base = {
            esfRef: String(r["Ref_Key"]),
            number: String(r["Number"] ?? ""),
            date: String(r["Date"] ?? "").slice(0, 10),
            direction,
            status,
            amount: money(r["СуммаДокумента"]),
            registrationNumber: String(r["РегистрационныйНомер"] ?? "") || undefined,
          };
          if (/^(Отозванный|Аннулированный|ВОжиданииПодтвержденияОтзываПолучателя)$/.test(status)) {
            items.push({
              ...base,
              verdict: "notNeeded",
              candidates: [],
              note: `ЭСФ в статусе «${status}» — счёт-фактуру к нему привязывать не нужно.`,
            });
            summary.notNeeded++;
            continue;
          }
          if (!invSet || !(await conn.available()).has(invSet)) {
            items.push({
              ...base,
              verdict: "none",
              candidates: [],
              note: `Счета-фактуры для направления «${direction}» не опубликованы.`,
            });
            summary.none++;
            continue;
          }
          const counterparty = isRef(r["Контрагент_Key"]) ? String(r["Контрагент_Key"]) : undefined;
          const dates = [r["Date"], r["ДатаОборота"]].map(dayNum).filter((x): x is number => x !== undefined);
          const lo = Math.min(...dates) - windowDays;
          const hi = Math.max(...dates) + windowDays;
          const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
          const docs = dates.length
            ? (
                await fetchAll(
                  conn.client,
                  invSet,
                  {
                    filter: and(
                      cmp("DeletionMark", "eq", "false"),
                      cmp("Date", "ge", `datetime'${iso(lo)}T00:00:00'`),
                      cmp("Date", "le", `datetime'${iso(hi)}T23:59:59'`),
                      counterparty ? cmp("Контрагент_Key", "eq", odataGuid(counterparty)) : undefined,
                      isRef(r["Организация_Key"])
                        ? cmp("Организация_Key", "eq", odataGuid(String(r["Организация_Key"])))
                        : undefined,
                    ),
                    select: [
                      "Ref_Key",
                      "Number",
                      "Date",
                      "Posted",
                      "DeletionMark",
                      "Организация_Key",
                      "Контрагент_Key",
                      "СуммаДокумента",
                      "ДатаСовершенияОборотаПоРеализации",
                    ],
                  },
                  100,
                  conn.behavior.maxRows,
                )
              ).rows
            : [];
          const { candidates, verdict } = rankCandidates(
            {
              org: isRef(r["Организация_Key"]) ? String(r["Организация_Key"]) : undefined,
              counterparty,
              amounts: [money(r["СуммаДокумента"])],
              dates,
            },
            docs.map((d) => toDoc(d, "Договор_Key", ["ДатаСовершенияОборотаПоРеализации"])),
            { windowDays, tolerance, taken: takenByType.get(invSet) ?? new Set() },
          );
          if (verdict === "unique") summary.unique++;
          else if (verdict === "ambiguous") summary.ambiguous++;
          else if (verdict === "no_counterparty") summary.noCounterparty++;
          else summary.none++;
          items.push({
            ...base,
            invoiceEntity: invSet,
            verdict,
            candidates: candidates.slice(0, maxCandidates),
            ...(verdict === "none"
              ? {
                  note: "Свободной счёта-фактуры с такой суммой в окне дат нет: возможно, её ещё не ввели (тогда — create_document Document_СчетФактураПолученный на основании поступления).",
                }
              : {}),
            ...(verdict === "ambiguous"
              ? { note: "Подходит несколько счетов-фактур — выберите по номеру и дате." }
              : {}),
            ...(verdict === "no_counterparty"
              ? { note: "У ЭСФ не указан контрагент — кандидаты только по сумме и дате." }
              : {}),
          });
        }
        annotateBatch(items);
        return ok({ database: conn.cfg.name, summary, count: items.length, items });
      }),
  );
}
