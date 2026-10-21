import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, odataGuid, or } from "../odata/query.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, organizationField } from "./_shared.js";
import { fitToMetadata } from "./esf-create.js";
import { nextNumber } from "./esf-fill.js";
import {
  DETAILS,
  ESF,
  LINES,
  REG_BY_ESF,
  REG_BY_RECEIPT,
  counterpartyNames,
  loadByRefs,
  periodOf,
  reconcileIncomingEsf,
  requireNotice,
  type EsfVerdict,
  type NoticeTotals,
} from "./vat-notices.js";
import { confirmField, createOrPreview, odataDate } from "./write.js";

/**
 * Черновик извещения об отнесении в зачёт НДС (Document_ИзвещениеОбОтнесенииВЗачетНДС) по входящим ЭСФ квартала.
 *
 * Как заполнено проведённое извещение, сформированное в 1С (сверено с рабочей базой, только чтение):
 *  • СтрокиИзвещения — по одному ЭСФ: суммы = остаток регистра ОбязательстваПоИзвещениямИСЭСФ по ЭСФ (приход
 *    делает входящий ЭСФ), ДатаОтнесенияВЗачет — последний день квартала, КварталОтнесенияВЗачет «ГГГГ/К»,
 *    РегНомерЭСФ и ТипЭСФ (Вид) — из ЭСФ, валюта — из ЭСФ.
 *  • ДетализацияДанныхИзвещения — по документу поступления, связанному с ЭСФ (регистр
 *    АктуальныеЭСФПоПервичнымДокументам): суммы = остаток регистра ОбязательстваПоЗачетуИСЭСФ по поступлению за
 *    налоговый период (последний день квартала); приход делает поступление (по строке на ставку НДС).
 *  • Проведение даёт расход по обоим регистрам ровно на суммы строк и детализации.
 * Подбор ЭСФ — тот же, что в read.vat.find_unoffset_esf (группа unoffset). Поля обмена с ИС ЭСФ не заполняются,
 * документ не проводится: подпись ЭЦП, отправка и проведение — в 1С.
 */

const LINKS = "InformationRegister_АктуальныеЭСФПоПервичнымДокументам";
const ORG_SET = "Catalog_Организации";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
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
const fmt = (c: number) =>
  money(c)
    .toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/\u00a0/g, " ");
const num = (v: unknown) => String(v ?? "").replace(/^0+(?=\d)/, "");

/**
 * Поля обмена с ИС ЭСФ и подписи: в черновик извещения не пишутся никогда (их заполняет 1С при отправке и
 * получении ответа ИС). Проверяется перед записью.
 */
export const NOTICE_EXCHANGE_FIELDS = new Set([
  "Идентификатор",
  "РегистрационныйНомер",
  "НомерИзвещения",
  "Статус",
  "Состояние",
  "ЭЦП",
  "ТипПодписи",
  "ДатаПоступленияИзвещениеВСистему",
  "ПричинаАвтоматическогоИзвещения",
  "АвторИзвещенияИИН",
  "АвторИзвещенияНаименование",
  "Ошибки",
  "Posted",
  "DeletionMark",
]);

/** ЭСФ-кандидат в строку извещения; суммы в копейках. */
export interface DraftCandidate {
  ref: string;
  number: string;
  date?: string | undefined;
  turnoverDate?: string | undefined;
  registrationNumber?: string | undefined;
  kind?: string | undefined;
  counterpartyRef?: string | undefined;
  counterparty?: string | undefined;
  currencyRef?: string | undefined;
  currencyCode?: string | undefined;
  /** Остаток регистра ОбязательстваПоИзвещениямИСЭСФ по ЭСФ, копейки. */
  balance: { turnover: number; vat: number };
}
export interface PrimaryLink {
  esfRef: string;
  type: string;
  ref: string;
}
/** Остаток регистра ОбязательстваПоЗачетуИСЭСФ по документу поступления и налоговому периоду; копейки. */
export interface ReceiptBalance {
  receiptRef: string;
  type: string;
  period: string;
  turnover: number;
  vat: number;
  turnoverNoVat: number;
  vatNotOffset: number;
}
export interface SkippedEsf {
  ref: string;
  number?: string | undefined;
  registrationNumber?: string | undefined;
  counterparty?: string | undefined;
  verdict?: EsfVerdict | undefined;
  reason: string;
}

