import type { Connection } from "../context.js";
import { fetchAll } from "../odata/pagination.js";
import { buildQuery, cmp, odataGuid, or } from "../odata/query.js";
import { documentTitle } from "../print/doc-titles.js";
import type { ODataEntity } from "../types/odata.js";

/**
 * Читаемый предпросмотр записи: заголовок, поля и табличные части с человеческими подписями и названиями
 * вместо GUID, итоги и изменения «было → станет». Строится в общих помощниках записи (createOrPreview,
 * patchOrPreview, EP-помощник), чтобы его получали все инструменты.
 */

export interface PreviewField {
  name: string;
  label: string;
  value: unknown;
  text?: string | undefined;
}

export interface PreviewColumn {
  name: string;
  label: string;
}

export interface PreviewTable {
  name: string;
  label: string;
  columns: PreviewColumn[];
  rows: unknown[][];
}

export interface PreviewChange {
  name: string;
  label: string;
  from: { value: unknown; text?: string | undefined };
  to: { value: unknown; text?: string | undefined };
}

export interface PreviewView {
  title: string;
  fields: PreviewField[];
  tables: PreviewTable[];
  totals?: { sum: number; vat: number; total: number } | undefined;
  changes?: PreviewChange[] | undefined;
}

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isGuid = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v !== EMPTY && GUID_RE.test(v.trim().replace(/[{}]/g, ""));
const normGuid = (v: string): string => v.trim().replace(/[{}]/g, "").toLowerCase();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Техническое имя 1С — человеческая подпись: «ДоговорКонтрагента_Key» → «Договор контрагента». */
export function humanize(name: string): string {
  const base = name.replace(/_(Key|Type)$/, "");
  const short = base.includes("_") ? base.slice(base.indexOf("_") + 1) : base;
  const words = short.split(/(?<=[а-яёa-z])(?=[А-ЯЁA-Z])|(?<=[А-ЯЁA-Z])(?=[А-ЯЁA-Z][а-яёa-z])/u);
  return words
    .map((w, i) => {
      if (i === 0) return w;
      if (/^[А-ЯЁA-Z0-9]+$/u.test(w)) return w; // аббревиатуры (НДС, ЕП, ТМЗ) — как есть
      return w.toLowerCase();
    })
    .join(" ");
}

/** Заголовок предпросмотра: для документов — синоним 1С, иначе имя объекта по словам. */
export function previewTitle(entitySet: string, shortName?: string): string {
  if (entitySet.startsWith("Document_")) {
    const base = entitySet.replace(/^Document_/, "");
    // Аббревиатура (ЭСФ, ЭАВР) — как есть, иначе documentTitle разобьёт её по буквам («Э с ф»).
    if (/^[А-ЯЁA-Z0-9]+$/u.test(base)) return humanize(shortName || base);
    return documentTitle(entitySet);
  }
  return humanize(shortName || entitySet);
}

/** Частые ссылки без навигации в метаданных (фейковая база, урезанный $metadata). */
const COMMON_TARGETS: Record<string, string> = {
  Контрагент: "Catalog_Контрагенты",
  Грузополучатель: "Catalog_Контрагенты",
  ГоловнойКонтрагент: "Catalog_Контрагенты",
  Организация: "Catalog_Организации",
  ДоговорКонтрагента: "Catalog_ДоговорыКонтрагентов",
  ОсновнойДоговорКонтрагента: "Catalog_ДоговорыКонтрагентов",
  Договор: "Catalog_ДоговорыКонтрагентов",
  Номенклатура: "Catalog_Номенклатура",
  ВалютаДокумента: "Catalog_Валюты",
  ВалютаВзаиморасчетов: "Catalog_Валюты",
  СтавкаНДС: "Catalog_СтавкиНДС",
  ЕдиницаИзмерения: "Catalog_КлассификаторЕдиницИзмерения",
  БазоваяЕдиницаИзмерения: "Catalog_КлассификаторЕдиницИзмерения",
  Склад: "Catalog_Склады",
  Ответственный: "Catalog_Пользователи",
  Автор: "Catalog_Пользователи",
  ТипЦен: "Catalog_ТиповЦенНоменклатуры",
  Банк: "Catalog_Банки",
  ОсновнойБанковскийСчет: "Catalog_БанковскиеСчета",
  БанковскийСчетОрганизации: "Catalog_БанковскиеСчета",
  ФизЛицо: "Catalog_ФизическиеЛица",
  ФизическоеЛицо: "Catalog_ФизическиеЛица",
  Сотрудник: "Catalog_Сотрудники",
  ВидУчетаНУ: "Catalog_ВидыУчетаНУ",
  Подразделение: "Catalog_ПодразделенияОрганизаций",
  СтруктурноеПодразделение: "Catalog_ПодразделенияОрганизаций",
  СтранаРезидентства: "Catalog_КлассификаторСтранМира",
};

