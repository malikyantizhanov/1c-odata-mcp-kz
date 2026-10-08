import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { money, quantity } from "./invoice-pdf.js";

/**
 * Первичные документы реализации по формам приказа Министра финансов РК от 20.12.2012 № 562
 * (https://adilet.zan.kz/rus/docs/V1200008265):
 *  - Р-1 «Акт выполненных работ (оказанных услуг)» — приложение 50 (ред. приказа № 458 от 27.10.2014);
 *  - З-2 «Накладная на отпуск запасов на сторону» — приложение 26 (ред. приказа № 402 от 19.08.2013).
 * Р-1 повторяет акт, напечатанный из 1С:Бухгалтерии для Казахстана (образец PDF, A4 альбомная): координаты блоков,
 * шрифты (7,5 pt; стороны и договор — 9 pt полужирный; заголовок — 10,5 pt полужирный; таблица — 7,1 pt; пояснения —
 * курсив), колонка 9 «в том числе НДС, в теңге» всегда, «Место печати», даты с « г.». Значения — по правилам ПечатьР1 /
 * ПечатьЗ2 модуля менеджера документа «Реализация товаров и услуг». З-2 — по сетке макета ПФ_MXL_З2 (49 колонок,
 * Landscape, поля 10 мм). Шрифт — Arimo (метрики Arial) вместо DejaVu Sans Condensed печати 1С. Печать 1С через OData
 * не вызвать — это её повторение по данным документа.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve("@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf");
const FONT_BOLD = require.resolve("@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf");
const FONT_ITALIC = require.resolve("@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf");

/**
 * Ширины 49 колонок макетов (единицы 1С): у Р-1 колонки 10, 16, 34, 37 узкие (12), 0 и 28 широкие (32); у З-2 ещё
 * и 17 узкая. Колонки листа пропорциональны им — как в 1С при выводе макета.
 */
const R1_WIDTHS = Array.from({ length: 49 }, (_, i) =>
  i === 0 || i === 28 ? 32 : [10, 16, 34, 37].includes(i) ? 12 : 24,
);
const Z2_WIDTHS = R1_WIDTHS.map((w, i) => (i === 17 ? 12 : w));
/** A4 альбомная (pt) и поля 10 мм, как в параметрах печати макета. */
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const MARGIN = 28.35;

export interface PrintParty {
  /** Полное наименование (как ОписаниеОрганизации «ПолноеНаименование»). */
  name: string;
  /** Юридический адрес (контактная информация, вид «Юридический адрес»), если он есть в базе. */
  address?: string | undefined;
  /** Телефоны (контактная информация), через запятую. */
  phones?: string | undefined;
  /** ИИН (ИП, физлицо) или БИН (юрлицо). */
  idNumber?: string | undefined;
}

export interface Signer {
  position?: string | undefined;
  name?: string | undefined;
}

export interface ActLine {
  name: string;
  unit?: string | undefined;
  quantity: number;
  price: number;
  sum: number;
  vat: number;
  sumWithVat: number;
}

/** Вариант таблицы Р-1, как в 1С: без колонок НДС, «сумма НДС + сумма с НДС» (НДС сверху), «в том числе НДС». */
export type ActVariant = "plain" | "vatOnTop" | "vatIncluded";

export interface ActR1Data {
  number: string;
  /** YYYY-MM-DD */
  date: string;
  customer: PrintParty;
  executor: PrintParty;
  /** Договор: «Договор №<номер> от <дата> г.» (Р-1 1С: «Договор (контракт) [ДоговорКонтрагента]»). */
  contract?: string | undefined;
  /** Колонка 3 «Дата выполнения работ (оказания услуг)»: «08.06.2026 - 30.09.2026» (отчётный период документа). */
  period?: string | undefined;
  variant: ActVariant;
  /** Валюта в заголовках колонок НДС («в теңге»): наименование валюты документа. */
  currency: string;
  lines: ActLine[];
  totals: { quantity: number; sum: number; vat: number; sumWithVat: number };
  executorSigner?: Signer | undefined;
  /** Дата подписания (принятия) работ — YYYY-MM-DD. */
  acceptedDate?: string | undefined;
  documentation?: string | undefined;
}

export interface WaybillLine {
  name: string;
  code?: string | undefined;
  unit?: string | undefined;
  quantity: number;
  price: number;
  sumWithVat: number;
  vat: number;
}

export interface WaybillZ2Data {
  number: string;
  date: string;
  organization: PrintParty;
  receiver: string;
  /** «Ответственный за поставку (Ф.И.О.)» — ответственный документа. */
  responsible?: string | undefined;
  currency: string;
  lines: WaybillLine[];
  totals: { quantity: number; sumWithVat: number; vat: number };
  quantityWords: string;
  amountWords: string;
  permittedBy?: Signer | undefined;
  chiefAccountant?: string | undefined;
  releasedBy?: string | undefined;
  powerOfAttorney?: string | undefined;
  powerOfAttorneyPerson?: string | undefined;
  powerOfAttorneyIssuedBy?: string | undefined;
}

