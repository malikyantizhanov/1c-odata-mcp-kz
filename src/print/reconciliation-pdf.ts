import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { dateWords, money } from "./invoice-pdf.js";

/**
 * «Акт сверки взаимных расчетов» по печатной форме 1С:Бухгалтерии для Казахстана 3.0. Координаты строк, линий
 * (рамка 1,3 pt, внутренние 0,65 pt), колонок и кегли сняты с PDF, который сформировала 1С в 1С:Fresh.kz (A4 книжная):
 * заголовок — 12,12 pt полужирный, подзаголовок и вступление — 7,8 pt, «По данным …» — 8,61 pt, таблица и подписи —
 * 6,96 pt. Числа — по-русски («1 000 000,00»). Печать 1С через OData не вызвать — это её повторение по данным документа.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve("@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf");
const FONT_BOLD = require.resolve("@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf");

export interface ReconciliationRow {
  /** YYYY-MM-DD */
  date?: string | undefined;
  /** «Реализация ТМЗ и услуг 19 от 09.10.2026» */
  document?: string | undefined;
  debit: number;
  credit: number;
}

export interface ReconciliationParty {
  name: string;
  /** «ИИН: 123123123123» или «БИН: …». */
  id: string;
}

export interface ReconciliationData {
  /** Номер без ведущих нулей. */
  number: string;
  /** YYYY-MM-DD */
  date: string;
  periodStart?: string | undefined;
  periodEnd: string;
  organization: ReconciliationParty;
  counterparty: ReconciliationParty;
  contract?: string | undefined;
  /** Код валюты в шапке таблицы и в итоге («KZT»). */
  currency: string;
  /** Сальдо на начало по данным организации: «+» — долг контрагента, «−» — долг организации. */
  opening: number;
  organizationRows: ReconciliationRow[];
  counterpartyRows: ReconciliationRow[];
  /** Сверка согласована: только тогда 1С печатает обороты и сальдо по данным контрагента. */
  agreed: boolean;
  /** Сумма задолженности прописью (по параметрам валюты). */
  amountWords: string;
}

