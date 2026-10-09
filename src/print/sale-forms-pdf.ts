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

/**
 * Суммы и цена в З-2 — «1 000,00», по-русски. В образце из 1С было «1,000.00»: так 1С:Fresh печатает при английских
 * региональных настройках системы пользователя; формы должны быть на русском.
 */
export const z2Money = (n: number): string => money(n);
/** Количество в З-2: целое — «1», дробное — до трёх знаков через запятую («2,5»). */
export const z2Quantity = (n: number): string => {
  const [int, frac] = String(Math.round(Math.abs(n) * 1000) / 1000).split(".");
  return `${n < 0 ? "-" : ""}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${frac ? `,${frac}` : ""}`;
};

/**
 * З-2 в абсолютных координатах печатной формы 1С (образец — накладная, напечатанная из 1С:Бухгалтерии для Казахстана
 * в 1С:Fresh, A4 альбомная): рамки 0,75 pt, текст 8 pt (ИИН/БИН и организация — 9 pt, заголовок — 10 pt полужирный),
 * курсив — «Приложение 26…», пояснения под чертой и суммы прописью. Строки таблицы растут, если наименование длиннее
 * одной строки; не поместились — новая страница с шапкой таблицы.
 */
const Z2 = {
  left: 28.2,
  right: 771.2,
  /** Границы колонок шапки (отправитель, получатель, ответственный, транспорт, ТТН) и таблицы запасов. */
  parties: [28.6, 199.3, 356.8, 503.8, 629.8, 771.6],
  cols: [28.6, 65.3, 246.6, 309.6, 356.8, 435.6, 503.8, 590.3, 677.0, 771.6],
  bottom: 560,
  pitch: 9.2,
} as const;

