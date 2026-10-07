import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { isWithoutVat, kzCounterpartyPayload, vatPercent } from "../src/tools/write-kz.js";

/**
 * Запись в казахстанскую базу. Форма объектов сверена с документами, созданными в 1С:Fresh.kz:
 * БИН/ИИН в ИдентификационныйКодЛичности, ставка НДС — ссылка на справочник, «Товары»/«Услуги»,
 * единица из карточки номенклатуры, валюта KZT.
 */

type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const ORG = "00000000-0000-4000-8000-000000000001";
const BUYER = "00000000-0000-4000-8000-000000000002";
const GOODS = "00000000-0000-4000-8000-000000000003";
const SERVICE = "00000000-0000-4000-8000-000000000004";
const UNIT = "00000000-0000-4000-8000-000000000005";
const KZT = "00000000-0000-4000-8000-000000000006";
const VAT16 = "00000000-0000-4000-8000-000000000007";
const VAT0 = "00000000-0000-4000-8000-000000000008";

const props = (...names: string[]) => ({ properties: names.map((name) => ({ name })) });

function kzConnection(kazakhstan = true) {
  const entities = new Map<string, { properties: { name: string }[] }>([
    [
      "Catalog_Контрагенты",
      props("Ref_Key", "Description", kazakhstan ? "ИдентификационныйКодЛичности" : "ИНН"),
    ],
    ["Catalog_Организации", props("Ref_Key", "Description", kazakhstan ? "ИдентификационныйНомер" : "ИНН")],
    ["Catalog_Номенклатура", props("Ref_Key", "Description", "Услуга", "БазоваяЕдиницаИзмерения_Key")],
    ["Catalog_ДоговорыКонтрагентов", props("Ref_Key", "Description", "Owner_Key", "ВидДоговора")],
    ["Document_СчетНаОплатуПокупателю", props("Ref_Key", "Number")],
    ...(kazakhstan ? [["ChartOfAccounts_Типовой", props("Ref_Key", "Code")] as const] : []),
  ]);
  const rows: Record<string, Array<Record<string, unknown>>> = {
    Catalog_Организации: [{ Ref_Key: ORG, Description: "ИП Тест" }],
    Catalog_Номенклатура: [
      { Ref_Key: GOODS, Description: "Одежда", Услуга: false, БазоваяЕдиницаИзмерения_Key: UNIT },
      { Ref_Key: SERVICE, Description: "Консультация", Услуга: true },
    ],
    Catalog_СтавкиНДС: [
      { Ref_Key: VAT16, Description: "16%" },
      { Ref_Key: VAT0, Description: "без НДС" },
    ],
    Catalog_Валюты: [{ Ref_Key: KZT, Code: "398" }],
    Catalog_КлассификаторЕдиницИзмерения: [{ Ref_Key: UNIT, Description: "шт", Code: "796" }],
  };
  const prepareCreate = vi.fn(async () => undefined);
  const connection = {
    cfg: { name: "default", writable: true },
    behavior: { writeOperationMarker: false, pageSize: 100, maxRows: 1000 },
    getMetadata: async () => ({ entities }),
    available: async () => new Set([...entities.keys(), ...Object.keys(rows), "Catalog_БанковскиеСчета"]),
    client: {
      prepareCreate,
      getEntity: async () => ({}),
      getCollection: async (path: string) => ({
        value: rows[Object.keys(rows).find((set) => path.startsWith(set)) ?? ""] ?? [],
      }),
    },
  };
  return { connection, prepareCreate };
}

async function preview(tool: string, args: Record<string, unknown>, kazakhstan = true) {
  const { connection } = kzConnection(kazakhstan);
  const res = await toolsOf(connection)[tool]!.handler({ database: "default", confirm: false, ...args }, {});
  return res;
}
const payloadOf = (res: CallToolResult) =>
  (res.structuredContent as { payload: Record<string, unknown> }).payload;

describe("ставки НДС Казахстана", () => {
  it("понимает казахстанские и российские имена ставок", () => {
    expect(vatPercent("16%")).toBe(16);
    expect(vatPercent("12 %")).toBe(12);
    expect(vatPercent("НДС16")).toBe(16);
    expect(isWithoutVat("без НДС")).toBe(true);
    expect(isWithoutVat("БезНДС")).toBe(true);
    expect(isWithoutVat("без НДС - не РК")).toBe(false);
  });
});

describe("контрагент в казахстанской базе", () => {
  it("пишет БИН/ИИН, вид лица и КБЕ вместо ИНН/КПП", async () => {
    const p = payloadOf(
      await preview("write.counterparty.create_counterparty", {
        name: "ТОО Покупатель",
        inn: "990140000001",
        legalType: "ЮридическоеЛицо",
        kbe: "17",
      }),
    );
    expect(p).toMatchObject({
      Description: "ТОО Покупатель",
      ИдентификационныйКодЛичности: "990140000001",
      ЮрФизЛицо: "ЮрЛицо",
      КБЕ: "17",
    });
    expect(p).not.toHaveProperty("ИНН");
  });

  it("отклоняет КПП/ОГРН и неверный БИН/ИИН", () => {
    expect(() => kzCounterpartyPayload({ name: "X", kpp: "123" })).toThrow(/КПП и ОГРН/);
    expect(() => kzCounterpartyPayload({ name: "X", inn: "12345" })).toThrow(/12 цифр/);
  });
});