/** «09.10.26» из YYYY-MM-DD — дата в таблице акта. */
export const actRowDate = (iso: string | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && !iso.startsWith("0001")
    ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`
    : "";
/** «09.10.2026» из YYYY-MM-DD. */
const shortDate = (iso: string | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && !iso.startsWith("0001")
    ? iso.slice(0, 10).split("-").reverse().join(".")
    : "";
const amount = (n: number): string => (n ? money(n) : "");

/** Итог акта по данным организации: сальдо на конец, обороты. */
export function reconciliationTotals(d: Pick<ReconciliationData, "opening" | "organizationRows">) {
  const debit = d.organizationRows.reduce((a, r) => a + r.debit, 0);
  const credit = d.organizationRows.reduce((a, r) => a + r.credit, 0);
  return { debit, credit, closing: Math.round((d.opening + debit - credit) * 100) / 100 };
}

/**
 * Строка задолженности под таблицей, как в 1С (двойные пробелы — из шаблона): «на 09.10.2026 задолженность  в пользу
 * <сторона>  1 000 000,00  KZT (Один миллион теңге 00 тиын)».
 */
export function debtStatement(d: ReconciliationData, closing: number): string {
  const on = `на ${shortDate(d.periodEnd)} задолженность`;
  if (!closing) return `${on} отсутствует`;
  const creditor = closing > 0 ? d.organization.name : d.counterparty.name;
  return `${on}  в пользу ${creditor}  ${money(Math.abs(closing))}  ${d.currency} (${d.amountWords})`;
}

// Кегли, шаг строк и сетка формы (pt, левый верхний угол листа A4).
const F_TITLE = 12.12;
const F_TEXT = 7.8;
const F_HEAD = 8.61;
const F = 6.96;
const LEFT = 37.3;
const RIGHT = 567.1;
const THICK = 1.3;
const THIN = 0.65;
/** Границы колонок: дата, документ, дебет, кредит — по данным организации и по данным контрагента. */
const L = [38.0, 74.2, 170.1, 236.5, 302.6];
const R = [302.9, 339.1, 435.1, 501.3, 567.8];
const EMPTY_ROWS = 5;
const PAGE_BOTTOM = 800;

type Font = "r" | "b";

export function renderReconciliationPdf(d: ReconciliationData): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 0,
    info: { Title: `Акт сверки № ${d.number} от ${d.date}` },
  });
  pdf.registerFont("r", FONT);
  pdf.registerFont("b", FONT_BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  /** Межстрочный шаг 1С для кегля (считается до выбора шрифта — иначе он сбросится на обычный). */
  const gapFor = (size: number, pitch: number) => {
    pdf.font("r").fontSize(size);
    return Math.max(0, pitch - pdf.currentLineHeight(true));
  };
  const height = (s: string, w: number, font: Font, size: number, pitch: number) => {
    const gap = gapFor(size, pitch);
    pdf.font(font).fontSize(size);
    return s
      .split("\n")
      .reduce((a, part) => a + pdf.heightOfString(part || " ", { width: w, lineGap: gap }), 0);
  };
  const lines = (s: string, w: number, font: Font, size: number, pitch: number) =>
    Math.max(1, Math.round(height(s, w, font, size, pitch) / pitch));
  const put = (
    s: string,
    x1: number,
    x2: number,
    y: number,
    o: { font?: Font; size?: number; pitch?: number; align?: "left" | "center" | "right" } = {},
  ) => {
    const size = o.size ?? F;
    const gap = gapFor(size, o.pitch ?? 8.1);
    pdf
      .font(o.font ?? "r")
      .fontSize(size)
      .text(s, x1, y, { width: x2 - x1, align: o.align ?? "left", lineGap: gap });
  };
  const hline = (x1: number, x2: number, y: number, w = THIN) =>
    pdf.moveTo(x1, y).lineTo(x2, y).lineWidth(w).stroke();
  const vline = (x: number, y1: number, y2: number, w = THIN) =>
    pdf.moveTo(x, y1).lineTo(x, y2).lineWidth(w).stroke();

  // Заголовок, подзаголовок, вступление.
  put(`Акт сверки № ${d.number} от ${dateWords(d.date)}`, LEFT, RIGHT, 40.2, {
    font: "b",
    size: F_TITLE,
    align: "center",
  });
  const sub =
    `взаимных расчетов за период с ${shortDate(d.periodStart)} по ${shortDate(d.periodEnd)} между ` +
    `${d.organization.name} и ${d.counterparty.name}${d.contract ? ` по договору ${d.contract}` : ""}`;
  put(sub, LEFT, RIGHT, 55.6, { size: F_TEXT, pitch: 9.0, align: "center" });
  let y = 55.6 + lines(sub, RIGHT - LEFT, "r", F_TEXT, 9.0) * 9.0 + 17.1;
  const intro = [
    `Мы, нижеподписавшиеся, ________________ _______________________ ${d.organization.name}, с одной стороны,`,
    `и ________________ ${d.counterparty.name} _______________________, с другой стороны,`,
    "составили настоящий акт сверки в том, что состояние взаимных расчетов по данным учета следующее:",
  ];
  for (const t of intro) {
    put(t, 39.1, RIGHT, y, { size: F_TEXT, pitch: 9.0 });
    y += lines(t, RIGHT - 39.1, "r", F_TEXT, 9.0) * 9.0;
  }

  // Таблица: «По данным …», шапка колонок, сальдо, операции, пустые строки, обороты, сальдо на конец.
  let top = y + 6.4;
  const headL = `По данным ${d.organization.name}, ${d.currency}`;
  const headR = `По данным ${d.counterparty.name}, ${d.currency}`;
  const headRows = Math.max(
    lines(headL, L[4]! - 39.4 - 1.4, "r", F_HEAD, 10),
    lines(headR, R[4]! - 304.3 - 1.4, "r", F_HEAD, 10),
  );
  const tableTop = top;
  const rowLine = (yy: number) => hline(LEFT, RIGHT, yy);
  const header = () => {
    put(headL, 39.4, L[4]! - 1.4, top + 0.3, { size: F_HEAD, pitch: 10 });
    put(headR, 304.3, R[4]! - 1.4, top + 0.3, { size: F_HEAD, pitch: 10 });
    top += headRows * 10 + 1.2;
    rowLine(top);
    const cols = ["Дата", "Документ", "Дебет", "Кредит"];
    for (const b of [L, R]) cols.forEach((t, i) => put(t, b[i]!, b[i + 1]!, top + 0.4, { align: "center" }));
    for (const b of [L, R]) {
      vline(b[1]!, top - 0.3, top + 9.4);
      for (const x of [b[2]!, b[3]!]) vline(x, top - 0.3, top + 9.1);
    }
    top += 9.1;
    rowLine(top);
  };
  header();

  /** Строка таблицы: ячейки по центру по вертикали; дата и документ — слева, суммы — справа. */
  const row = (
    left: [string, string, string, string],
    right: [string, string, string, string],
    o: { font?: Font; label?: boolean; minH?: number; last?: boolean } = {},
  ) => {
    const docW = (b: number[]) => b[2]! - b[1]! - 2.8;
    const n = o.label
      ? 1
      : Math.max(lines(left[1], docW(L), "r", F, 8.1), lines(right[1], docW(R), "r", F, 8.1));
    // Однострочная строка 1С — 9,1 pt, многострочная — 8,1 pt на строку + 1,2.
    const h = Math.max(o.minH ?? 9.1, n > 1 ? n * 8.1 + 1.2 : 9.1);
    if (top + h > PAGE_BOTTOM) {
      hline(LEFT, RIGHT, top, THICK);
      pdf.addPage({ size: "A4", margin: 0 });
      top = 36;
      hline(LEFT, RIGHT, top, THICK);
      header();
    }
    const mid = top + h / 2;
    for (const [b, v] of [
      [L, left],
      [R, right],
    ] as const) {
      const font = o.font ?? "r";
      if (o.label) {
        put(v[0], b[0]! + 1.1, b[2]!, mid - 4.25, { font });
      } else {
        put(v[0], b[0]! + 1.0, b[1]! - 1, mid - 4.05, { font });
        const dh = lines(v[1], docW(b), font, F, 8.1) * 8.1;
        put(v[1], b[1]! + 1.4, b[2]! - 1.4, mid - dh / 2, { font });
      }
      put(v[2], b[2]! + 1, b[3]! - 1.6, mid - 4.0, { font, align: "right" });
      put(v[3], b[3]! + 1, b[4]! - 1.9, mid - 4.0, { font, align: "right" });
      if (!o.label) vline(b[1]!, top - 0.3, top + h + 0.3);
      for (const x of [b[2]!, b[3]!]) vline(x, top, top + h);
    }
    top += h;
    if (!o.last) rowLine(top);
  };

  const opening = d.opening;
  row(
    ["Сальдо на начало", "", amount(Math.max(opening, 0)), amount(Math.max(-opening, 0))],
    ["Сальдо на начало", "", amount(Math.max(-opening, 0)), amount(Math.max(opening, 0))],
    { font: "b", label: true },
  );
  const count = Math.max(d.organizationRows.length, d.counterpartyRows.length);
  const cells = (r: ReconciliationRow | undefined): [string, string, string, string] =>
    r ? [actRowDate(r.date), r.document ?? "", amount(r.debit), amount(r.credit)] : ["", "", "", ""];
  for (let i = 0; i < count; i++) row(cells(d.organizationRows[i]), cells(d.counterpartyRows[i]));
  for (let i = 0; i < EMPTY_ROWS; i++) row(["", "", "", ""], ["", "", "", ""]);

  const t = reconciliationTotals(d);
  const cpDebit = d.counterpartyRows.reduce((a, r) => a + r.debit, 0);
  const cpCredit = d.counterpartyRows.reduce((a, r) => a + r.credit, 0);
  const cpClosing = -opening + cpDebit - cpCredit;
  const endLabel = `Сальдо на конец ${dateWords(d.periodEnd)}`;
  row(
    ["Обороты за период", "", amount(t.debit), amount(t.credit)],
    ["Обороты за период", "", d.agreed ? amount(cpDebit) : "", d.agreed ? amount(cpCredit) : ""],
    { font: "b", label: true },
  );
  row(
    [endLabel, "", amount(Math.max(t.closing, 0)), amount(Math.max(-t.closing, 0))],
    [
      endLabel,
      "",
      d.agreed ? amount(Math.max(cpClosing, 0)) : "",
      d.agreed ? amount(Math.max(-cpClosing, 0)) : "",
    ],
    { font: "b", label: true, minH: 9.5, last: true },
  );
  // Рамка: толстые верх, низ, края и середина; тонкая вторая линия середины.
  hline(LEFT, RIGHT, tableTop, THICK);
  hline(LEFT, RIGHT, top, THICK);
  for (const x of [L[0]!, R[0]!, R[4]!]) vline(x, tableTop - 0.6, top + 0.6, THICK);
  vline(L[4]!, tableTop - 0.6, top);

  // Итог по данным организации и подписи.
  let s = top + 9.1;
  if (s + 125 > PAGE_BOTTOM) {
    pdf.addPage({ size: "A4", margin: 0 });
    s = 36;
  }
  put(`По данным ${d.organization.name}`, 39.0, 300, s);
  const debt = debtStatement(d, t.closing);
  // Ширина колонки итога подобрана по образцу: переносы строк совпадают с 1С («…теңге 00 / тиын)»).
  put(debt, 39.1, 298.1, s + 9.4, { font: "b", pitch: 8.25 });
  s += 9.4 + lines(debt, 298.1 - 39.1, "b", F, 8.25) * 8.25 + 12.45;
  for (const [x, p, x2] of [
    [39.0, d.organization, 300],
    [325.7, d.counterparty, RIGHT],
  ] as const) {
    put(`От ${p.name}`, x, x2, s);
    put(p.id, x, x2, s + 9.1);
    put("________________", x, x2, s + 27.3);
    put("М.П.", x, x2, s + 63.8);
  }
  put("(_______________________)", 166.9, 300, s + 45.6);
  put("(_______________________)", 451.8, RIGHT, s + 45.6);
  hline(LEFT, 165.2, s + 54.4);
  hline(324.0, 450.1, s + 54.4);
  pdf.end();
  return done;
}
