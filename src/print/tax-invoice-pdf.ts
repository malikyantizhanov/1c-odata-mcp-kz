import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { dateWords, money } from "./invoice-pdf.js";

/**
 * «Счет-фактура» (бумажная форма счёта-фактуры выданного) по печатной форме 1С:Бухгалтерии для Казахстана 3.0.
 * Координаты строк, линий (0,71 pt; рамка «МП» — 0,96 pt), колонок, серых ячеек итога и кегли сняты с PDF, который
 * сформировала 1С в 1С:Fresh.kz (A4 книжная): текст 7,91 pt, «Дата совершения оборота» и «Примечание» — 7,56 pt,
 * заголовок — 11,39 pt полужирный, пояснения под чертой и номера колонок — 5,63 pt курсив, «МП» — 8,5 pt. Числа и даты —
 * по-русски («1 000,00», «8 октября 2026 г.»). Печать 1С через OData не вызвать — это её повторение по данным документа.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve("@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf");
const FONT_BOLD = require.resolve("@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf");
const FONT_ITALIC = require.resolve("@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf");

export interface TaxInvoiceLine {
  name: string;
  unit?: string | undefined;
  /** Код ТНВЭД номенклатуры. */
  tnved?: string | undefined;
  quantity: number;
  price: number;
  /** Стоимость товаров (работ, услуг) без НДС. */
  costWithoutVat: number;
  /** Ставка НДС, как в справочнике («Без НДС», «16%»). */
  vatRate: string;
  vat: number;
  /** Всего стоимость реализации. */
  total: number;
  exciseRate?: string | undefined;
  excise: number;
}

export interface TaxInvoiceData {
  /** Номер как в 1С, с ведущими нулями. */
  number: string;
  /** YYYY-MM-DD */
  date: string;
  /** Дата совершения оборота, YYYY-MM-DD. */
  turnoverDate?: string | undefined;
  supplierName: string;
  /** «ИИН: 123123123123, ,» — идентификатор и адрес места нахождения поставщика. */
  supplierIds: string;
  /** «KZ…, в банке АО "…", БИК …». */
  supplierAccount: string;
  contract: string;
  paymentTerms?: string | undefined;
  destination?: string | undefined;
  /** «Без доверенности» или «№ … от …». */
  powerOfAttorney: string;
  shipmentMethod?: string | undefined;
  /** «Реализация ТМЗ и услуг № 16 от 8 октября 2026 г.». */
  waybill?: string | undefined;
  consignor?: string | undefined;
  consignee?: string | undefined;
  buyerName: string;
  buyerIds: string;
  buyerAccount: string;
  /** Валюта в заголовке колонки «Цена (теңге)». */
  currency: string;
  lines: TaxInvoiceLine[];
  totals: { costWithoutVat: number; vat: number; total: number; excise: number };
  /** «Жумабекова А. Е.» */
  head?: string | undefined;
  chiefAccountant?: string | undefined;
}

