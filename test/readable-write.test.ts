import { describe, expect, it } from "vitest";
import { matches } from "./support/fake-1c.js";
import { fromReadable } from "../src/tools/readable-write.js";

const R = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const p = (name: string, type = "Edm.String") => ({ name, type });

const STORE: Record<string, Array<Record<string, unknown>>> = {
  Catalog_Контрагенты: [
    {
      Ref_Key: R(1),
      Description: "ИП Алексеев",
      ИдентификационныйКодЛичности: "850101300123",
      DeletionMark: false,
    },
    {
      Ref_Key: R(2),
      Description: "ИП Алексеев Плюс",
      ИдентификационныйКодЛичности: "850101300124",
      DeletionMark: false,
    },
  ],
  Catalog_ДоговорыКонтрагентов: [
    { Ref_Key: R(11), Description: "Договор об оказании услуг №2", Owner_Key: R(1), DeletionMark: false },
    { Ref_Key: R(12), Description: "Договор об оказании услуг №2", Owner_Key: R(2), DeletionMark: false },
  ],
  Catalog_Номенклатура: [{ Ref_Key: R(21), Description: "Стирка белья", DeletionMark: false }],
  Catalog_БанковскиеСчета: [
    { Ref_Key: R(31), Description: "Расчетный счет (Halyk Bank KZT)", DeletionMark: false },
  ],
};

const META = new Map<
  string,
  {
    entitySet: string;
    properties: ReturnType<typeof p>[];
    navigations?: Array<{ name: string; toType: string }>;
  }
>([
  [
    "Document_СчетНаОплатуПокупателю",
    {
      entitySet: "Document_СчетНаОплатуПокупателю",
      properties: [
        p("Контрагент_Key"),
        p("ДоговорКонтрагента_Key"),
        p("СтруктурнаяЕдиница"),
        p("СтруктурнаяЕдиница_Type"),
        p("КодНазначенияПлатежа"),
        p("Комментарий"),
        p("Услуги", "Collection(StandardODATA.Document_СчетНаОплатуПокупателю_Услуги_RowType)"),
      ],
    },
  ],
  [
    "Document_СчетНаОплатуПокупателю_Услуги",
    {
      entitySet: "Document_СчетНаОплатуПокупателю_Услуги",
      properties: [p("Номенклатура_Key"), p("Количество"), p("Цена"), p("Сумма"), p("Содержание")],
    },
  ],
  ...Object.keys(STORE).map(
    (s) => [s, { entitySet: s, properties: Object.keys(STORE[s]![0]!).map((k) => p(k)) }] as const,
  ),
]);

const conn = {
  getMetadata: async () => ({ entities: META }),
  available: async () => new Set(META.keys()),
  behavior: { pageSize: 100, maxRows: 1000 },
  client: {
    getCollection: async (path: string) => {
      const set = path.split("?")[0]!;
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      return { value: (STORE[set] ?? []).filter((r) => matches(r as never, q.get("$filter") ?? undefined)) };
    },
  },
};

const em = META.get("Document_СчетНаОплатуПокупателю")!;

describe("fromReadable: запись в понятных полях", () => {
  it("названия и БИН → guid, договор — среди договоров этого контрагента, составное поле с типом, КНП кодом", async () => {
    const out = await fromReadable(
      conn as never,
      em as never,
      {
        contract: { name: "Договор об оказании услуг №2" },
        counterparty: "ИП Алексеев",
        bank_account: { name: "Расчетный счет (Halyk Bank KZT)", type: "Catalog_БанковскиеСчета" },
        knp: { code: "859", name: "Платежи за профессиональные, научные и технические услуги" },
        comment: "по заявке",
      },
      {
        services: [{ line_number: 1, nomenclature: "Стирка белья", quantity: 1, price: 170050, sum: 170050 }],
      },
    );
    expect(out.fields).toEqual({
      Контрагент_Key: R(1),
      ДоговорКонтрагента_Key: R(11),
      СтруктурнаяЕдиница: R(31),
      СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
      КодНазначенияПлатежа: "859",
      Комментарий: "по заявке",
    });
    expect(out.tables).toEqual({
      Услуги: [{ Номенклатура_Key: R(21), Количество: 1, Цена: 170050, Сумма: 170050 }],
    });
    const byBin = await fromReadable(conn as never, em as never, { counterparty: "850101300124" }, {});
    expect(byBin.fields["Контрагент_Key"]).toBe(R(2));
  });

  it("guid и реквизиты 1С — как есть; несколько похожих — ошибка со списком", async () => {
    const out = await fromReadable(
      conn as never,
      em as never,
      { counterparty: { guid: R(2) }, Комментарий: "x" },
      {},
    );
    expect(out.fields).toEqual({ Контрагент_Key: R(2), Комментарий: "x" });
    await expect(fromReadable(conn as never, em as never, { counterparty: "Алексеев" }, {})).rejects.toThrow(
      /несколько/,
    );
    await expect(fromReadable(conn as never, em as never, { counterparty: "Бета" }, {})).rejects.toThrow(
      /не найден/,
    );
  });
});