/** «08.10.2026» из YYYY-MM-DD (ДЛФ=Д). */
export const shortDate = (iso: string | undefined): string =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) && !iso.startsWith("0001")
    ? iso.slice(0, 10).split("-").reverse().join(".")
    : "";

type Font = "r" | "b" | "i";
interface TextOpts {
  font?: Font;
  size?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  pad?: number;
}

/** Альбомный лист A4 с сеткой из 49 колонок шириной как в макете 1С. */
class Sheet {
  readonly pdf: PDFKit.PDFDocument;
  readonly chunks: Buffer[] = [];
  readonly done: Promise<Buffer>;
  readonly left = MARGIN;
  readonly right = A4_LANDSCAPE.width - MARGIN;
  readonly top = MARGIN;
  readonly bottom = A4_LANDSCAPE.height - MARGIN;
  private readonly edges: number[];
  y: number;

  constructor(widths: number[], title: string) {
    this.pdf = new PDFDocument({ size: "A4", layout: "landscape", margin: 0, info: { Title: title } });
    this.pdf.registerFont("r", FONT);
    this.pdf.registerFont("b", FONT_BOLD);
    this.pdf.registerFont("i", FONT_ITALIC);
    this.pdf.on("data", (c: Buffer) => this.chunks.push(c));
    this.done = new Promise<Buffer>((res) => this.pdf.on("end", () => res(Buffer.concat(this.chunks))));
    const total = widths.reduce((a, w) => a + w, 0);
    let acc = 0;
    this.edges = [0, ...widths.map((w) => (acc += w))].map(
      (u) => this.left + ((this.right - this.left) * u) / total,
    );
    this.y = this.top;
  }

  x(col: number): number {
    return this.edges[col]!;
  }

  height(s: string, width: number, font: Font = "r", size = 7): number {
    return this.pdf
      .font(font)
      .fontSize(size)
      .heightOfString(s || " ", { width });
  }

  /** Текст в прямоугольнике колонок [c1, c2) высотой h, с выравниванием. */
  text(s: string, c1: number, c2: number, y: number, h: number, o: TextOpts = {}): void {
    const pad = o.pad ?? 1.5;
    const size = o.size ?? 7;
    const font = o.font ?? "r";
    const width = this.x(c2) - this.x(c1) - 2 * pad;
    const th = this.height(s, width, font, size);
    const ty = o.valign === "top" ? y + pad : o.valign === "bottom" ? y + h - th - pad : y + (h - th) / 2;
    this.pdf
      .font(font)
      .fontSize(size)
      .text(s, this.x(c1) + pad, ty, { width, align: o.align ?? "left" });
  }

  box(c1: number, c2: number, y: number, h: number, w = 0.5): void {
    this.pdf
      .rect(this.x(c1), y, this.x(c2) - this.x(c1), h)
      .lineWidth(w)
      .stroke();
  }

  hline(c1: number, c2: number, y: number, w = 0.5): void {
    this.pdf.moveTo(this.x(c1), y).lineTo(this.x(c2), y).lineWidth(w).stroke();
  }

  /** Строка таблицы: ячейки [границы колонок], высота — по самому высокому тексту. */
  row(
    bounds: number[],
    values: string[],
    o: TextOpts & { minH?: number; border?: boolean; aligns?: Array<TextOpts["align"]> } = {},
  ): number {
    const size = o.size ?? 6.5;
    const font = o.font ?? "r";
    let h = o.minH ?? 11;
    values.forEach((v, i) => {
      const w = this.x(bounds[i + 1]!) - this.x(bounds[i]!) - 3;
      h = Math.max(h, this.height(v, w, font, size) + 3);
    });
    return h;
  }

  /** Новая страница, если блок высотой h не помещается; onNewPage — повтор шапки таблицы. */
  ensure(h: number, onNewPage?: () => void): void {
    if (this.y + h <= this.bottom) return;
    this.pdf.addPage({ size: "A4", layout: "landscape", margin: 0 });
    this.y = this.top;
    onNewPage?.();
  }

  /** Блок «Приложение N к приказу …» (колонки 39–49 макета, по центру) и «Форма X» справа под ним. */
  appendix(n: number, form: string): void {
    const lines = [
      `Приложение ${n}`,
      "к приказу Министра финансов",
      "Республики Казахстан",
      "от 20 декабря 2012 года № 562",
    ];
    lines.forEach((l, i) =>
      this.text(l, 39, 49, this.y + i * 10, 10, { size: 8, font: "i", align: "center", pad: 0 }),
    );
    this.y += lines.length * 10 + 4;
    this.text(form, 39, 49, this.y, 11, { size: 8, font: "b", align: "right", pad: 0 });
    this.y += 14;
  }

