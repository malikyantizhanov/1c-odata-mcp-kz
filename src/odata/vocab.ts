/**
 * Общий словарь полей документа: понятные английские имена ⇄ реквизиты 1С. Один и тот же для чтения
 * (read.document.get_document — читаемый вид) и для записи: интеграция читает и пишет документ в одних полях.
 *
 * Ключ — имя реквизита 1С без суффикса _Key (ссылка) или как есть (простое поле). Реквизит, которого нет в
 * словаре, остаётся под своим русским именем (ссылка — без _Key, со значением {guid, name}).
 */

/** Реквизиты шапки (общие для документов БП РК). */
export const HEADER_FIELDS: Readonly<Record<string, string>> = {
  Number: "number",
  Date: "date",
  Posted: "is_posted",
  DeletionMark: "is_deleted",
  СуммаДокумента: "total_amount",
  Комментарий: "comment",
  АдресДоставки: "delivery_address",
  Организация: "organization",
  СтруктурноеПодразделение: "department",
  Склад: "warehouse",
  Контрагент: "counterparty",
  ДоговорКонтрагента: "contract",
  ДокументОснование: "basis",
  ВалютаДокумента: "currency",
  КурсВзаиморасчетов: "exchange_rate",
  КратностьВзаиморасчетов: "rate_multiplier",
  ТипЦен: "price_type",
  УчитыватьНДС: "apply_vat",
  СуммаВключаетНДС: "amount_includes_vat",
  УчитыватьАкциз: "apply_excise",
  СуммаВключаетАкциз: "amount_includes_excise",
  КодНазначенияПлатежа: "knp",
  СтруктурнаяЕдиница: "bank_account",
  БанковскийСчетОрганизации: "organization_bank_account",
  СчетОрганизации: "organization_bank_account",
  СчетКонтрагента: "counterparty_bank_account",
  НазначениеПлатежа: "payment_purpose",
  СуммаНДС: "vat_amount",
  СтавкаНДС: "vat_rate",
  Ответственный: "responsible_person",
  Автор: "author",
  ВидОперации: "operation_kind",
  ДатаОборота: "turnover_date",
  ДатаВыполненияРабот: "work_date",
  Направление: "direction",
  Статус: "status",
};

/** Табличные части. */
export const TABLES: Readonly<Record<string, string>> = {
  Услуги: "services",
  Товары: "goods",
  ОС: "fixed_assets",
  НМА: "intangibles",
  ДокументыОснования: "bases",
  РасшифровкаПлатежа: "payment_breakdown",
  Начисления: "accruals",
  Удержания: "deductions",
};

/** Поля строк табличных частей. */
export const ROW_FIELDS: Readonly<Record<string, string>> = {
  LineNumber: "line_number",
  Номенклатура: "nomenclature",
  Содержание: "description",
  Количество: "quantity",
  Цена: "price",
  Сумма: "sum",
  СтавкаНДС: "vat_rate",
  СуммаНДС: "vat_amount",
  ЕдиницаИзмерения: "unit",
  Коэффициент: "unit_ratio",
  ДоговорКонтрагента: "contract",
  ДокументРасчетовСКонтрагентом: "settlement_document",
  СуммаПлатежа: "payment_sum",
  Сотрудник: "employee",
  ФизЛицо: "person",
  Результат: "result",
};

/** Служебные поля OData, которых нет в читаемом виде. */
export const SERVICE_FIELDS = new Set(["odata.metadata", "DataVersion", "Ref_Key"]);

const invert = (m: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));

/** Английское имя → реквизит 1С (для записи). Первое русское имя у синонимов (organization_bank_account). */
export const HEADER_FROM: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [ru, en] of Object.entries(HEADER_FIELDS)) if (!(en in out)) out[en] = ru;
  return out;
})();
export const TABLES_FROM: Readonly<Record<string, string>> = invert(TABLES);
export const ROW_FROM: Readonly<Record<string, string>> = invert(ROW_FIELDS);
