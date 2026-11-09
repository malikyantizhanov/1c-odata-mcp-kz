import { encode } from "@toon-format/toon";
import { KNP_NAMES } from "../config/knp.js";
import type { Connection } from "../context.js";
import { fetchAll } from "../odata/pagination.js";
import { cmp, odataGuid, or } from "../odata/query.js";
import { HEADER_FIELDS, ROW_FIELDS, SERVICE_FIELDS, TABLES } from "../odata/vocab.js";
import type { ODataEntity } from "../types/odata.js";
import { COMMON_TARGETS, previewTitle } from "./preview-view.js";

/**
 * Читаемый вид документа 1С: понятные имена полей (общий словарь odata/vocab.ts), у ссылок — {guid, name}
 * (названия коннектор подставляет сам — пакетно, один запрос на справочник, с кешем на подключение), без служебных
 * полей OData (odata.metadata, DataVersion, …@navigationLinkUrl) и без пустых ссылок. Текст — TOON v4: первой
 * строкой комментарий «# <вид> № <номер> от <дата>», табличные части — таблицами (вложенные поля — группами v4).
 */

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (v: unknown): string =>
  String(v ?? "")
    .replace(/[{}']/g, "")
    .toLowerCase();
const isRef = (v: unknown): v is string =>
  typeof v === "string" && GUID_RE.test(norm(v)) && norm(v) !== EMPTY;
const isEmptyRef = (v: unknown): boolean => typeof v === "string" && norm(v) === EMPTY;
const str = (v: unknown): string => (v == null ? "" : String(v));

export interface RefValue {
  guid: string;
  name?: string;
  type?: string;
}

/** Названия ссылок на подключение: (набор, guid) → название; живут 10 минут. */
const NAME_TTL_MS = 10 * 60_000;
const nameCache = new WeakMap<Connection, Map<string, { name: string; at: number }>>();

function cacheOf(conn: Connection): Map<string, { name: string; at: number }> {
  let m = nameCache.get(conn);
  if (!m) nameCache.set(conn, (m = new Map()));
  return m;
}

/** Название объекта: полное наименование, описание, «№ номер от дата» у документа, код. */
function nameOf(r: ODataEntity, set = ""): string {
  if (set.startsWith("ChartOfAccounts_") && str(r["Code"]))
    return [str(r["Code"]), str(r["Description"])].filter(Boolean).join(" "); // счёт: «1210 Краткосрочная …»
  for (const f of ["НаименованиеПолное", "Description"]) {
    const s = str(r[f]).trim();
    if (s) return s;
  }
  const num = str(r["Number"]).replace(/^0+(?=\d)/, "");
  if (num) {
    const date = str(r["Date"]).slice(0, 10);
    return date && !date.startsWith("0001") ? `№ ${num} от ${date}` : `№ ${num}`;
  }
  return str(r["Code"]);
}

/** Пакетно: названия ссылок по наборам. Сбой чтения набора — без названий (guid остаётся). */
export async function resolveNames(
  conn: Connection,
  wanted: Map<string, Set<string>>,
): Promise<Map<string, string>> {
  const cache = cacheOf(conn);
  const out = new Map<string, string>();
  const now = Date.now();
  const meta = await conn.getMetadata().catch(() => undefined);
  // справочники — по очереди, не параллельно: 1cfresh держит запросы одного пользователя в очереди, и пачка
  // одновременных упирается в тайм-аут (замер на проде 09.11.2026: 26 с вместо 0,4 с)
  for (const [set, guids] of wanted) {
    const missing: string[] = [];
    for (const g of guids) {
      const hit = cache.get(`${set}|${g}`);
      if (hit && now - hit.at < NAME_TTL_MS) out.set(g, hit.name);
      else missing.push(g);
    }
    for (let i = 0; i < missing.length; i += 40) {
      const part = missing.slice(i, i + 40);
      try {
        const props = new Set((meta?.entities.get(set)?.properties ?? []).map((p) => p.name));
        const doc = set.startsWith("Document_");
        const has = (f: string) =>
          props.size ? props.has(f) : (doc ? ["Number", "Date"] : ["Description", "Code"]).includes(f);
        const select = [
          "Ref_Key",
          ...["НаименованиеПолное", "Description", "Number", "Date", "Code"].filter(has),
        ];
        const { rows } = await fetchAll(
          conn.client,
          set,
          { filter: or(...part.map((g) => cmp("Ref_Key", "eq", odataGuid(g)))), select },
          part.length,
          part.length,
        );
        for (const r of rows as ODataEntity[]) {
          const name = nameOf(r, set);
          if (!name) continue;
          const g = norm(r["Ref_Key"]);
          out.set(g, name);
          cache.set(`${set}|${g}`, { name, at: now });
        }
      } catch {
        // название не прочиталось — у ссылки останется guid
      }
    }
  }
  return out;
}

type Meta = Awaited<ReturnType<Connection["getMetadata"]>>;

/** Набор, на который указывает ссылка: навигация в $metadata, частые ссылки, составное поле — по _Type. */
function targetOf(
  meta: Meta | undefined,
  set: string,
  base: string,
  row: Record<string, unknown>,
): string | undefined {
  const typed = str(row[`${base}_Type`]).replace(/^StandardODATA\./, "");
  if (typed && typed !== "Undefined") return typed;
  return meta?.entities.get(set)?.navigations?.find((n) => n.name === base)?.toType ?? COMMON_TARGETS[base];
}

/** Табличная часть: набор строк из типа поля Collection(StandardODATA.<Набор>_RowType). */
function rowSetOf(meta: Meta | undefined, set: string, table: string): string {
  const type = meta?.entities.get(set)?.properties?.find((p) => p.name === table)?.type ?? "";
  return /^Collection\(StandardODATA\.(.+)_RowType\)$/.exec(type)?.[1] ?? `${set}_${table}`;
}

/** Поля объекта (шапка или строка): ссылки — {guid, name}, служебное — прочь, имена — по словарю. */
function shape(
  row: Record<string, unknown>,
  dict: Readonly<Record<string, string>>,
  refs: (base: string, guid: string) => RefValue,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SERVICE_FIELDS.has(k) || k.includes("@") || k.endsWith("_Type")) continue;
    if (Array.isArray(v)) continue; // табличные части — отдельно
    if (k.endsWith("_Key")) {
      const base = k.slice(0, -4);
      if (!isRef(v)) continue; // пустая ссылка — без поля
      out[dict[base] ?? base] = refs(base, norm(v));
      continue;
    }
    if (isRef(v) && `${k}_Type` in row) {
      out[dict[k] ?? k] = refs(k, norm(v)); // составное поле (ссылка + тип)
      continue;
    }
    if (isEmptyRef(v)) continue;
    if (k === "КодНазначенияПлатежа" && typeof v === "string" && v.trim()) {
      // КНП — код из классификатора Нацбанка: название из словаря (в OData классификатора нет)
      const code = v.trim();
      out[dict[k] ?? k] = KNP_NAMES[code] ? { code, name: KNP_NAMES[code] } : { code };
      continue;
    }
    if (k === "LineNumber") {
      out[dict[k] ?? k] = Number(v);
      continue;
    }
    out[dict[k] ?? k] = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(v) ? v.slice(0, 10) : v;
  }
  // строка: содержание = название номенклатуры — второй раз не повторяем
  const item = out["nomenclature"] as RefValue | undefined;
  if (item?.name && typeof out["description"] === "string" && out["description"].trim() === item.name.trim())
    delete out["description"];
  return ordered(out);
}

