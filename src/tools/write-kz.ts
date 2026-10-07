/**
 * Запись в 1С:Бухгалтерию для Казахстана — те же инструменты, что и для российской базы, но с казахстанскими
 * реквизитами: БИН/ИИН в ИдентификационныйКодЛичности, ставка НДС — элемент справочника «Ставки НДС»,
 * договор — НомерДоговора/ДатаДоговора, валюта KZT, счёт на оплату — табличные части «Товары» и «Услуги»
 * с единицей измерения из карточки номенклатуры. Форма каждого объекта сверена с документами,
 * созданными в самой 1С:Fresh.kz.
 */
import type { Connection } from "../context.js";
import { InputError } from "../errors.js";
import { CATALOGS } from "../config/mapping.js";
import { fetchAll } from "../odata/pagination.js";
import { cmp, odataGuid, odataString, or } from "../odata/query.js";
import { requireEntity } from "../odata/publication.js";

/** Казахстанская конфигурация: план счетов «Типовой» или БИН/ИИН у контрагентов. */
export async function isKazakhstan(conn: Connection): Promise<boolean> {
  if (typeof (conn as { getMetadata?: unknown }).getMetadata !== "function") return false;
  const meta = await conn.getMetadata();
  const counterparties = meta.entities.get("Catalog_Контрагенты");
  return (
    meta.entities.has("ChartOfAccounts_Типовой") ||
    !!counterparties?.properties.some((p) => p.name === "ИдентификационныйКодЛичности")
  );
}

/** Инструменты записи, которые умеют казахстанскую базу; остальные в ней отвечают отказом. */
export const KZ_WRITE_TOOLS = [
  "write.counterparty.create_counterparty",
  "write.catalog.create_nomenclature",
  "write.catalog.create_contract",
  "write.sales.create_invoice",
  "write.entity.mark_for_deletion",
  "write.operation.status",
  "write.document.create_document",
  "write.document.update_document",
  "write.document.post_document",
] as const;

/**
 * Документы, которые в казахстанской базе пишутся общими инструментами (create_document, update_document,
 * post_document): зарплата, налоги и взносы с неё, выплата. Суммы и ставки задаёт вызывающий — MCP их
 * не рассчитывает, а только проверяет поля по $metadata базы.
 */
export const KZ_DOCUMENTS = [
  "Document_НачислениеЗарплатыРаботникамОрганизаций",
  "Document_РасчетУдержанийРаботниковОрганизаций",
  "Document_РасчетСНиСО",
  "Document_РасчетЕдиногоПлатежа",
  "Document_ОтражениеЗарплатыВРеглУчете",
  "Document_ЗарплатаКВыплатеОрганизаций",
  "Document_ПлатежноеПоручениеИсходящее",
  "Document_ОПВПеречислениеВФонды",
  "Document_СОПеречислениеВФонды",
  "Document_ЕППеречислениеВФонды",
  "Document_РасходныйКассовыйОрдер",
  "Document_СчетНаОплатуПокупателю",
] as const;

/** Общие инструменты записи документов: в казахстанской базе — только для KZ_DOCUMENTS. */
export const KZ_DOCUMENT_TOOLS = [
  "write.document.create_document",
  "write.document.update_document",
  "write.document.post_document",
] as const;

/** Ставки в казахстанском виде (как в справочнике «Ставки НДС»). */
export const KZ_VAT_RATES = ["без НДС", "0%", "5%", "10%", "12%", "16%"] as const;

/** Российские имена ставок, которые однозначно соответствуют казахстанским (ключ — без пробелов и регистра). */
const VAT_ALIASES: Record<string, string> = {
  безндс: "без ндс",
  ндс0: "0%",
  ндс5: "5%",
  ндс10: "10%",
  ндс12: "12%",
  ндс16: "16%",
};