const zero = () => ({ turnover: 0, vat: 0, turnoverNoVat: 0, vatNotOffset: 0 });

/**
 * Строки и детализация извещения из кандидатов, связей ЭСФ ↔ поступление и остатков по поступлениям — как в
 * извещении, сформированном в 1С. Чистая функция (без запросов к 1С).
 */
export function buildNoticeRows(input: {
  quarter: string;
  offsetDate: string;
  candidates: DraftCandidate[];
  links: PrimaryLink[];
  receiptBalances: ReceiptBalance[] | undefined;
}): {
  lines: ODataEntity[];
  details: ODataEntity[];
  skipped: SkippedEsf[];
  warnings: string[];
  totals: NoticeTotals;
} {
  const { quarter, offsetDate, candidates, links } = input;
  const warnings: string[] = [];
  const skipped: SkippedEsf[] = [];
  const lines: ODataEntity[] = [];
  const details: ODataEntity[] = [];
  const at = `${offsetDate}T00:00:00`;
  const chosen = new Set(candidates.map((c) => guidOf(c.ref)));
  const esfByReceipt = new Map<string, Set<string>>();
  for (const l of links) {
    if (!chosen.has(guidOf(l.esfRef))) continue;
    const k = `${l.type}:${guidOf(l.ref)}`;
    esfByReceipt.set(k, new Set([...(esfByReceipt.get(k) ?? []), guidOf(l.esfRef)]));
  }
  const balances = new Map<string, ReceiptBalance[]>();
  for (const b of input.receiptBalances ?? []) {
    const k = `${b.type}:${guidOf(b.receiptRef)}`;
    balances.set(k, [...(balances.get(k) ?? []), b]);
  }
  const label = (c: DraftCandidate) => `ЭСФ №${num(c.number)}${c.date ? ` от ${c.date}` : ""}`;
  for (const c of candidates) {
    const reg = c.registrationNumber;
    if (!reg) {
      skipped.push({
        ref: c.ref,
        number: c.number,
        counterparty: c.counterparty,
        reason: "У ЭСФ нет регистрационного номера ИС ЭСФ — в извещение не включается.",
      });
      continue;
    }
    if (c.balance.vat < 0 || c.balance.turnover < 0 || (c.balance.vat === 0 && c.balance.turnover === 0)) {
      skipped.push({
        ref: c.ref,
        number: c.number,
        registrationNumber: reg,
        counterparty: c.counterparty,
        reason: `Остаток обязательств по ЭСФ не положительный (оборот ${fmt(c.balance.turnover)}, НДС ${fmt(c.balance.vat)}) — уменьшение зачёта оформляется в 1С.`,
      });
      continue;
    }
    const own = links.filter((l) => guidOf(l.esfRef) === guidOf(c.ref));
    const mine: ODataEntity[] = [];
    const sum = zero();
    for (const l of own) {
      const k = `${l.type}:${guidOf(l.ref)}`;
      if ((esfByReceipt.get(k)?.size ?? 0) > 1) {
        warnings.push(
          `${label(c)}: поступление ${l.ref} связано с несколькими ЭСФ — детализацию по нему заполните в 1С.`,
        );
        continue;
      }
      if (!input.receiptBalances) continue;
      const rows = (balances.get(k) ?? []).filter(
        (b) => b.turnover !== 0 || b.vat !== 0 || b.turnoverNoVat !== 0 || b.vatNotOffset !== 0,
      );
      const other = rows.filter((b) => b.period !== offsetDate);
      if (other.length)
        warnings.push(
          `${label(c)}: у поступления ${l.ref} есть остаток за другой налоговый период (${[...new Set(other.map((b) => b.period))].join(", ")}) — в это извещение не включён.`,
        );
      const inQuarter = rows.filter((b) => b.period === offsetDate);
      if (!inQuarter.length) continue;
      const s = inQuarter.reduce(
        (a, b) => ({
          turnover: a.turnover + b.turnover,
          vat: a.vat + b.vat,
          turnoverNoVat: a.turnoverNoVat + b.turnoverNoVat,
          vatNotOffset: a.vatNotOffset + b.vatNotOffset,
        }),
        zero(),
      );
      sum.turnover += s.turnover;
      sum.vat += s.vat;
      sum.turnoverNoVat += s.turnoverNoVat;
      sum.vatNotOffset += s.vatNotOffset;
      mine.push({
        ПервичныйДокумент: guidOf(l.ref),
        ПервичныйДокумент_Type: `StandardODATA.${l.type}`,
        ЭСФ_Key: guidOf(c.ref),
        ДатаОтнесенияВЗачет: at,
        КварталОтнесенияВЗачет: quarter,
        СуммаОборотаПоПриобретению: money(s.turnover),
        СуммаНДСВЗачет: money(s.vat),
        ОборотБезНДС: money(s.turnoverNoVat),
        СуммаНДСНеВЗачет: money(s.vatNotOffset),
      });
    }
    if (input.receiptBalances && !mine.length)
      warnings.push(
        own.length
          ? `${label(c)}: у связанного поступления нет остатка в регистре «Обязательства по зачёту ИС ЭСФ» за ${quarter} — строка без детализации, проверьте в 1С.`
          : `${label(c)}: документ поступления по ЭСФ не найден (регистр «Актуальные ЭСФ по первичным документам») — строка без детализации, проверьте в 1С.`,
      );
    if (mine.length && (sum.turnover !== c.balance.turnover || sum.vat !== c.balance.vat))
      warnings.push(
        `${label(c)}: детализация по поступлениям (оборот ${fmt(sum.turnover)}, НДС ${fmt(sum.vat)}) не совпадает с остатком по ЭСФ (оборот ${fmt(c.balance.turnover)}, НДС ${fmt(c.balance.vat)}) — проверьте в 1С.`,
      );
    const n = lines.length + 1;
    lines.push({
      LineNumber: n,
      ПорядковыйНомер: n,
      РегНомерЭСФ: reg,
      ТипЭСФ: c.kind ?? "Обычный",
      ЭСФ_Key: guidOf(c.ref),
      ДатаОтнесенияВЗачет: at,
      КварталОтнесенияВЗачет: quarter,
      ...(c.currencyRef ? { Валюта_Key: guidOf(c.currencyRef) } : {}),
      ...(c.currencyCode ? { ВалютаКод: c.currencyCode } : {}),
      СуммаОборотаПоПриобретению: money(c.balance.turnover),
      СуммаНДСВЗачет: money(c.balance.vat),
      ОборотБезНДС: money(sum.turnoverNoVat),
      СуммаНДСНеВЗачет: money(sum.vatNotOffset),
    });
    details.push(...mine.map((d, i) => ({ LineNumber: details.length + i + 1, ...d })));
  }
  const total = (f: string) => money(lines.reduce((a, l) => a + cents(l[f]), 0));
  return {
    lines,
    details,
    skipped,
    warnings,
    totals: {
      turnover: total("СуммаОборотаПоПриобретению"),
      vatOffset: total("СуммаНДСВЗачет"),
      turnoverNotOffset: total("ОборотБезНДС"),
      vatNotOffset: total("СуммаНДСНеВЗачет"),
    },
  };
}

