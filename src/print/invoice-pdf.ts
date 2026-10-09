import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { amountInWords } from "./amount-words.js";

/**
 * PDF «Счёт на оплату» по макету печатной формы 1С:Бухгалтерии для Казахстана 3.0 (команда «Счет на оплату»).
 * Координаты линий, колонки, кегли и отступы сняты с PDF, который сформировала сама 1С; шрифт Arimo
 * метрически совместим с Arial, которым печатает 1С, поэтому переносы строк совпадают. Печатную форму 1С через
 * OData не вызвать — это её повторение по данным документа: настройки печати базы (свой текст условий,
 * факсимиле, логотип) сюда не попадают.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve("@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf");
const FONT_BOLD = require.resolve("@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf");

export interface InvoicePrintLine {
  code?: string | undefined;
  name: string;
  quantity: number;
  unit?: string | undefined;
  price: number;
  sum: number;
}

export interface InvoicePrintData {
  number: string;
  /** YYYY-MM-DD */
  date: string;
  /** individual — ИП (в 1С «ФизЛицо»): в образце платёжки номер подписан «ИИН:», у юрлица — «БИН:». */
  supplier: {
    name: string;
    bin?: string | undefined;
    kbe?: string | undefined;
    individual?: boolean | undefined;
  };
  bank?: { iik: string; bankName: string; bik?: string | undefined } | undefined;
  paymentCode?: string | undefined;
  buyer: { name: string; bin?: string | undefined };
  contract?: string | undefined;
  lines: InvoicePrintLine[];
  withVat: boolean;
  vatIncluded: boolean;
  vatSum: number;
  total: number;
  currency: string;
  /** «Параметры прописи» валюты из 1С — для суммы прописью («тенге» или «теңге», как настроено в базе). */
  currencySpelling?: string | undefined;
  /** Исполнитель — как в подписи формы; без него 1С печатает «<Не указан>». */
  executor?: string | undefined;
}