  /** Подчёркнутое поле со значением и подписью под чертой мелким курсивом (как в макете). */
  field(value: string, c1: number, c2: number, caption?: string, o: TextOpts = {}): number {
    const w = this.x(c2) - this.x(c1) - 3;
    const h = Math.max(12, this.height(value, w, o.font ?? "r", o.size ?? 8) + 3);
    this.text(value, c1, c2, this.y, h, { size: 8, ...o, valign: "bottom", pad: 1.5 });
    this.hline(c1, c2, this.y + h);
    if (caption) this.text(caption, c1, c2, this.y + h, 9, { size: 6.5, font: "i", align: "center", pad: 0 });
    return h + (caption ? 9 : 0);
  }

  end(): Promise<Buffer> {
    this.pdf.end();
    return this.done;
  }
}

const num = (n: number): string => money(n);
const qty = (n: number): string => (Number.isInteger(n) ? quantity(n).replace(/,000$/, "") : quantity(n));

/** Таблица с шапкой: заголовок (с объединёнными ячейками) повторяется на новой странице. */
function drawHeader(
  s: Sheet,
  head: Array<{ c1: number; c2: number; r1: number; r2: number; text: string }>,
  rows: number[],
  size = 7.5,
): void {
  // Узкие колонки (№ п/п, единица) — мельче, чтобы слова не рвались посередине.
  const fontSize = (c: { c1: number; c2: number }) => (c.c2 - c.c1 <= 3 ? size - 1 : size);
  const pad = (c: { c1: number; c2: number }) => (c.c2 - c.c1 <= 3 ? 0.5 : 1.5);
  // Высоты строк шапки — по самому длинному тексту (сначала однострочные ячейки, потом объединённые).
  const heights = [...rows];
  for (const c of [...head].sort((a, b) => a.r2 - a.r1 - (b.r2 - b.r1))) {
    const need = s.height(c.text, s.x(c.c2) - s.x(c.c1) - 2 * pad(c), "r", fontSize(c)) + 2 * pad(c) + 2;
    const have = heights.slice(c.r1, c.r2).reduce((a, h) => a + h, 0);
    if (need > have) heights[c.r2 - 1]! += need - have;
  }
  const ys = [s.y];
  heights.forEach((h) => ys.push(ys[ys.length - 1]! + h));
  for (const c of head) {
    const y = ys[c.r1]!;
    const h = ys[c.r2]! - y;
    s.box(c.c1, c.c2, y, h);
    s.text(c.text, c.c1, c.c2, y, h, { align: "center", size: fontSize(c), pad: pad(c) });
  }
  s.y = ys[ys.length - 1]!;
}

/**
 * Р-1 в абсолютных координатах печатной формы 1С (образец — акт, напечатанный из 1С:Бухгалтерии для Казахстана в
 * PDF, A4 альбомная): поля ≈ 12 pt, шрифты 7,5 pt (подписи), 9 pt полужирный (стороны, договор), 10,5 pt полужирный
 * (заголовок), 7,1 pt (таблица), курсив — пояснения под чертой. Высоты растут, если текст длиннее одной строки.
 */
const R1 = {
  left: 12.3,
  right: 828.9,
  top: 20,
  bottom: 575.28,
  /** Границы колонок таблицы: 9 колонок (без НДС и «в том числе НДС») и 10 (НДС сверху: сумма НДС + сумма с НДС). */
  cols9: [12.3, 49.8, 277.4, 353.2, 504.9, 558.1, 621.2, 712.6, 770.7, 828.9],
  cols10: [12.3, 49.8, 247.4, 313.2, 445.9, 495.1, 548.2, 627.6, 697.7, 763.3, 828.9],
  /** Шаг строк таблицы и подписей (как в образце: 8,5 pt при 7,1 pt и 9 pt при 7,5 pt). */
  tablePitch: 8.5,
} as const;

/** «08.10.2026 г.» — дата в Р-1 (дата составления, дата подписания), как в печатной форме 1С. */
export const actDate = (iso: string | undefined): string => {
  const s = shortDate(iso);
  return s ? `${s} г.` : "";
};

/** «Наименование, адрес, тел.: …» — ОписаниеОрганизации(Сведения, "ПолноеНаименование,ЮридическийАдрес,Телефоны,"). */
export function partyPresentation(p: PrintParty): string {
  return [p.name, p.address, p.phones ? `тел.: ${p.phones}` : ""].filter((x) => x && x.trim()).join(", ");
}

