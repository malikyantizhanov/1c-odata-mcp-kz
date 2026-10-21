import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { recorderFilter, resolveNames } from "../odata/accounting.js";
import { CATALOGS, resolveEntity } from "../config/mapping.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, odataGuid, odataString, or } from "../odata/query.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok, organizationField } from "./_shared.js";

/**
 * Извещения об отнесении в зачёт НДС (Казахстан, документ «Извещение об отнесении в зачёт НДС», обмен с ИС ЭСФ)
 * и сверка входящих ЭСФ, которые ещё не попали ни в одно извещение. Только чтение.
 *
 * Устройство в 1С (проверено на рабочей базе, только чтение):
 *  • Шапка: НомерИзвещения, РегистрационныйНомер (ZT-…), Статус (СтатусыИзвещенияЭСФ), Состояние
 *    (СостоянияИзвещенияЭСФ), ТипСобытия (Пользователь/Система), ТипПодписи, итоги: СуммаОборотаПоПриобретению,
 *    СуммаНДСПринятогоВЗачет, ОборотБезНДСИлиСНДСНеВЗачет, СуммаНДСНеВЗачет.
 *  • СтрокиИзвещения — по ЭСФ: РегНомерЭСФ, ТипЭСФ, ЭСФ_Key, ДатаОтнесенияВЗачет, КварталОтнесенияВЗачет «ГГГГ/К», суммы.
 *  • ДетализацияДанныхИзвещения — по первичным документам: ПервичныйДокумент (+_Type), ЭСФ_Key, суммы.
 *  • Ошибки — Текст, Поле.
 *  • Проводок по счетам документ не делает. Движения — расход по двум регистрам накопления:
 *    ОбязательстваПоИзвещениямИСЭСФ (по ЭСФ; приход делает проведённый входящий ЭСФ) и ОбязательстваПоЗачетуИСЭСФ
 *    (по документу поступления и налоговому периоду; приход делает поступление). Остаток первого регистра по ЭСФ —
 *    это то, что 1С ещё ждёт в извещении.
 */

export const NOTICE = "Document_ИзвещениеОбОтнесенииВЗачетНДС";
const ESF = "Document_ЭСФ";
export const REG_BY_ESF = "AccumulationRegister_ОбязательстваПоИзвещениямИСЭСФ";
export const REG_BY_RECEIPT = "AccumulationRegister_ОбязательстваПоЗачетуИСЭСФ";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}]/g, "").toLowerCase();
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const str = (v: unknown): string | undefined => {
  const s = String(v ?? "").trim();
  return s ? s : undefined;
};
const day = (v: unknown): string | undefined => {
  const s = String(v ?? "").slice(0, 10);
  return s && !s.startsWith("0001") ? s : undefined;
};
const cents = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const money = (c: number): number => c / 100;
const typeOf = (t: unknown): string => String(t ?? "").replace(/^StandardODATA\./, "");
const posted = (v: unknown) => v === true || v === "true";
const deleted = (v: unknown) => v === true || v === "true";

/** Статусы входящего ЭСФ, при которых относить его в зачёт не нужно (отозван, аннулирован, отклонён, удалён). */
export const ESF_EXCLUDED_STATUS =
  /^(Аннулирован|Отозван|Отклонен|Удален|Ошибочн|ВОжиданииПодтвержденияОтзыва|БиоидентификацияНеПройдена)/;

const NOT_IN_CONFIG =
  "В этой версии 1С документа «Извещение об отнесении в зачёт НДС» нет (в опубликованном составе OData нет " +
  `${NOTICE}). Если в конфигурации документ есть (1С:Бухгалтерия для Казахстана с обменом ИС ЭСФ), его нужно ` +
  "опубликовать: «Все функции → Обработки → Настройка стандартного интерфейса OData → Состав» — документ и три " +
  "его табличные части (СтрокиИзвещения, ДетализацияДанныхИзвещения, Ошибки).";

async function requireNotice(conn: Connection): Promise<string> {
  if (!(await conn.available()).has(NOTICE)) throw new InputError(NOT_IN_CONFIG);
  return NOTICE;
}

const HEADER_SELECT = [
  "Ref_Key",
  "Number",
  "Date",
  "DeletionMark",
  "Posted",
  "Организация_Key",
  "Идентификатор",
  "РегистрационныйНомер",
  "НомерИзвещения",
  "ПлательщикИдентификатор",
  "ПлательщикНаименование",
  "СтруктурноеПодразделениеИдентификатор",
  "СтруктурноеПодразделениеНаименование",
  "ДатаПоступленияИзвещениеВСистему",
  "Статус",
  "Состояние",
  "ТипСобытия",
  "ПричинаАвтоматическогоИзвещения",
  "АвторИзвещенияИИН",
  "АвторИзвещенияНаименование",
  "ТипПодписи",
  "Комментарий",
  "СуммаОборотаПоПриобретению",
  "СуммаНДСПринятогоВЗачет",
  "ОборотБезНДСИлиСНДСНеВЗачет",
  "СуммаНДСНеВЗачет",
];
const LINES = "СтрокиИзвещения";
const DETAILS = "ДетализацияДанныхИзвещения";
const ERRORS = "Ошибки";

