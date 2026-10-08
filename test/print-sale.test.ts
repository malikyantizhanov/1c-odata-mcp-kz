import { describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { quantityInWords } from "../src/print/amount-words.js";
import { renderActR1Pdf, renderWaybillZ2Pdf } from "../src/print/sale-forms-pdf.js";
import { salePrintData, shortFio } from "../src/tools/print-sale.js";
import {
  BUYER,
  CONTRACT,
  KZT,
  ORG,
  SERVICE,
  UNIT,
  baseStore,
  fake1C,
  id,
  type Store,
} from "./support/fake-1c.js";

/** read.document.print_sale: данные Р-1 / З-2 по правилам печатных форм 1С и PDF на диске. */

const SALE = id(40);
const PERSON = id(51);
const USER = id(50);
const EMPLOYEE_PERSON = id(53);
const POSITION = id(54);
const GOODS = id(70);
const BOX = id(72);

function store(): Store {
  const s = baseStore();
  Object.assign(s["Catalog_Организации"]![0]!, { ИндивидуальныйПредприниматель_Key: PERSON });
  s["Catalog_Номенклатура"]!.push({
    Ref_Key: GOODS,
    Code: "00000000020",
    Description: "Кабель",
    НаименованиеПолное: "Кабель UTP cat.6",
    БазоваяЕдиницаИзмерения_Key: UNIT,
  });
  s["Catalog_КлассификаторЕдиницИзмерения"]!.push({ Ref_Key: BOX, Code: "778", Description: "упак" });
  s["Catalog_Пользователи"] = [{ Ref_Key: USER, Description: "Автоматический REST-сервис" }];
  s["Catalog_ФизическиеЛица"] = [
    { Ref_Key: PERSON, Description: "Жумабекова Алина Ерлановна" },
    { Ref_Key: EMPLOYEE_PERSON, Description: "Иванов Пётр Сергеевич" },
  ];
  s["Catalog_СотрудникиОрганизаций"] = [
    {
      Ref_Key: id(55),
      Физлицо_Key: EMPLOYEE_PERSON,
      Организация_Key: ORG,
      ТекущаяДолжностьОрганизации_Key: POSITION,
      Актуальность: true,
      DeletionMark: false,
    },
  ];
  s["Catalog_ДолжностиОрганизаций"] = [{ Ref_Key: POSITION, Description: "Менеджер по продажам" }];
  s["Document_РеализацияТоваровУслуг"] = [
    {
      Ref_Key: SALE,
      Number: "00000000018",
      Date: "2026-10-08T15:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      Ответственный_Key: USER,
      УчитыватьНДС: false,
      СуммаВключаетНДС: true,
      ДатаПодписанияГЗ: "2026-10-08T00:00:00",
      СуммаДокумента: 1000000,
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Содержание: "",
          Количество: 1,
          Цена: 400000,
          Сумма: 400000,
          СуммаНДС: 0,
        },
        {
          LineNumber: 2,
          Номенклатура_Key: SERVICE,
          Содержание: "",
          Количество: 1,
          Цена: 400000,
          Сумма: 400000,
          СуммаНДС: 0,
        },
        {
          LineNumber: 3,
          Номенклатура_Key: SERVICE,
          Содержание: "Доработка",
          Количество: 1,
          Цена: 200000,
          Сумма: 200000,
          СуммаНДС: 0,
        },
      ],
      Товары: [],
    },
  ];
  return s;
}

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const errText = (r: CallToolResult) => JSON.stringify(r.content);

describe("print_sale: помощники", () => {
  it("ФИО кратко и количество прописью (женский род для дробей и тысяч)", () => {
    expect(shortFio("Жумабекова Алина Ерлановна")).toBe("Жумабекова А. Е.");
    expect(shortFio("Admin")).toBe("Admin");
    expect(quantityInWords(1)).toBe("Один");
    expect(quantityInWords(21)).toBe("Двадцать один");
    expect(quantityInWords(1.5)).toBe("Одна целая пять десятых");
    expect(quantityInWords(1000)).toBe("Одна тысяча");
  });
});

