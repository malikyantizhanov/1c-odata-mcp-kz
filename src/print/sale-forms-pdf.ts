import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { money, quantity } from "./invoice-pdf.js";

/**
 * Первичные документы реализации по формам приказа Министра финансов РК от 20.12.2012 № 562
 * (https://adilet.zan.kz/rus/docs/V1200008265):
 *  - Р-1 «Акт выполненных работ (оказанных услуг)» — приложение 50 (ред. приказа № 458 от 27.10.2014);
 *  - З-2 «Накладная на отпуск запасов на сторону» — приложение 26 (ред. приказа № 402 от 19.08.2013).
 * Раскладка повторяет общие макеты 1С:Бухгалтерии для Казахстана ПФ_MXL_Р1 / ПФ_MXL_З2 (сетка 49 колонок с
 * шириной колонок из макета, области «Шапка», «ЗаголовокТаблицы», «СтрокаТаблицы», «Итого», «Подвал»), значения — по
 * правилам процедур ПечатьР1 / ПечатьЗ2 модуля менеджера документа «Реализация товаров и услуг». Обе формы — A4
 * альбомная, поля 10 мм (параметры печати макета ПФ_MXL_З2: Landscape, поля 1000 = 10 мм; сетка ПФ_MXL_Р1 той же
 * ширины — 1144 против 1132 единиц у З-2 — рассчитана на альбомный лист). Шрифты — как в макетах: 8 pt, наименования
 * сторон 9 pt полужирный, заголовок 10 pt. Печать 1С через OData не вызвать — это её повторение по данным документа.
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
  /** Представление договора (Р-1 1С: «Договор (контракт) [ДоговорКонтрагента]»). */
  contract?: string | undefined;
  variant: ActVariant;
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