/** Связи ЭСФ → документы поступления (регистр АктуальныеЭСФПоПервичнымДокументам), пачками по 20 ЭСФ. */
async function primaryLinks(conn: Connection, esfRefs: string[]): Promise<PrimaryLink[] | undefined> {
  if (!(await conn.available()).has(LINKS)) return undefined;
  const out: PrimaryLink[] = [];
  const unique = [...new Set(esfRefs.map(guidOf))];
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const { rows } = await fetchAll(
      conn.client,
      LINKS,
      {
        filter: or(...batch.map((k) => cmp("ЭСФ_Key", "eq", odataGuid(k)))),
        select: ["ЭСФ_Key", "ПервичныйДокумент", "ПервичныйДокумент_Type"],
      },
      conn.behavior.pageSize,
      conn.behavior.maxRows,
    );
    for (const r of rows) {
      const t = typeOf(r["ПервичныйДокумент_Type"]);
      if (!isRef(r["ЭСФ_Key"]) || !isRef(r["ПервичныйДокумент"]) || !/^Document_[\p{L}\p{N}_]+$/u.test(t))
        continue;
      out.push({ esfRef: String(r["ЭСФ_Key"]), type: t, ref: String(r["ПервичныйДокумент"]) });
    }
  }
  return out;
}

/** Остатки регистра ОбязательстваПоЗачетуИСЭСФ по организации (текущие). */
async function receiptBalances(conn: Connection, org: string): Promise<ReceiptBalance[] | undefined> {
  const available = await conn.available();
  if (!available.has(REG_BY_RECEIPT) && !available.has(`${REG_BY_RECEIPT}_RecordType`)) return undefined;
  const { rows } = await fetchAll(
    conn.client,
    `${REG_BY_RECEIPT}/Balance`,
    { filter: cmp("Организация_Key", "eq", odataGuid(org)) },
    conn.behavior.pageSize,
    conn.behavior.analyticsMaxRows,
  );
  return rows
    .filter((r) => isRef(r["ДокументПоступления"]))
    .map((r) => ({
      receiptRef: String(r["ДокументПоступления"]),
      type: typeOf(r["ДокументПоступления_Type"]),
      period: day(r["НалоговыйПериод"]) ?? "",
      turnover: cents(r["СуммаОборотаПоПриобретениюBalance"]),
      vat: cents(r["СуммаНДСBalance"]),
      turnoverNoVat: cents(r["СуммаОборотаБезНДСBalance"]),
      vatNotOffset: cents(r["СуммаНДСНеВЗачетBalance"]),
    }));
}