const normalize = (rate: string): string => rate.trim().toLowerCase().replace(/\s+/g, " ");
/** Ключ ставки как в справочнике: «БезНДС» и «без НДС» → «без ндс», «12 %» и «НДС12» → «12%». */
const vatKey = (rate: string): string => {
  const compact = rate.toLowerCase().replace(/[^а-яёa-z0-9%]/g, "");
  return VAT_ALIASES[compact] ?? (/^\d+%$/.test(compact) ? compact : normalize(rate));
};
/** Процент ставки: «16%» → 16, «без НДС» → 0. */
export const vatPercent = (rate: string): number => Number(/^(\d+(?:[.,]\d+)?)%$/.exec(vatKey(rate))?.[1]?.replace(",", ".") ?? 0);
export const isWithoutVat = (rate: string): boolean => vatKey(rate) === "без ндс";

/** Ref_Key ставок НДС базы по нормализованному наименованию («16%», «без ндс»). */
export async function vatRateRefs(conn: Connection, rates: readonly string[]): Promise<Map<string, string>> {
  const set = await requireEntity(conn, ["Catalog_СтавкиНДС"], "Справочник «Ставки НДС»");
  const { rows } = await fetchAll(conn.client, set, { select: ["Ref_Key", "Description", "DeletionMark"] }, 50, 200);
  const byName = new Map(
    rows.filter((r) => r["DeletionMark"] !== true).map((r) => [normalize(String(r["Description"] ?? "")), String(r["Ref_Key"])]),
  );
  const out = new Map<string, string>();
  for (const rate of rates) {
    const ref = byName.get(vatKey(rate));
    if (!ref) {
      throw new InputError(
        `Ставка НДС «${rate}» не найдена в справочнике «Ставки НДС» этой базы. Есть: ${[...byName.keys()].join(", ")}.`,
      );
    }
    out.set(rate, ref);
  }
  return out;
}

/** Валюта KZT (код 398) — валюта документов по умолчанию. */
export async function tengeRef(conn: Connection): Promise<string | undefined> {
  const set = await requireEntity(conn, CATALOGS.currencies, "Справочник «Валюты»");
  const { rows } = await fetchAll(conn.client, set, { filter: cmp("Code", "eq", odataString("398")), select: ["Ref_Key"] }, 1, 1);
  return rows[0] ? String(rows[0]["Ref_Key"]) : undefined;
}

/** Единица измерения по наименованию (по умолчанию «шт», код 796). */
export async function unitRef(conn: Connection, name = "шт"): Promise<string> {
  const set = await requireEntity(
    conn,
    ["Catalog_КлассификаторЕдиницИзмерения", "Catalog_ЕдиницыИзмерения"],
    "Справочник единиц измерения",
  );
  const { rows } = await fetchAll(
    conn.client,
    set,
    { filter: or(cmp("Description", "eq", odataString(name)), cmp("Code", "eq", odataString("796"))), select: ["Ref_Key", "Description"] },
    5,
    5,
  );
  const hit = rows.find((r) => String(r["Description"]) === name) ?? (name === "шт" ? rows[0] : undefined);
  if (!hit) throw new InputError(`Единица измерения «${name}» не найдена в справочнике.`);
  return String(hit["Ref_Key"]);
}

export interface KzCounterpartyInput {
  name: string;
  inn?: string | undefined;
  kpp?: string | undefined;
  ogrn?: string | undefined;
  fullName?: string | undefined;
  legalType?: "ЮридическоеЛицо" | "ФизическоеЛицо" | undefined;
  kbe?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  address?: string | undefined;
}