/** Количество: целое — «1», дробное — до трёх знаков через запятую. */
export const sfQuantity = (n: number): string => {
  const [int, frac] = String(Math.round(Math.abs(n) * 1000) / 1000).split(".");
  return `${n < 0 ? "-" : ""}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${frac ? `,${frac}` : ""}`;
};
/** «08.10.2026» из YYYY-MM-DD. */
const shortDate = (iso: string | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && !iso.startsWith("0001")
    ? iso.slice(0, 10).split("-").reverse().join(".")
    : "";

// Кегли и сетка формы (pt, левый верхний угол листа A4).
const F = 7.91;
const F_SMALL = 7.56;
const F_CAPTION = 5.63;
const F_TITLE = 11.39;
const PITCH = 9.07;
const LEFT = 28.2;
const RIGHT = 568.1;
const COLS = [28.6, 51.6, 139.4, 173.2, 222.4, 260.6, 301.0, 357.0, 391.9, 438.2, 487.4, 523.1, 568.4];
const THIN = 0.71;
const PAGE_BOTTOM = 790;

type Font = "r" | "b" | "i";

export function renderTaxInvoicePdf(d: TaxInvoiceData): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 0,
    info: { Title: `Счет-фактура № ${d.number} от ${d.date}` },
  });
  pdf.registerFont("r", FONT);
  pdf.registerFont("b", FONT_BOLD);
  pdf.registerFont("i", FONT_ITALIC);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  /** Межстрочный шаг 1С — 9,07 pt при 7,91 pt; считаем до выбора шрифта (иначе он сбросится на обычный). */
  const gapFor = (size: number) => {
    pdf.font("r").fontSize(size);
    return Math.max(0, (size * PITCH) / F - pdf.currentLineHeight(true));
  };
  /** Высота текста; явные переносы — построчно, как в put(). */
  const height = (s: string, w: number, font: Font = "r", size = F) => {
    const gap = gapFor(size);
    pdf.font(font).fontSize(size);
    return s
      .split("\n")
      .reduce((a, part) => a + pdf.heightOfString(part || " ", { width: w, lineGap: gap }), 0);
  };
  const put = (
    s: string,
    x1: number,
    x2: number,
    y: number,
    o: { font?: Font; size?: number; align?: "left" | "center" | "right" } = {},
  ) => {
    const size = o.size ?? F;
    const gap = gapFor(size);
    let top = y;
    // Явные переносы — построчно: pdfkit центрует строку вместе с символом перевода строки.
    for (const part of s.split("\n")) {
      pdf
        .font(o.font ?? "r")
        .fontSize(size)
        .text(part, x1, top, { width: x2 - x1, align: o.align ?? "left", lineGap: gap });
      top += pdf.heightOfString(part || " ", { width: x2 - x1, lineGap: gap });
    }
  };
  const hline = (x1: number, x2: number, y: number, w = THIN) =>
    pdf.moveTo(x1, y).lineTo(x2, y).lineWidth(w).stroke();
  const vline = (x: number, y1: number, y2: number, w = THIN) =>
    pdf.moveTo(x, y1).lineTo(x, y2).lineWidth(w).stroke();

  put(`Счет-фактура № ${d.number} от ${dateWords(d.date)}`, 28.32, 518.88, 29.6, {
    font: "b",
    size: F_TITLE,
    align: "center",
  });

  // Реквизиты: строка текста, под ней черта на всю ширину; у некоторых — пояснение мелким курсивом под чертой.
  put("Дата совершения оборота:", 30.0, 139, 59.4, { size: F_SMALL });
  put(shortDate(d.turnoverDate), 140.9, 300, 59.4, { size: F_SMALL });
  let line = 69.0;
  hline(LEFT, RIGHT, line);
  const textWidth = RIGHT - 30.0;
  /** Строка реквизитов: шаг 1С — 10,43 pt, каждая строка переноса — ещё 9,07; пояснение под чертой — 8,57. */
  const row = (text: string, o: { bold?: boolean; caption?: string } = {}) => {
    const top = line + 0.5;
    put(text, o.bold ? 30.2 : 30.0, RIGHT, top, { font: o.bold ? "b" : "r" });
    const lines = Math.max(1, Math.round(height(text, textWidth, o.bold ? "b" : "r") / PITCH));
    line += 10.43 + (lines - 1) * PITCH;
    hline(LEFT, RIGHT, line);
    if (o.caption) {
      put(o.caption, 28.32, 518.88, line + 0.3, { font: "i", size: F_CAPTION, align: "center" });
      line += 8.57;
    }
  };
  row(`Поставщик: ${d.supplierName}`, { bold: true });
  row(`ИИН и адрес места нахождения поставщика: ${d.supplierIds}`);
  row(`ИИК поставщика: ${d.supplierAccount}`);
  row(`Договор (контракт) на поставку товаров (работ, услуг): ${d.contract}`);
  row(`Условия оплаты по договору (контракту): ${d.paymentTerms ?? ""}`.trimEnd());
  row(`Пункт назначения поставляемых товаров (работ, услуг): ${d.destination ?? ""}`.trimEnd(), {
    caption: "государство, регион, область, город, район",
  });
  row(`Поставка товаров (работ,услуг) осуществлена по доверенности: ${d.powerOfAttorney}`);
  row(`Способ отправления: ${d.shipmentMethod ?? ""}`.trimEnd());
  row(`Товарно-транспортная накладная: ${d.waybill ?? ""}`.trimEnd());
  row(`Грузоотправитель: ${d.consignor ?? ""}`.trimEnd(), { caption: "(, наименование и адрес)" });
  row(`Грузополучатель: ${d.consignee ?? ""}`.trimEnd(), { caption: "(ИИН, ИНН/КПП, наименование и адрес)" });
  row(`Получатель: ${d.buyerName}`, { bold: true });
  row(`ИИН, ИНН/КПП и адрес места нахождения получателя: ${d.buyerIds}`);
  row(`ИИК получателя: ${d.buyerAccount}`);

  // Таблица: шапка в два яруса (НДС, Акциз), строка номеров колонок, строки, «Всего по счету».
  const c = COLS;
  let y = line + 6.4;
  const header = () => {
    const top = y;
    const sub = top + 24.2;
    const bottom = top + 42.0;
    const numbers = bottom + 7.8;
    for (const yy of [top, bottom, numbers]) hline(LEFT, RIGHT, yy);
    hline(c[7]! - 0.4, c[9]! - 0.3, sub);
    hline(c[10]! - 0.3, RIGHT, sub);
    const center = (t: string, a: number, b: number, y1: number, y2: number) =>
      put(t, c[a]! + 1, c[b]! - 1, (y1 + y2) / 2 - height(t, c[b]! - c[a]! - 2) / 2, { align: "center" });
    center("№ \nп/п", 0, 1, top, bottom);
    center("Наименование \nтоваров (работ, услуг)", 1, 2, top, bottom);
    center("Ед. изм.", 2, 3, top, bottom);
    center("Код ТНВЭД", 3, 4, top, bottom);
    center("Кол-во \n(объем)", 4, 5, top, bottom);
    center(`Цена \n(${d.currency})`, 5, 6, top, bottom);
    center("Стоимость \nтоваров \n(работ, услуг) \nбез НДС", 6, 7, top, bottom);
    center("НДС", 7, 9, top, sub);
    center("Ставка", 7, 8, sub, bottom);
    center("Сумма", 8, 9, sub, bottom);
    center("Всего \nстоимость \nреализации", 9, 10, top, bottom);
    center("Акциз", 10, 12, top, sub);
    center("Ставка", 10, 11, sub, bottom);
    center("Сумма", 11, 12, sub, bottom);
    for (let i = 0; i < 12; i++)
      put(String(i + 1), c[i]!, c[i + 1]!, bottom + 0.4, { font: "i", size: F_CAPTION, align: "center" });
    for (const x of c) {
      if (x === c[8] || x === c[11]) vline(x, sub - 0.3, numbers + 0.3);
      else vline(x, top - 0.4, numbers + 0.3);
    }
    y = numbers;
  };
  header();

  /** Ячейки строки: № , ед., код, ставки — по центру; наименование — слева; числа — справа. Выравнивание по низу. */
  const PAD = [0, 1.7, 0, 0, 2.0, 2.2, 2.2, 0, 2.2, 2.1, 0, 2.2];
  const ALIGN: Array<"left" | "center" | "right"> = [
    "center",
    "left",
    "center",
    "center",
    "right",
    "right",
    "right",
    "center",
    "right",
    "right",
    "center",
    "right",
  ];
  // Отступ в ячейке 1С — 2 pt: «Без НДС» в колонке ставки переносится на две строки, как в форме.
  const cellWidth = (i: number) => c[i + 1]! - c[i]! - 2 * Math.max(PAD[i]!, 2);
  d.lines.forEach((l, idx) => {
    const values = [
      String(idx + 1),
      l.name,
      l.unit ?? "",
      l.tnved ?? "",
      sfQuantity(l.quantity),
      money(l.price),
      money(l.costWithoutVat),
      l.vatRate,
      l.vat ? money(l.vat) : "",
      money(l.total),
      l.exciseRate ?? "",
      l.excise ? money(l.excise) : "",
    ];
    const lines = Math.max(...values.map((v, i) => Math.round(height(v, cellWidth(i)) / PITCH)));
    const h = lines > 1 ? lines * PITCH + 1.56 : 10.4;
    if (y + h + 10.4 > PAGE_BOTTOM) {
      pdf.addPage({ size: "A4", margin: 0 });
      y = 28.32;
      header();
    }
    values.forEach((v, i) => {
      if (!v) return;
      const w = cellWidth(i);
      const vh = Math.round(height(v, w) / PITCH) * PITCH;
      const x1 = ALIGN[i] === "left" ? c[i]! + PAD[i]! : c[i]! + Math.max(PAD[i]!, 2);
      put(v, x1, x1 + w, y + h - vh - 0.93, { align: ALIGN[i] });
    });
    for (const x of c) vline(x, y, y + h + 0.3);
    y += h;
    hline(LEFT, RIGHT, y);
  });

  // Всего по счету: серые ячейки ставок НДС и акциза.
  const totalTop = y;
  const totalBottom = totalTop + 10.4;
  pdf.save();
  pdf.fillColor([191, 191, 191]).strokeColor([191, 191, 191]).lineWidth(THIN);
  pdf.rect(c[7]! - 0.36, totalTop - 0.03, c[8]! - c[7]!, 10.56).fillAndStroke();
  pdf.rect(c[10]! - 0.32, totalTop - 0.03, c[11]! - c[10]!, 10.56).fillAndStroke();
  pdf.restore();
  pdf.fillColor("black").strokeColor("black");
  // В 1С заливка рисуется под линиями: верхняя черта строки итога остаётся чёрной.
  hline(LEFT, RIGHT, totalTop);
  put("Всего по счету:", 30.2, c[6]!, totalTop + 0.5, { font: "b" });
  put(money(d.totals.costWithoutVat), c[6]! + 2.2, c[7]! - 2.2, totalTop + 0.5, {
    font: "b",
    align: "right",
  });
  if (d.totals.vat)
    put(money(d.totals.vat), c[8]! + 2.2, c[9]! - 2.2, totalTop + 0.5, { font: "b", align: "right" });
  put(money(d.totals.total), c[9]! + 2.1, c[10]! - 2.1, totalTop + 0.5, { font: "b", align: "right" });
  if (d.totals.excise)
    put(money(d.totals.excise), c[11]! + 2.2, c[12]! - 2.2, totalTop + 0.5, { font: "b", align: "right" });
  hline(LEFT, RIGHT, totalBottom);
  for (const x of [c[0]!, ...c.slice(6)]) vline(x, totalTop, totalBottom + 0.3);

  // Подписи, «МП» и примечание.
  let s = totalBottom;
  if (s + 92 > PAGE_BOTTOM) {
    pdf.addPage({ size: "A4", margin: 0 });
    s = 28.32;
  }
  const caption = (t: string, x1: number, x2: number, yy: number) =>
    put(t, x1, x2, yy, { font: "i", size: F_CAPTION, align: "center" });
  put(`Руководитель: ${d.head ?? ""}`.trimEnd(), 30.2, 270, s + 11.0, { font: "b" });
  put("ВЫДАЛ (ответственное лицо поставщика)", 371.3, RIGHT, s + 11.0, { font: "b" });
  hline(LEFT, 270.2, s + 30.8);
  hline(369.2, RIGHT, s + 30.8);
  caption("(Ф.И.О., подпись)", 28.32, 270.24, s + 31.1);
  caption("(должность)", 369.36, 567.96, s + 31.1);
  hline(302.6, 332.8, s + 26.4, 0.96);
  hline(302.6, 332.8, s + 46.2, 0.96);
  vline(303.1, s + 25.9, s + 46.7, 0.96);
  vline(332.3, s + 25.9, s + 46.7, 0.96);
  put("МП", 303.1, 332.3, s + 31.5, { size: 8.5, align: "center" });
  put(`Главный бухгалтер: ${d.chiefAccountant ?? ""}`.trimEnd(), 30.2, 270, s + 41.3, { font: "b" });
  hline(LEFT, 270.2, s + 61.2);
  hline(369.2, RIGHT, s + 61.2);
  caption("(Ф.И.О., подпись)", 28.32, 270.24, s + 61.5);
  caption("(Ф.И.О., подпись)", 369.36, 567.96, s + 61.5);
  put(
    "Примечание: Без печати недействительно. Оригинал (первый экземпляр) - покупателю. Копия (второй экземпляр) - поставщику.",
    30.0,
    RIGHT,
    s + 80.0,
    { size: F_SMALL },
  );
  pdf.end();
  return done;
}