const rowsOf = (r: ODataEntity, tp: string): ODataEntity[] =>
  Array.isArray(r[tp]) ? (r[tp] as ODataEntity[]) : [];

export interface NoticeTotals {
  turnover: number;
  vatOffset: number;
  turnoverNotOffset: number;
  vatNotOffset: number;
}
const headerTotals = (r: ODataEntity): NoticeTotals => ({
  turnover: money(cents(r["СуммаОборотаПоПриобретению"])),
  vatOffset: money(cents(r["СуммаНДСПринятогоВЗачет"])),
  turnoverNotOffset: money(cents(r["ОборотБезНДСИлиСНДСНеВЗачет"])),
  vatNotOffset: money(cents(r["СуммаНДСНеВЗачет"])),
});
/** Итоги по строкам (СтрокиИзвещения): оборот, НДС в зачёт, оборот без НДС / не в зачёт, НДС не в зачёт. */
export function lineTotals(lines: ODataEntity[]): NoticeTotals {
  const sum = (f: string) => money(lines.reduce((a, l) => a + cents(l[f]), 0));
  return {
    turnover: sum("СуммаОборотаПоПриобретению"),
    vatOffset: sum("СуммаНДСВЗачет"),
    turnoverNotOffset: sum("ОборотБезНДС"),
    vatNotOffset: sum("СуммаНДСНеВЗачет"),
  };
}
const sameTotals = (a: NoticeTotals, b: NoticeTotals) =>
  a.turnover === b.turnover &&
  a.vatOffset === b.vatOffset &&
  a.turnoverNotOffset === b.turnoverNotOffset &&
  a.vatNotOffset === b.vatNotOffset;

/** Краткая шапка извещения для списка и разбора. */
export function noticeHeader(r: ODataEntity) {
  const lines = rowsOf(r, LINES);
  const quarters = [...new Set(lines.map((l) => str(l["КварталОтнесенияВЗачет"])).filter(Boolean))].sort();
  return {
    ref: String(r["Ref_Key"]),
    number: String(r["Number"] ?? ""),
    date: day(r["Date"]) ?? "",
    noticeNumber: str(r["НомерИзвещения"]),
    registrationNumber: str(r["РегистрационныйНомер"]),
    status: str(r["Статус"]),
    state: str(r["Состояние"]),
    eventType: str(r["ТипСобытия"]),
    signatureType: str(r["ТипПодписи"]),
    receivedAt: str(r["ДатаПоступленияИзвещениеВСистему"])?.startsWith("0001")
      ? undefined
      : str(r["ДатаПоступленияИзвещениеВСистему"]),
    posted: posted(r["Posted"]),
    deletionMark: deleted(r["DeletionMark"]),
    totals: headerTotals(r),
    lines: lines.length,
    errors: rowsOf(r, ERRORS).length,
    quarters: quarters as string[],
  };
}

