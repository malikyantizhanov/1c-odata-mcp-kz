/* eslint-disable @typescript-eslint/no-explicit-any -- разбор decode() в тестах */
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { baseStore, fake1C } from "./support/fake-1c.js";

const R = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const EMPTY = "00000000-0000-0000-0000-000000000000";

function invoiceStore() {
  const store = baseStore();
  store["Catalog_Контрагенты"]!.push({
    Ref_Key: R(901),
    Description: "ИП Алексеев",
    IsFolder: false,
    DeletionMark: false,
  });
  store["Catalog_ДоговорыКонтрагентов"]!.push({
    Ref_Key: R(902),
    Description: "Договор об оказании услуг №2",
    Owner_Key: R(901),
    DeletionMark: false,
  });
  store["Catalog_Номенклатура"]!.push({
    Ref_Key: R(903),
    Description: "Услуги прачечной (стирка и обработка белья)",
    DeletionMark: false,
  });
  store["Catalog_Валюты"] = [{ Ref_Key: R(904), Description: "KZT", Code: "398" }];
  store["Catalog_Пользователи"] = [{ Ref_Key: R(905), Description: "Сергеева Татьяна Альбертовна" }];
  store["Catalog_БанковскиеСчета"] = [{ Ref_Key: R(907), Description: "Расчетный счет (Halyk Bank KZT)" }];
  store["Document_СчетНаОплатуПокупателю"] = [
    {
      "odata.metadata": "https://1cfresh.kz/…/$metadata#Document_СчетНаОплатуПокупателю/@Element",
      Ref_Key: R(950),
      DataVersion: "AAAAAAAAAAA=",
      Number: "00000000095",
      Date: "2026-11-06T00:00:00",
      Posted: false,
      DeletionMark: false,
      СуммаДокумента: 170050,
      Контрагент_Key: R(901),
      ДоговорКонтрагента_Key: R(902),
      ВалютаДокумента_Key: R(904),
      Ответственный_Key: R(905),
      СтруктурнаяЕдиница: R(907),
      СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
      СтруктурноеПодразделение_Key: EMPTY,
      КодНазначенияПлатежа: "859",
      Комментарий: "",
      Товары: [],
      Услуги: [
        {
          LineNumber: "1",
          Номенклатура_Key: R(903),
          Содержание: "Услуги прачечной (стирка и обработка белья)",
          Количество: 1,
          Цена: 170050,
          Сумма: 170050,
          СтавкаНДС_Key: EMPTY,
          СуммаНДС: 0,
        },
      ],
      "Контрагент@navigationLinkUrl": "Document_СчетНаОплатуПокупателю(guid'…')/Контрагент",
    },
  ];
  return store;
}

describe("read.document.get_document: читаемый вид в TOON", () => {
  it("понятные имена, ссылки с названиями, без служебного; structuredContent — как в 1С", async () => {
    const { call } = fake1C({ store: invoiceStore() });
    const r = await call("read.document.get_document", {
      entitySet: "Document_СчетНаОплатуПокупателю",
      ref: R(950),
    });
    const text = (r.content[0] as { text: string }).text;
    expect(text.split("\n")[0]).toBe("# Счет на оплату покупателю № 95 от 2026-11-06");
    expect(text).not.toMatch(
      /odata\.metadata|DataVersion|navigationLinkUrl|00000000-0000-0000-0000-000000000000/,
    );
    const view = decode(text) as Record<string, any>;
    expect(view).toMatchObject({
      number: "00000000095",
      date: "2026-11-06",
      is_posted: false,
      total_amount: 170050,
      counterparty: { guid: R(901), name: "ИП Алексеев" },
      contract: { guid: R(902), name: "Договор об оказании услуг №2" },
      currency: { guid: R(904), name: "KZT" },
      bank_account: {
        guid: R(907),
        name: "Расчетный счет (Halyk Bank KZT)",
        type: "Catalog_БанковскиеСчета",
      },
      knp: { code: "859", name: "Платежи за профессиональные, научные и технические услуги" },
      services: [
        {
          line_number: 1,
          nomenclature: { guid: R(903), name: "Услуги прачечной (стирка и обработка белья)" },
          quantity: 1,
          price: 170050,
          sum: 170050,
          vat_amount: 0,
        },
      ],
    });
    expect(view).not.toHaveProperty("department");
    expect(view).not.toHaveProperty("goods");
    expect(view["services"][0]).not.toHaveProperty("description"); // = названию номенклатуры
    expect(Object.keys(view).slice(0, 5)).toEqual(["type", "entity_set", "guid", "number", "date"]);
    expect((r.structuredContent as Record<string, unknown>)["Контрагент_Key"]).toBe(R(901));
  });

  it("raw=true — текст как в 1С", async () => {
    const { call } = fake1C({ store: invoiceStore() });
    const r = await call("read.document.get_document", {
      entitySet: "Document_СчетНаОплатуПокупателю",
      ref: R(950),
      raw: true,
    });
    expect(JSON.parse((r.content[0] as { text: string }).text)["Контрагент_Key"]).toBe(R(901));
  });
});
