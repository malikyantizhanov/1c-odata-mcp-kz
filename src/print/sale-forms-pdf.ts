import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { money, quantity } from "./invoice-pdf.js";

/**
 * Первичные документы реализации по формам приказа Министра финансов РК от 20.12.2012 № 562
 * (https://adilet.zan.kz/rus/docs/V1200008265):
 *  - Р-1 «Акт выполненных работ (оказанных услуг)» — приложение 50 (ред. приказа № 458 от 27.10.2014);
 *  - З-2 «Накладная на отпуск запасов на сторону» — приложение 26 (ред. приказа № 402 от 19.08.2013).
 * Раскладка повторяет общие макеты 1С:Бухгалтерии для Казахстана ПФ_MXL_Р1 / ПФ_MXL_З2 (сетка 49 колонок, области
 * «Шапка», «ЗаголовокТаблицы», «СтрокаТаблицы», «Итого», «Подвал»), значения — по правилам процедур ПечатьР1 /
 * ПечатьЗ2 модуля менеджера документа «Реализация товаров и услуг». Печать 1С через OData не вызвать — это её
 * повторение по данным документа.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve("@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf");
const FONT_BOLD = require.resolve("@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf");

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

type Font = "r" | "b";
interface TextOpts {
  font?: Font;
  size?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  pad?: number;
}

/** Лист с сеткой из 49 равных колонок, как у макетов 1С. */
class Sheet {
  readonly pdf: PDFKit.PDFDocument;
  readonly chunks: Buffer[] = [];
  readonly done: Promise<Buffer>;
  readonly col: number;
  y: number;

  constructor(
    readonly layout: "portrait" | "landscape",
    readonly left: number,
    readonly right: number,
    readonly top: number,
    readonly bottom: number,
    title: string,
  ) {
    this.pdf = new PDFDocument({ size: "A4", layout, margin: 0, info: { Title: title } });
    this.pdf.registerFont("r", FONT);
    this.pdf.registerFont("b", FONT_BOLD);
    this.pdf.on("data", (c: Buffer) => this.chunks.push(c));
    this.done = new Promise<Buffer>((res) => this.pdf.on("end", () => res(Buffer.concat(this.chunks))));
    this.col = (right - left) / 49;
    this.y = top;
  }

