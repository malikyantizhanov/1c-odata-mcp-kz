import type { Connection } from "../context.js";
import { InputError } from "../errors.js";

/**
 * Имена объектов 1С в параметрах инструментов. Агенты и люди часто пишут тип документа без префикса OData
 * («СчетНаОплатуПокупателю») или в синтаксисе 1С («Документ.СчетНаОплатуПокупателю») — раньше это давало
 * «не опубликован в OData». Здесь имя приводится к техническому имени EntitySet.
 */

/** Префиксы классов объектов в стандартном интерфейсе OData 1С. */
export const ODATA_CLASS_PREFIXES = [
  "Catalog",
  "Document",
  "DocumentJournal",
  "Constant",
  "ExchangePlan",
  "ChartOfAccounts",
  "ChartOfCalculationTypes",
  "ChartOfCharacteristicTypes",
  "InformationRegister",
  "AccumulationRegister",
  "CalculationRegister",
  "AccountingRegister",
  "BusinessProcess",
  "Task",
  "Enum",
] as const;

const CLASS_RE = new RegExp(`^(?:${ODATA_CLASS_PREFIXES.join("|")})_`);

/** Синтаксис 1С (рус./англ.) → префикс OData: «Документ.Х» → «Document_Х». */
const ONEC_SYNTAX: ReadonlyArray<[RegExp, string]> = [
  [/^(?:Документ|Document)\./i, "Document_"],
  [/^(?:Справочник|Catalog)\./i, "Catalog_"],
  [/^(?:РегистрСведений|InformationRegister)\./i, "InformationRegister_"],
  [/^(?:РегистрНакопления|AccumulationRegister)\./i, "AccumulationRegister_"],
  [/^(?:РегистрБухгалтерии|AccountingRegister)\./i, "AccountingRegister_"],
  [/^(?:ПланСчетов|ChartOfAccounts)\./i, "ChartOfAccounts_"],
  [/^(?:ПланВидовХарактеристик|ChartOfCharacteristicTypes)\./i, "ChartOfCharacteristicTypes_"],
  [/^(?:Перечисление|Enum)\./i, "Enum_"],
];

/** Есть ли у имени префикс класса OData (Catalog_, Document_, …). Подчёркивание внутри имени — не префикс. */
export const hasClassPrefix = (name: string): boolean => CLASS_RE.test(name);

/** Обрезает пробелы и переводит синтаксис 1С в префикс OData; без префикса — как есть. */
export function normalizeEntityName(name: string): string {
  const n = name.trim();
  for (const [re, prefix] of ONEC_SYNTAX) if (re.test(n)) return prefix + n.replace(re, "");
  return n;
}

/**
 * Имя документа: «СчетНаОплатуПокупателю», «Документ.СчетНаОплатуПокупателю» → «Document_СчетНаОплатуПокупателю».
 * Имя с префиксом другого класса (Catalog_…) — ошибка: параметр ждёт документ.
 */
export function normalizeDocumentEntity(name: string): string {
  const n = normalizeEntityName(name);
  if (!n) return n;
  if (n.startsWith("Document_")) return n;
  if (hasClassPrefix(n)) throw new InputError(`Ожидается документ (Document_…), передано «${n}».`);
  return `Document_${n}`;
}

/**
 * Имя объекта любого класса: точное имя — как есть; синтаксис 1С — в префикс OData; без префикса — ищется среди
 * опубликованных Document_<имя> и Catalog_<имя>: ровно одно — оно, оба — ошибка с вариантами, ни одного — как есть
 * (инструмент сам скажет, что объект не опубликован).
 */
export async function resolveEntityName(conn: Connection, name: string): Promise<string> {
  const n = normalizeEntityName(name);
  if (!n || hasClassPrefix(n)) return n;
  const available = await conn.available();
  if (available.has(n)) return n;
  const hits = ["Document_", "Catalog_"].map((p) => p + n).filter((c) => available.has(c));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1)
    throw new InputError(`Имя «${n}» неоднозначно: ${hits.join(" или ")}. Укажите полное имя с префиксом.`);
  return n;
}

/** Параметры-документы по инструментам: к ним дописывается Document_. */
export const DOCUMENT_ENTITY_PARAMS: Readonly<Record<string, string>> = {
  "read.document.search_documents": "entitySet",
  "read.document.get_document": "entitySet",
  "read.document.get_document_movements": "documentEntity",
  "read.accounting.get_document_postings": "documentEntity",
  "read.audit.get_document_history": "documentEntity",
  "read.system.kz_document_guide": "entitySet",
  "write.document.create_document": "entitySet",
  "write.document.update_document": "entitySet",
  "write.document.post_document": "entitySet",
  "write.document.update_document_lines": "entitySet",
  "write.document.add_document_line": "entitySet",
  "write.document.remove_document_line": "entitySet",
  "write.document.copy_document": "entitySet",
};

/** Параметры-объекты любого класса: префикс подбирается по опубликованным объектам. */
export const ANY_ENTITY_PARAMS: Readonly<Record<string, string>> = {
  "read.schema.describe_entity": "entitySet",
  "write.entity.mark_for_deletion": "entitySet",
  "write.entity.update_entity": "entitySet",
  "read.files.list_attachments": "entitySet",
};

/** Приводит имя объекта в аргументах инструмента (новый объект; исходный не меняется). */
export async function normalizeToolArgs(
  name: string,
  args: Record<string, unknown>,
  conn: () => Connection,
): Promise<Record<string, unknown>> {
  const docParam = DOCUMENT_ENTITY_PARAMS[name];
  if (docParam && typeof args[docParam] === "string" && args[docParam])
    return { ...args, [docParam]: normalizeDocumentEntity(args[docParam]) };
  const anyParam = ANY_ENTITY_PARAMS[name];
  if (anyParam && typeof args[anyParam] === "string" && args[anyParam])
    return { ...args, [anyParam]: await resolveEntityName(conn(), args[anyParam]) };
  return args;
}
