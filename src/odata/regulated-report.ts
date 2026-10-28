import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

/**
 * Разбор данных документа «Регламентированный отчет» (ФНО) 1С:Бухгалтерии для Казахстана.
 *
 * Реквизит ДанныеОтчета — ХранилищеЗначения. В OData он виден как поток `ДанныеОтчета` (Edm.Stream,
 * `…/ДанныеОтчета/$value`) и как `ДанныеОтчета_Base64Data` (base64). Тип содержимого —
 * `ДанныеОтчета_Type`, у ФНО это `application/xml+xdto`: XML-сериализация XDTO структуры
 * «СтруктураДополнительныхРеквизитовФормы», где каждая страница формы — табличный документ
 * (mxl:SpreadsheetDocument). Показатели — именованные области ячеек `s_<форма>_<приложение>_<строка>_<колонка>`,
 * напр. `s_200_01_001_1` → строка 200.01.001, колонка 1.
 */

export interface ReportCell {
  /** Код строки формы, напр. «200.01.001». */
  code: string;
  /** Наименование строки из формы (текст рядом с кодом строки). */
  title?: string;
  /** Колонки строки: имя колонки из имени ячейки → значение. */
  columns: Record<string, number | string>;
  /** Подписи буквенных колонок (напр. «А» → «в т.ч. доходы работников»), если они есть в форме. */
  columnTitles?: Record<string, string>;
}

export interface ReportSection {
  /** Код раздела (приложения), напр. «200.00», «200.01», «200.05». */
  section: string;
  pages: number[];
  lines: ReportCell[];
  /** Прочие именованные ячейки страниц раздела (ИИН/БИН, период, численность…) — как в макете. */
  fields: Record<string, number | string>;
}

export interface ReportTable {
  name: string;
  section?: string;
  rows: Array<Record<string, number | string>>;
}

export interface ParsedRegulatedReport {
  sections: ReportSection[];
  /** Разделы, страницы которых в сохранённых данных пустые (не заполнены или не сформированы в 1С). */
  emptySections: string[];
  /** Многострочные части (ТаблицаСтрокГруппы…), только непустые. */
  tables: ReportTable[];
  /** Скалярные значения из мСтруктураЗначений (численность и т.п.). */
  values: Record<string, number | string>;
  comment?: string;
}

type Node = Record<string, unknown>;