describe("договор и номенклатура в казахстанской базе", () => {
  it("договор: НомерДоговора/ДатаДоговора и валюта KZT", async () => {
    const p = payloadOf(
      await preview("write.catalog.create_contract", {
        counterpartyRef: BUYER,
        kind: "СПокупателем",
        number: "7",
        date: "2026-10-01",
      }),
    );
    expect(p).toMatchObject({
      НомерДоговора: "7",
      ДатаДоговора: "2026-10-01T00:00:00",
      ВалютаВзаиморасчетов_Key: KZT,
      Организация_Key: ORG,
    });
    expect(p).not.toHaveProperty("Номер");
  });

  it("номенклатура получает единицу измерения «шт»", async () => {
    const p = payloadOf(
      await preview("write.catalog.create_nomenclature", { name: "Услуга", isService: true }),
    );
    expect(p).toMatchObject({ Услуга: true, БазоваяЕдиницаИзмерения_Key: UNIT });
  });
});

describe("счёт на оплату в казахстанской базе", () => {
  it("без НДС: товары и услуги раздельно, ставка пустая, валюта KZT", async () => {
    const p = payloadOf(
      await preview("write.sales.create_invoice", {
        counterpartyRef: BUYER,
        sumIncludesVat: true,
        lines: [
          { nomenclatureRef: GOODS, quantity: 2, price: 5000, vatRate: "без НДС" },
          {
            nomenclatureRef: SERVICE,
            quantity: 1,
            price: 10000,
            vatRate: "без НДС",
            content: "Консультация за октябрь",
          },
        ],
      }),
    );
    expect(p).toMatchObject({
      УчитыватьНДС: false,
      СуммаВключаетНДС: false,
      СуммаДокумента: 20000,
      ВалютаДокумента_Key: KZT,
    });
    expect(p["Товары"]).toEqual([
      {
        LineNumber: 1,
        Номенклатура_Key: GOODS,
        Количество: 2,
        Цена: 5000,
        Сумма: 10000,
        СуммаНДС: 0,
        ЕдиницаИзмерения_Key: UNIT,
        Коэффициент: 1,
      },
    ]);
    expect(p["Услуги"]).toEqual([
      {
        LineNumber: 1,
        Номенклатура_Key: SERVICE,
        Количество: 1,
        Цена: 10000,
        Сумма: 10000,
        СуммаНДС: 0,
        Содержание: "Консультация за октябрь",
      },
    ]);
  });

  it("с НДС 16%: ставка — ссылка на справочник, налог выделен из суммы или начислен сверху", async () => {
    const included = payloadOf(
      await preview("write.sales.create_invoice", {
        counterpartyRef: BUYER,
        sumIncludesVat: true,
        lines: [{ nomenclatureRef: GOODS, quantity: 1, price: 11600, vatRate: "16%" }],
      }),
    );
    expect(included).toMatchObject({ УчитыватьНДС: true, СуммаВключаетНДС: true, СуммаДокумента: 11600 });
    expect((included["Товары"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      СтавкаНДС_Key: VAT16,
      СуммаНДС: 1600,
    });

    const onTop = payloadOf(
      await preview("write.sales.create_invoice", {
        counterpartyRef: BUYER,
        sumIncludesVat: false,
        lines: [{ nomenclatureRef: GOODS, quantity: 1, price: 10000, vatRate: "16%" }],
      }),
    );
    expect(onTop).toMatchObject({ СуммаВключаетНДС: false, СуммаДокумента: 11600 });
  });

  it("ставка, которой нет в справочнике базы, — понятная ошибка", async () => {
    const res = await preview("write.sales.create_invoice", {
      counterpartyRef: BUYER,
      sumIncludesVat: true,
      lines: [{ nomenclatureRef: GOODS, quantity: 1, price: 100, vatRate: "12%" }],
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("не найдена в справочнике «Ставки НДС»");
  });
});

describe("политика записи по профилю базы", () => {
  it("в Казахстане документы с проводками отвечают отказом со списком доступной записи", async () => {
    const res = await preview("write.sales.create_shipment", {
      counterpartyRef: BUYER,
      lines: [{ nomenclatureRef: GOODS, quantity: 1, price: 1, vatRate: "без НДС" }],
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("write.sales.create_invoice");
  });

  it("в российской базе казахстанская ставка не уходит в 1С", async () => {
    const res = await preview(
      "write.sales.create_invoice",
      {
        counterpartyRef: BUYER,
        sumIncludesVat: true,
        lines: [{ nomenclatureRef: GOODS, quantity: 1, price: 100, vatRate: "16%" }],
      },
      false,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("для казахстанской базы");
  });
});