describe("print_sale: данные форм", () => {
  it("Р-1: строки сгруппированы, наименование — содержание или полное наименование; без НДС; у ИП без физлица — ИП", async () => {
    const f = fake1C({ store: store() });
    const d = await salePrintData(f.conn, SALE);
    expect(d).toMatchObject({ number: "18", date: "2026-10-08", total: 1000000 });
    expect(d.waybill).toBeUndefined();
    expect(d.act).toMatchObject({
      variant: "plain",
      contract: "Договор б/н",
      acceptedDate: "2026-10-08",
      executor: { name: "ИП Aru Market", idNumber: "123123123123" },
      customer: { idNumber: "240440007327" },
      executorSigner: { name: "Жумабекова А. Е.", position: "Индивидуальный предприниматель" },
      totals: { quantity: 3, sum: 1000000, sumWithVat: 1000000 },
    });
    expect(d.act!.lines.map((l) => [l.name, l.quantity, l.sum, l.unit])).toEqual([
      ["Разработка программного обеспечения", 2, 800000, "шт"],
      ["Доработка", 1, 200000, "шт"],
    ]);
    expect(d.notes.join(" ")).toMatch(/индивидуальный предприниматель/);
  });

  it("плательщик НДС сверху — колонки НДС; ответственный с физлицом — его должность в организации", async () => {
    const s = store();
    const doc = s["Document_РеализацияТоваровУслуг"]![0]!;
    Object.assign(doc, { УчитыватьНДС: true, СуммаВключаетНДС: false });
    (doc["Услуги"] as Array<Record<string, unknown>>).forEach(
      (r) => (r["СуммаНДС"] = Number(r["Сумма"]) * 0.16),
    );
    s["Catalog_Пользователи"]![0]!["ФизЛицо_Key"] = EMPLOYEE_PERSON;
    const d = await salePrintData(fake1C({ store: s }).conn, SALE);
    expect(d.act).toMatchObject({
      variant: "vatOnTop",
      totals: { sum: 1000000, vat: 160000, sumWithVat: 1160000 },
      executorSigner: { name: "Иванов П. С.", position: "Менеджер по продажам" },
    });
  });

  it("З-2: товары по номенклатуре/единице/цене, сумма с НДС, количество и сумма прописью", async () => {
    const s = store();
    const doc = s["Document_РеализацияТоваровУслуг"]![0]!;
    Object.assign(doc, { УчитыватьНДС: true, СуммаВключаетНДС: false, Услуги: [] });
    doc["Товары"] = [
      {
        LineNumber: 1,
        Номенклатура_Key: GOODS,
        ЕдиницаИзмерения_Key: UNIT,
        Количество: 2,
        Цена: 100,
        Сумма: 200,
        СуммаНДС: 32,
      },
      {
        LineNumber: 2,
        Номенклатура_Key: GOODS,
        ЕдиницаИзмерения_Key: UNIT,
        Количество: 3,
        Цена: 100,
        Сумма: 300,
        СуммаНДС: 48,
      },
      {
        LineNumber: 3,
        Номенклатура_Key: GOODS,
        ЕдиницаИзмерения_Key: BOX,
        Количество: 1,
        Цена: 1000,
        Сумма: 1000,
        СуммаНДС: 160,
      },
    ];
    const d = await salePrintData(fake1C({ store: s }).conn, SALE);
    expect(d.act).toBeUndefined();
    expect(d.waybill!.lines.map((l) => [l.name, l.code, l.unit, l.quantity, l.sumWithVat, l.vat])).toEqual([
      ["Кабель UTP cat.6", "00000000020", "шт", 5, 580, 80],
      ["Кабель UTP cat.6", "00000000020", "упак", 1, 1160, 160],
    ]);
    expect(d.waybill).toMatchObject({
      totals: { quantity: 6, sumWithVat: 1740, vat: 240 },
      quantityWords: "Шесть",
      receiver: 'ТОО "TRADESPACE"',
    });
    expect(d.waybill!.amountWords).toMatch(/^Одна тысяча семьсот сорок/);
    expect(d.notes.join(" ")).toMatch(/главный бухгалтер/);
  });

  it("рендеры дают PDF и для длинных таблиц (перенос на новую страницу)", async () => {
    const s = store();
    const d = await salePrintData(fake1C({ store: s }).conn, SALE);
    const many = {
      ...d.act!,
      lines: Array.from({ length: 60 }, (_, i) => ({ ...d.act!.lines[0]!, name: `Услуга ${i + 1}` })),
    };
    const act = await renderActR1Pdf(many);
    expect(act.subarray(0, 4).toString()).toBe("%PDF");
    expect((act.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
    const z2 = await renderWaybillZ2Pdf({
      number: "1",
      date: "2026-10-08",
      organization: { name: "ИП Aru Market" },
      receiver: "ТОО",
      currency: "KZT",
      lines: [{ name: "Кабель", quantity: 1, price: 10, sumWithVat: 10, vat: 0 }],
      totals: { quantity: 1, sumWithVat: 10, vat: 0 },
      quantityWords: "Один",
      amountWords: "Десять тенге 00 тиын",
    });
    expect(z2.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("print_sale: инструмент", () => {
  it("по номеру: Р-1 в «акты», повтор — « (2)» без перезаписи; PDF во вложении", async () => {
    const f = fake1C({ store: store() });
    const call = (a: Record<string, unknown>) => f.call("read.document.print_sale", a);
    const first = await call({ number: "18", year: 2026 });
    expect(first.isError).toBeFalsy();
    const out = sc(first);
    expect(out).toMatchObject({ ref: SALE, number: "18", files: [{ form: "Р-1" }] });
    expect(out["path"]).toBe(
      join(f.conn.behavior.printDir!, "акты", "Акт выполненных работ Р-1 № 18 от 08.10.2026.pdf"),
    );
    expect(readFileSync(out["path"]).subarray(0, 4).toString()).toBe("%PDF");
    expect(first.content.some((c) => c.type === "resource")).toBe(true);
    const again = sc(await call({ ref: SALE }));
    expect(again["path"]).toMatch(/Р-1 № 18 от 08\.10\.2026 \(2\)\.pdf$/);
    expect(existsSync(out["path"])).toBe(true);
    expect(again["note"]).toMatch(/не перезаписан/);
  });

  it("form=waybill без товаров, выход за каталог печати, ref и number вместе — ошибки", async () => {
    const f = fake1C({ store: store() });
    const call = (a: Record<string, unknown>) => f.call("read.document.print_sale", a);
    expect(errText(await call({ ref: SALE, form: "waybill" }))).toMatch(/нет строк «Товары»/);
    expect((await call({ ref: SALE, outputDir: "../x" })).isError).toBe(true);
    expect((await call({ ref: SALE, number: "18" })).isError).toBe(true);
    expect(errText(await call({ number: "999" }))).toMatch(/не найден/);
  });
});

describe("print_sale: каталоги", () => {
  it("печатается только акт — подкаталог «накладные» не создаётся; outputDir — обе формы туда", async () => {
    const f = fake1C({ store: store() });
    const out = sc(await f.call("read.document.print_sale", { ref: SALE }));
    expect(out["path"]).toContain(join("акты", "Акт"));
    expect(existsSync(join(f.conn.behavior.printDir!, "накладные"))).toBe(false);
    const custom = sc(
      await f.call("read.document.print_sale", { ref: SALE, outputDir: "клиенты/TRADESPACE" }),
    );
    expect(custom["path"]).toBe(
      join(
        f.conn.behavior.printDir!,
        "клиенты",
        "TRADESPACE",
        "Акт выполненных работ Р-1 № 18 от 08.10.2026.pdf",
      ),
    );
  });
});

describe("print_sale: альбомный A4", () => {
  const mediaBoxes = (pdf: Buffer) =>
    [...pdf.toString("latin1").matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((m) =>
      m[1]!.trim().split(/\s+/).map(Number),
    );
  const act = (lines: Array<{ name: string }>) =>
    renderActR1Pdf({
      number: "18",
      date: "2026-10-08",
      customer: { name: 'ТОО "TRADESPACE"', idNumber: "240440007327" },
      executor: { name: 'ИП "Aru Market"', idNumber: "123123123123" },
      contract: "Договор б/н",
      variant: "vatOnTop",
      currency: "KZT",
      lines: lines.map((l) => ({
        ...l,
        unit: "шт",
        quantity: 1,
        price: 100,
        sum: 100,
        vat: 16,
        sumWithVat: 116,
      })),
      totals: {
        quantity: lines.length,
        sum: 100 * lines.length,
        vat: 16 * lines.length,
        sumWithVat: 116 * lines.length,
      },
      executorSigner: { name: "Жумабекова А. Е.", position: "Индивидуальный предприниматель" },
      acceptedDate: "2026-10-08",
    });

  it("Р-1 и З-2 — A4 альбомная (841.89 × 595.28) на каждой странице", async () => {
    const r1 = await act([{ name: "Разработка" }]);
    const z2 = await renderWaybillZ2Pdf({
      number: "1",
      date: "2026-10-08",
      organization: { name: "ИП" },
      receiver: "ТОО",
      currency: "KZT",
      lines: [{ name: "Кабель", quantity: 1, price: 10, sumWithVat: 10, vat: 0 }],
      totals: { quantity: 1, sumWithVat: 10, vat: 0 },
      quantityWords: "Один",
      amountWords: "Десять тенге 00 тиын",
    });
    for (const pdf of [r1, z2]) {
      const boxes = mediaBoxes(pdf);
      expect(boxes.length).toBeGreaterThan(0);
      for (const b of boxes) expect(b).toEqual([0, 0, 841.89, 595.28]);
    }
  });

  it("длинные наименования переносятся, таблица — на несколько страниц, текст не выходит за поля листа", async () => {
    const drawn: Array<{ x: number; y: number; w: number; h: number }> = [];
    const orig = PDFDocument.prototype.text;
    const spy = vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (
      this: PDFKit.PDFDocument,
      ...args: unknown[]
    ) {
      const [str, x, y, o] = args as [string, number, number, { width?: number }];
      if (typeof x === "number" && typeof y === "number" && o?.width)
        drawn.push({ x, y, w: o.width, h: this.heightOfString(String(str) || " ", { width: o.width }) });
      return (orig as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
    });
    try {
      const long =
        "Разработка программного обеспечения: модуль интеграции 1С с маркетплейсом, выгрузка остатков и цен, " +
        "загрузка заказов, обработка возвратов, настройка расписания обмена и обучение персонала заказчика";
      const huge = long.repeat(40);
      const pdf = await act([
        ...Array.from({ length: 30 }, (_, i) => ({ name: i % 3 ? `Услуга ${i}` : long })),
        { name: huge },
      ]);
      expect(mediaBoxes(pdf).length).toBeGreaterThan(2);
      expect(drawn.length).toBeGreaterThan(100);
      for (const t of drawn) {
        expect(t.x).toBeGreaterThanOrEqual(28);
        expect(t.x + t.w).toBeLessThanOrEqual(841.89 - 28);
        expect(t.y).toBeGreaterThanOrEqual(28);
        expect(t.y + t.h).toBeLessThanOrEqual(595.28 - 28);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