export function renderActR1Pdf(d: ActR1Data): Promise<Buffer> {
  const s = new Sheet(
    R1_WIDTHS,
    `Акт выполненных работ (оказанных услуг) № ${d.number} от ${shortDate(d.date)}`,
  );
  const pdf = s.pdf;
  const gap = (size: number, pitch: number) => {
    pdf.font("r").fontSize(size);
    return Math.max(0, pitch - pdf.currentLineHeight(true));
  };
  const height = (str: string, w: number, font: Font, size: number, pitch = size * 1.2) => {
    const lineGap = gap(size, pitch);
    return pdf
      .font(font)
      .fontSize(size)
      .heightOfString(str || " ", { width: w, lineGap });
  };
  /** Текст в полосе [x1, x2] с верхом y; возвращает высоту. */
  const put = (
    str: string,
    x1: number,
    x2: number,
    y: number,
    o: { font?: Font; size?: number; align?: "left" | "center" | "right"; pitch?: number } = {},
  ): number => {
    const font = o.font ?? "r";
    const size = o.size ?? 7.5;
    const pitch = o.pitch ?? size * 1.2;
    const lineGap = gap(size, pitch);
    pdf
      .font(font)
      .fontSize(size)
      .text(str, x1, y, { width: x2 - x1, align: o.align ?? "left", lineGap });
    return height(str, x2 - x1, font, size, pitch);
  };
  const line = (x1: number, x2: number, y: number, w = 0.75) =>
    pdf.moveTo(x1, y).lineTo(x2, y).lineWidth(w).stroke();
  const rect = (x1: number, y1: number, x2: number, y2: number, w = 0.75) =>
    pdf
      .rect(x1, y1, x2 - x1, y2 - y1)
      .lineWidth(w)
      .stroke();
  /** Текст по центру прямоугольника (по обеим осям). */
  const cell = (
    str: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    o: { font?: Font; size?: number; valign?: "middle" | "bottom"; inset?: number } = {},
  ) => {
    const size = o.size ?? 7.1;
    const font = o.font ?? "r";
    const w = x2 - x1 - 2;
    const th = height(str, w, font, size, R1.tablePitch);
    // inset — сверху ячейки не занимать (как в образце: шапка центрируется ниже середины), если текст помещается.
    const top = o.inset && th <= y2 - y1 - o.inset ? y1 + o.inset : y1;
    const ty = o.valign === "bottom" ? Math.max(y1 + 1, y2 - 4.9 - th) : top + (y2 - top - th) / 2;
    put(str, x1 + 1, x2 - 1, ty, { font, size, align: "center", pitch: R1.tablePitch });
  };

  // Приложение 50 к приказу № 562 (курсив, по центру справа) и «Форма Р-1» по правому краю.
  [
    "Приложение 50",
    "к приказу Министра",
    "финансов",
    "Республики Казахстан",
    "от 20 декабря 2012 года №",
    "562",
  ].forEach((t, i) => put(t, 720.1, 827.4, 20 + i * 9, { font: "i", align: "center" }));
  put("Форма Р-1", 760, 829.2, 77.7, { align: "right" });
  // Подпись над ячейками ИИН/БИН — полностью, как в 1С.
  ["Индивидуальный", "идентификационный", "номер/Бизнес", "идентификационный номер"].forEach((t, i) =>
    put(t, 720.1, 827.4, 90.5 + i * 9, { align: "center" }),
  );

  // Заказчик / Исполнитель: «наименование, адрес, тел.» полужирным по центру над чертой, ИИН/БИН в рамке справа.
  const partyW = 717.1 - 94.8;
  const extra = (str: string, font: Font, size: number, w: number, one: number) =>
    Math.max(0, height(str, w, font, size) - one);
  const one9 = height("Ж", partyW, "b", 9);
  let dy = 0;
  const party = (
    label: string,
    p: PrintParty,
    nameTop: number,
    labelTop: number,
    box: [number, number, number],
  ) => {
    const text = partyPresentation(p);
    put(text, 94.8, 717.1, nameTop + dy, { font: "b", size: 9, align: "center" });
    const ex = extra(text, "b", 9, partyW, one9);
    dy += ex;
    const [bx, by1, by2] = box;
    put(label, 12.7, 94, labelTop + dy);
    rect(bx, by1 + dy, 827.4, by2 + dy);
    const idH = height(p.idNumber ?? "", 827.4 - bx, "b", 7.5);
    put(p.idNumber ?? "", bx, 827.4, by1 + dy + (by2 - by1 - idH) / 2, { font: "b", align: "center" });
    line(94.8, 717.1, by2 + 2.6 + dy);
    put("полное наименование, адрес, данные о средствах связи", 94.8, 619.5, by2 + 3.5 + dy, {
      font: "i",
      align: "center",
    });
  };
  party("Заказчик", d.customer, 111.2, 117.5, [720.1, 129.0, 143.2]);
  party("Исполнитель", d.executor, 160.7, 167.0, [745.4, 159.0, 173.2]);

  // Договор (контракт): «Договор №… от … г.» полужирным по центру над чертой.
  put("Договор (контракт)", 12.7, 94, 187.2 + dy);
  const contract = d.contract ?? "";
  put(contract, 94.8, 619.6, 187.3 + dy, { font: "b", size: 9, align: "center" });
  dy += extra(contract, "b", 9, 619.6 - 94.8, one9);
  line(94.8, 619.6, 199.0 + dy);

  // Номер документа / Дата составления и заголовок.
  rect(628.6, 200.1 + dy, 677.6, 223.4 + dy);
  rect(677.6, 200.1 + dy, 739.3, 223.4 + dy);
  rect(628.6, 223.4 + dy, 677.6, 237.6 + dy);
  rect(677.6, 223.4 + dy, 739.3, 237.6 + dy);
  put("Номер\nдокумента", 628.6, 677.6, 202.9 + dy, { align: "center" });
  put("Дата\nсоставления", 677.6, 739.3, 202.9 + dy, { align: "center" });
  put(d.number, 628.6, 677.6, 226.1 + dy, { font: "b", align: "center" });
  put(actDate(d.date), 677.6, 739.3, 226.1 + dy, { font: "b", align: "center" });
  put("АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)", 12.3, 702, 212.8 + dy, {
    font: "b",
    size: 10.5,
    align: "center",
  });

  // Таблица: колонка 9 «в том числе НДС» есть всегда (у неплательщика НДС — пустая), у НДС сверху — 10 колонок.
  const cur = d.currency;
  const b = d.variant === "vatOnTop" ? R1.cols10 : R1.cols9;
  const n = b.length - 1;
  const lw = 0.71;
  const name =
    "Наименование работ (услуг) (в разрезе их подвидов в соответствии с технической спецификацией, " +
    "заданием, графиком выполнения работ (услуг) при их наличии)";
  const report =
    "Сведения об отчете о научных исследованиях, маркетинговых, консультационных и прочих услугах " +
    "(дата, номер, количество страниц) (при их наличии)";
  const sub = [
    "количество",
    "цена за единицу",
    "стоимость",
    ...(d.variant === "vatOnTop"
      ? [`сумма НДС, в ${cur}`, `сумма с НДС, в ${cur}`]
      : [`в том числе НДС, в ${cur}`]),
  ];
  const cellH = (str: string, x1: number, x2: number) =>
    height(str, x2 - x1 - 2, "r", 7.1, R1.tablePitch) + 2;
  const main = [
    "Номер по порядку",
    name,
    "Дата выполнения работ (оказания услуг)",
    report,
    "Единица измерения",
  ];
  const rowA = Math.max(18, cellH("Выполнено работ (оказано услуг)", b[5]!, b[n]!));
  let rowB = Math.max(26.6, ...sub.map((t, i) => cellH(t, b[5 + i]!, b[6 + i]!)));
  rowB = Math.max(rowB, ...main.map((t, i) => cellH(t, b[i]!, b[i + 1]!) - rowA));
  const numH = 10.7;
  let y = 242.9 + dy;
  const header = () => {
    const y1 = y + rowA;
    const y2 = y1 + rowB;
    main.forEach((t, i) => {
      rect(b[i]!, y, b[i + 1]!, y2, lw);
      cell(t, b[i]!, y, b[i + 1]!, y2, { inset: 8.5 });
    });
    rect(b[5]!, y, b[n]!, y1, lw);
    cell("Выполнено работ (оказано услуг)", b[5]!, y, b[n]!, y1);
    sub.forEach((t, i) => {
      rect(b[5 + i]!, y1, b[6 + i]!, y2, lw);
      cell(t, b[5 + i]!, y1, b[6 + i]!, y2, { valign: "bottom" });
    });
    for (let i = 0; i < n; i++) {
      rect(b[i]!, y2, b[i + 1]!, y2 + numH, lw);
      cell(String(i + 1), b[i]!, y2, b[i + 1]!, y2 + numH);
    }
    y = y2 + numH;
  };
  const newPage = () => {
    pdf.addPage({ size: "A4", layout: "landscape", margin: 0 });
    y = R1.top;
  };
  header();
  const period = d.period ?? "";
  d.lines.forEach((l, i) => {
    const values = [
      String(i + 1),
      l.name,
      period,
      "",
      l.unit ?? "",
      qty(l.quantity),
      num(l.price),
      num(l.sum),
      ...(d.variant === "vatOnTop"
        ? [num(l.vat), num(l.sumWithVat)]
        : d.variant === "vatIncluded"
          ? [num(l.vat)]
          : [""]),
    ];
    // Очень длинное наименование: строка должна поместиться на страницу под шапкой — обрезается с «…».
    const limit = (R1.bottom - R1.top) * 0.7;
    const rowH = () => Math.max(10.7, ...values.map((v, j) => cellH(v, b[j]!, b[j + 1]!) + 0.2));
    let h = rowH();
    if (h > limit) {
      let text = values[1]!;
      while (text.length > 1 && cellH(`${text}…`, b[1]!, b[2]!) > limit)
        text = text.slice(0, Math.floor(text.length * 0.95));
      values[1] = `${text}…`;
      h = rowH();
    }
    if (y + h > R1.bottom) {
      newPage();
      header();
    }
    values.forEach((v, j) => {
      rect(b[j]!, y, b[j + 1]!, y + h, lw);
      cell(v, b[j]!, y, b[j + 1]!, y + h);
    });
    y += h;
  });
  // Итого: «Итого» в колонке 5 без рамки, итоги 6…9 (10) в рамках; «X» — в цене.
  const totH = 10.6;
  if (y + totH > R1.bottom) newPage();
  cell("Итого", b[4]!, y, b[5]!, y + totH);
  const totals = [
    qty(d.totals.quantity),
    "X",
    num(d.totals.sum),
    ...(d.variant === "vatOnTop"
      ? [num(d.totals.vat), num(d.totals.sumWithVat)]
      : d.variant === "vatIncluded"
        ? [num(d.totals.vat)]
        : [""]),
  ];
  totals.forEach((v, j) => {
    rect(b[5 + j]!, y, b[6 + j]!, y + totH, lw);
    cell(v, b[5 + j]!, y, b[6 + j]!, y + totH);
  });
  y += totH;

  // Подвал (запасы, приложение, подписи) — целиком на одной странице.
  const docs = d.documentation ?? "";
  const docsExtra = extra(docs, "r", 7.5, 829.6 - 280, height("Ж", 500, "r", 7.5));
  const posFit = fitOneLine(pdf, d.executorSigner?.position ?? "", 229.7 - 89.5, 7.5);
  const posExtra = Math.max(0, posFit.h - height("Ж", 500, "r", 7.5));
  if (y + 117 + docsExtra + posExtra > R1.bottom) {
    newPage();
    y = R1.top;
  }
  const end = y;
  put("Сведения об использовании запасов, полученных от заказчика", 12.6, 240, end + 15.4, { size: 7.4 });
  line(240.5, 828.8, end + 24.9, 0.74);
  put("наименование, количество, стоимость", 240.5, 828.8, end + 26.1, {
    font: "i",
    size: 7.4,
    align: "center",
  });

  const app = end + 40.1;
  put("Приложение:", 12.7, 68, app);
  put(
    "Перечень документации, в том числе отчет(ы) о маркетинговых, научных исследованиях, консультационных и " +
      "прочих услугах (обязательны при его",
    68.9,
    829.6,
    app,
  );
  put("(их) наличии) на", 68.9, 131, app + 10.5);
  line(132.3, 244.0, app + 20.1);
  put("страниц", 245.2, 278, app + 10.5);
  put(docs, 280, 829.6, app + 10.5);
  line(278.5, 829.6, app + 20.1 + docsExtra);

  // Подписи. Исполнитель: должность / подпись / расшифровка; «Место печати» под подписью.
  const sig = app + 33.8 + docsExtra + posExtra;
  const signer = d.executorSigner;
  put("Сдал (Исполнитель)", 14.9, 89, sig + 6.3);
  pdf
    .font("r")
    .fontSize(posFit.size)
    .text(signer?.position ?? "", 89.5, sig + 8.6 - posFit.h, { width: 229.7 - 89.5, align: "center" });
  const nameFit = fitOneLine(pdf, signer?.name ?? "", 377.7 - 285.4, 7.5);
  pdf
    .font("r")
    .fontSize(nameFit.size)
    .text(signer?.name ?? "", 285.4, sig + 8.6 - nameFit.h, { width: 377.7 - 285.4, align: "center" });
  // У заказчика «расшифровка подписи» — от левого края черты (так в макете 1С), остальные подписи — по центру.
  const parts = (
    yLine: number,
    xs: Array<[number, number]>,
    slashes: number[],
    yCap: number,
    lastLeft = false,
  ) => {
    xs.forEach(([x1, x2], i) => {
      line(x1, x2, yLine);
      const left = lastLeft && i === 2;
      put(["должность", "подпись", "расшифровка подписи"][i]!, left ? x1 + 0.4 : x1, x2, yCap, {
        font: "i",
        align: left ? "left" : "center",
      });
    });
    slashes.forEach((x) => put("/", x, x + 4, yLine - 3.7));
  };
  parts(
    sig + 10,
    [
      [89.5, 229.7],
      [237.2, 277.9],
      [285.4, 377.7],
    ],
    [232.3, 280.5],
    sig + 12.7,
  );
  put("Место печати", 14.9, 89, sig + 30.7);

  // Заказчик: подписи, дата подписания (принятия) с « г.», «Место печати».
  put("Принял (Заказчик)", 423.9, 498, sig + 3.0);
  parts(
    sig + 6.6,
    [
      [498.6, 603.1],
      [610.7, 691.8],
      [699.3, 827.4],
    ],
    [605.8, 694.4],
    sig + 9.3,
    true,
  );
  put("Дата подписания (принятия) работ (услуг)", 423.9, 604, sig + 21.7);
  put(actDate(d.acceptedDate), 605.4, 691.8, sig + 21.3, { align: "center" });
  line(605.4, 691.8, sig + 31.3);
  put("Место печати", 423.9, 498, sig + 34.1);
  return s.end();
}