export function renderWaybillZ2Pdf(d: WaybillZ2Data): Promise<Buffer> {
  const s = new Sheet(
    Z2_WIDTHS,
    `Накладная на отпуск запасов на сторону № ${d.number} от ${shortDate(d.date)}`,
  );
  const pdf = s.pdf;
  const lineGap = (size: number) => {
    pdf.font("r").fontSize(size);
    return Math.max(0, size * 1.15 - pdf.currentLineHeight(true));
  };
  // Межстрочный интервал считаем до выбора шрифта: lineGap() сам переключает шрифт на обычный.
  const height = (str: string, w: number, font: Font = "r", size = 8) => {
    const gap = lineGap(size);
    return pdf
      .font(font)
      .fontSize(size)
      .heightOfString(str || " ", { width: w, lineGap: gap });
  };
  /** Текст в полосе [x1, x2] с верхом y. */
  const put = (
    str: string,
    x1: number,
    x2: number,
    y: number,
    o: { font?: Font; size?: number; align?: "left" | "center" | "right" } = {},
  ) => {
    const size = o.size ?? 8;
    const gap = lineGap(size);
    // Явные переносы — построчно: иначе pdfkit центрует строку вместе с символом перевода строки. Пробел перед
    // переносом сохраняется: 1С переносит по пробелу и центрует первую строку вместе с ним.
    let top = y;
    for (const part of str.split("\n")) {
      pdf
        .font(o.font ?? "r")
        .fontSize(size)
        .text(part, x1, top, { width: x2 - x1, align: o.align ?? "left", lineGap: gap });
      top += pdf.heightOfString(part || " ", { width: x2 - x1, lineGap: gap });
    }
  };
  /** Текст по центру ячейки [x1, x2] × [y1, y2] (по вертикали — тоже по центру). */
  const centered = (
    str: string,
    x1: number,
    x2: number,
    y1: number,
    y2: number,
    font: Font = "r",
    size = 8,
  ) => {
    const h = height(str, x2 - x1 - 3, font, size);
    put(str, x1 + 1.5, x2 - 1.5, (y1 + y2) / 2 - h / 2 + 0.4, { font, size, align: "center" });
  };
  const hline = (x1: number, x2: number, y: number) =>
    pdf.moveTo(x1, y).lineTo(x2, y).lineWidth(0.75).stroke();
  const vline = (x: number, y1: number, y2: number) =>
    pdf.moveTo(x, y1).lineTo(x, y2).lineWidth(0.75).stroke();

  // «Приложение 26 …» и «Форма З-2».
  [
    "Приложение 26",
    "к приказу Министра финансов",
    "Республики Казахстан",
    "от 20 декабря 2012 года № 562",
  ].forEach((l, i) => put(l, 613.8, 771.2, 29.2 + i * 10.8, { font: "i", align: "center" }));
  put("Форма З-2", 613.8, 769.6, 84.4, { align: "right" });

  // Организация и ИИН/БИН.
  put("Организация (индивидуальный предприниматель)", 30.1, 230, 118);
  put(d.organization.name, 230.4, 574.2, 116.9, { font: "b", size: 9, align: "center" });
  hline(230.4, 574.2, 128.2);
  put("ИИН/БИН", 560, 656.5, 116.8, { size: 9, align: "right" });
  hline(661.0, 771.2, 116.2);
  hline(661.0, 771.2, 128.2);
  vline(661.3, 115.8, 128.6);
  vline(771.6, 115.8, 128.6);
  put(d.organization.idNumber ?? "", 661.3, 771.6, 116.9, { font: "b", size: 9, align: "center" });

  // Номер документа и дата составления.
  for (const y of [151.0, 171.0, 181.8]) hline(645.2, 771.2, y);
  for (const x of [645.6, 708.6, 771.6]) vline(x, 150.6, 182.2);
  put("Номер \nдокумента", 645.6, 708.6, 151.6, { align: "center" });
  put("Дата \nсоставления", 708.6, 771.6, 151.6, { align: "center" });
  put(d.number, 645.6, 708.6, 171.6, { font: "b", align: "center" });
  put(shortDate(d.date), 708.6, 771.6, 171.6, { font: "b", align: "center" });

  put("НАКЛАДНАЯ НА ОТПУСК ЗАПАСОВ НА СТОРОНУ", Z2.left, Z2.right, 193.3, {
    font: "b",
    size: 10,
    align: "center",
  });

  // Отправитель, получатель, ответственный, транспортная организация, ТТН.
  const p = Z2.parties;
  const partyHead = [
    "Организация (индивидуальный предприниматель) - отправитель",
    "Организация (индивидуальный предприниматель) - получатель",
    "Ответственный за поставку (Ф.И.О.)",
    "Транспортная организация",
    "Товарно-транспортная накладная (номер, дата)",
  ];
  const partyValues = [d.organization.name, d.receiver, d.responsible ?? "", "", ""];
  const rowH = (values: string[], bounds: readonly number[], min: number) =>
    Math.max(min, ...values.map((v, i) => height(v, bounds[i + 1]! - bounds[i]! - 3) + 1.6));
  const headTop = 227.4;
  const headBottom = headTop + rowH(partyHead, p, 20.1);
  const valuesBottom = headBottom + rowH(partyValues, p, 20.0);
  for (const y of [headTop, headBottom, valuesBottom]) hline(Z2.left, Z2.right, y);
  for (const x of p) vline(x, headTop - 0.4, valuesBottom + 0.4);
  partyHead.forEach((t, i) => centered(t, p[i]!, p[i + 1]!, headTop, headBottom));
  partyValues.forEach((t, i) => centered(t, p[i]!, p[i + 1]!, headBottom, valuesBottom));

  // Таблица запасов: шапка в два яруса («Количество» над «подлежит отпуску» / «отпущено»), строка номеров колонок.
  const c = Z2.cols;
  const cur = d.currency;
  let y = valuesBottom + 10.8;
  const header = () => {
    const top = y;
    const mid = top + 14.8;
    const bottom = top + 29.3;
    const numbers = bottom + 10.8;
    hline(Z2.left, Z2.right, top);
    hline(c[4]! - 0.4, c[6]! - 0.4, mid);
    hline(Z2.left, Z2.right, bottom);
    hline(Z2.left, Z2.right, numbers);
    const spans: Array<[string, number, number, number, number]> = [
      ["Номер \nпо \nпорядку", 0, 1, top, bottom],
      ["Наименование, характеристика", 1, 2, top, bottom],
      ["Номенкла-\nтурный номер", 2, 3, top, bottom],
      ["Единица \nизмерения", 3, 4, top, bottom],
      ["Количество", 4, 6, top, mid],
      ["подлежит отпуску", 4, 5, mid, bottom],
      ["отпущено", 5, 6, mid, bottom],
      [`Цена за единицу, в ${cur}`, 6, 7, top, bottom],
      [`Сумма с НДС, в ${cur}`, 7, 8, top, bottom],
      [`Сумма НДС, в ${cur}`, 8, 9, top, bottom],
    ];
    for (const [t, a, b, y1, y2] of spans) centered(t, c[a]!, c[b]!, y1, y2);
    for (let i = 0; i < 9; i++) centered(String(i + 1), c[i]!, c[i + 1]!, bottom, numbers);
    for (const x of c) if (x !== c[5]) vline(x, top - 0.4, numbers);
    vline(c[5]!, mid - 0.4, numbers);
    y = numbers;
  };
  header();

  /** Значения строки: № и единица — по центру, наименование — слева, номенклатурный номер — по центру, числа — справа. */
  const cells = (values: string[], top: number) =>
    values.forEach((v, i) => {
      if (!v) return;
      const align = i === 1 ? "left" : i === 0 || i === 2 || i === 3 ? "center" : "right";
      const pad = i === 1 ? 1.5 : 2.1;
      put(v, c[i]! + (align === "left" ? pad : 1.5), c[i + 1]! - (align === "right" ? pad : 1.5), top + 0.6, {
        align,
      });
    });
  d.lines.forEach((l, i) => {
    const values = [
      String(i + 1),
      l.name,
      l.code ?? "",
      l.unit ?? "",
      z2Quantity(l.quantity),
      z2Quantity(l.quantity),
      z2Money(l.price),
      z2Money(l.sumWithVat),
      l.vat ? z2Money(l.vat) : "",
    ];
    const h = Math.max(10.8, height(l.name, c[2]! - c[1]! - 3) + 1.6);
    if (y + h + 10.8 > Z2.bottom) {
      pdf.addPage({ size: "A4", layout: "landscape", margin: 0 });
      y = 28.35;
      header();
    }
    cells(values, y);
    for (const x of c) vline(x, y - 0.4, y + h + 0.4);
    y += h;
    hline(Z2.left, Z2.right, y);
  });

  // Итого: подпись слева от колонки 5, ячейки — с колонки 5.
  const totalTop = y;
  put("Итого", c[3]!, c[4]! - 2.2, totalTop + 0.6, { align: "right" });
  cells(
    [
      "",
      "",
      "",
      "",
      z2Quantity(d.totals.quantity),
      z2Quantity(d.totals.quantity),
      "",
      z2Money(d.totals.sumWithVat),
      d.totals.vat ? z2Money(d.totals.vat) : "",
    ],
    totalTop,
  );
  put("х", c[6]!, c[7]!, totalTop + 0.6, { align: "center" });
  y = totalTop + 10.8;
  hline(c[4]! - 0.4, Z2.right, y);
  for (const x of c.slice(4)) vline(x, totalTop - 0.4, y + 0.4);

  // Прописью.
  if (y + 145 > Z2.bottom + 25) {
    pdf.addPage({ size: "A4", layout: "landscape", margin: 0 });
    y = 28.35;
  }
  const words = y + 11.4;
  put("Всего отпущено количество запасов (прописью)", 30.1, 230, words);
  put(d.quantityWords, 232.3, 356.4, words, { font: "i" });
  hline(230.4, 356.4, words + 10.2);
  put(`на сумму (прописью), в ${cur}`, 368.6, 487, words);
  put(d.amountWords, 489.6, 771.2, words, { font: "i" });
  hline(487.7, 771.2, words + 10.2);

  // Подписи: слева — отпуск разрешил, главный бухгалтер, М.П., отпустил; справа — доверенность и «Запасы получил».
  const a = words + 10.2;
  const caption = (t: string, x1: number, x2: number, yy: number) =>
    put(t, x1, x2, yy, { font: "i", align: "center" });
  /** Расшифровка над чертой: переносится вверх, последняя строка — на уровне подписи строки. */
  const above = (t: string, x1: number, x2: number, baseY: number) => {
    if (!t) return;
    const h = height(t, x2 - x1);
    put(t, x1, x2, baseY + Z2.pitch - h, { align: "center" });
  };
  const signLine = (label: string, top: number, value: string, position?: string) => {
    put(label, 30.1, 112, top);
    const lineY = top + 10.2;
    if (position !== undefined) {
      above(position, 112.2, 190.9, top);
      hline(112.2, 190.9, lineY);
      caption("должность", 112.2, 190.9, lineY + 0.6);
      put("/", 193.8, 199, top);
      hline(199.0, 277.7, lineY);
      caption("подпись", 199.0, 277.7, lineY + 0.6);
      put("/", 280.4, 285.5, top);
      above(value, 285.5, 388.0, top);
      hline(285.5, 388.0, lineY);
      caption("расшифровка подписи", 285.5, 388.0, lineY + 0.6);
    } else {
      hline(112.2, 190.9, lineY);
      caption("подпись", 112.2, 190.9, lineY + 0.6);
      put("/", 193.8, 199, top);
      above(value, 199.0, 356.4, top);
      hline(199.0, 356.4, lineY);
      caption("расшифровка подписи", 199.0, 356.4, lineY + 0.6);
    }
  };
  signLine("Отпуск разрешил", a + 20.6, d.permittedBy?.name ?? "", d.permittedBy?.position ?? "");
  signLine("Главный бухгалтер", a + 61.1, d.chiefAccountant ?? "");
  put("М.П.", 30.2, 112, a + 82.7, { font: "b" });
  signLine("Отпустил", a + 101.5, d.releasedBy ?? "");

  put("По доверенности", 421.3, 505, a + 20.6);
  put(
    d.powerOfAttorney ?? '№_____________ от "____"_____________________ 20___ года',
    505.3,
    771.2,
    a + 20.6,
  );
  put("выданной", 421.3, 471, a + 42.2);
  if (d.powerOfAttorneyPerson) put(d.powerOfAttorneyPerson, 473.5, 755.4, a + 42.2);
  hline(472.0, 755.4, a + 52.4);
  if (d.powerOfAttorneyIssuedBy) put(d.powerOfAttorneyIssuedBy, 420.9, 755.4, a + 61.1);
  hline(419.4, 755.4, a + 71.3);
  put("Запасы получил", 421.3, 503, a + 101.5);
  hline(503.4, 589.9, a + 111.7);
  caption("подпись", 503.4, 589.9, a + 112.3);
  put("/", 592.8, 598, a + 101.5);
  hline(598.0, 755.4, a + 111.7);
  caption("расшифровка подписи", 598.0, 755.4, a + 112.3);
  vline(404.1, a + 10.4, a + 122.9);
  return s.end();
}