/** Следующий номер извещения в году даты: максимум среди извещений базы за год + 1 (формат — как у них). */
async function planNoticeNumber(conn: Connection, set: string, date: string) {
  const y = date.slice(0, 4);
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        cmp("Date", "ge", `datetime'${y}-01-01T00:00:00'`),
        cmp("Date", "le", `datetime'${y}-12-31T23:59:59'`),
      ),
      select: ["Ref_Key", "Number", "Date"],
    },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  const numbers = rows.map((r) => String(r["Number"] ?? "").trim()).filter(Boolean);
  const n = nextNumber(numbers, { prefix: "", width: 11 });
  return {
    number: n.number,
    taken: new Set(numbers),
    how: numbers.length
      ? `следующий после ${num(numbers.sort().at(-1))} среди извещений базы за ${y} год`
      : `первое извещение базы за ${y} год`,
  };
}

function withPreview(res: CallToolResult, extra: Record<string, unknown>): CallToolResult {
  if (res.isError || !res.structuredContent) return res;
  const structuredContent = { ...res.structuredContent, ...extra };
  return {
    ...res,
    structuredContent,
    content: res.content.map((c) =>
      c.type === "text" ? { ...c, text: JSON.stringify(structuredContent, null, 2) } : c,
    ),
  };
}