/** Шрифт мельче (до 5,5 pt), чтобы текст встал в одну строку; иначе — перенос (высота растёт вверх от черты). */
function fitOneLine(
  pdf: PDFKit.PDFDocument,
  str: string,
  width: number,
  size: number,
): { size: number; h: number } {
  let sz = size;
  pdf.font("r");
  while (sz > 5.5 && pdf.fontSize(sz).widthOfString(str) > width) sz -= 0.5;
  return { size: sz, h: pdf.fontSize(sz).heightOfString(str || " ", { width }) };
}

export function renderWaybillZ2Pdf(d: WaybillZ2Data): Promise<Buffer> {
  const s = new Sheet(
    Z2_WIDTHS,
    `Накладная на отпуск запасов на сторону № ${d.number} от ${shortDate(d.date)}`,
  );
  s.appendix(26, "Форма З-2");

  // Организация и ИИН/БИН.
  const orgTop = s.y;
  s.text("Организация (индивидуальный предприниматель)", 0, 13, orgTop, 12, {
    pad: 0,
    valign: "bottom",
    size: 7,
  });
  s.field(d.organization.name, 13, 38);
  s.text("ИИН/БИН", 39, 42, orgTop, 12, { align: "right", valign: "bottom", size: 7 });
  s.box(42, 49, orgTop, 12);
  s.text(d.organization.idNumber ?? "", 42, 49, orgTop, 12, { align: "center", size: 7.5 });
  s.y = orgTop + 20;

  // Номер и дата.
  s.box(41, 45, s.y, 16);
  s.box(45, 49, s.y, 16);
  s.text("Номер документа", 41, 45, s.y, 16, { align: "center", size: 6.5 });
  s.text("Дата составления", 45, 49, s.y, 16, { align: "center", size: 6.5 });
  s.y += 16;
  s.box(41, 45, s.y, 13, 1);
  s.box(45, 49, s.y, 13, 1);
  s.text(d.number, 41, 45, s.y, 13, { align: "center", font: "b", size: 8 });
  s.text(actDate(d.date), 45, 49, s.y, 13, { align: "center", font: "b", size: 8 });
  s.y += 20;
  s.text("НАКЛАДНАЯ НА ОТПУСК ЗАПАСОВ НА СТОРОНУ", 0, 49, s.y, 14, { align: "center", font: "b", size: 10 });
  s.y += 20;

  // Шапка: отправитель, получатель, ответственный, транспорт, ТТН.
  const hb = [0, 11, 22, 31, 40, 49];
  const titles = [
    "Организация (индивидуальный предприниматель) - отправитель",
    "Организация (индивидуальный предприниматель) - получатель",
    "Ответственный за поставку (Ф.И.О.)",
    "Транспортная организация",
    "Товарно-транспортная накладная (номер, дата)",
  ];
  const th = s.row(hb, titles, { minH: 20 });
  titles.forEach((t, i) => {
    s.box(hb[i]!, hb[i + 1]!, s.y, th);
    s.text(t, hb[i]!, hb[i + 1]!, s.y, th, { align: "center", size: 6.5 });
  });
  s.y += th;
  const vals = [d.organization.name, d.receiver, d.responsible ?? "", "", ""];
  const vh = s.row(hb, vals, { minH: 13 });
  vals.forEach((v, i) => {
    s.box(hb[i]!, hb[i + 1]!, s.y, vh);
    s.text(v, hb[i]!, hb[i + 1]!, s.y, vh, { align: "center" });
  });
  s.y += vh + 10;

  // Таблица запасов: границы — область «ЗаголовокТаблицы» макета ПФ_MXL_З2.
  const b = [0, 2, 14, 19, 22, 27, 31, 37, 43, 49];
  const cur = d.currency;
  const header = () =>
    drawHeader(
      s,
      [
        { c1: 0, c2: 2, r1: 0, r2: 2, text: "Номер по порядку" },
        { c1: 2, c2: 14, r1: 0, r2: 2, text: "Наименование, характеристика" },
        { c1: 14, c2: 19, r1: 0, r2: 2, text: "Номенклатурный номер" },
        { c1: 19, c2: 22, r1: 0, r2: 2, text: "Единица измерения" },
        { c1: 22, c2: 31, r1: 0, r2: 1, text: "Количество" },
        { c1: 22, c2: 27, r1: 1, r2: 2, text: "подлежит отпуску" },
        { c1: 27, c2: 31, r1: 1, r2: 2, text: "отпущено" },
        { c1: 31, c2: 37, r1: 0, r2: 2, text: `Цена за единицу, в ${cur}` },
        { c1: 37, c2: 43, r1: 0, r2: 2, text: `Сумма с НДС, в ${cur}` },
        { c1: 43, c2: 49, r1: 0, r2: 2, text: `Сумма НДС, в ${cur}` },
        ...b.slice(0, -1).map((c, i) => ({ c1: c, c2: b[i + 1]!, r1: 2, r2: 3, text: String(i + 1) })),
      ],
      [12, 12, 10],
    );
  header();
  d.lines.forEach((l, i) => {
    const values = [
      String(i + 1),
      l.name,
      l.code ?? "",
      l.unit ?? "",
      qty(l.quantity),
      qty(l.quantity),
      num(l.price),
      num(l.sumWithVat),
      num(l.vat),
    ];
    const h = s.row(b, values);
    s.ensure(h, header);
    values.forEach((v, j) => {
      s.box(b[j]!, b[j + 1]!, s.y, h);
      s.text(v, b[j]!, b[j + 1]!, s.y, h, {
        align: j === 0 || j === 3 ? "center" : j >= 4 ? "right" : "left",
        size: 6.5,
      });
    });
    s.y += h;
  });
  s.ensure(12);
  s.text("Итого", 14, 22, s.y, 12, { align: "right", font: "b" });
  const tot = [
    qty(d.totals.quantity),
    qty(d.totals.quantity),
    "х",
    num(d.totals.sumWithVat),
    num(d.totals.vat),
  ];
  tot.forEach((v, j) => {
    s.box(b[4 + j]!, b[5 + j]!, s.y, 12);
    s.text(v, b[4 + j]!, b[5 + j]!, s.y, 12, { align: j === 2 ? "center" : "right", font: "b" });
  });
  s.y += 12 + 8;

  // Итог прописью.
  s.ensure(40);
  const wordsTop = s.y;
  s.text("Всего отпущено количество запасов (прописью)", 0, 13, wordsTop, 12, { pad: 0, valign: "bottom" });
  s.field(d.quantityWords, 13, 22);
  s.y = wordsTop;
  s.text(` на сумму (прописью), в ${cur}`, 22, 30, wordsTop, 12, { pad: 0, valign: "bottom" });
  s.field(d.amountWords, 30, 49, undefined, { font: "b" });
  s.y = wordsTop + 26;

  // Подписи (область «Подвал»).
  s.ensure(110);
  const row = (label: string, c: number, value: string, withPosition: boolean, position?: string) => {
    const y = s.y;
    s.text(label, c, c + 5, y, 12, { pad: 0, valign: "bottom" });
    if (withPosition) {
      s.text(position ?? "", c + 5, c + 10, y, 12, { align: "center", valign: "bottom" });
      s.hline(c + 5, c + 10, y + 12);
      s.text("должность", c + 5, c + 10, y + 12, 8, { size: 5.5, align: "center", pad: 0 });
      s.text("/", c + 10, c + 11, y, 12, { align: "center", valign: "bottom", pad: 0 });
      s.hline(c + 11, c + 16, y + 12);
      s.text("подпись", c + 11, c + 16, y + 12, 8, { size: 5.5, align: "center", pad: 0 });
      s.text("/", c + 16, c + 17, y, 12, { align: "center", valign: "bottom", pad: 0 });
      s.text(value, c + 17, c + 25, y, 12, { align: "center", valign: "bottom" });
      s.hline(c + 17, c + 25, y + 12);
      s.text("расшифровка подписи", c + 17, c + 25, y + 12, 8, { size: 5.5, align: "center", pad: 0 });
    } else {
      s.hline(c + 5, c + 10, y + 12);
      s.text("подпись", c + 5, c + 10, y + 12, 8, { size: 5.5, align: "center", pad: 0 });
      s.text("/", c + 10, c + 11, y, 12, { align: "center", valign: "bottom", pad: 0 });
      s.text(value, c + 11, c + 22, y, 12, { align: "center", valign: "bottom" });
      s.hline(c + 11, c + 22, y + 12);
      s.text("расшифровка подписи", c + 11, c + 22, y + 12, 8, { size: 5.5, align: "center", pad: 0 });
    }
  };
  const footTop = s.y;
  row("Отпуск разрешил", 0, d.permittedBy?.name ?? "", true, d.permittedBy?.position);
  // Доверенность — справа.
  s.text("По доверенности", 26, 31, footTop, 12, { pad: 0, valign: "bottom" });
  s.text(d.powerOfAttorney ?? "№ ______ от «___» __________ 20__ года", 31, 49, footTop, 12, {
    valign: "bottom",
  });
  s.y = footTop + 26;
  s.text("выданной", 26, 29, s.y, 12, { pad: 0, valign: "bottom" });
  s.text(d.powerOfAttorneyPerson ?? "", 29, 49, s.y, 12, { valign: "bottom" });
  s.hline(29, 49, s.y + 12);
  const accTop = s.y + 16;
  s.y = accTop;
  row("Главный бухгалтер", 0, d.chiefAccountant ?? "", false);
  s.text(d.powerOfAttorneyIssuedBy ?? "", 26, 49, accTop, 12, { valign: "bottom" });
  s.hline(26, 49, accTop + 12);
  s.y = accTop + 24;
  s.text("Место печати", 0, 5, s.y, 10, { pad: 0 });
  s.y += 16;
  const lastTop = s.y;
  row("Отпустил", 0, d.releasedBy ?? "", false);
  s.text("Запасы получил", 26, 31, lastTop, 12, { pad: 0, valign: "bottom" });
  s.hline(31, 37, lastTop + 12);
  s.text("подпись", 31, 37, lastTop + 12, 8, { size: 5.5, align: "center", pad: 0 });
  s.text("/", 37, 38, lastTop, 12, { align: "center", valign: "bottom", pad: 0 });
  s.hline(38, 49, lastTop + 12);
  s.text("расшифровка подписи", 38, 49, lastTop + 12, 8, { size: 5.5, align: "center", pad: 0 });
  return s.end();
}