/** Квартал «2026/1», «2026-1», «2026Q1» → период; иначе from/to как есть. */
export function periodOf(
  quarter: string | undefined,
  from: string | undefined,
  to: string | undefined,
): { from: string; to: string; quarter?: string } {
  if (quarter) {
    const m = /^(\d{4})\s*[/\-.]?\s*[QКK]?\s*([1-4])$/iu.exec(quarter.trim());
    if (!m) throw new InputError("quarter — в формате «ГГГГ/К», напр. «2026/1».");
    const y = Number(m[1]);
    const q = Number(m[2]);
    const endMonth = q * 3;
    const last = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
    return {
      from: `${y}-${String(endMonth - 2).padStart(2, "0")}-01`,
      to: `${y}-${String(endMonth).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
      quarter: `${y}/${q}`,
    };
  }
  if (!from || !to) throw new InputError("Укажите quarter («2026/1») или период from и to.");
  if (from > to) throw new InputError("from позже to.");
  return { from, to };
}

async function loadByRefs(
  conn: Connection,
  set: string,
  refs: Iterable<string>,
  select: string[],
): Promise<Map<string, ODataEntity>> {
  const out = new Map<string, ODataEntity>();
  const unique = [...new Set([...refs].filter(isRef).map(guidOf))];
  if (!unique.length || !(await conn.available()).has(set)) return out;
  const BATCH = 20;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    try {
      const { rows } = await fetchAll(
        conn.client,
        set,
        { filter: or(...batch.map((k) => cmp("Ref_Key", "eq", odataGuid(k)))), select },
        BATCH,
        BATCH,
      );
      for (const r of rows) out.set(guidOf(String(r["Ref_Key"])), r);
    } catch {
      // не прочитано — останутся ссылки
    }
  }
  return out;
}

async function counterpartyNames(conn: Connection, keys: Iterable<string>): Promise<Map<string, string>> {
  const set = resolveEntity(CATALOGS.counterparties, await conn.available());
  return set ? resolveNames(conn, set, keys) : new Map();
}

/** Где ЭСФ уже есть в извещениях: по ЭСФ_Key и по регистрационному номеру. */
export interface NoticeUse {
  noticeRef: string;
  noticeNumber: string;
  noticeDate: string;
  posted: boolean;
  quarter?: string | undefined;
  vatOffset: number;
  vatNotOffset: number;
  matchedBy: "ЭСФ_Key" | "РегНомерЭСФ";
}
export function indexNotices(notices: ODataEntity[]): {
  byKey: Map<string, NoticeUse[]>;
  byReg: Map<string, NoticeUse[]>;
} {
  const byKey = new Map<string, NoticeUse[]>();
  const byReg = new Map<string, NoticeUse[]>();
  for (const n of notices) {
    if (deleted(n["DeletionMark"])) continue;
    for (const l of rowsOf(n, LINES)) {
      const use = {
        noticeRef: String(n["Ref_Key"]),
        noticeNumber: str(n["НомерИзвещения"]) ?? String(n["Number"] ?? ""),
        noticeDate: day(n["Date"]) ?? "",
        posted: posted(n["Posted"]),
        quarter: str(l["КварталОтнесенияВЗачет"]),
        vatOffset: money(cents(l["СуммаНДСВЗачет"])),
        vatNotOffset: money(cents(l["СуммаНДСНеВЗачет"])),
      };
      if (isRef(l["ЭСФ_Key"])) {
        const k = guidOf(String(l["ЭСФ_Key"]));
        byKey.set(k, [...(byKey.get(k) ?? []), { ...use, matchedBy: "ЭСФ_Key" }]);
      }
      const reg = str(l["РегНомерЭСФ"]);
      if (reg) byReg.set(reg, [...(byReg.get(reg) ?? []), { ...use, matchedBy: "РегНомерЭСФ" }]);
    }
  }
  return { byKey, byReg };
}

export type EsfVerdict = "unoffset" | "inUnpostedNotice" | "offset" | "noObligation" | "excluded";

export interface EsfForCheck {
  ref: string;
  number: string;
  date: string;
  turnoverDate?: string | undefined;
  registrationNumber?: string | undefined;
  status?: string | undefined;
  kind?: string | undefined;
  posted: boolean;
  counterpartyRef?: string | undefined;
  amount: number;
}

/**
 * Вердикт по входящему ЭСФ:
 *  excluded — отозван/аннулирован/отклонён или заменён исправленным ЭСФ (supersededBy);
 *  offset — есть в проведённом извещении; inUnpostedNotice — только в непроведённых извещениях;
 *  unoffset — ни в одном извещении нет, и 1С ждёт его (остаток регистра обязательств > 0; без регистра — по сверке);
 *  noObligation — ни в одном извещении нет, но остатка в регистре обязательств нет (ЭСФ без НДС к зачёту или не проведён).
 */
export function classifyEsf(
  esf: EsfForCheck,
  ctx: {
    uses: NoticeUse[];
    supersededBy?: string | undefined;
    balance?: { turnover: number; vat: number } | undefined;
    registerKnown: boolean;
  },
): { verdict: EsfVerdict; reason: string } {
  if (esf.status && ESF_EXCLUDED_STATUS.test(esf.status))
    return { verdict: "excluded", reason: `ЭСФ в статусе «${esf.status}» — в зачёт не относится.` };
  if (ctx.supersededBy)
    return {
      verdict: "excluded",
      reason: `ЭСФ заменён исправленным ЭСФ ${ctx.supersededBy} — в зачёт относится исправленный.`,
    };
  if (ctx.uses.some((u) => u.posted)) return { verdict: "offset", reason: "Есть в проведённом извещении." };
  if (ctx.uses.length)
    return {
      verdict: "inUnpostedNotice",
      reason:
        "Есть только в непроведённом извещении — в учёте 1С зачёт не отражён, пока извещение не проведено.",
    };
  if (!ctx.registerKnown)
    return {
      verdict: "unoffset",
      reason:
        "Ни в одном извещении нет (регистр обязательств по извещениям не опубликован — сумма НДС не проверена).",
    };
  if (ctx.balance && (ctx.balance.vat !== 0 || ctx.balance.turnover !== 0))
    return {
      verdict: "unoffset",
      reason: "Ни в одном извещении нет; 1С ждёт его в извещении (есть остаток обязательств).",
    };
  return {
    verdict: "noObligation",
    reason: esf.posted
      ? "Ни в одном извещении нет, но остатка обязательств по нему в 1С нет (обычно ЭСФ без НДС к зачёту)."
      : "Ни в одном извещении нет; ЭСФ не проведён, поэтому в регистре обязательств его нет — проверьте в 1С.",
  };
}

const ESF_SELECT = [
  "Ref_Key",
  "Number",
  "Date",
  "Posted",
  "DeletionMark",
  "Организация_Key",
  "Контрагент_Key",
  "Направление",
  "Статус",
  "Состояние",
  "Вид",
  "ДатаОборота",
  "РегистрационныйНомер",
  "СвязанныйЭСФ_Key",
  "СвязанныйЭСФРегистрационныйНомер",
  "СуммаДокумента",
];

async function findNotice(
  conn: Connection,
  set: string,
  ref: string | undefined,
  number: string | undefined,
  year: number | undefined,
  orgKey: string | undefined,
): Promise<ODataEntity> {
  const select = [...HEADER_SELECT, LINES, DETAILS, ERRORS];
  if (ref) return conn.client.getEntity(`${set}(guid'${guidOf(ref)}')${buildQuery({ select })}`);
  if (!number) throw new InputError("Укажите ref или number извещения.");
  const n = number.trim();
  const padded = /^\d+$/.test(n) && n.length < 11 ? n.padStart(11, "0") : undefined;
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        or(
          cmp("Number", "eq", odataString(n)),
          padded ? cmp("Number", "eq", odataString(padded)) : undefined,
          cmp("НомерИзвещения", "eq", odataString(n)),
        ),
        year ? cmp("Date", "ge", `datetime'${year}-01-01T00:00:00'`) : undefined,
        year ? cmp("Date", "le", `datetime'${year}-12-31T23:59:59'`) : undefined,
        orgKey ? cmp("Организация_Key", "eq", odataGuid(orgKey)) : undefined,
      ),
      select,
      orderby: "Date desc",
    },
    20,
    20,
  );
  if (!rows.length) throw new InputError(`Извещение с номером «${n}» не найдено.`);
  if (rows.length > 1) {
    const list = rows.map((r) => `${String(r["Number"])} от ${day(r["Date"])} (ref ${String(r["Ref_Key"])})`);
    throw new InputError(
      `Номеру «${n}» соответствует несколько извещений — укажите ref или year: ${list.join("; ")}`,
    );
  }
  return rows[0]!;
}

/** Движения извещения по регистрам обязательств: число строк и суммы (расход — закрытие обязательств). */
async function noticeMovements(conn: Connection, ref: string) {
  const available = await conn.available();
  const out: Array<Record<string, unknown>> = [];
  for (const reg of [REG_BY_ESF, REG_BY_RECEIPT]) {
    const set = `${reg}_RecordType`;
    if (!available.has(set) && !available.has(reg)) continue;
    try {
      const { rows } = await fetchAll(
        conn.client,
        set,
        { filter: recorderFilter(NOTICE, ref) },
        conn.behavior.pageSize,
        conn.behavior.maxRows,
      );
      const kinds = [...new Set(rows.map((r) => String(r["RecordType"] ?? "")))].filter(Boolean);
      out.push({
        register: reg,
        records: rows.length,
        recordTypes: kinds,
        turnover: money(rows.reduce((a, r) => a + cents(r["СуммаОборотаПоПриобретению"]), 0)),
        vat: money(rows.reduce((a, r) => a + cents(r["СуммаНДС"]), 0)),
      });
    } catch (e) {
      out.push({ register: reg, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export function registerVatNoticeTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.vat.list_offset_notices",
    {
      title: "Извещения об отнесении в зачёт НДС",
      description:
        "Список извещений об отнесении в зачёт НДС (Казахстан, документ обмена с ИС ЭСФ «Извещение об отнесении в " +
        "зачёт НДС»): номер, дата, номер извещения, регистрационный номер ИС ЭСФ, статус и состояние, тип события, " +
        "проведён ли, пометка удаления, итоги (оборот, НДС в зачёт, оборот без НДС / не в зачёт, НДС не в зачёт), " +
        "число строк и ошибок, кварталы отнесения. Отрицательные суммы — уменьшение ранее отнесённого. Фильтры: " +
        "период по дате документа, organization, posted; помеченные на удаление — только с includeDeleted. Сначала " +
        "новые. Только чтение; подписание и отправка — в 1С.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        from: dateField("Начало периода").optional(),
        to: dateField("Конец периода").optional(),
        posted: z.boolean().optional().describe("true — только проведённые, false — только непроведённые"),
        includeDeleted: z.boolean().default(false).describe("Показать и помеченные на удаление"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).max(1000000).default(0),
      },
      outputSchema: z
        .object({
          database: z.string(),
          count: z.number(),
          truncated: z.boolean(),
          notices: z.array(
            z.object({ ref: z.string(), number: z.string(), posted: z.boolean() }).passthrough(),
          ),
        })
        .passthrough(),
    },
    ({
      database,
      organization,
      from,
      to,
      posted: onlyPosted,
      includeDeleted = false,
      limit = 50,
      offset = 0,
    }) =>
      guard("read.vat.list_offset_notices", async () => {
        const conn = ctx.db(database);
        const set = await requireNotice(conn);
        const org = organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
        const { rows, truncated } = await fetchAll(
          conn.client,
          set,
          {
            filter: and(
              includeDeleted ? undefined : cmp("DeletionMark", "eq", "false"),
              org ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined,
              from ? cmp("Date", "ge", `datetime'${from}T00:00:00'`) : undefined,
              to ? cmp("Date", "le", `datetime'${to}T23:59:59'`) : undefined,
              onlyPosted === undefined ? undefined : cmp("Posted", "eq", onlyPosted ? "true" : "false"),
            ),
            select: [...HEADER_SELECT, LINES, ERRORS],
            orderby: "Date desc",
            skip: offset,
          },
          conn.behavior.pageSize,
          Math.min(limit, conn.behavior.maxRows),
        );
        const notices = rows
          .filter((r) => includeDeleted || !deleted(r["DeletionMark"]))
          .filter((r) => onlyPosted === undefined || posted(r["Posted"]) === onlyPosted)
          .map(noticeHeader);
        const sum = (f: keyof NoticeTotals) =>
          money(notices.reduce((a, n) => a + Math.round(n.totals[f] * 100), 0));
        return ok({
          database: conn.cfg.name,
          count: notices.length,
          truncated,
          ...(truncated ? { nextOffset: offset + rows.length } : {}),
          totals: {
            turnover: sum("turnover"),
            vatOffset: sum("vatOffset"),
            turnoverNotOffset: sum("turnoverNotOffset"),
            vatNotOffset: sum("vatNotOffset"),
          },
          notPosted: notices.filter((n) => !n.posted && !n.deletionMark).length,
          notices,
        });
      }),
  );

  server.registerTool(
    "read.vat.get_offset_notice",
    {
      title: "Извещение об отнесении в зачёт НДС — разбор",
      description:
        "Одно извещение об отнесении в зачёт НДС по ref или номеру (Number документа или НомерИзвещения; year — " +
        "если номер повторяется): шапка (статус, состояние, рег. номер ИС ЭСФ, плательщик, итоги), строки по ЭСФ " +
        "(рег. номер, тип ЭСФ, квартал и дата отнесения, суммы, найденный ЭСФ — номер, дата, дата оборота, статус, " +
        "контрагент), детализация по первичным документам (тип, номер, дата, проведён), ошибки ИС ЭСФ, сверка " +
        "итогов шапки со строками и движения по регистрам обязательств (у проведённого). Только чтение.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        ref: GUID.optional().describe("Ref_Key извещения"),
        number: z.string().max(50).optional().describe("Номер документа или номер извещения"),
        year: z
          .number()
          .int()
          .min(2000)
          .max(2100)
          .optional()
          .describe("Год документа (если номер повторяется)"),
        movements: z.boolean().default(true).describe("Показать движения проведённого извещения"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          notice: z.object({ ref: z.string(), number: z.string() }).passthrough(),
          lines: z.array(z.object({ registrationNumber: z.string().optional() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, ref, number, year, movements = true }) =>
      guard("read.vat.get_offset_notice", async () => {
        const conn = ctx.db(database);
        const set = await requireNotice(conn);
        const org = organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
        const r = await findNotice(conn, set, ref, number, year, org);
        const head = noticeHeader(r);
        const lines = rowsOf(r, LINES);
        const details = rowsOf(r, DETAILS);
        const esfKeys = [...lines, ...details].map((l) => String(l["ЭСФ_Key"] ?? ""));
        const esf = await loadByRefs(conn, ESF, esfKeys, [
          "Ref_Key",
          "Number",
          "Date",
          "ДатаОборота",
          "РегистрационныйНомер",
          "Статус",
          "Вид",
          "Контрагент_Key",
          "СуммаДокумента",
          "DeletionMark",
        ]);
        const cpNames = await counterpartyNames(
          conn,
          [...esf.values()].map((e) => String(e["Контрагент_Key"] ?? "")),
        );
        const byType = new Map<string, string[]>();
        for (const d of details) {
          const t = typeOf(d["ПервичныйДокумент_Type"]);
          if (!/^Document_[\p{L}\p{N}_]+$/u.test(t) || !isRef(d["ПервичныйДокумент"])) continue;
          byType.set(t, [...(byType.get(t) ?? []), String(d["ПервичныйДокумент"])]);
        }
        const primary = new Map<string, ODataEntity>();
        for (const [t, refs] of byType) {
          const got = await loadByRefs(conn, t, refs, ["Ref_Key", "Number", "Date", "Posted"]);
          for (const [k, v] of got) primary.set(`${t}:${k}`, v);
        }
        const esfInfo = (key: unknown) => {
          if (!isRef(key)) return undefined;
          const e = esf.get(guidOf(key));
          if (!e) return { ref: String(key), found: false };
          return {
            ref: String(key),
            found: true,
            number: String(e["Number"] ?? ""),
            date: day(e["Date"]),
            turnoverDate: day(e["ДатаОборота"]),
            registrationNumber: str(e["РегистрационныйНомер"]),
            status: str(e["Статус"]),
            kind: str(e["Вид"]),
            counterparty: cpNames.get(String(e["Контрагент_Key"] ?? "")),
            amount: money(cents(e["СуммаДокумента"])),
            deletionMark: deleted(e["DeletionMark"]),
          };
        };
        const outLines = lines.map((l) => ({
          lineNumber: Number(l["LineNumber"] ?? 0),
          registrationNumber: str(l["РегНомерЭСФ"]),
          esfType: str(l["ТипЭСФ"]),
          offsetDate: day(l["ДатаОтнесенияВЗачет"]),
          quarter: str(l["КварталОтнесенияВЗачет"]),
          currency: str(l["ВалютаКод"]),
          turnover: money(cents(l["СуммаОборотаПоПриобретению"])),
          vatOffset: money(cents(l["СуммаНДСВЗачет"])),
          turnoverNotOffset: money(cents(l["ОборотБезНДС"])),
          vatNotOffset: money(cents(l["СуммаНДСНеВЗачет"])),
          esf: esfInfo(l["ЭСФ_Key"]),
        }));
        const outDetails = details.map((d) => {
          const t = typeOf(d["ПервичныйДокумент_Type"]);
          const p = isRef(d["ПервичныйДокумент"])
            ? primary.get(`${t}:${guidOf(String(d["ПервичныйДокумент"]))}`)
            : undefined;
          const e = isRef(d["ЭСФ_Key"]) ? esf.get(guidOf(String(d["ЭСФ_Key"]))) : undefined;
          return {
            lineNumber: Number(d["LineNumber"] ?? 0),
            primaryDocument: isRef(d["ПервичныйДокумент"])
              ? {
                  type: t,
                  ref: String(d["ПервичныйДокумент"]),
                  ...(p
                    ? { number: String(p["Number"] ?? ""), date: day(p["Date"]), posted: posted(p["Posted"]) }
                    : { found: false }),
                }
              : undefined,
            esfRef: isRef(d["ЭСФ_Key"]) ? String(d["ЭСФ_Key"]) : undefined,
            esfRegistrationNumber: e ? str(e["РегистрационныйНомер"]) : undefined,
            offsetDate: day(d["ДатаОтнесенияВЗачет"]),
            quarter: str(d["КварталОтнесенияВЗачет"]),
            turnover: money(cents(d["СуммаОборотаПоПриобретению"])),
            vatOffset: money(cents(d["СуммаНДСВЗачет"])),
            turnoverNotOffset: money(cents(d["ОборотБезНДС"])),
            vatNotOffset: money(cents(d["СуммаНДСНеВЗачет"])),
          };
        });
        const byLines = lineTotals(lines);
        const notes: string[] = [];
        if (!sameTotals(head.totals, byLines))
          notes.push("Итоги шапки не совпадают с суммой строк — проверьте извещение в 1С.");
        if (details.length && !sameTotals(byLines, lineTotals(details)))
          notes.push("Суммы детализации по первичным документам не совпадают со строками по ЭСФ.");
        if (outLines.some((l) => l.vatOffset < 0))
          notes.push("Отрицательные суммы в зачёт — уменьшение ранее отнесённого в зачёт НДС.");
        if (!head.posted && !head.deletionMark)
          notes.push(
            "Извещение не проведено: движений по регистрам обязательств нет, проводит бухгалтер в 1С.",
          );
        const unfound = outLines.filter((l) => l.esf && !l.esf.found).length;
        if (unfound)
          notes.push(`ЭСФ не найден в базе для ${unfound} строк — сопоставление только по рег. номеру.`);
        return ok({
          database: conn.cfg.name,
          notice: {
            ...head,
            identifier: str(r["Идентификатор"]),
            payer: { iin: str(r["ПлательщикИдентификатор"]), name: str(r["ПлательщикНаименование"]) },
            division: str(r["СтруктурноеПодразделениеИдентификатор"])
              ? {
                  id: str(r["СтруктурноеПодразделениеИдентификатор"]),
                  name: str(r["СтруктурноеПодразделениеНаименование"]),
                }
              : undefined,
            autoReason: str(r["ПричинаАвтоматическогоИзвещения"]),
            author: { iin: str(r["АвторИзвещенияИИН"]), name: str(r["АвторИзвещенияНаименование"]) },
            comment: str(r["Комментарий"]),
          },
          lineTotals: byLines,
          totalsMatch: sameTotals(head.totals, byLines),
          lines: outLines,
          details: outDetails,
          errors: rowsOf(r, ERRORS).map((e) => ({
            lineNumber: Number(e["LineNumber"] ?? 0),
            text: str(e["Текст"]),
            field: str(e["Поле"]),
          })),
          ...(movements && head.posted ? { movements: await noticeMovements(conn, head.ref) } : {}),
          notes,
        });
      }),
  );

  server.registerTool(
    "read.vat.find_unoffset_esf",
    {
      title: "Входящие ЭСФ, не отнесённые в зачёт (нет в извещениях)",
      description:
        "Сверка входящих ЭСФ поставщиков за квартал (quarter «2026/1») или период from–to по дате оборота с " +
        "извещениями об отнесении в зачёт НДС: какие ЭСФ ещё не попали ни в одно извещение. Сопоставление по " +
        "ЭСФ_Key и регистрационному номеру. Не учитываются: помеченные на удаление ЭСФ и извещения; отозванные, " +
        "аннулированные, отклонённые ЭСФ; ЭСФ, заменённые исправленным. Если опубликован регистр обязательств по " +
        "извещениям, остаток по нему показывает, что 1С ждёт ЭСФ в извещении, и даёт сумму НДС. Группы: unoffset — " +
        "не отнесены; inUnpostedNotice — только в непроведённом извещении; noObligation — нет в извещениях, но и " +
        "остатка обязательств нет (обычно ЭСФ без НДС); offset — отнесены; excluded — не нужны. Только чтение: " +
        "извещение формируется, подписывается и отправляется в 1С.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        quarter: z.string().max(20).optional().describe("Квартал «ГГГГ/К», напр. «2026/1»"),
        from: dateField("Начало периода по дате оборота ЭСФ").optional(),
        to: dateField("Конец периода по дате оборота ЭСФ").optional(),
        counterpartyRef: GUID.optional().describe("Ref_Key поставщика"),
        includeOffset: z.boolean().default(false).describe("Показать и отнесённые ЭСФ списком"),
        limit: z.number().int().min(1).max(500).default(200).describe("Максимум строк в каждой группе"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          period: z.object({ from: z.string(), to: z.string() }).passthrough(),
          summary: z.object({ checked: z.number(), unoffset: z.number() }).passthrough(),
          unoffset: z.array(z.object({ ref: z.string() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, quarter, from, to, counterpartyRef, includeOffset = false, limit = 200 }) =>
      guard("read.vat.find_unoffset_esf", async () => {
        const conn = ctx.db(database);
        const period = periodOf(quarter, from, to);
        const set = await requireNotice(conn);
        const available = await conn.available();
        if (!available.has(ESF))
          throw new InputError("Документ «ЭСФ» (Document_ЭСФ) не опубликован в OData.");
        const org = organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
        const orgFilter = org ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined;
        const { rows: esfRows, truncated } = await fetchAll(
          conn.client,
          ESF,
          {
            filter: and(
              cmp("DeletionMark", "eq", "false"),
              cmp("Направление", "eq", odataString("Входящий")),
              orgFilter,
              cmp("ДатаОборота", "ge", `datetime'${period.from}T00:00:00'`),
              cmp("ДатаОборота", "le", `datetime'${period.to}T23:59:59'`),
              counterpartyRef ? cmp("Контрагент_Key", "eq", odataGuid(guidOf(counterpartyRef))) : undefined,
            ),
            select: ESF_SELECT,
            orderby: "ДатаОборота",
          },
          conn.behavior.pageSize,
          conn.behavior.analyticsMaxRows,
        );
        const inPeriod = esfRows.filter(
          (r) => !deleted(r["DeletionMark"]) && String(r["Направление"] ?? "Входящий") === "Входящий",
        );
        // Исправленные входящие ЭСФ (за любой период): исходный ЭСФ, на который они ссылаются, в зачёт не идёт.
        const { rows: corrected } = await fetchAll(
          conn.client,
          ESF,
          {
            filter: and(
              cmp("DeletionMark", "eq", "false"),
              cmp("Направление", "eq", odataString("Входящий")),
              cmp("Вид", "eq", odataString("Исправленный")),
              orgFilter,
            ),
            select: [
              "Ref_Key",
              "Number",
              "Вид",
              "РегистрационныйНомер",
              "Статус",
              "СвязанныйЭСФ_Key",
              "СвязанныйЭСФРегистрационныйНомер",
            ],
          },
          conn.behavior.pageSize,
          conn.behavior.maxRows,
        );
        const supersededKey = new Map<string, string>();
        const supersededReg = new Map<string, string>();
        for (const c of corrected) {
          if (c["Вид"] !== undefined && c["Вид"] !== "Исправленный") continue;
          if (str(c["Статус"]) && ESF_EXCLUDED_STATUS.test(String(c["Статус"]))) continue;
          const label = str(c["РегистрационныйНомер"]) ?? String(c["Number"] ?? "");
          if (isRef(c["СвязанныйЭСФ_Key"])) supersededKey.set(guidOf(String(c["СвязанныйЭСФ_Key"])), label);
          const reg = str(c["СвязанныйЭСФРегистрационныйНомер"]);
          if (reg) supersededReg.set(reg, label);
        }
        const { rows: notices } = await fetchAll(
          conn.client,
          set,
          {
            filter: and(cmp("DeletionMark", "eq", "false"), orgFilter),
            select: ["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "НомерИзвещения", LINES],
          },
          conn.behavior.pageSize,
          conn.behavior.maxRows,
        );
        const { byKey, byReg } = indexNotices(notices);
        const registerKnown = available.has(REG_BY_ESF);
        const balances = new Map<string, { turnover: number; vat: number }>();
        let registerError: string | undefined;
        if (registerKnown) {
          try {
            const { rows } = await fetchAll(
              conn.client,
              `${REG_BY_ESF}/Balance`,
              { filter: orgFilter },
              conn.behavior.pageSize,
              conn.behavior.analyticsMaxRows,
            );
            for (const b of rows) {
              if (!isRef(b["ЭСФ_Key"])) continue;
              const k = guidOf(String(b["ЭСФ_Key"]));
              const prev = balances.get(k) ?? { turnover: 0, vat: 0 };
              balances.set(k, {
                turnover: prev.turnover + cents(b["СуммаОборотаПоПриобретениюBalance"]),
                vat: prev.vat + cents(b["СуммаНДСBalance"]),
              });
            }
          } catch (e) {
            registerError = e instanceof Error ? e.message : String(e);
          }
        }
        const cpNames = await counterpartyNames(
          conn,
          inPeriod.map((r) => String(r["Контрагент_Key"] ?? "")),
        );
        const groups: Record<EsfVerdict, Array<Record<string, unknown>>> = {
          unoffset: [],
          inUnpostedNotice: [],
          noObligation: [],
          offset: [],
          excluded: [],
        };
        let unoffsetVat = 0;
        let unoffsetTurnover = 0;
        for (const r of inPeriod) {
          const key = guidOf(String(r["Ref_Key"]));
          const reg = str(r["РегистрационныйНомер"]);
          const uses = [...(byKey.get(key) ?? []), ...(reg ? (byReg.get(reg) ?? []) : [])].filter(
            (u, i, all) => all.findIndex((x) => x.noticeRef === u.noticeRef) === i,
          );
          const esf: EsfForCheck = {
            ref: String(r["Ref_Key"]),
            number: String(r["Number"] ?? ""),
            date: day(r["Date"]) ?? "",
            turnoverDate: day(r["ДатаОборота"]),
            registrationNumber: reg,
            status: str(r["Статус"]),
            kind: str(r["Вид"]),
            posted: posted(r["Posted"]),
            counterpartyRef: isRef(r["Контрагент_Key"]) ? String(r["Контрагент_Key"]) : undefined,
            amount: money(cents(r["СуммаДокумента"])),
          };
          const bal = registerKnown && !registerError ? balances.get(key) : undefined;
          const { verdict, reason } = classifyEsf(esf, {
            uses,
            supersededBy: supersededKey.get(key) ?? (reg ? supersededReg.get(reg) : undefined),
            balance: bal,
            registerKnown: registerKnown && !registerError,
          });
          if (verdict === "unoffset" && bal) {
            unoffsetVat += bal.vat;
            unoffsetTurnover += bal.turnover;
          }
          groups[verdict].push({
            ...esf,
            counterparty: esf.counterpartyRef ? cpNames.get(esf.counterpartyRef) : undefined,
            ...(bal ? { obligation: { turnover: money(bal.turnover), vat: money(bal.vat) } } : {}),
            ...(uses.length
              ? {
                  notices: uses.map((u) => ({
                    number: u.noticeNumber,
                    date: u.noticeDate,
                    posted: u.posted,
                    quarter: u.quarter,
                    vatOffset: u.vatOffset,
                    vatNotOffset: u.vatNotOffset,
                    matchedBy: u.matchedBy,
                  })),
                }
              : {}),
            reason,
          });
        }
        const notes: string[] = [];
        if (!registerKnown)
          notes.push(
            `Регистр ${REG_BY_ESF} не опубликован: «не отнесены» — все ЭСФ без извещения, включая ЭСФ без НДС; сумма НДС не показана.`,
          );
        if (registerError) notes.push(`Остатки регистра обязательств не прочитаны: ${registerError}`);
        if (truncated) notes.push("ЭСФ за период больше лимита выборки — сузьте период или поставщика.");
        const cut = (a: Array<Record<string, unknown>>) => a.slice(0, limit);
        return ok({
          database: conn.cfg.name,
          period,
          sources: {
            notices: notices.length,
            noticesNotPosted: notices.filter((n) => !posted(n["Posted"])).length,
            obligationRegister: registerKnown && !registerError,
          },
          summary: {
            checked: inPeriod.length,
            unoffset: groups.unoffset.length,
            unoffsetTurnover: money(unoffsetTurnover),
            unoffsetVat: money(unoffsetVat),
            inUnpostedNotice: groups.inUnpostedNotice.length,
            noObligation: groups.noObligation.length,
            offset: groups.offset.length,
            excluded: groups.excluded.length,
          },
          unoffset: cut(groups.unoffset),
          inUnpostedNotice: cut(groups.inUnpostedNotice),
          noObligation: cut(groups.noObligation),
          excluded: cut(groups.excluded),
          ...(includeOffset ? { offset: cut(groups.offset) } : {}),
          notes,
        });
      }),
  );
}
