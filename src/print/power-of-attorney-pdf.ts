import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { dateWords } from "./invoice-pdf.js";
import { quantityInWords } from "./amount-words.js";

/**
 * Доверенность по форме Д-1 (приложение 6 к приказу Министра финансов РК № 562) — повтор печатной формы
 * 1С:Бухгалтерии для Казахстана 3.0. Координаты строк, линий и кегли сняты с PDF, который сформировала 1С в 1С:Fresh.kz
 * (A4 книжная): текст — 8,04 pt, «ИИН/БИН» — 9 pt, «ДОВЕРЕННОСТЬ № …» — 9,95 pt полужирный, подписи под линиями —
 * 6 pt курсив, номера колонок — 6,83 pt; линии 0,6 pt, рамка ИИН/БИН — 0,75 pt.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve("@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf");
const FONT_BOLD = require.resolve("@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf");
const FONT_ITALIC = require.resolve("@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf");

export interface PowerOfAttorneyLine {
  name: string;
  unit?: string | undefined;
  quantity: number;
}

export interface PowerOfAttorneyPassport {
  series?: string | undefined;
  number?: string | undefined;
  /** YYYY-MM-DD */
  date?: string | undefined;
  issuedBy?: string | undefined;
}

export interface PowerOfAttorneyData {
  /** Номер без ведущих нулей. */
  number: string;
  /** Дата выдачи, YYYY-MM-DD. */
  date: string;
  /** «Доверенность действительна по», YYYY-MM-DD. */
  validUntil?: string | undefined;
  /** Полное наименование организации (шапка «Организация (индивидуальный предприниматель)»). */
  organization: string;
  /** ИИН/БИН организации (рамка справа в шапке). */
  organizationId: string;
  /** «<наименование>, БИН / ИИН <номер>[, <адрес>]» — получатель и плательщик. */
  recipient: string;
  payer: string;
  /** ИИК организации и банк. */
  account?: string | undefined;
  bank?: string | undefined;
  /** «Бухгалтеру, Касымовой Диане Сериковне.» — должность и ФИО в дательном падеже. */
  issuedTo: string;
  passport?: PowerOfAttorneyPassport | undefined;
  /** «На получение от» — наименование поставщика. */
  supplier?: string | undefined;
  /** «активов по» — наименование, номер и дата документа. */
  basis?: string | undefined;
  lines: PowerOfAttorneyLine[];
  /** Расшифровки подписей: «Жумабекова А. Е.». */
  head?: string | undefined;
  chiefAccountant?: string | undefined;
}