const NAME_FIELDS = ["НаименованиеПолное", "Description", "Code", "Number"];

/** Название объекта для text: полное наименование, описание, код или номер с датой. */
function rowText(r: ODataEntity): string {
  for (const f of ["НаименованиеПолное", "Description"]) {
    const s = str(r[f]);
    if (s) return s;
  }
  const num = str(r["Number"]).replace(/^0+(?=\d)/, "");
  if (num) {
    const date = str(r["Date"]).slice(0, 10);
    return date && !date.startsWith("0001") ? `№ ${num} от ${date}` : `№ ${num}`;
  }
  return str(r["Code"]);
}

/** Имя набора строк табличной части из типа поля: Collection(StandardODATA.<Набор>_RowType). */
function rowEntitySet(type: unknown): string | undefined {
  return typeof type === "string"
    ? (/^Collection\(StandardODATA\.(.+)_RowType\)$/.exec(type)?.[1] ?? undefined)
    : undefined;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Строит читаемый вид полезной нагрузки записи. Ссылки `*_Key` разрешаются в названия пакетно: один запрос на
 * набор сущностей (`Ref_Key in (…)`), всего не больше 50 ссылок. Пустая ссылка — без строки. Ошибки чтения
 * названий и метаданных вид не роняют: подписи остаются, text пропускается.
 */
export async function buildPreviewView(
  conn: Connection,
  entitySet: string,
  data: Record<string, unknown>,
  opts: { before?: Record<string, unknown> | undefined } = {},
): Promise<PreviewView> {
  const meta = await conn.getMetadata().catch(() => undefined);
  const em = meta?.entities.get(entitySet);
  const navOf = (base: string): string | undefined =>
    em?.navigations.find((n) => n.name === base)?.toType ?? COMMON_TARGETS[base];
  const rowMetaOf = (table: string): ReturnType<NonNullable<typeof meta>["entities"]["get"]> => {
    const prop = em?.properties.find((p) => p.name === table);
    const set = prop ? rowEntitySet(prop.type) : undefined;
    return set ? meta?.entities.get(set) : undefined;
  };

  const tables: PreviewTable[] = [];
  const fieldEntries: Array<[string, unknown]> = [];
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const rows = (value as Array<Record<string, unknown>>).filter((r) => r && typeof r === "object");
      const cols: string[] = [];
      for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      tables.push({
        name,
        label: humanize(name),
        columns: cols.map((c) => ({ name: c, label: humanize(c) })),
        rows: rows.map((r) => cols.map((c) => r[c])),
      });
    } else {
      if (name.endsWith("_Key") && !isGuid(value)) continue; // пустая ссылка — без строки
      fieldEntries.push([name, value]);
    }
  }

  // Ссылки для разрешения в названия: поля шапки + ячейки таблиц (шапка и «до» для changes).
  const wanted = new Map<string, Set<string>>();
  const want = (base: string, value: unknown) => {
    if (!isGuid(value)) return;
    const target = navOf(base);
    if (!target) return;
    if ([...wanted.values()].reduce((n, s) => n + s.size, 0) >= 50) return;
    let s = wanted.get(target);
    if (!s) wanted.set(target, (s = new Set()));
    s.add(normGuid(value as string));
  };
  for (const [name, value] of fieldEntries) if (name.endsWith("_Key")) want(name.slice(0, -4), value);
  for (const t of tables) {
    const rm = rowMetaOf(t.name);
    for (const row of t.rows)
      t.columns.forEach((c, i) => {
        if (!c.name.endsWith("_Key")) return;
        const base = c.name.slice(0, -4);
        const target = rm?.navigations.find((n) => n.name === base)?.toType ?? COMMON_TARGETS[base];
        if (!target) return;
        const v = row[i];
        if (isGuid(v)) {
          if ([...wanted.values()].reduce((n, s) => n + s.size, 0) >= 50) return;
          let s = wanted.get(target);
          if (!s) wanted.set(target, (s = new Set()));
          s.add(normGuid(v as string));
        }
      });
  }
  const before = opts.before;
  if (before)
    for (const [name, value] of Object.entries(before)) {
      if (Array.isArray(value) || value === undefined) continue;
      if (name.endsWith("_Key")) want(name.slice(0, -4), value);
    }

  const texts = new Map<string, string>();
  for (const [target, guids] of wanted) {
    try {
      const props = new Set((meta?.entities.get(target)?.properties ?? []).map((p) => p.name));
      // Только поля, которые у объекта есть: 1С отвергает весь запрос (400), если в $select чужое поле, — у
      // справочника нет Date. Метаданных нет — по виду объекта: у документа номер и дата, у справочника — название.
      const doc = target.startsWith("Document_");
      const has = (f: string) =>
        props.size ? props.has(f) : (doc ? ["Number", "Date"] : ["Description", "Code"]).includes(f);
      const select = ["Ref_Key", ...[...NAME_FIELDS, "Date"].filter((f) => f !== "Ref_Key" && has(f))].filter(
        (f, i, a) => a.indexOf(f) === i,
      );
      const { rows } = await fetchAll(
        conn.client,
        target,
        { filter: or(...[...guids].map((g) => cmp("Ref_Key", "eq", odataGuid(g)))), select },
        50,
        guids.size,
      );
      for (const r of rows as ODataEntity[]) {
        const text = rowText(r);
        if (text) texts.set(normGuid(str(r["Ref_Key"])), text);
      }
    } catch {
      // Название не прочиталось — поле останется без text.
    }
  }
  const textOf = (v: unknown): string | undefined => {
    if (!isGuid(v)) return undefined;
    return texts.get(normGuid(v as string));
  };

  const fields: PreviewField[] = fieldEntries.map(([name, value]) => ({
    name,
    label: humanize(name),
    value,
    ...(textOf(value) ? { text: textOf(value)! } : {}),
  }));
  for (const t of tables) {
    const rm = rowMetaOf(t.name);
    t.rows = t.rows.map((row) =>
      row.map((cell, i) => {
        const col = t.columns[i]!.name;
        if (col.endsWith("_Key")) {
          if (!isGuid(cell)) return "";
          return textOf(cell) ?? cell;
        }
        if (col.endsWith("_Type") && typeof cell === "string") return cell.replace(/^StandardODATA\./, "");
        void rm;
        return cell;
      }),
    );
  }

  let view: PreviewView = {
    title: previewTitle(entitySet, em?.shortName),
    fields,
    tables,
  };

  // Итоги: суммы по таблицам и СуммаДокумента шапки.
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  let sum = 0;
  let vat = 0;
  for (const t of tables)
    for (const row of t.rows) {
      const byName = new Map(t.columns.map((c, i) => [c.name, row[i]]));
      const s = Number(byName.get("Сумма") ?? 0);
      const v = Number(byName.get("СуммаНДС") ?? 0);
      if (Number.isFinite(s) && s) sum = round2(sum + s);
      if (Number.isFinite(v) && v) vat = round2(vat + v);
    }
  const headerTotal = Number((data as Record<string, unknown>)["СуммаДокумента"]);
  const headerVat = Number((data as Record<string, unknown>)["СуммаНДС"]);
  const total = Number.isFinite(headerTotal)
    ? headerTotal
    : sum || vat || Number.isFinite(headerVat)
      ? round2(sum + (data["СуммаВключаетНДС"] === true ? 0 : vat))
      : NaN;
  if (Number.isFinite(total) || sum || vat)
    view = {
      ...view,
      totals: {
        sum: round2(sum),
        vat: round2(Number.isFinite(headerVat) && headerVat ? headerVat : vat),
        total: Number.isFinite(total) ? (total as number) : round2(sum + vat),
      },
    };

  if (before) {
    const changes: PreviewChange[] = [];
    for (const [name, value] of fieldEntries) {
      const was = (before as Record<string, unknown>)[name];
      if (
        name.endsWith("_Type")
          ? sameValue(
              String(was).replace(/^StandardODATA\./, ""),
              String(value).replace(/^StandardODATA\./, ""),
            )
          : sameValue(was, value)
      )
        continue;
      changes.push({
        name,
        label: humanize(name),
        from: { value: (was as unknown) ?? null, ...(textOf(was) ? { text: textOf(was)! } : {}) },
        to: { value, ...(textOf(value) ? { text: textOf(value)! } : {}) },
      });
    }
    if (changes.length) view = { ...view, changes };
  }
  return view;
}

/** Одна карточка документа после записи: дата, сумма и признак проведения. */
export async function readDocumentCard(
  conn: Connection,
  entitySet: string,
  ref: string,
): Promise<{ date?: string | undefined; total?: number | undefined; posted?: boolean | undefined }> {
  try {
    const doc = await conn.client.getEntity(
      `${entitySet}(guid'${ref.replace(/[{}]/g, "")}')${buildQuery({ select: ["Number", "Date", "Posted", "СуммаДокумента"] })}`,
    );
    const out: { date?: string | undefined; total?: number | undefined; posted?: boolean | undefined } = {};
    const date = str(doc["Date"]).slice(0, 10);
    if (date) out.date = date;
    const total = Number(doc["СуммаДокумента"]);
    if (Number.isFinite(total)) out.total = total;
    if (typeof doc["Posted"] === "boolean") out.posted = doc["Posted"] as boolean;
    return out;
  } catch {
    return {};
  }
}