export function renderActR1Pdf(d: ActR1Data): Promise<Buffer> {
  const s = new Sheet(
    R1_WIDTHS,
    `Акт выполненных работ (оказанных услуг) № ${d.number} от ${shortDate(d.date)}`,
  );
  s.appendix(50, "Форма Р-1");

  // Стороны (область «Шапка»): подпись слева (колонки 0–4), наименование 4–36 с чертой и пояснением, ИИН/БИН 42–49.
  s.text("ИИН/БИН", 42, 49, s.y, 11, { align: "center", size: 9 });
  s.y += 11;
  const party = (label: string, p: PrintParty) => {
    const start = s.y;
    const h = s.field(p.name, 4, 36, "полное наименование, адрес, данные о средствах связи", {
      font: "b",
      size: 9,
      align: "center",
    });
    s.text(label, 0, 4, start, h - 9, { size: 8, valign: "bottom", pad: 0 });
    s.box(42, 49, start + h - 9 - 14, 14);
    s.text(p.idNumber ?? "", 42, 49, start + h - 9 - 14, 14, { align: "center", size: 9, font: "b" });
    s.y = start + h + 4;
  };
  party("Заказчик", d.customer);
  party("Исполнитель", d.executor);
  s.y += 4;

  // Договор (0–5 / 5–29), справа таблица «Номер документа» 33–38 и «Дата составления» 38–42; под договором — заголовок.
  const top = s.y;
  s.box(33, 38, top, 22);
  s.box(38, 42, top, 22);
  s.text("Номер документа", 33, 38, top, 22, { align: "center", size: 8 });
  s.text("Дата составления", 38, 42, top, 22, { align: "center", size: 8 });
  s.box(33, 38, top + 22, 15, 1);
  s.box(38, 42, top + 22, 15, 1);
  s.text(d.number, 33, 38, top + 22, 15, { align: "center", size: 8, font: "b" });
  s.text(shortDate(d.date), 38, 42, top + 22, 15, { align: "center", size: 8, font: "b" });
  s.y = top;
  const ch = s.field(d.contract ?? "", 5, 29);
  s.text("Договор (контракт)", 0, 5, top, ch, { size: 8, valign: "bottom", pad: 0 });
  s.text("АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)", 0, 33, top + 22, 15, {
    size: 10,
    font: "b",
    align: "center",
  });
  s.y = top + 22 + 15 + 12;

  // Таблица: границы колонок — как в областях ЗаголовокТаблицы* макета ПФ_MXL_Р1.
  const name =
    "Наименование работ (услуг) (в разрезе их подвидов в соответствии с технической спецификацией, " +
    "заданием, графиком выполнения работ (услуг) при их наличии)";
  const report =
    "Сведения об отчете о научных исследованиях, маркетинговых, консультационных и прочих услугах " +
    "(дата, номер, количество страниц) (при их наличии)";
  const cur = d.currency;
  const layout =
    d.variant === "vatOnTop"
      ? {
          b: [0, 2, 10, 14, 23, 26, 30, 34, 39, 44, 49],
          extra: [`сумма НДС, в ${cur}`, `сумма с НДС, в ${cur}`],
        }
      : d.variant === "vatIncluded"
        ? { b: [0, 2, 14, 18, 28, 31, 35, 39, 44, 49], extra: [`в том числе НДС, в ${cur}`] }
        : { b: [0, 2, 15, 20, 29, 32, 37, 43, 49], extra: [] as string[] };
  const b = layout.b;
  const n = b.length - 1;
  const header = () => {
    const head = [
      { c1: b[0]!, c2: b[1]!, r1: 0, r2: 2, text: "Номер по порядку" },
      { c1: b[1]!, c2: b[2]!, r1: 0, r2: 2, text: name },
      { c1: b[2]!, c2: b[3]!, r1: 0, r2: 2, text: "Дата выполнения работ (оказания услуг)" },
      { c1: b[3]!, c2: b[4]!, r1: 0, r2: 2, text: report },
      { c1: b[4]!, c2: b[5]!, r1: 0, r2: 2, text: "Единица измерения" },
      { c1: b[5]!, c2: b[n]!, r1: 0, r2: 1, text: "Выполнено работ (оказано услуг)" },
      { c1: b[5]!, c2: b[6]!, r1: 1, r2: 2, text: "количество" },
      { c1: b[6]!, c2: b[7]!, r1: 1, r2: 2, text: "цена за единицу" },
      { c1: b[7]!, c2: b[8]!, r1: 1, r2: 2, text: "стоимость" },
      ...layout.extra.map((t, i) => ({ c1: b[8 + i]!, c2: b[9 + i]!, r1: 1, r2: 2, text: t })),
      ...b.slice(0, n).map((c, i) => ({ c1: c, c2: b[i + 1]!, r1: 2, r2: 3, text: String(i + 1) })),
    ];
    drawHeader(s, head, [14, 14, 11]);
  };
  header();
  d.lines.forEach((l, i) => {
    const values = [
      String(i + 1),
      l.name,
      "",
      "",
      l.unit ?? "",
      qty(l.quantity),
      num(l.price),
      num(l.sum),
      ...(d.variant === "vatOnTop"
        ? [num(l.vat), num(l.sumWithVat)]
        : d.variant === "vatIncluded"
          ? [num(l.vat)]
          : []),
    ];
    // Очень длинное наименование: строка должна поместиться на страницу под шапкой — шрифт мельче (до 5 pt),
    // а сверх этого текст обрезается с «…» (иначе он ушёл бы за край листа).
    const limit = (s.bottom - s.top) * 0.7;
    let size = 8;
    let h = s.row(b, values, { size, minH: 13 });
    while (h > limit && size > 5) h = s.row(b, values, { size: (size -= 0.5), minH: 13 });
    if (h > limit) {
      const w = s.x(b[2]!) - s.x(b[1]!) - 3;
      let text = values[1]!;
      while (text.length > 1 && s.height(`${text}…`, w, "r", size) + 3 > limit)
        text = text.slice(0, Math.floor(text.length * 0.95));
      values[1] = `${text}…`;
      h = s.row(b, values, { size, minH: 13 });
    }
    s.ensure(h, header);
    values.forEach((v, j) => {
      s.box(b[j]!, b[j + 1]!, s.y, h);
      s.text(v, b[j]!, b[j + 1]!, s.y, h, {
        align: j === 0 || j === 4 ? "center" : j >= 5 ? "right" : "left",
        size,
      });
    });
    s.y += h;
  });
  // Итого: «Итого» перед колонкой количества, «х» в цене, суммы.
  s.ensure(14);
  s.text("Итого", b[3]!, b[5]!, s.y, 14, { align: "right", font: "b", size: 8 });
  const totals = [
    qty(d.totals.quantity),
    "х",
    num(d.totals.sum),
    ...(d.variant === "vatOnTop"
      ? [num(d.totals.vat), num(d.totals.sumWithVat)]
      : d.variant === "vatIncluded"
        ? [num(d.totals.vat)]
        : []),
  ];
  totals.forEach((v, j) => {
    s.box(b[5 + j]!, b[6 + j]!, s.y, 14);
    s.text(v, b[5 + j]!, b[6 + j]!, s.y, 14, { align: j === 1 ? "center" : "right", font: "b", size: 8 });
  });
  s.y += 14 + 12;

  // Запасы заказчика (0–16 / 16–49) и перечень документации (область «Запасы»).
  s.ensure(75);
  const stockTop = s.y;
  const sh = s.field("", 16, 49, "наименование, количество, стоимость");
  s.text("Сведения об использовании запасов, полученных от заказчика", 0, 16, stockTop, sh - 9, {
    pad: 0,
    valign: "bottom",
    size: 8,
  });
  s.y = stockTop + sh + 6;
  const appendixText =
    "Приложение: Перечень документации, в том числе отчет(ы) о маркетинговых, научных исследованиях, " +
    "консультационных и прочих услугах (обязательны при его (их) наличии) на _____________ страниц";
  const ah = s.height(appendixText, s.x(49) - s.x(0), "r", 8);
  s.text(appendixText, 0, 49, s.y, ah, { pad: 0, valign: "top", size: 8 });
  s.y += ah + 2;
  if (d.documentation) s.y += s.field(d.documentation, 14, 49) + 2;
  s.y += 14;

  // Подписи (область «Подвал»): «Сдал (Исполнитель)» 0–5, должность 5–10, подпись 11–16, расшифровка 17–24;
  // «Принял (Заказчик)» 26–31, должность 31–36, подпись 37–42, расшифровка 43–49.
  const sideH = (signer?: Signer) =>
    Math.max(
      12,
      s.height(signer?.position ?? "", s.x(10) - s.x(5) - 3, "r", 8) + 3,
      s.height(signer?.name ?? "", s.x(24) - s.x(17) - 3, "r", 8) + 3,
    );
  const lineH = Math.max(sideH(d.executorSigner), 12);
  s.ensure(lineH + 9 + 60);
  const sigTop = s.y;
  const signature = (label: string, cols: [number, number, number, number, number], signer?: Signer) => {
    const [l, p, sg, nm, end] = cols;
    s.text(label, l, p, sigTop, lineH, { pad: 0, valign: "bottom", size: 8 });
    const parts: Array<[number, number, string, string]> = [
      [p, sg - 1, signer?.position ?? "", "должность"],
      [sg, nm - 1, "", "подпись"],
      [nm, end, signer?.name ?? "", "расшифровка подписи"],
    ];
    for (const [a1, z1, v, cap] of parts) {
      s.text(v, a1, z1, sigTop, lineH, { align: "center", valign: "bottom", size: 8 });
      s.hline(a1, z1, sigTop + lineH);
      s.text(cap, a1, z1, sigTop + lineH, 9, { size: 6.5, font: "i", align: "center", pad: 0 });
    }
    s.text("/", sg - 1, sg, sigTop, lineH, { align: "center", valign: "bottom", pad: 0, size: 8 });
    s.text("/", nm - 1, nm, sigTop, lineH, { align: "center", valign: "bottom", pad: 0, size: 8 });
  };
  signature("Сдал (Исполнитель)", [0, 5, 11, 17, 24], d.executorSigner);
  signature("Принял (Заказчик)", [26, 31, 37, 43, 49]);
  s.y = sigTop + lineH + 9 + 12;
  s.text("М.П.", 1, 5, s.y, 12, { pad: 0, font: "b", size: 8 });
  s.text("Дата подписания (принятия) работ (услуг)", 26, 37, s.y, 12, { pad: 0, valign: "bottom", size: 8 });
  s.text(shortDate(d.acceptedDate), 37, 43, s.y, 12, { align: "center", valign: "bottom", size: 8 });
  s.hline(37, 43, s.y + 12);
  s.y += 24;
  s.text("М.П.", 27, 31, s.y, 12, { pad: 0, font: "b", size: 8 });
  return s.end();
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
  s.text(shortDate(d.date), 45, 49, s.y, 13, { align: "center", font: "b", size: 8 });
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
  s.text("М.П.", 0, 4, s.y, 10, { pad: 0 });
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