  x(col: number): number {
    return this.left + col * this.col;
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

  ensure(h: number, onNewPage?: () => void): void {
    if (this.y + h <= this.bottom) return;
    this.pdf.addPage({ size: "A4", layout: this.layout, margin: 0 });
    this.y = this.top;
    onNewPage?.();
  }

  /** Блок «Приложение N к приказу …» справа и «Форма X» под ним. */
  appendix(n: number, form: string): void {
    const lines = [
      `Приложение ${n}`,
      "к приказу Министра финансов",
      "Республики Казахстан",
      "от 20 декабря 2012 года № 562",
    ];
    lines.forEach((l, i) => this.text(l, 37, 49, this.y + i * 9, 9, { size: 7, pad: 0 }));
    this.y += lines.length * 9 + 4;
    this.text(form, 37, 49, this.y, 10, { size: 8, font: "b", align: "right", pad: 0 });
    this.y += 14;
  }

  /** Подчёркнутое поле со значением и подписью под чертой мелким шрифтом. */
  field(value: string, c1: number, c2: number, caption?: string, o: TextOpts = {}): number {
    const w = this.x(c2) - this.x(c1) - 3;
    const h = Math.max(10, this.height(value, w, o.font ?? "r", o.size ?? 7) + 2);
    this.text(value, c1, c2, this.y, h, { ...o, valign: "bottom", pad: 1.5 });
    this.hline(c1, c2, this.y + h);
    if (caption) this.text(caption, c1, c2, this.y + h, 8, { size: 5.5, align: "center", pad: 0 });
    return h + (caption ? 8 : 0);
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
): void {
  const top = s.y;
  const ys = [top];
  rows.forEach((h) => ys.push(ys[ys.length - 1]! + h));
  for (const c of head) {
    const y = ys[c.r1]!;
    const h = ys[c.r2]! - y;
    s.box(c.c1, c.c2, y, h);
    // Узкие колонки (№ п/п, единица) — мельче, чтобы слова не рвались посередине.
    const narrow = c.c2 - c.c1 <= 3;
    s.text(c.text, c.c1, c.c2, y, h, { align: "center", size: narrow ? 5 : 6, pad: narrow ? 0.5 : 1 });
  }
  s.y = ys[ys.length - 1]!;
}

export function renderActR1Pdf(d: ActR1Data): Promise<Buffer> {
  const s = new Sheet(
    "portrait",
    28,
    567,
    28,
    814,
    `Акт выполненных работ (оказанных услуг) № ${d.number} от ${shortDate(d.date)}`,
  );
  s.appendix(50, "Форма Р-1");

  // Стороны и ИИН/БИН справа.
  s.text("ИИН/БИН", 42, 49, s.y, 10, { align: "center", size: 7 });
  s.y += 10;
  const party = (label: string, p: PrintParty) => {
    const start = s.y;
    s.text(label, 0, 4, s.y, 10, { size: 7, valign: "bottom", pad: 0 });
    const h = s.field(p.name, 4, 41, "полное наименование, адрес, данные о средствах связи");
    s.box(42, 49, start, 12);
    s.text(p.idNumber ?? "", 42, 49, start, 12, { align: "center", size: 7.5 });
    s.y = start + Math.max(h, 20) + 3;
  };
  party("Заказчик", d.customer);
  party("Исполнитель", d.executor);

  // Договор, номер и дата документа (область «Шапка» макета: договор слева, справа — номер и дата).
  const top = s.y;
  s.text("Договор (контракт)", 0, 6, top + 6, 10, { size: 7, valign: "bottom", pad: 0 });
  s.y = top + 6;
  s.field(d.contract ?? "", 6, 31);
  s.box(33, 38, top, 18);
  s.box(38, 43, top, 18);
  s.text("Номер документа", 33, 38, top, 18, { align: "center", size: 6.5 });
  s.text("Дата составления", 38, 43, top, 18, { align: "center", size: 6.5 });
  s.box(33, 38, top + 18, 13, 1);
  s.box(38, 43, top + 18, 13, 1);
  s.text(d.number, 33, 38, top + 18, 13, { align: "center", size: 8, font: "b" });
  s.text(shortDate(d.date), 38, 43, top + 18, 13, { align: "center", size: 8, font: "b" });
  s.text("АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)", 0, 33, top + 24, 13, { size: 9, font: "b", pad: 0 });
  s.y = top + 18 + 13 + 10;

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
    drawHeader(s, head, [16, 50, 10]);
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
    const h = s.row(b, values);
    s.ensure(h, header);
    values.forEach((v, j) => {
      s.box(b[j]!, b[j + 1]!, s.y, h);
      s.text(v, b[j]!, b[j + 1]!, s.y, h, {
        align: j === 0 || j === 4 ? "center" : j >= 5 ? "right" : "left",
        size: 6.5,
      });
    });
    s.y += h;
  });
  // Итого: «Итого» перед колонкой количества, «х» в цене, суммы.
  s.ensure(12);
  s.text("Итого", b[3]!, b[5]!, s.y, 12, { align: "right", font: "b" });
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
    s.box(b[5 + j]!, b[6 + j]!, s.y, 12);
    s.text(v, b[5 + j]!, b[6 + j]!, s.y, 12, { align: j === 1 ? "center" : "right", font: "b" });
  });
  s.y += 12 + 12;

  // Запасы заказчика и перечень документации.
  s.ensure(70);
  s.text("Сведения об использовании запасов, полученных от заказчика", 0, 16, s.y, 10, {
    pad: 0,
    valign: "bottom",
  });
  s.y += s.field("", 16, 49, "наименование, количество, стоимость") + 6;
  s.text(
    "Приложение: Перечень документации, в том числе отчет(ы) о маркетинговых, научных исследованиях, " +
      "консультационных и прочих услугах (обязательны при его (их) наличии) на _____________ страниц",
    0,
    49,
    s.y,
    20,
    { pad: 0, valign: "top" },
  );
  s.y += 20;
  if (d.documentation) {
    s.text(d.documentation, 0, 49, s.y, 10, { pad: 0 });
    s.y += 12;
  }
  s.y += 10;

  // Подписи: «Сдал (Исполнитель)» слева, «Принял (Заказчик)» справа (область «Подвал»).
  s.ensure(80);
  const sigTop = s.y;
  const signature = (label: string, c: number, signer?: Signer) => {
    s.text(label, c, c + 22, sigTop, 10, { pad: 0, valign: "bottom", size: 7 });
    const y = sigTop + 18;
    const parts: Array<[number, number, string, string]> = [
      [c, c + 8, signer?.position ?? "", "должность"],
      [c + 9, c + 14, "", "подпись"],
      [c + 15, c + 23, signer?.name ?? "", "расшифровка подписи"],
    ];
    for (const [a1, z1, v, cap] of parts) {
      s.text(v, a1, z1, y, 12, { align: "center", valign: "bottom", size: 6.5 });
      s.hline(a1, z1, y + 12);
      s.text(cap, a1, z1, y + 12, 8, { size: 5.5, align: "center", pad: 0 });
    }
    s.text("/", c + 8, c + 9, y, 12, { align: "center", valign: "bottom", pad: 0 });
    s.text("/", c + 14, c + 15, y, 12, { align: "center", valign: "bottom", pad: 0 });
  };
  signature("Сдал (Исполнитель)", 0, d.executorSigner);
  signature("Принял (Заказчик)", 26);
  s.y = sigTop + 44;
  s.text("М.П.", 1, 5, s.y, 10, { pad: 0 });
  s.text("Дата подписания (принятия) работ (услуг)", 26, 37, s.y, 20, { pad: 0, valign: "top" });
  s.text(shortDate(d.acceptedDate), 37, 44, s.y, 10, { align: "center", valign: "bottom" });
  s.hline(37, 44, s.y + 10);
  s.y += 22;
  s.text("М.П.", 27, 31, s.y, 10, { pad: 0 });
  return s.end();
}

export function renderWaybillZ2Pdf(d: WaybillZ2Data): Promise<Buffer> {
  const s = new Sheet(
    "landscape",
    28,
    814,
    24,
    571,
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