const ARRAY_TAGS = new Set(["Property", "rowsItem", "c", "namedItem", "item", "row", "column", "Value"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** Байты хранилища → XML: как есть, а если это deflate без заголовка (сжатое ХранилищеЗначения) — распаковка. */
export function reportXml(bytes: Buffer): string {
  const text = stripBom(bytes.toString("utf8"));
  if (/^\s*</.test(text)) return text;
  try {
    const inflated = stripBom(inflateRawSync(bytes).toString("utf8"));
    if (/^\s*</.test(inflated)) return inflated;
  } catch {
    // не deflate
  }
  throw new Error(
    "Данные отчёта не в формате XML XDTO (и не deflate от него): этот вид хранилища инструмент пока не разбирает.",
  );
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

const arr = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : v == null ? [] : [v as Node]);
const text = (v: unknown): string => {
  const n = arr(v)[0] as unknown;
  if (n == null) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  const t = (n as Node)["#text"];
  return t == null ? "" : String(t);
};
const typeOf = (n: Node | undefined): string => String(n?.["@_type"] ?? "");

/** Значение ячейки: xs:decimal → число (если без потери точности), прочее — строка. */
function scalar(type: string, raw: string): number | string {
  if (/decimal|int|double|float/i.test(type) && /^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && (Number.isSafeInteger(n) || raw.includes("."))) return n;
  }
  return raw;
}

export interface SheetCells {
  /** Имя области → значение левой верхней ячейки и её позиция. Пустые ячейки не попадают. */
  named: Map<string, { value: number | string; row: number; col: number }>;
  /** Тексты (подписи) формы по строкам: строка → [колонка, текст]. */
  texts: Map<number, Array<[number, string]>>;
}

/** Табличный документ (mxl:SpreadsheetDocument в XDTO) → именованные ячейки и подписи. */
export function spreadsheetCells(doc: Node): SheetCells {
  const grid = new Map<string, number | string>();
  const texts = new Map<number, Array<[number, string]>>();
  for (const ri of arr(doc["rowsItem"])) {
    const r = Number(text(ri["index"]));
    const row = arr(ri["row"])[0];
    if (!row) continue;
    let col = -1;
    for (const c of arr(row["c"])) {
      const i = text(c["i"]);
      col = i !== "" ? Number(i) : col + 1;
      const inner = arr(c["c"])[0];
      if (!inner) continue;
      const v = arr(inner["v"])[0] as unknown;
      if (v != null) {
        const node = typeof v === "object" ? (v as Node) : { "#text": v };
        if (node["@_nil"] === "true") continue;
        grid.set(`${r}:${col}`, scalar(typeOf(node), text([node])));
        continue;
      }
      const tl = arr(inner["tl"])[0];
      if (tl) {
        const items = arr(tl["item"]);
        const ru = items.find((it) => text(it["lang"]) === "ru") ?? items[0];
        const t = ru ? text(ru["content"]).replace(/\s+/g, " ").trim() : "";
        if (t) {
          const list = texts.get(r) ?? [];
          list.push([col, t]);
          texts.set(r, list);
        }
      }
    }
  }
  const named = new Map<string, { value: number | string; row: number; col: number }>();
  for (const ni of arr(doc["namedItem"])) {
    const name = text(ni["name"]);
    const area = arr(ni["area"])[0];
    if (!name || !area) continue;
    const br = text(area["beginRow"]);
    const bc = text(area["beginColumn"]);
    if (br === "" || bc === "") continue;
    const row = Number(br);
    const col = Number(bc);
    const v = grid.get(`${row}:${col}`);
    if (v !== undefined && v !== "") named.set(name, { value: v, row, col });
  }
  return { named, texts };
}

/** Табличный документ → {имя области: значение}. */
export function spreadsheetNamedValues(doc: Node): Record<string, number | string> {
  return Object.fromEntries([...spreadsheetCells(doc).named].map(([k, v]) => [k, v.value]));
}

const UNIT_RE = /^(млрд|млн|тыс)\.?$/;
/** Наименование строки: первый текст правее ячейки с кодом строки. */
function lineTitle(texts: SheetCells["texts"], code: string): string | undefined {
  for (const list of texts.values()) {
    const at = list.find(([, t]) => t === code);
    if (!at) continue;
    const next = list
      .filter(([c, t]) => c > at[0] && !UNIT_RE.test(t) && !/^\d{3}\.\d{2}\.\d{3}/.test(t))
      .sort((a, b) => a[0] - b[0])[0];
    return next?.[1];
  }
  return undefined;
}

const PAGE_RE = /^Форма(\d{3})(?:_(\d{2}))?ПолеТабличногоДокументаСтраница(\d+)$/;
const CELL_RE = /^s_(\d{3})_(\d{2})_(\d{3})(?:_([0-9A-Za-zА-Яа-я]+))?$/;
const TABLE_RE = /^ТаблицаСтрокГруппыФорма(\d{3})(?:_(\d{2}))?Страница(\d+)$/;

function properties(structure: Node): Map<string, Node> {
  const m = new Map<string, Node>();
  for (const p of arr(structure["Property"])) {
    const v = arr(p["Value"])[0];
    if (v) m.set(String(p["@_name"] ?? ""), v);
  }
  return m;
}

/** Разбор XML XDTO данных регламентированного отчёта. */
export function parseRegulatedReportXml(xml: string): ParsedRegulatedReport {
  const doc = parser.parse(xml) as Node;
  const root = arr(doc["Structure"])[0] ?? (doc["Structure"] as Node | undefined);
  if (!root) throw new Error("В данных отчёта нет корневой Structure (XDTO).");
  let props = properties(root);
  const inner = props.get("СтруктураДополнительныхРеквизитовФормы");
  if (inner) props = properties(inner);

  const sections = new Map<string, ReportSection>();
  const seen = new Set<string>();
  for (const [name, value] of props) {
    const m = PAGE_RE.exec(name);
    if (!m || typeOf(value) !== "mxl:SpreadsheetDocument") continue;
    const code = `${m[1]}.${m[2] ?? "00"}`;
    seen.add(code);
    const { named, texts } = spreadsheetCells(value);
    if (named.size === 0) continue;
    const sec = sections.get(code) ?? { section: code, pages: [], lines: [], fields: {} };
    sec.pages.push(Number(m[3]));
    const byCode = new Map(sec.lines.map((l) => [l.code, l]));
    for (const [cell, { value: v, row, col }] of named) {
      const c = CELL_RE.exec(cell);
      if (!c) {
        // Шапка повторяется на каждой странице — достаточно одного значения.
        if (!(cell in sec.fields)) sec.fields[cell] = v;
        continue;
      }
      const lineCode = `${c[1]}.${c[2]}.${c[3]}`;
      let line = byCode.get(lineCode);
      if (!line) {
        const title = lineTitle(texts, lineCode);
        line = { code: lineCode, ...(title ? { title } : {}), columns: {} };
      }
      const key = c[4] ?? "value";
      line.columns[key] = v;
      if (c[4] && /^[A-Za-zА-Яа-я]+$/.test(key)) {
        // Буквенная колонка (А, Б…) — подпись из текстов той же строки формы левее значения.
        const label = (texts.get(row) ?? [])
          .filter(([tc, t]) => tc < col && !UNIT_RE.test(t))
          .sort((a, b) => a[0] - b[0])
          .map(([, t]) => t)
          .join(" ")
          .trim();
        if (label) line.columnTitles = { ...line.columnTitles, [key]: label };
      }
      byCode.set(lineCode, line);
    }
    sec.lines = [...byCode.values()];
    sections.set(code, sec);
  }
  const ordered = [...sections.values()]
    .map((s) => ({
      ...s,
      pages: s.pages.sort((a, b) => a - b),
      lines: s.lines.sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => a.section.localeCompare(b.section));

  const tables: ReportTable[] = [];
  for (const [name, value] of props) {
    const m = TABLE_RE.exec(name);
    if (!m || typeOf(value) !== "ValueTable") continue;
    const cols = arr(value["column"]).map((c) => text(c["Name"]));
    const rows = arr(value["row"]).map((r) => {
      const out: Record<string, number | string> = {};
      arr(r["Value"]).forEach((v, i) => {
        const col = cols[i];
        if (!col || col.endsWith("_Расшифровка") || v["@_nil"] === "true") return;
        const t = text([v]);
        if (t !== "") out[col] = scalar(typeOf(v), t);
      });
      return out;
    });
    if (rows.length) tables.push({ name, section: `${m[1]}.${m[2] ?? "00"}`, rows });
  }

  const values: Record<string, number | string> = {};
  const vs = props.get("мСтруктураЗначений");
  if (vs) {
    for (const [k, v] of properties(vs)) {
      const t = text([v]);
      if (t !== "" && v["@_nil"] !== "true") values[k] = scalar(typeOf(v), t);
    }
  }
  const commentNode = props.get("Комментарий");
  const comment = commentNode ? text([commentNode]) : "";

  return {
    sections: ordered,
    emptySections: [...seen].filter((s) => !sections.has(s) && !tables.some((t) => t.section === s)).sort(),
    tables,
    values,
    ...(comment ? { comment } : {}),
  };
}

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

/**
 * Разбивка по месяцам для квартальных форм (200.00 и т.п.): колонки 1–3 — месяцы квартала,
 * 4 — итог за квартал. Возвращает месяцы и проверку «4 = 1 + 2 + 3»; для прочих периодов — undefined.
 */
export function monthlyBreakdown(
  line: ReportCell,
  periodStart: string | undefined,
  periodicity: string | undefined,
):
  | {
      months: Array<{ month: string; label: string; value: number }>;
      /** Месяцы с пустой ячейкой (в форме 1С это 0). */
      blankMonths?: string[];
      quarter?: number;
      sumMatches?: boolean;
    }
  | undefined {
  if (periodicity !== "Квартал" || !periodStart) return undefined;
  const m = /^(\d{4})-(\d{2})/.exec(periodStart);
  if (!m) return undefined;
  const year = Number(m[1]);
  const first = Number(m[2]);
  const months: Array<{ month: string; label: string; value: number }> = [];
  const blankMonths: string[] = [];
  for (let k = 1; k <= 3; k++) {
    const v = line.columns[String(k)];
    const mon = first + k - 1;
    const month = `${year}-${String(mon).padStart(2, "0")}`;
    if (typeof v !== "number") {
      blankMonths.push(month);
      continue;
    }
    months.push({ month, label: `${MONTHS[mon - 1]} ${year}`, value: v });
  }
  if (!months.length) return undefined;
  const blank = blankMonths.length ? { blankMonths } : {};
  const q = line.columns["4"];
  if (typeof q !== "number") return { months, ...blank };
  // Пустая ячейка месяца в форме 1С — это 0: в сумму не входит.
  const sum = months.reduce((s, x) => s + x.value, 0);
  return { months, ...blank, quarter: q, sumMatches: Math.abs(sum - q) < 0.005 };
}