/** Текст условий из типового макета счёта. */
export const INVOICE_TERMS =
  "Внимание! Оплата данного счета означает согласие с условиями поставки товара. Уведомление об оплате " +
  "обязательно, в противном случае не гарантируется наличие товара на складе. Товар отпускается по факту " +
  "прихода денег на р/с Поставщика, самовывозом, при наличии доверенности и документов удостоверяющих личность.";

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
/** «7 октября 2026 г.» */
export const dateWords = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y} г.`;
};
/** «15 000,00» — пробел между тысячами, запятая в дробной части. */
export const money = (n: number, digits = 2): string => {
  const [int, frac] = Math.abs(n).toFixed(digits).split(".");
  return `${n < 0 ? "-" : ""}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${frac}`;
};
/** Количество — три знака, как в форме 1С: «1,000». */
export const quantity = (n: number): string => money(n, 3);

/**
 * Номер бенефициара в образце платёжки — как ОбщегоНазначенияБК.ПолучитьРегистрационныйНомерОрганизацииКонтрагентаВПечатнуюФорму:
 * «ИИН: …», если организация — физлицо (ИП), иначе «БИН: …».
 */
export const beneficiaryId = (bin: string, individual?: boolean): string =>
  `${individual ? "ИИН" : "БИН"}: ${bin}`;

/** « БИН / ИИН 211040003047,ТОО ...» — так 1С печатает стороны: с пробелом в начале и без пробела после запятой. */
export const partyText = (name: string, bin?: string): string => (bin ? ` БИН / ИИН ${bin},${name}` : name);

// Сетка формы (pt, начало координат — левый верхний угол листа A4).
const BEN = { left: 33.85, col2: 317.3, col3: 443.3, bankCol3: 411.86, right: 536.53 };
const RULE = { left: 33.48, right: 536.16 };
const ITEMS = [34.23, 65.3, 129.13, 293.77, 341.06, 377.06, 451.33, 532.23];
const PAGE_BOTTOM = 800;
// Фактические кегли в PDF 1С: «10» печатается как 9,84, «14» — как 14,28, «8» — как 8,04 (1С пересчитывает
// размер шрифта через пиксели экрана); «9» и подзаголовок «Образец…» — без изменений.
const F8 = 8.04;
const F10 = 9.84;
const F14 = 14.28;
const THIN = 0.75;
const THICK = 1.5;

export function renderInvoicePdf(d: InvoicePrintData): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 0,
    info: { Title: `Счет на оплату № ${d.number} от ${d.date}` },
  });
  pdf.registerFont("r", FONT);
  pdf.registerFont("b", FONT_BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  type Opts = { width?: number; align?: "left" | "center" | "right"; lineGap?: number };
  const text = (s: string, font: "r" | "b", size: number, x: number, y: number, o: Opts = {}) =>
    pdf
      .font(font)
      .fontSize(size)
      .text(s, x, y, { lineBreak: o.width !== undefined, ...o });
  const height = (s: string, font: "r" | "b", size: number, width: number, lineGap = 0) =>
    pdf.font(font).fontSize(size).heightOfString(s, { width, lineGap });
  const line = (x1: number, y1: number, x2: number, y2: number, w: number) =>
    pdf.moveTo(x1, y1).lineTo(x2, y2).lineWidth(w).stroke();

  // Условия — по центру над реквизитами.
  text(INVOICE_TERMS, "r", F8, 115.1, 42.8, { width: 420, align: "center" });

  // Образец платёжного поручения.
  text("Образец платежного поручения", "b", 9.96, 36, 105.8);
  const top = 118.33;
  const rowB = 130.71;
  const nameGap = 0.45; // межстрочный интервал 1С в ячейке реквизитов — 10,8 pt при 9 pt
  const nameWidth = BEN.col2 - 35.8 - 2;
  const nameH = height(d.supplier.name, "b", 9, nameWidth, nameGap);
  const binTop = Math.max(rowB + 0.4 + nameH + 1, rowB + 23);
  const middle = Math.max(d.supplier.bin ? binTop + 10.8 + 0.64 : rowB + 0.4 + nameH + 1, rowB + 34.43);
  const rowD = middle + 12.37;
  const bankName = d.bank?.bankName ?? "";
  const bottom = Math.max(rowD + 11.63, rowD + 0.4 + height(bankName, "r", 9, BEN.col2 - 35.5 - 2) + 1.2);

  text("Бенефициар:", "b", 9, 35.8, top + 0.77);
  text(d.supplier.name, "b", 9, 35.8, rowB + 0.4, { width: nameWidth, lineGap: nameGap });
  if (d.supplier.bin) text(beneficiaryId(d.supplier.bin, d.supplier.individual), "r", 9, 35.5, binTop);
  const center = (s: string, font: "r" | "b", size: number, x1: number, x2: number, y: number) =>
    text(s, font, size, x1, y, { width: x2 - x1, align: "center" });
  center("ИИК", "b", 9, BEN.col2, BEN.col3, top + 0.77);
  center("Кбе", "b", 9, BEN.col3, BEN.right, top + 0.77);
  const valueY = (rowB + middle) / 2 - 5.4;
  center(d.bank?.iik ?? "", "b", 9, BEN.col2, BEN.col3, valueY);
  center(d.supplier.kbe ?? "", "b", 9, BEN.col3, BEN.right, valueY);
  text("Банк бенефициара:", "r", 9, 35.5, middle + 0.56);
  text(bankName, "r", 9, 35.5, rowD + 0.2, { width: BEN.col2 - 35.5 - 2 });
  center("БИК", "b", 9, BEN.col2, BEN.bankCol3, middle + 0.76);
  center("Код назначения платежа", "b", 9, BEN.bankCol3, BEN.right, middle + 0.76);
  center(d.bank?.bik ?? "", "b", 9, BEN.col2, BEN.bankCol3, rowD + 0.4);
  center(d.paymentCode ?? "", "b", 9, BEN.bankCol3, BEN.right, rowD + 0.4);
  for (const y of [top, middle, bottom]) line(BEN.left - 0.37, y, BEN.right - 0.37, y, THIN);
  for (const x of [BEN.left, BEN.col2, BEN.right]) line(x, top, x, bottom, THIN);
  line(BEN.col3, top, BEN.col3, middle, THIN);
  line(BEN.bankCol3, middle, BEN.bankCol3, bottom, THIN);

  // Заголовок и черта.
  const titleY = bottom + 24.16;
  text(`Счет на оплату № ${d.number} от ${dateWords(d.date)}`, "b", F14, 37, titleY);
  const rule1 = titleY + 26.37;
  line(RULE.left, rule1, RULE.right, rule1, THICK);

  // Поставщик, покупатель, договор.
  let y = rule1 + 7.23;
  const partyWidth = RULE.right - 98.9;
  const party = (label: string, value: string) => {
    text(label, "r", F10, 35.8, y);
    text(value, "b", F10, 98.9, y + 0.2, { width: partyWidth, lineGap: 0.38 });
    y += height(value, "b", F10, partyWidth, 0.38) + 8.1;
  };
  party("Поставщик:", partyText(d.supplier.name, d.supplier.bin));
  party("Покупатель:", partyText(d.buyer.name, d.buyer.bin));
  // Как в форме 1С: представление договора (его наименование); без договора поле пустое.
  party("Договор:", d.contract || " ");

  // Таблица позиций: шапка 12,59 pt, внешняя рамка 1,5 pt, внутренние линии 0,75 pt.
  const cols = [
    { title: "№", align: "center" as const, pad: 0 },
    { title: "Код", align: "left" as const, pad: 1.5 },
    { title: "Наименование", align: "left" as const, pad: 1.6 },
    { title: "Кол-во", align: "right" as const, pad: 1.5 },
    { title: "Ед.", align: "left" as const, pad: 1.9 },
    { title: "Цена", align: "right" as const, pad: 2 },
    { title: "Сумма", align: "right" as const, pad: 2.4 },
  ];
  const cell = (
    s: string,
    i: number,
    rowTop: number,
    font: "r" | "b",
    size: number,
    align = cols[i]!.align,
  ) => {
    const pad = align === "center" ? 0 : cols[i]!.pad;
    const x = ITEMS[i]! + (align === "left" ? pad : 0);
    text(s, font, size, x, rowTop, { width: ITEMS[i + 1]! - ITEMS[i]! - pad, align });
  };
  const verticals = (y1: number, y2: number) =>
    ITEMS.forEach((x, i) => line(x, y1, x, y2, i === 0 || i === ITEMS.length - 1 ? THICK : THIN));
  const header = (tableTop: number): number => {
    const rowBottom = tableTop + 12.59;
    line(RULE.left, tableTop, ITEMS[ITEMS.length - 1]! - 0.75, tableTop, THICK);
    cols.forEach((c, i) => cell(c.title, i, tableTop + 0.41, "b", F10, "center"));
    verticals(tableTop - 0.75, rowBottom);
    line(RULE.left, rowBottom, ITEMS[ITEMS.length - 1]! - 0.75, rowBottom, THIN);
    return rowBottom;
  };
  y = header(y);
  d.lines.forEach((l, i) => {
    const values = [
      String(i + 1),
      l.code ?? "",
      l.name,
      quantity(l.quantity),
      l.unit ?? "",
      money(l.price),
      money(l.sum),
    ];
    const h = Math.max(11.17, height(l.name, "r", F8, ITEMS[3]! - ITEMS[2]! - 1.6) + 1.97);
    if (y + h > PAGE_BOTTOM) {
      line(RULE.left, y, ITEMS[ITEMS.length - 1]! - 0.75, y, THICK);
      pdf.addPage({ size: "A4", margin: 0 });
      y = header(36);
    }
    values.forEach((v, j) => cell(v, j, y + 0.52, "r", F8));
    verticals(y, y + h);
    y += h;
    line(RULE.left, y, ITEMS[ITEMS.length - 1]! - 0.75, y, i === d.lines.length - 1 ? THICK : THIN);
  });

  // Итоги: подпись выровнена по колонке «Цена», сумма — по «Сумме».
  y += 7.35;
  const total = (label: string, value: string) => {
    text(label, "b", F10, ITEMS[0]!, y, { width: ITEMS[6]! - ITEMS[0]! - 2.2, align: "right" });
    text(value, "b", F10, ITEMS[6]!, y, { width: ITEMS[7]! - ITEMS[6]! - 3.4, align: "right" });
    y += 13;
  };
  const linesSum = d.lines.reduce((s, l) => s + l.sum, 0);
  total("Итого:", money(linesSum));
  // Как в форме 1С: строка НДС — только при «Учитывать НДС» (нулевая сумма — «-»), «Всего:» — при НДС сверху.
  // Без учёта НДС 1С строку «Без НДС» не печатает — строка остаётся пустой.
  if (d.withVat) {
    total(d.vatIncluded ? "В том числе НДС:" : "Сумма НДС:", d.vatSum ? money(d.vatSum) : "-");
    if (!d.vatIncluded) total("Всего:", money(linesSum + d.vatSum));
  }
  y += 38.7 - 13;
  text(`Всего наименований ${d.lines.length}, на сумму ${money(d.total)} ${d.currency}`, "r", F10, 35.8, y, {
    width: RULE.right - 35.8,
  });
  y += 13.2;
  const words = `Всего к оплате: ${amountInWords(d.total, d.currency, d.currencySpelling)}`;
  text(words, "b", F10, 35.9, y, { width: RULE.right - 35.9 });
  const rule2 =
    y + height(words, "b", F10, RULE.right - 35.9) - height("Всего", "b", F10, RULE.right - 35.9) + 19.47;
  line(RULE.left, rule2, RULE.right, rule2, THICK);

  // Подпись исполнителя.
  text("Исполнитель", "b", F10, 35.9, rule2 + 8.63);
  line(112.2, rule2 + 20.86, 332.76, rule2 + 20.86, THIN);
  text(`/${d.executor || "<Не указан>"}/`, "r", F8, 334.7, rule2 + 10.73);

  pdf.end();
  return done;
}
