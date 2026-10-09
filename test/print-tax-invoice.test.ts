import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { renderTaxInvoicePdf, sfQuantity } from "../src/print/tax-invoice-pdf.js";
import { accountLine, taxInvoicePrintData } from "../src/tools/print-tax-invoice.js";

/**
 * Счёт-фактура выданный (Казахстан): строки реквизитов как в печатной форме 1С (образец из 1С:Fresh.kz — счёт-фактура
 * № 2 по реализации № 16), PDF и сохранение без перезаписи.
 */
type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const roots: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "1c-sf-test-")));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SF = id(1);
const ORG = id(2);
const BUYER = id(3);
const SALE = id(4);
const GOODS = id(5);
const UNIT = id(6);
const NO_VAT = id(7);

function connection(printDir?: string) {
  const entities: Record<string, Record<string, unknown>> = {
    [`Document_СчетФактураВыданный(guid'${SF}')`]: {
      Number: "00000000002",
      Date: "2026-10-08T13:35:00",
      Поставщик_Key: ORG,
      Покупатель_Key: BUYER,
      Грузополучатель_Key: BUYER,
      ДоговорКонтрагента_Key: id(8),
      ДокументОснование: SALE,
      ДокументОснование_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
      СчетОрганизации_Key: id(9),
      ВалютаДокумента_Key: id(10),
      ДатаСовершенияОборотаПоРеализации: "2026-10-08T00:00:00",
      ДоверенностьДата: "0001-01-01T00:00:00",
      СуммаВключаетНДС: false,
      СуммаДокумента: 1000,
      Товары: [
        {
          Номенклатура_Key: GOODS,
          ЕдиницаИзмерения_Key: UNIT,
          Количество: 1,
          Цена: 1000,
          Сумма: 1000,
          СтавкаНДС_Key: NO_VAT,
          СуммаНДС: 0,
          СуммаАкциза: 0,
        },
      ],
    },
    [`Catalog_Организации(guid'${ORG}')`]: {
      НаименованиеПолное: 'Индивидуальный предприниматель "Aru Market"',
      ИдентификационныйНомер: "123123123123",
      ЮрФизЛицо: "ФизЛицо",
      ИндивидуальныйПредприниматель_Key: id(11),
    },
    [`Catalog_Контрагенты(guid'${BUYER}')`]: {
      Description: "Розничная выручка",
      НаименованиеПолное: "Розничная выручка",
      ИдентификационныйКодЛичности: "000000000000",
      НомерНалоговойРегистрацииВСтранеРезидентства: "выаыва",
      ЮрФизЛицо: "ФизЛицо",
    },
    [`Catalog_ДоговорыКонтрагентов(guid'${id(8)}')`]: { Description: "Без договора" },
    [`Document_РеализацияТоваровУслуг(guid'${SALE}')`]: {
      Number: "00000000016",
      Date: "2026-10-08T10:00:00",
    },
    [`Catalog_БанковскиеСчета(guid'${id(9)}')`]: { НомерСчета: "KZ86125KZT1004100100", Банк_Key: id(12) },
    [`Catalog_Банки(guid'${id(12)}')`]: { Description: 'АО "Банк ЦентрКредит"', БИК: "KCJBKZKX" },
    [`Catalog_Валюты(guid'${id(10)}')`]: {
      Code: "398",
      Description: "KZT",
      ПараметрыПрописиНаРусском: "теңге, теңге, теңге, м, тиын, тиын, тиын, м, 2",
    },
    [`Catalog_ФизическиеЛица(guid'${id(11)}')`]: { Description: "Жумабекова Алина Ерлановна" },
  };
  const collections: Record<string, Array<Record<string, unknown>>> = {
    Catalog_Номенклатура: [{ Ref_Key: GOODS, Description: "Одежда" }],
    Catalog_КлассификаторЕдиницИзмерения: [{ Ref_Key: UNIT, Description: "шт" }],
    Catalog_СтавкиНДС: [{ Ref_Key: NO_VAT, Description: "без НДС" }],
    Document_СчетФактураВыданный: [
      { Ref_Key: SF, Number: "00000000002", Date: "2026-10-08T13:35:00", СуммаДокумента: 1000, Posted: true },
    ],
  };
  return {
    cfg: { name: "default" },
    behavior: { pageSize: 100, maxRows: 1000, ...(printDir ? { printDir } : {}) },
    getMetadata: async () => ({ entities: new Map([["ChartOfAccounts_Типовой", { properties: [] }]]) }),
    available: async () =>
      new Set([
        "Document_СчетФактураВыданный",
        "Document_РеализацияТоваровУслуг",
        ...Object.keys(collections),
      ]),
    client: {
      getEntity: async (path: string) =>
        entities[Object.keys(entities).find((k) => path.startsWith(k)) ?? ""] ?? {},
      getCollection: async (path: string) => ({
        value: collections[Object.keys(collections).find((k) => path.startsWith(k)) ?? ""] ?? [],
      }),
    },
  };
}

