import { encode } from "@toon-format/toon";
import { KNP_NAMES } from "../config/knp.js";
import type { Connection } from "../context.js";
import { HEADER_FIELDS, ROW_FIELDS, TABLES } from "../odata/vocab.js";
import { COMMON_TARGETS, previewTitle } from "./preview-view.js";
import { resolveNames } from "./readable.js";

/**
 * Читаемый ответ любого инструмента — тот же вид, что у read.document.get_document: TOON v4 с заголовком
 * «# <инструмент>», понятные английские имена полей (snake_case и общий словарь odata/vocab.ts), у каждой ссылки —
 * {guid, name} (пара «counterparty» + «counterpartyRef» склеивается, голая ссылка получает название из 1С сама),
 * без служебных полей OData и пустых значений. structuredContent не меняется — код интеграций читает его как раньше.
 */

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const norm = (v: unknown): string =>
  String(v ?? "")
    .replace(/[{}']/g, "")
    .toLowerCase();
const HAS_GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const isGuid = (v: unknown): v is string => typeof v === "string" && GUID_RE.test(v.trim());

/** Реквизиты 1С (шапка, строки, справочники) → понятные имена. */
const RU: Readonly<Record<string, string>> = {
  ...ROW_FIELDS,
  ...HEADER_FIELDS,
  ...TABLES,
  Ref_Key: "guid",
  Description: "name",
  Code: "code",
  Parent: "parent",
  Owner: "owner",
  IsFolder: "is_folder",
  Predefined: "is_predefined",
  НаименованиеПолное: "full_name",
  ИдентификационныйКодЛичности: "bin",
  ЮрФизЛицо: "legal_type",
  КБЕ: "kbe",
  БИК: "bik",
  НомерСчета: "account_number",
  Наименование: "name",
};

/** Английская ссылка без набора в ответе → справочник, где взять её название. */
const EN_TARGETS: Readonly<Record<string, string>> = {
  counterparty: "Catalog_Контрагенты",
  buyer: "Catalog_Контрагенты",
  supplier: "Catalog_Контрагенты",
  consignee: "Catalog_Контрагенты",
  contract: "Catalog_ДоговорыКонтрагентов",
  nomenclature: "Catalog_Номенклатура",
  nom: "Catalog_Номенклатура",
  item: "Catalog_Номенклатура",
  org: "Catalog_Организации",
  organization: "Catalog_Организации",
  unit: "Catalog_КлассификаторЕдиницИзмерения",
  currency: "Catalog_Валюты",
  cur: "Catalog_Валюты",
  tenge: "Catalog_Валюты",
  warehouse: "Catalog_Склады",
  person: "Catalog_ФизическиеЛица",
  employee: "Catalog_Сотрудники",
  responsible: "Catalog_Пользователи",
  division: "Catalog_ПодразделенияОрганизаций",
  department: "Catalog_ПодразделенияОрганизаций",
  vat_rate: "Catalog_СтавкиНДС",
  vatRate: "Catalog_СтавкиНДС",
  vat: "Catalog_СтавкиНДС",
  price_type: "Catalog_ТиповЦенНоменклатуры",
  priceType: "Catalog_ТиповЦенНоменклатуры",
  bank: "Catalog_Банки",
  bankAccount: "Catalog_БанковскиеСчета",
  bank_account: "Catalog_БанковскиеСчета",
  organizationBankAccount: "Catalog_БанковскиеСчета",
  orgBankAccount: "Catalog_БанковскиеСчета",
  esf: "Document_ЭСФ",
  counterpartyAccount: "Catalog_БанковскиеСчета",
  supplierBankAccount: "Catalog_БанковскиеСчета",
  cashflowItem: "Catalog_ДвижениеДенежныхСредств",
  calculationType: "ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций",
  nomenclatureGroup: "Catalog_НоменклатурныеГруппы",
};

/** Русская ссылка без связи в $metadata: частые реквизиты, счета учёта, склады. */
function ruTarget(base: string): string | undefined {
  if (COMMON_TARGETS[base]) return COMMON_TARGETS[base];
  if (/^Счет(Учета|Доходов|Расходов|Касса|Затрат|Дт|Кт)/.test(base)) return "ChartOfAccounts_Типовой";
  if (/^Склад/.test(base)) return "Catalog_Склады";
  if (/^Валюта/.test(base)) return "Catalog_Валюты";
  if (/^Договор/.test(base)) return "Catalog_ДоговорыКонтрагентов";
  if (base === "НоменклатурнаяГруппа") return "Catalog_НоменклатурныеГруппы";
  if (base === "Плательщик" || base === "Получатель") return "Catalog_Контрагенты";
  return undefined;
}

/** Имена, которые остаются как есть: их же ждут параметры инструментов (подтверждение записи). */
const KEEP = new Set(["operationId"]);

/** Служебное OData и пустые значения — не показываем. */
const isService = (k: string) =>
  k === "odata.metadata" || k === "odata.nextLink" || k === "DataVersion" || k.includes("@");

const snake = (k: string): string =>
  /^[A-Za-z][A-Za-z0-9]*$/.test(k) && !KEEP.has(k)
    ? k
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()
    : k;

const keyName = (k: string): string => RU[k] ?? snake(k);

/** Ключ-ссылка → имя объекта без суффикса: counterpartyRef → counterparty, Контрагент_Key → Контрагент. */
function refBase(k: string): string | undefined {
  if (k === "ref" || k === "Ref_Key" || k === "guid" || k === "Ref") return "";
  const ru = /^(.+)_Key$/.exec(k);
  if (ru) return ru[1];
  const en = /^(.+?)(Ref|Key|_ref|_key|Guid|_guid)$/.exec(k);
  return en ? en[1] : undefined;
}

interface Pending {
  obj: Record<string, unknown>;
  target: string;
}

interface Ctx {
  pending: Pending[];
  entitySet?: string;
  navTarget: (set: string | undefined, base: string) => string | undefined;
}

/** Дата 1С: «2026-10-07T00:00:00» → «2026-10-07», со временем — «2026-10-07 10:00». */
const dateOnly = (v: string): string => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.\d+)?Z?$/.exec(v);
  if (!m) return v;
  return m[2] === "00:00" && m[3] === "00" ? m[1]! : `${m[1]} ${m[2]}`;
};
const emptyDate = (v: unknown) => typeof v === "string" && v.startsWith("0001-01-01");

