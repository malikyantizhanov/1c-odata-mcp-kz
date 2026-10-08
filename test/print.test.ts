import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { amountInWords, numberToWords } from "../src/print/amount-words.js";
import { dateWords, money, partyText, quantity, renderInvoicePdf } from "../src/print/invoice-pdf.js";
import { bankTitle, invoicePrintData } from "../src/tools/print.js";

/**
 * Печать счёта на оплату (Казахстан): форматы как в печатной форме 1С, PDF и сбор данных документа.
 * Сетка макета сверена с PDF, который сформировала 1С: все строки текста совпадают в пределах 1,2 pt.
 */
type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

describe("сумма прописью", () => {
  it.each([
    [0, "ноль"],
    [1, "один"],
    [12, "двенадцать"],
    [1001, "одна тысяча один"],
    [2000, "две тысячи"],
    [5000, "пять тысяч"],
    [11000000, "одиннадцать миллионов"],
    [1550000, "один миллион пятьсот пятьдесят тысяч"],
  ])("%d → %s", (n, words) => expect(numberToWords(n)).toBe(words));

  it("тенге и тиын", () => {
    expect(amountInWords(15000)).toBe("Пятнадцать тысяч тенге 00 тиын");
    expect(amountInWords(1229600.5)).toBe("Один миллион двести двадцать девять тысяч шестьсот тенге 50 тиын");
  });
});

describe("форматы печатной формы 1С", () => {
  it("суммы, количество, дата, стороны и банк — как печатает 1С", () => {
    expect(money(1550000)).toBe("1 550 000,00");
    expect(quantity(1)).toBe("1,000");
    expect(quantity(2.5)).toBe("2,500");
    expect(dateWords("2026-10-07")).toBe("7 октября 2026 г.");
    expect(partyText("ТОО Mybuh.kz", "170240009787")).toBe(" БИН / ИИН 170240009787,ТОО Mybuh.kz");
    expect(partyText("Иванов И.И.")).toBe("Иванов И.И.");
    expect(bankTitle('АО "Народный Банк Казахстана"', "г. Алматы")).toBe(
      'АО "Народный Банк Казахстана" г. г. Алматы',
    );
  });
});

describe("PDF счёта", () => {
  it("строится PDF, длинный список переносится на следующую страницу", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      name: `Позиция ${i + 1}`,
      quantity: 1,
      price: 100,
      sum: 100,
    }));
    const pdf = await renderInvoicePdf({
      number: "1",
      date: "2026-10-07",
      supplier: { name: "ИП Тест", bin: "123123123123" },
      buyer: { name: "ТОО Покупатель" },
      lines,
      withVat: true,
      vatIncluded: false,
      vatSum: 1280,
      total: 9280,
      currency: "KZT",
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });

  it("инструмент собирает документ, банк и единицы из 1С и отдаёт PDF ресурсом", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
    const entities: Record<string, Record<string, unknown>> = {
      Document_СчетНаОплатуПокупателю: {
        Number: "00000000007",
        Date: "2026-10-07T10:00:00",
        Организация_Key: id(2),
        Контрагент_Key: id(3),
        СтруктурнаяЕдиница: id(8),
        СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
        УчитыватьНДС: false,
        СуммаВключаетНДС: false,
        СуммаДокумента: 15300,
        Товары: [
          {
            Номенклатура_Key: id(4),
            ЕдиницаИзмерения_Key: id(6),
            Количество: 3,
            Цена: 100,
            Сумма: 300,
            СуммаНДС: 0,
          },
        ],
        Услуги: [
          {
            Номенклатура_Key: id(5),
            Содержание: "Консультация за октябрь",
            Количество: 1,
            Цена: 15000,
            Сумма: 15000,
            СуммаНДС: 0,
          },
        ],
      },
      Catalog_Организации: {
        НаименованиеПолное: "ИП Тест",
        ИдентификационныйНомер: "123123123123",
        КБЕ: "19",
      },
      Catalog_Контрагенты: { Description: "ТОО Покупатель", ИдентификационныйКодЛичности: "990140000001" },
      Catalog_БанковскиеСчета: { НомерСчета: "KZ86125KZT1004100100", Банк_Key: id(9) },
      Catalog_Банки: { Description: 'АО "Банк ЦентрКредит"', БИК: "KCJBKZKX", Город: "г. Алматы" },
    };
    const collections: Record<string, Array<Record<string, unknown>>> = {
      Catalog_Номенклатура: [
        { Ref_Key: id(4), Code: "001", Description: "Товар" },
        { Ref_Key: id(5), Code: "002", Description: "Консультация", БазоваяЕдиницаИзмерения_Key: id(7) },
      ],
      Catalog_КлассификаторЕдиницИзмерения: [
        { Ref_Key: id(6), Description: "шт" },
        { Ref_Key: id(7), Description: "ч" },
      ],
    };
    const seen: string[] = [];
    const conn = {
      cfg: { name: "default" },
      behavior: { pageSize: 100, maxRows: 1000 },
      getMetadata: async () => ({ entities: new Map([["ChartOfAccounts_Типовой", { properties: [] }]]) }),
      available: async () => new Set(["Document_СчетНаОплатуПокупателю", ...Object.keys(collections)]),
      client: {
        getEntity: async (path: string) => {
          seen.push(path);
          return entities[Object.keys(entities).find((k) => path.startsWith(`${k}(`)) ?? ""] ?? {};
        },
        getCollection: async (path: string) => ({
          value: collections[Object.keys(collections).find((k) => path.startsWith(k)) ?? ""] ?? [],
        }),
      },
    };
    const res = await toolsOf(conn)["read.document.print_invoice"]!.handler(
      { database: "default", ref: id(1) },
      {},
    );
    expect(res.structuredContent).toMatchObject({
      name: "Счет на оплату покупателю № 7 от 07.10.2026.pdf",
      mimeType: "application/pdf",
      total: 15300,
    });
    expect(res.structuredContent).not.toHaveProperty("note");
    expect(seen.some((p) => p.startsWith(`Catalog_БанковскиеСчета(guid'${id(8)}')`))).toBe(true);
    const resource = res.content.find((c) => c.type === "resource") as { resource: { blob: string } };
    expect(Buffer.from(resource.resource.blob, "base64").subarray(0, 4).toString()).toBe("%PDF");

    const data = await invoicePrintData(conn as never, id(1));
    expect(data.bank).toEqual({
      iik: "KZ86125KZT1004100100",
      bankName: 'АО "Банк ЦентрКредит" г. г. Алматы',
      bik: "KCJBKZKX",
    });
    expect(data.supplier).toEqual({ name: "ИП Тест", bin: "123123123123", kbe: "19" });
    expect(data.lines.map((l) => [l.code, l.name, l.unit])).toEqual([
      ["001", "Товар", "шт"],
      ["002", "Консультация за октябрь", "ч"],
    ]);
  });
});