export function registerVatNoticeDraftTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.vat.create_offset_notice_draft",
    {
      title: "Черновик извещения об отнесении в зачёт НДС по входящим ЭСФ квартала",
      description:
        "Создаёт НЕпроведённый черновик извещения об отнесении в зачёт НДС (Казахстан, обмен с ИС ЭСФ) за квартал " +
        "(quarter «2026/2») по организации: строки — входящие ЭСФ, которые 1С ждёт в извещении (та же сверка, что " +
        "read.vat.find_unoffset_esf, группа unoffset: нет ни в одном извещении и есть остаток регистра обязательств), " +
        "при желании только по поставщику (counterpartyRef) и/или списку ЭСФ (esfRefs). Суммы строки — остаток " +
        "обязательств по ЭСФ; детализация — документы поступления по ЭСФ с остатком регистра «Обязательства по зачёту " +
        "ИС ЭСФ» за квартал; дата отнесения — последний день квартала. Номер — следующий за год (или number). Поля " +
        "обмена с ИС (идентификатор, рег. номер, номер извещения, статус, состояние, ЭЦП, тип подписи) не заполняются; " +
        "документ не проводится. Подпись, отправка в ИС ЭСФ и проведение — в 1С. Предпросмотр по умолчанию: шапка, " +
        "строки, детализация, итоги, пропущенные ЭСФ с причиной; создание — confirm=true с operationId после " +
        "согласия бухгалтера.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        quarter: z.string().max(20).describe("Квартал отнесения в зачёт «ГГГГ/К», напр. «2026/2»"),
        counterpartyRef: GUID.optional().describe("Ref_Key поставщика — только его ЭСФ"),
        esfRefs: z
          .array(GUID)
          .min(1)
          .max(500)
          .optional()
          .describe("Ref_Key входящих ЭСФ — только они (каждый должен быть «не отнесён» в этом квартале)"),
        date: dateField("Дата извещения (по умолчанию — сегодня)").optional(),
        number: z
          .string()
          .trim()
          .min(1)
          .max(20)
          .regex(/^\S*\d$/, "Номер — цифры (допускается префикс без пробелов)")
          .optional()
          .describe("Номер документа; по умолчанию — следующий за год"),
        comment: z.string().max(500).optional().describe("Комментарий в документе"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, organization, quarter, counterpartyRef, esfRefs, date, number, comment, confirm = false }) =>
      guard("write.vat.create_offset_notice_draft", async () => {
        const conn = ctx.db(database);
        const period = periodOf(quarter, undefined, undefined);
        const q = period.quarter!;
        const set = await requireNotice(conn);
        const available = await conn.available();
        if (!available.has(REG_BY_ESF))
          throw new InputError(
            `Регистр ${REG_BY_ESF} не опубликован в OData — без остатка обязательств по ЭСФ суммы строк не определить. ` +
              "Опубликуйте его («Настройка стандартного интерфейса OData → Состав») или сформируйте извещение в 1С.",
          );
        const org = await resolveOrgOrDefault(conn, organization);
        const rec = await reconcileIncomingEsf(conn, { org: org.ref, period, counterpartyRef });
        if (rec.registerError)
          throw new InputError(
            `Остатки регистра обязательств по извещениям не прочитаны: ${rec.registerError}`,
          );
        if (rec.truncated)
          throw new InputError(
            "ЭСФ за квартал больше лимита выборки — укажите поставщика (counterpartyRef) или esfRefs.",
          );
        const wanted = esfRefs ? new Set(esfRefs.map(guidOf)) : undefined;
        const skipped: SkippedEsf[] = [];
        const picked = rec.items.filter((i) => !wanted || wanted.has(guidOf(i.esf.ref)));
        if (wanted) {
          const found = new Set(picked.map((i) => guidOf(i.esf.ref)));
          for (const r of wanted)
            if (!found.has(r))
              skipped.push({
                ref: r,
                reason: `Не входящий ЭСФ организации с датой оборота в ${q}${counterpartyRef ? " от этого поставщика" : ""} (или помечен на удаление).`,
              });
        }
        const cpNames = await counterpartyNames(
          conn,
          picked.map((i) => i.esf.counterpartyRef ?? ""),
        );
        for (const i of picked)
          if (i.verdict !== "unoffset" && wanted)
            skipped.push({
              ref: i.esf.ref,
              number: i.esf.number,
              registrationNumber: i.esf.registrationNumber,
              counterparty: i.esf.counterpartyRef ? cpNames.get(i.esf.counterpartyRef) : undefined,
              verdict: i.verdict,
              reason: i.reason,
            });
        const chosen = picked.filter((i) => i.verdict === "unoffset" && i.balance);
        const currency = await loadByRefs(
          conn,
          ESF,
          chosen.map((i) => i.esf.ref),
          ["Ref_Key", "Валюта_Key", "ВалютаКод"],
        );
        const candidates: DraftCandidate[] = chosen.map((i) => {
          const cur = currency.get(guidOf(i.esf.ref));
          return {
            ref: i.esf.ref,
            number: i.esf.number,
            date: i.esf.date,
            turnoverDate: i.esf.turnoverDate,
            registrationNumber: i.esf.registrationNumber,
            kind: i.esf.kind,
            counterpartyRef: i.esf.counterpartyRef,
            counterparty: i.esf.counterpartyRef ? cpNames.get(i.esf.counterpartyRef) : undefined,
            currencyRef: isRef(cur?.["Валюта_Key"]) ? String(cur!["Валюта_Key"]) : undefined,
            currencyCode: str(cur?.["ВалютаКод"]),
            balance: i.balance!,
          };
        });
        const warnings: string[] = [];
        const links = candidates.length
          ? await primaryLinks(
              conn,
              candidates.map((c) => c.ref),
            )
          : [];
        if (!links)
          warnings.push(
            `Регистр ${LINKS} не опубликован — детализация по поступлениям не заполнена, заполните её в 1С.`,
          );
        const balances = candidates.length && links ? await receiptBalances(conn, org.ref) : undefined;
        if (links && candidates.length && !balances)
          warnings.push(
            `Регистр ${REG_BY_RECEIPT} не опубликован — детализация по поступлениям не заполнена, заполните её в 1С.`,
          );
        const built = buildNoticeRows({
          quarter: q,
          offsetDate: period.to,
          candidates,
          links: links ?? [],
          receiptBalances: balances,
        });
        skipped.push(...built.skipped);
        warnings.push(...built.warnings);
        const summary = {
          checked: rec.items.length,
          unoffset: rec.items.filter((i) => i.verdict === "unoffset").length,
          inUnpostedNotice: rec.items.filter((i) => i.verdict === "inUnpostedNotice").length,
          noObligation: rec.items.filter((i) => i.verdict === "noObligation").length,
          offset: rec.items.filter((i) => i.verdict === "offset").length,
          excluded: rec.items.filter((i) => i.verdict === "excluded").length,
        };
        if (!built.lines.length)
          throw new InputError(
            `Извещение не создано: за ${q} нет входящих ЭСФ, которые 1С ждёт в извещении` +
              `${counterpartyRef || esfRefs ? " (с учётом отбора)" : ""}. Сверка: ${JSON.stringify(summary)}.` +
              (skipped.length
                ? ` Пропущены: ${skipped.map((s) => `${s.number ?? s.ref} — ${s.reason}`).join("; ")}`
                : ""),
          );
        if (summary.inUnpostedNotice)
          warnings.push(
            `${summary.inUnpostedNotice} ЭСФ квартала уже есть в непроведённых извещениях — в черновик не включены (дубль не создаём).`,
          );

        const docDate = date ? `${date}T${odataDate(new Date()).slice(11)}` : odataDate(new Date());
        const planned = await planNoticeNumber(conn, set, docDate);
        const docNumber = number ?? planned.number;
        if (number && planned.taken.has(number))
          throw new InputError(`Извещение не создано: номер ${number} уже занят извещением этого года.`);
        const o = await conn.client
          .getEntity<ODataEntity>(
            `${ORG_SET}(guid'${guidOf(org.ref)}')?$select=Description,НаименованиеПолное,ИдентификационныйНомер`,
          )
          .catch(() => ({}) as ODataEntity);
        const bin = str(o["ИдентификационныйНомер"]);
        if (!bin) warnings.push("У организации не заполнен БИН/ИИН — ИС ЭСФ не примет извещение.");
        const payload: Record<string, unknown> = {
          Number: docNumber,
          Date: docDate,
          Организация_Key: guidOf(org.ref),
          Плательщик_Key: guidOf(org.ref),
          ...(bin ? { ПлательщикИдентификатор: bin } : {}),
          ПлательщикНаименование: str(o["НаименованиеПолное"]) ?? str(o["Description"]) ?? org.name,
          ТипСобытия: "Пользователь",
          ...(comment ? { Комментарий: comment } : {}),
          СуммаОборотаПоПриобретению: built.totals.turnover,
          СуммаНДСПринятогоВЗачет: built.totals.vatOffset,
          ОборотБезНДСИлиСНДСНеВЗачет: built.totals.turnoverNotOffset,
          СуммаНДСНеВЗачет: built.totals.vatNotOffset,
          [LINES]: built.lines,
          [DETAILS]: built.details,
        };
        warnings.push(
          "Черновик не проведён и не отправлен: проверка, подпись ЭЦП, отправка в ИС ЭСФ и проведение — в 1С. " +
            "Через MCP извещение не проводится: проведение закрывает обязательства в учёте 1С, а принято ли " +
            "извещение ИС ЭСФ, через OData не узнать.",
        );
        const fitted = await fitToMetadata(conn, set, payload, warnings);
        for (const k of Object.keys(fitted))
          if (NOTICE_EXCHANGE_FIELDS.has(k))
            throw new Error(`Внутренняя ошибка: поле обмена ${k} в черновике.`);

        // Для предпросмотра: номера и даты поступлений.
        const byType = new Map<string, string[]>();
        for (const d of built.details) {
          const t = typeOf(d["ПервичныйДокумент_Type"]);
          byType.set(t, [...(byType.get(t) ?? []), String(d["ПервичныйДокумент"])]);
        }
        const primary = new Map<string, ODataEntity>();
        for (const [t, refs] of byType)
          for (const [k, v] of await loadByRefs(conn, t, refs, ["Ref_Key", "Number", "Date", "Posted"]))
            primary.set(`${t}:${k}`, v);
        const byRef = new Map(candidates.map((c) => [guidOf(c.ref), c]));
        const preview = {
          organization: { ref: guidOf(org.ref), name: org.name, bin },
          quarter: q,
          offsetDate: period.to,
          number: docNumber,
          numberHow: number ? "задан вручную" : planned.how,
          date: docDate,
          totals: built.totals,
          lines: built.lines.map((l) => {
            const c = byRef.get(String(l["ЭСФ_Key"]));
            return {
              lineNumber: l["LineNumber"],
              esfRef: l["ЭСФ_Key"],
              esfNumber: c?.number,
              esfDate: c?.date,
              turnoverDate: c?.turnoverDate,
              registrationNumber: l["РегНомерЭСФ"],
              esfType: l["ТипЭСФ"],
              counterparty: c?.counterparty,
              turnover: l["СуммаОборотаПоПриобретению"],
              vatOffset: l["СуммаНДСВЗачет"],
              turnoverNotOffset: l["ОборотБезНДС"],
              vatNotOffset: l["СуммаНДСНеВЗачет"],
              details: built.details.filter((d) => d["ЭСФ_Key"] === l["ЭСФ_Key"]).length,
            };
          }),
          details: built.details.map((d) => {
            const t = typeOf(d["ПервичныйДокумент_Type"]);
            const p = primary.get(`${t}:${guidOf(String(d["ПервичныйДокумент"]))}`);
            return {
              lineNumber: d["LineNumber"],
              esfRef: d["ЭСФ_Key"],
              primaryDocument: {
                type: t,
                ref: d["ПервичныйДокумент"],
                ...(p
                  ? { number: num(p["Number"]), date: day(p["Date"]), posted: p["Posted"] === true }
                  : {}),
              },
              turnover: d["СуммаОборотаПоПриобретению"],
              vatOffset: d["СуммаНДСВЗачет"],
              turnoverNotOffset: d["ОборотБезНДС"],
              vatNotOffset: d["СуммаНДСНеВЗачет"],
            };
          }),
          skipped,
          reconciliation: summary,
          posting:
            "Не проводится. Проведение — в 1С после подтверждения ИС ЭСФ (документ спишет остатки регистров " +
            "обязательств на суммы строк и детализации).",
        };
        const res = await createOrPreview(conn, set, fitted, confirm, [
          `Проверено: ${built.lines.length} ЭСФ за ${q} — нет ни в одном извещении, 1С ждёт их в извещении (остаток обязательств); итого НДС в зачёт ${fmt(cents(built.totals.vatOffset))}`,
          `Проверено: номер ${docNumber} — ${number ? "задан вручную, не занят" : planned.how}`,
          ...warnings,
        ]);
        return withPreview(res, { preview });
      }),
  );
}