function shapeValue(v: unknown, ctx: Ctx, set: string | undefined): unknown {
  if (Array.isArray(v)) return v.map((x) => shapeValue(x, ctx, set));
  if (v && typeof v === "object") return shapeObject(v as Record<string, unknown>, ctx, set);
  if (typeof v === "string") return dateOnly(v);
  return v;
}

function shapeObject(
  o: Record<string, unknown>,
  ctx: Ctx,
  parentSet: string | undefined,
): Record<string, unknown> {
  const own = [o["entitySet"], o["willCreate"], o["willPatch"]].find(
    (v): v is string => typeof v === "string" && /^[A-Za-z]+_/.test(v),
  );
  const set = own ?? parentSet;
  const used = new Set<string>();
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (!(k in out)) out[k] = v;
  };
  const nameOf = (base: string): string | undefined => {
    for (const k of [base, `${base}Name`, `${base}_name`, `${base}Description`, `${base}Title`]) {
      const v = o[k];
      if (typeof v === "string" && v.trim() && !GUID_RE.test(v.trim())) {
        used.add(k);
        return v.trim();
      }
    }
    return undefined;
  };

  // 1. ссылки — первыми: забираем к ним названия из соседних полей
  for (const [k, v] of Object.entries(o)) {
    if (isService(k) || !isGuid(v)) continue;
    const base = refBase(k);
    if (base === undefined) {
      if (k.endsWith("_Type")) continue;
      // составное поле 1С (значение + _Type) или guid под именем объекта («counterparty») — тоже ссылка
      if (typeof o[`${k}_Type`] !== "string" && !EN_TARGETS[k] && !COMMON_TARGETS[k]) continue;
    }
    used.add(k);
    if (norm(v) === EMPTY) continue;
    if (base === "") {
      put("guid", norm(v));
      continue;
    }
    const b = base ?? k;
    const typed = String(o[`${b}_Type`] ?? "").replace(/^StandardODATA\./, "");
    if (typed) used.add(`${b}_Type`);
    const name = nameOf(b);
    const ref: Record<string, unknown> = { guid: norm(v), ...(name ? { name } : {}) };
    if (typed && typed !== "Undefined") ref["type"] = typed;
    put(keyName(b), ref);
    if (!name) {
      const target =
        (typed && typed !== "Undefined" ? typed : undefined) ??
        (/[А-Яа-яЁё]/.test(b) ? (ctx.navTarget(set, b) ?? ruTarget(b)) : EN_TARGETS[b]);
      if (target) ctx.pending.push({ obj: ref, target });
    }
  }

  // 2. остальные поля
  for (const [k, v] of Object.entries(o)) {
    if (used.has(k) || isService(k)) continue;
    if (k === "view" && "payload" in o) continue; // карточка предпросмотра — для экрана; модели хватает payload
    if (k.endsWith("_Type") && k.slice(0, -5) in o) continue;
    if (v === null || v === undefined || v === "" || emptyDate(v)) continue;
    if (typeof v === "string" && norm(v) === EMPTY) continue;
    const name = keyName(k);
    if ((k === "КодНазначенияПлатежа" || k === "knp") && typeof v === "string") {
      const code = v.trim();
      put(name, KNP_NAMES[code] ? { code, name: KNP_NAMES[code] } : { code });
      continue;
    }
    if (k === "type" && typeof v === "string" && v === o["entitySet"] && /^(Document|Catalog)_/.test(v)) {
      put(name, previewTitle(v)); // вид объекта по-русски; техническое имя — в entity_set
      continue;
    }
    const childSet = Array.isArray(v) && set && /[А-Яа-яЁё]/.test(k) ? `${set}_${k}` : set;
    const shaped = shapeValue(v, ctx, childSet);
    if (shaped && typeof shaped === "object" && !Array.isArray(shaped) && !Object.keys(shaped).length)
      continue;
    put(name, shaped);
  }
  return out;
}