describe("счёт-фактура: данные как в печатной форме 1С", () => {
  it("реквизиты сторон, основание, доверенность, подписи ИП и строки", async () => {
    const { form } = await taxInvoicePrintData(connection() as never, SF);
    expect(form).toMatchObject({
      number: "00000000002",
      turnoverDate: "2026-10-08",
      supplierName: 'Индивидуальный предприниматель "Aru Market"',
      supplierIds: "ИИН: 123123123123, ,",
      supplierAccount: 'KZ86125KZT1004100100, в банке АО "Банк ЦентрКредит", БИК KCJBKZKX',
      contract: "Без договора",
      powerOfAttorney: "Без доверенности",
      waybill: "Реализация ТМЗ и услуг № 16 от 8 октября 2026 г.",
      consignee: "ИИН: 000000000000, ИНН/КПП: выаыва, Розничная выручка,",
      buyerName: "Розничная выручка",
      buyerIds: "ИИН: 000000000000, ИНН/КПП: выаыва",
      buyerAccount: ", в банке , БИК",
      currency: "теңге",
      head: "Жумабекова А. Е.",
      chiefAccountant: "Не предусмотрен",
      totals: { costWithoutVat: 1000, vat: 0, total: 1000, excise: 0 },
    });
    expect(form.lines).toEqual([
      expect.objectContaining({
        name: "Одежда",
        unit: "шт",
        quantity: 1,
        price: 1000,
        costWithoutVat: 1000,
        vatRate: "Без НДС",
        total: 1000,
      }),
    ]);
  });

  it("форматы: счёт без реквизитов, количество по-русски", () => {
    expect(accountLine("", "", "")).toBe(", в банке , БИК");
    expect(sfQuantity(1)).toBe("1");
    expect(sfQuantity(2.5)).toBe("2,5");
  });
});

describe("read.document.print_tax_invoice", () => {
  it("по номеру: PDF в «счета-фактуры», повтор — « (2)» без перезаписи; файл во вложении", async () => {
    const root = tmp();
    const tool = toolsOf(connection(root))["read.document.print_tax_invoice"]!;
    const res = await tool.handler({ database: "default", number: "2", year: 2026 }, {});
    const name = "Счет-фактура № 2 от 08.10.2026.pdf";
    expect(res.structuredContent).toMatchObject({
      number: "00000000002",
      path: join(root, "счета-фактуры", name),
    });
    expect(
      readFileSync(join(root, "счета-фактуры", name))
        .subarray(0, 4)
        .toString(),
    ).toBe("%PDF");
    const again = await tool.handler({ database: "default", number: "2", year: 2026 }, {});
    expect(again.structuredContent!["path"]).toBe(
      join(root, "счета-фактуры", "Счет-фактура № 2 от 08.10.2026 (2).pdf"),
    );
    const resource = res.content.find((c) => c.type === "resource") as { resource: { blob: string } };
    expect(Buffer.from(resource.resource.blob, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("длинная таблица переносится на следующую страницу", async () => {
    const { form } = await taxInvoicePrintData(connection() as never, SF);
    const pdf = await renderTaxInvoicePdf({
      ...form,
      lines: Array.from({ length: 70 }, () => form.lines[0]!),
    });
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