/** «1», «2,5», «1 500» — количество в колонке «Количество (прописью)». */
export const poaQuantity = (q: number): string => {
  const [int, frac] = String(Math.round(Math.abs(q) * 1000) / 1000).split(".");
  return `${q < 0 ? "-" : ""}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${frac ? `,${frac}` : ""}`;
};
/** «1 (Один)». */
export const quantityText = (q: number): string => `${poaQuantity(q)} (${quantityInWords(q)})`;
const shortDate = (iso: string | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && !iso.startsWith("0001")
    ? iso.slice(0, 10).split("-").reverse().join(".")
    : "";
const longDate = (iso: string | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && !iso.startsWith("0001") ? dateWords(iso) : "";

// Кегли и сетка формы (pt, левый верхний угол листа A4).
const F = 8.04;
const F_ID = 9.0;
const F_TITLE = 9.95;
const F_CAPTION = 6.0;
const F_COLNUM = 6.83;
const F_SIGN = 8.28;
const PITCH = 9.2;
const W = 0.6;
const W_BOX = 0.75;
const LEFT = 34.7;
const RIGHT = 556.4;
const PAD = 1.9;
/** Колонки таблицы: номер, наименование, единица, количество. */
const COLS = [35.1, 82.3, 352.1, 399.4, 556.8];
const PAGE_BOTTOM = 800;

type Font = "r" | "b" | "i";

export function renderPowerOfAttorneyPdf(d: PowerOfAttorneyData): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 0,
    info: { Title: `Доверенность № ${d.number} от ${d.date}` },
  });
  pdf.registerFont("r", FONT);
  pdf.registerFont("b", FONT_BOLD);
  pdf.registerFont("i", FONT_ITALIC);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  /** Межстрочный шаг 1С (считается до выбора шрифта — иначе он сбросится на обычный). */
  const gapFor = (size: number, pitch: number) => {
    pdf.font("r").fontSize(size);
    return Math.max(0, pitch - pdf.currentLineHeight(true));
  };
  const lineCount = (s: string, w: number, font: Font = "r", size = F, pitch = PITCH) => {
    const gap = gapFor(size, pitch);
    pdf.font(font).fontSize(size);
    return Math.max(1, Math.round(pdf.heightOfString(s || " ", { width: w, lineGap: gap }) / pitch));
  };
  const put = (
    s: string,
    x1: number,
    x2: number,
    y: number,
    o: { font?: Font; size?: number; align?: "left" | "center" | "right"; pitch?: number } = {},
  ) => {
    if (!s) return;
    const size = o.size ?? F;
    const gap = gapFor(size, o.pitch ?? PITCH);
    pdf
      .font(o.font ?? "r")
      .fontSize(size)
      .text(s, x1, y, { width: x2 - x1, align: o.align ?? "left", lineGap: gap });
  };
  const hline = (x1: number, x2: number, y: number, w = W) =>
    pdf.moveTo(x1, y).lineTo(x2, y).lineWidth(w).stroke();
  const vline = (x: number, y1: number, y2: number, w = W) =>
    pdf.moveTo(x, y1).lineTo(x, y2).lineWidth(w).stroke();
  const caption = (s: string, x1: number, x2: number, y: number) =>
    put(s, x1, x2, y, { font: "i", size: F_CAPTION, align: "center" });
  /** Поле с подчёркиванием: текст с отступом 1,9 pt от начала линии, линия на 10,2 pt ниже строки. */
  const field = (s: string, x1: number, x2: number, y: number) => {
    put(s, x1 + PAD, x2, y);
    hline(x1, x2, y + 10.2);
  };

  // Шапка: приложение к приказу, форма.
  for (const [t, y] of [
    ["Приложение 6", 32.1],
    ["к приказу Министра финансов Республики Казахстан", 41.4],
    ["от 20 декабря 2012 года № 562", 50.8],
  ] as const)
    put(t, 300, 554.7, y, { font: "i", align: "right" });
  put("Форма Д-1", 400, 554.7, 72.4, { align: "right" });

  // Организация: наименование по центру над линией (снизу вверх), рамка ИИН/БИН.
  put("Организация (индивидуальный предприниматель)", 44.0, 240, 103.2);
  const orgLines = lineCount(d.organization, 367.4 - 241.4 - 2 * PAD);
  put(d.organization, 241.4 + PAD, 367.4 - PAD, 103.2 - (orgLines - 1) * PITCH, { align: "center" });
  hline(241.4, 367.4, 113.4, W_BOX);
  put("ИИН/БИН", 387.7, 430, 102.0, { size: F_ID });
  hline(430.4, 556.4, 93.4, W_BOX);
  hline(430.4, 556.4, 113.4, W_BOX);
  vline(430.8, 93.0, 113.8, W_BOX);
  vline(556.8, 93.0, 113.8, W_BOX);
  put(d.organizationId, 430.8, 556.8, 103.2, { align: "center" });

  // Срок, получатель, плательщик, счёт.
  put("Доверенность действительна по", 36.6, 180, 138.0);
  put(longDate(d.validUntil), 180.4, 260, 138.0);
  hline(180.4, 248.4, 146.2);
  const wide = (s: string, y: number, cap: string) => {
    put(s, 36.6, RIGHT, y);
    hline(LEFT, RIGHT, y + 10.2);
    caption(cap, LEFT, RIGHT, y + 10.6);
  };
  wide(d.recipient, 148.8, "наименование получателя, ИИН/БИН и его адрес");
  wide(d.payer, 170.4, "наименование плательщика, ИИН/БИН и его адрес");
  put("Счет №", 36.6, 74, 192.0);
  field(d.account ?? "", 74.2, 210.0, 192.0);
  put("в", 211.9, 225, 192.0);
  field(d.bank ?? "", 225.7, RIGHT, 192.0);
  caption("наименование банка", LEFT, RIGHT, 202.7);

  // Заголовок и дата выдачи.
  put(`ДОВЕРЕННОСТЬ № ${d.number}`, LEFT, RIGHT, 224.5, { font: "b", size: F_TITLE, align: "center" });
  put("Дата выдачи", 150, 284.6, 237.6, { align: "right" });
  put(longDate(d.date), 290.6, 380, 237.6);
  hline(290.6, 354.2, 245.8);

  // Кому выдана, паспорт, от кого и по какому документу получить.
  put("Выдана", 36.6, 74, 259.2);
  field(d.issuedTo, 74.2, RIGHT, 259.2);
  caption("должность, фамилия, имя, отчество", LEFT, RIGHT, 269.9);
  const p = d.passport ?? {};
  put("Удостоверение личности (паспорт) серии", 36.6, 210, 280.8);
  field(p.series ?? "", 210.0, 288.7, 280.8);
  put("№", 290.6, 304, 280.8);
  field(p.number ?? "", 304.4, 399.0, 280.8);
  put("от", 400.9, 414, 280.8);
  field(shortDate(p.date), 414.7, 540.7, 280.8);
  wide(`выдан ${p.issuedBy ?? ""}`.trimEnd(), 291.6, "кем выдано удостоверение (паспорт) и когда");
  put("На получение от", 36.6, 113, 313.2);
  field(d.supplier ?? "", 113.4, RIGHT, 313.2);
  caption("наименование поставщика", LEFT, RIGHT, 323.9);
  put("активов по", 36.6, 82, 334.8);
  field(d.basis ?? "", 82.0, RIGHT, 334.8);
  caption("наименование, номер и дата документа", LEFT, RIGHT, 345.4);

  // Таблица: шапка 20 pt, номера колонок 10,9 pt, строки 10,7 pt (длинное наименование — выше), «Итого».
  let top = 372.6;
  const tableHead = () => {
    hline(LEFT, RIGHT, top);
    // Две строки по отдельности: 1С центрирует первую вместе с пробелом в конце («Номер по »).
    put("Номер по ", COLS[0]!, COLS[1]!, top + 0.5, { align: "center" });
    put("порядку", COLS[0]!, COLS[1]!, top + 9.8, { align: "center" });
    put("Наименование активов", COLS[1]!, COLS[2]!, top + 5.2, { align: "center" });
    put("Единица ", COLS[2]!, COLS[3]!, top + 0.5, { align: "center" });
    put("измерения", COLS[2]!, COLS[3]!, top + 9.8, { align: "center" });
    put("Количество (прописью)", COLS[3]!, COLS[4]!, top + 5.2, { align: "center" });
    hline(LEFT, RIGHT, top + 20);
    ["1", "2", "3", "4"].forEach((t, i) =>
      put(t, COLS[i]!, COLS[i + 1]!, top + 21.3, { size: F_COLNUM, align: "center" }),
    );
    hline(LEFT, RIGHT, top + 30.9);
    return top + 30.9;
  };
  let tableTop = top;
  top = tableHead();
  const nameW = COLS[2]! - COLS[1]! - 2 * 1.6;
  const vlines = (from: number, to: number) => COLS.forEach((x) => vline(x, from - 0.4, to + 0.4));
  d.lines.forEach((l, i) => {
    const n = lineCount(l.name, nameW);
    const h = 10.7 + (n - 1) * PITCH;
    if (top + h + 100 > PAGE_BOTTOM && i < d.lines.length - 1) {
      vlines(tableTop, top);
      pdf.addPage({ size: "A4", margin: 0 });
      top = 36;
      tableTop = top;
      top = tableHead();
    }
    put(String(i + 1), COLS[0]!, COLS[1]!, top + 0.5, { align: "center" });
    put(l.name, COLS[1]! + 1.6, COLS[2]! - 1.6, top + 0.5);
    put(l.unit ?? "", COLS[2]!, COLS[3]!, top + 0.5, { align: "center" });
    put(quantityText(l.quantity), COLS[3]! + 1.5, COLS[4]! - 1.5, top + 0.5);
    top += h;
    hline(LEFT, RIGHT, top);
  });
  vlines(tableTop, top);
  const total = d.lines.reduce((a, l) => a + l.quantity, 0);
  put("Итого", 300, COLS[3]! - 2.3, top + 0.7, { align: "right" });
  put(quantityText(total), COLS[3]! + 1.5, COLS[4]! - 1.5, top + 0.7);
  vline(COLS[3]!, top, top + 11.2);
  vline(COLS[4]!, top, top + 11.2);
  hline(COLS[3]! - 0.4, RIGHT, top + 10.8);

  // Подписи: получатель доверенности, руководитель и главный бухгалтер.
  let s = top + 10.8 + 22.3;
  if (s + 75 > PAGE_BOTTOM) {
    pdf.addPage({ size: "A4", margin: 0 });
    s = 36;
  }
  put("Подпись лица, получившего доверенность", 36.6, 210, s);
  hline(210.0, 399.0, s + 10.2);
  put("удостоверяем:", 36.6, 200, s + 21.6);
  put("М.П.", 36.6, 100, s + 32.4);
  put("Руководитель организации", 115.3, 300, s + 32.4);
  put("(индивидуальный предприниматель)", 99.6, 300, s + 43.2);
  put("Главный бухгалтер", 400.9, RIGHT, s + 32.4);
  put("/", 174.4, 186, s + 54.2);
  put("/", 432.4, 446, s + 54.2);
  put(d.head ?? "", 186.5, 288.7, s + 53.9, { size: F_SIGN, align: "center" });
  put(d.chiefAccountant ?? "", 446.2, RIGHT, s + 53.9, { size: F_SIGN, align: "center" });
  for (const [x1, x2] of [
    [97.7, 160.7],
    [186.5, 288.7],
    [367.4, 422.8],
    [446.2, RIGHT],
  ] as const)
    hline(x1, x2, s + 64.4);
  caption("Подпись", 97.7, 160.7, s + 64.8);
  caption("расшифровка подписи", 178.1, 288.7, s + 64.8);
  caption("Подпись", 367.4, 422.8, s + 64.8);
  caption("расшифровка подписи", 430.0, RIGHT, s + 64.8);
  pdf.end();
  return done;
}