export interface ReadableResult {
  view: unknown;
  text: string;
}

/** Читаемый вид ответа инструмента (объект и текст TOON с заголовком). Без подключения — без догрузки названий. */
export async function readableResult(
  conn: Connection | undefined,
  title: string,
  data: unknown,
): Promise<ReadableResult> {
  // ссылок в ответе нет — к 1С не ходим (ни $metadata, ни названия)
  if (conn && !HAS_GUID.test(JSON.stringify(data))) conn = undefined;
  const meta = conn ? await conn.getMetadata().catch(() => undefined) : undefined;
  const ctx: Ctx = {
    pending: [],
    navTarget: (set, base) =>
      set ? meta?.entities.get(set)?.navigations?.find((n) => n.name === base)?.toType : undefined,
  };
  const view = shapeValue(data, ctx, undefined);
  if (conn && ctx.pending.length) {
    const wanted = new Map<string, Set<string>>();
    for (const p of ctx.pending.slice(0, MAX_NAMES)) {
      let s = wanted.get(p.target);
      if (!s) wanted.set(p.target, (s = new Set()));
      s.add(String(p.obj["guid"]));
    }
    const names = await resolveNames(conn, wanted).catch(() => new Map<string, string>());
    for (const p of ctx.pending) {
      const name = names.get(String(p.obj["guid"]));
      if (name) {
        // name — сразу после guid, тип — последним
        const { guid, type, ...rest } = p.obj;
        for (const k of Object.keys(p.obj)) delete p.obj[k];
        Object.assign(p.obj, { guid, name, ...rest, ...(type ? { type } : {}) });
      }
    }
  }
  return { view, text: `# ${title}\n${encode(view)}` };
}

/** Сколько голых ссылок одного ответа догружаем названиями (дальше — guid как есть: длинные выборки). */
const MAX_NAMES = 600;