/** Порядок полей: главное — сверху (номер, дата, суммы, стороны), служебное — внизу; прочие — как в 1С. */
const ORDER = [
  "type",
  "entity_set",
  "guid",
  "number",
  "date",
  "is_posted",
  "is_deleted",
  "total_amount",
  "currency",
  "organization",
  "counterparty",
  "contract",
  "basis",
  "operation_kind",
  "knp",
  "payment_purpose",
  "bank_account",
  "organization_bank_account",
  "counterparty_bank_account",
  "warehouse",
  "department",
  "line_number",
  "nomenclature",
  "description",
  "quantity",
  "unit",
  "price",
  "sum",
  "vat_rate",
  "vat_amount",
];
const LAST = [
  "exchange_rate",
  "rate_multiplier",
  "price_type",
  "apply_vat",
  "amount_includes_vat",
  "apply_excise",
  "amount_includes_excise",
  "delivery_address",
  "comment",
  "responsible_person",
  "author",
];

function ordered(o: Record<string, unknown>): Record<string, unknown> {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    if (i >= 0) return i;
    const j = LAST.indexOf(k);
    return j >= 0 ? 1000 + j : 500;
  };
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => rank(a) - rank(b)));
}

export interface ReadableDocument {
  title: string;
  view: Record<string, unknown>;
  text: string;
}

/** Читаемый вид документа (объект и текст TOON). */
export async function readableDocument(
  conn: Connection,
  entitySet: string,
  entity: Record<string, unknown>,
): Promise<ReadableDocument> {
  const meta = await conn.getMetadata().catch(() => undefined);
  const tables = Object.entries(entity).filter(([, v]) => Array.isArray(v)) as Array<
    [string, Array<Record<string, unknown>>]
  >;

  // ссылки, которым нужны названия: шапка + строки таблиц
  const wanted = new Map<string, Set<string>>();
  const want = (set: string, base: string, row: Record<string, unknown>, value: unknown) => {
    if (!isRef(value)) return;
    const target = targetOf(meta, set, base, row);
    if (!target) return;
    let s = wanted.get(target);
    if (!s) wanted.set(target, (s = new Set()));
    s.add(norm(value));
  };
  const collect = (set: string, row: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(row)) {
      if (k.endsWith("_Key")) want(set, k.slice(0, -4), row, v);
      else if (`${k}_Type` in row) want(set, k, row, v);
    }
  };
  collect(entitySet, entity);
  for (const [name, rows] of tables) for (const r of rows) collect(rowSetOf(meta, entitySet, name), r);
  const names = await resolveNames(conn, wanted);

  const refOf =
    (row: Record<string, unknown>) =>
    (base: string, guid: string): RefValue => {
      const name = names.get(guid);
      const typed = str(row[`${base}_Type`]).replace(/^StandardODATA\./, "");
      return { guid, ...(name ? { name } : {}), ...(typed && typed !== "Undefined" ? { type: typed } : {}) };
    };

  const title = previewTitle(entitySet);
  const view: Record<string, unknown> = ordered({
    type: title,
    entity_set: entitySet,
    guid: norm(entity["Ref_Key"]),
    ...shape(entity, HEADER_FIELDS, refOf(entity)),
  });
  for (const [name, rows] of tables) {
    if (!rows.length) continue; // пустая табличная часть — без поля
    view[TABLES[name] ?? name] = rows.map((r) => shape(r, ROW_FIELDS, refOf(r)));
  }
  const num = str(entity["Number"]).replace(/^0+(?=\d)/, "");
  const date = str(entity["Date"]).slice(0, 10);
  const head = `# ${title}${num ? ` № ${num}` : ""}${date ? ` от ${date}` : ""}`;
  return { title, view, text: `${head}\n${encode(view)}` };
}