export function kzCounterpartyPayload(input: KzCounterpartyInput): { payload: Record<string, unknown>; notes: string[] } {
  if (input.kpp || input.ogrn) {
    throw new InputError("В казахстанской базе нет КПП и ОГРН: передайте БИН/ИИН в inn.");
  }
  const bin = input.inn?.trim();
  if (bin && !/^\d{12}$/.test(bin)) throw new InputError("БИН/ИИН — 12 цифр.");
  if (input.kbe && !/^\d{2}$/.test(input.kbe.trim())) throw new InputError("КБЕ — две цифры (напр. 17 или 19).");
  const notes =
    input.phone || input.email || input.address
      ? ["Телефон, email и адрес в казахстанской базе этим инструментом не записываются — добавьте их в карточке в 1С."]
      : [];
  return {
    payload: {
      Description: input.name,
      НаименованиеПолное: input.fullName ?? input.name,
      ИдентификационныйКодЛичности: bin,
      ЮрФизЛицо: input.legalType === "ФизическоеЛицо" ? "ФизЛицо" : input.legalType === "ЮридическоеЛицо" ? "ЮрЛицо" : undefined,
      КБЕ: input.kbe?.trim(),
    },
    notes,
  };
}

export interface KzInvoiceLine {
  nomenclatureRef: string;
  quantity: number;
  price: number;
  vatRate: string;
  content?: string | undefined;
}

const roundMoney = (n: number): number => Math.round(n * 100) / 100;

/** Товары и услуги счёта на оплату: раскладка по признаку «Услуга» номенклатуры, НДС по ставке строки. */
export async function kzInvoiceRows(
  conn: Connection,
  lines: KzInvoiceLine[],
  sumIncludesVat: boolean,
): Promise<{ goods: Array<Record<string, unknown>>; services: Array<Record<string, unknown>>; withVat: boolean; total: number }> {
  const set = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
  const refs = [...new Set(lines.map((l) => l.nomenclatureRef.replace(/[{}]/g, "")))];
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: or(...refs.map((r) => cmp("Ref_Key", "eq", odataGuid(r)))),
      select: ["Ref_Key", "Description", "Услуга", "БазоваяЕдиницаИзмерения_Key"],
    },
    50,
    refs.length,
  );
  const items = new Map(rows.map((r) => [String(r["Ref_Key"]), r]));
  const missing = refs.filter((r) => !items.has(r));
  if (missing.length) throw new InputError(`Номенклатура не найдена: ${missing.join(", ")}.`);

  // Без НДС у всех строк — документ без учёта НДС, как у неплательщиков: ставка в строках пустая.
  const withVat = lines.some((l) => !isWithoutVat(l.vatRate));
  const vatRefs = withVat ? await vatRateRefs(conn, [...new Set(lines.map((l) => l.vatRate))]) : new Map<string, string>();
  const fallbackUnit = lines.some((l) => {
    const item = items.get(l.nomenclatureRef.replace(/[{}]/g, ""));
    return item?.["Услуга"] !== true && !item?.["БазоваяЕдиницаИзмерения_Key"];
  })
    ? await unitRef(conn)
    : undefined;

  const goods: Array<Record<string, unknown>> = [];
  const services: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const l of lines) {
    const ref = l.nomenclatureRef.replace(/[{}]/g, "");
    const item = items.get(ref)!;
    const sum = roundMoney(l.quantity * l.price);
    const rate = withVat ? vatPercent(l.vatRate) : 0;
    const vat = roundMoney(sumIncludesVat ? (sum * rate) / (100 + rate) : (sum * rate) / 100);
    total += sum + (withVat && !sumIncludesVat ? vat : 0);
    const common = {
      Номенклатура_Key: ref,
      Количество: l.quantity,
      Цена: l.price,
      Сумма: sum,
      ...(withVat ? { СтавкаНДС_Key: vatRefs.get(l.vatRate) } : {}),
      СуммаНДС: vat,
    };
    if (item["Услуга"] === true) {
      services.push({ LineNumber: services.length + 1, ...common, Содержание: l.content ?? String(item["Description"] ?? "") });
    } else {
      const unit = item["БазоваяЕдиницаИзмерения_Key"];
      goods.push({
        LineNumber: goods.length + 1,
        ...common,
        ЕдиницаИзмерения_Key: unit && unit !== "00000000-0000-0000-0000-000000000000" ? unit : fallbackUnit,
        Коэффициент: 1,
      });
    }
  }
  return { goods, services, withVat, total: roundMoney(total) };
}
