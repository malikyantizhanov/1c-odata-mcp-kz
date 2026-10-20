/**
 * Суммы зарплатных расчётных документов считает 1С в форме («Заполнить», «Рассчитать»). Через OData 1С их не
 * досчитывает: проверено на живой базе (ZZ-TEST, 20.10.2026) — начисление без «Результат», ведомость с
 * «Авторасчет» и перечисление ЕП по документу-основанию с пустыми строками проводятся (HTTP 200, Posted=true)
 * с нулями и без движений. Поэтому post_document такой документ не проводит, а create/update предупреждают.
 */

type Scalar = string | number | boolean | null | undefined;
type Row = Record<string, unknown>;

/** Где у документа лежат суммы: табличная часть → числовые реквизиты строки; header — реквизиты шапки. */
export interface PayrollSumSpec {
  title: string;
  tables: Record<string, string[]>;
  header?: string[];
}

export const PAYROLL_SUM_DOCS: Readonly<Record<string, PayrollSumSpec>> = {
  Document_НачислениеЗарплатыРаботникамОрганизаций: {
    title: "Начисление зарплаты",
    tables: { Начисления: ["Результат"] },
  },
  Document_РасчетУдержанийРаботниковОрганизаций: {
    title: "Расчёт удержаний",
    tables: {
      ИсчисленныйИПН: ["Налог"],
      ИсчисленныйОПВ: ["Взнос"],
      ИсчисленныеВОСМС: ["Взнос"],
      Удержания: ["Результат"],
    },
  },
  Document_РасчетСНиСО: {
    title: "Расчёт СН и СО",
    tables: {
      ИсчисленныйСН: ["Налог"],
      ИсчисленныеСО: ["Отчисление"],
      ИсчисленныйОППВ: ["Взнос"],
      ИсчисленныеООСМС: ["Отчисление"],
      ИсчисленныйОПВР: ["Взнос"],
    },
  },
  Document_РасчетЕдиногоПлатежа: {
    title: "Расчёт единого платежа",
    tables: { ИсчисленныйЕП: ["СуммаПлатежа"], Удержания: ["Результат"] },
  },
  Document_ОтражениеЗарплатыВРеглУчете: {
    title: "Отражение зарплаты в регл. учёте",
    tables: { ОтражениеВУчете: ["Сумма"] },
  },
  Document_ЗарплатаКВыплатеОрганизаций: {
    title: "Зарплата к выплате (ведомость)",
    tables: { Зарплата: ["Сумма", "СуммаКВыплате"] },
    header: ["СуммаДокумента"],
  },
  Document_ОПВПеречислениеВФонды: {
    title: "Перечисление ОПВ в фонды",
    tables: { ПенсионныеВзносы: ["Сумма"] },
    header: ["СуммаДокумента"],
  },
  Document_СОПеречислениеВФонды: {
    title: "Перечисление СО в фонды",
    tables: { СоциальныеОтчисления: ["Сумма"] },
    header: ["СуммаДокумента"],
  },
  Document_ЕППеречислениеВФонды: {
    title: "Перечисление единого платежа",
    tables: { ЕдиныеПлатежи: ["Сумма"] },
    header: ["СуммаДокумента"],
  },
};

export const PAYROLL_SUM_SETS: ReadonlySet<string> = new Set(Object.keys(PAYROLL_SUM_DOCS));

/** Подсказка для kz_document_guide и отказа проведения. */
export const PAYROLL_FORM_HINT =
  "Суммы считает 1С в форме: откройте документ в 1С и нажмите «Заполнить»/«Рассчитать», затем проведите. " +
  "Через OData 1С их не досчитывает — пустой документ проведётся с нулями и без движений (проверено на живой базе).";

const num = (v: Scalar | unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
};

export interface PayrollSumCheck {
  /** Все суммы документа пустые или нулевые. */
  empty: boolean;
  /** Строки с нулевой суммой при ненулевых других: «Таблица: строки 2, 3». */
  zeroRows: string[];
  /** Какие поля проверены. */
  checked: string[];
}

/**
 * Проверяет суммы документа (объект из 1С или тело запроса). onlyPresent=true — смотреть только табличные части
 * и реквизиты, которые есть в объекте (для update: изменяемая часть), иначе отсутствующая ТЧ = пустая.
 */
export function checkPayrollSums(
  entitySet: string,
  doc: Row,
  onlyPresent = false,
): PayrollSumCheck | undefined {
  const spec = PAYROLL_SUM_DOCS[entitySet];
  if (!spec) return undefined;
  let total = 0;
  const zeroRows: string[] = [];
  const checked: string[] = [];
  for (const [table, fields] of Object.entries(spec.tables)) {
    const rows = doc[table];
    if (onlyPresent && !Array.isArray(rows)) continue;
    checked.push(`${table}.${fields.join("/")}`);
    if (!Array.isArray(rows)) continue;
    const zero: number[] = [];
    (rows as Row[]).forEach((r, i) => {
      const s = fields.reduce((a, f) => a + Math.abs(num(r[f])), 0);
      total += s;
      if (s === 0) zero.push(Number(r["LineNumber"] ?? i + 1));
    });
    if (zero.length && zero.length < rows.length) zeroRows.push(`${table}: строки ${zero.join(", ")}`);
  }
  for (const f of spec.header ?? []) {
    if (onlyPresent && !(f in doc)) continue;
    checked.push(f);
    total += Math.abs(num(doc[f]));
  }
  if (checked.length === 0) return { empty: false, zeroRows, checked };
  return { empty: total === 0, zeroRows, checked };
}

/** Предупреждения для create/update (не блокируют запись). */
export function payrollSumNotes(entitySet: string, doc: Row, onlyPresent = false): string[] {
  const c = checkPayrollSums(entitySet, doc, onlyPresent);
  if (!c || c.checked.length === 0) return [];
  const title = PAYROLL_SUM_DOCS[entitySet]!.title;
  if (c.empty)
    return [
      `${title}: суммы пустые или нулевые (${c.checked.join(", ")}). ${PAYROLL_FORM_HINT} ` +
        "write.document.post_document такой документ проводить откажется.",
    ];
  if (c.zeroRows.length)
    return [
      `${title}: нулевые суммы в части строк (${c.zeroRows.join("; ")}) — проверьте расчёт в форме 1С.`,
    ];
  return [];
}

/** Текст отказа проведения или undefined, если суммы есть. */
export function payrollPostRefusal(entitySet: string, doc: Row): string | undefined {
  const c = checkPayrollSums(entitySet, doc);
  if (!c?.empty) return undefined;
  const title = PAYROLL_SUM_DOCS[entitySet]!.title;
  return (
    `Проведение отклонено: в документе «${title}» суммы пустые или нулевые (${c.checked.join(", ")}). ` +
    "Суммы ставит 1С в форме — нажмите «Заполнить»/«Рассчитать» в 1С и проведите там. " +
    "Через OData 1С суммы не досчитывает: документ провёлся бы с нулями и без движений."
  );
}
