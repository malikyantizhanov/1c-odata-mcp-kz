import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BANK_ACC,
  BUYER,
  CONTRACT,
  KZT,
  ORG,
  SERVICE,
  VAT_NONE,
  fake1C,
  id,
  type Store,
} from "./support/fake-1c.js";
import { USD, USD_ACC, usdStore } from "./support/usd-store.js";

/**
 * write.sales.tax_invoice_from_sale — счёт-фактура выданный по проведённой реализации: отказ по непроведённой,
 * перенос полей, дата оборота, валюта (basis / tenge / auto по прошлым СФ), дубли, confirm без полей ИС ЭСФ.
 */

const TOOL = "write.sales.tax_invoice_from_sale";
const SALE = id(60);
const SALE_SET = "Document_РеализацияТоваровУслуг";
const SF_SET = "Document_СчетФактураВыданный";
const SALE_TYPE = "StandardODATA.Document_РеализацияТоваровУслуг";
const RESP = id(61);

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const errText = (r: CallToolResult) => JSON.stringify(r.content);

/** Проведённая реализация № 13 от 12.10.2026 на 672.64 USD по курсу 453.93, счёт Bereke USD, акт подписан 13.10. */
function saleStore(over: Record<string, unknown> = {}): Store {
  const store = usdStore();
  store[SALE_SET] = [
    {
      Ref_Key: SALE,
      Number: "00000000013",
      Date: "2026-10-12T12:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: USD,
      КурсВзаиморасчетов: 453.93,
      КратностьВзаиморасчетов: "1",
      УчитыватьНДС: false,
      СуммаВключаетНДС: false,
      УчитыватьАкциз: false,
      СуммаВключаетАкциз: false,
      БанковскийСчетОрганизации_Key: USD_ACC,
      Ответственный_Key: RESP,
      АдресДоставки: "г. Алматы",
      СуммаДокумента: 672.64,
      ДатаПодписанияГЗ: "2026-10-13T00:00:00",
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Содержание: "Разработка ПО, октябрь",
          Количество: 1,
          Цена: 672.64,
          Сумма: 672.64,
          СтавкаНДС_Key: "00000000-0000-0000-0000-000000000000",
          СуммаНДС: 0,
          СчетДоходовБУ_Key: id(62),
        },
      ],
      Товары: [],
      ...over,
    },
  ];
  store[SF_SET] = [];
  return store;
}

const base = { sale: SALE, date: "2026-10-14", currencyMode: "basis" };

describe("tax_invoice_from_sale: проверки основания", () => {
  it("непроведённая реализация — понятный отказ, ничего не создаётся", async () => {
    const f = fake1C({ store: saleStore({ Posted: false }) });
    const res = await f.call(TOOL, base);
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/Реализация № 13 от 12\.10\.2026 не проведена/);
    expect(errText(res)).toMatch(/Ничего не создано/);
    expect(f.posts).toEqual([]);
  });

  it("помеченная на удаление — отказ", async () => {
    const f = fake1C({ store: saleStore({ DeletionMark: true }) });
    const res = await f.call(TOOL, base);
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/помечена на удаление/);
  });
});

describe("tax_invoice_from_sale: перенос полей", () => {
  it("строки, НДС «без НДС», контрагент, договор, банк и курс — из реализации; дата оборота — дата реализации", async () => {
    const f = fake1C({ store: saleStore() });
    const plan = sc(await f.call(TOOL, base));
    expect(plan).toMatchObject({
      dryRun: true,
      ready: true,
      turnoverDate: "2026-10-12",
      bankAccount: { ref: USD_ACC },
      currency: { code: "840", rate: 453.93, multiplier: 1 },
      totals: { total: 672.64, vat: 0, withVat: false },
    });
    expect(plan["notes"].join(" ")).toMatch(/дата подписания акта 13\.10\.2026/);
    expect(f.posts).toEqual([]);

    const out = sc(await f.call(TOOL, { ...base, confirm: true, operationId: plan["operationId"] }));
    expect(out).toMatchObject({ created: true, taxInvoice: { total: 672.64, posted: false } });
    const body = f.posts.find((p) => p.set === SF_SET)!.body;
    expect(body).toMatchObject({
      Date: "2026-10-14T00:00:00",
      Организация_Key: ORG,
      Поставщик_Key: ORG,
      Грузоотправитель: ORG,
      Контрагент_Key: BUYER,
      Покупатель_Key: BUYER,
      Грузополучатель_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      СчетОрганизации_Key: USD_ACC,
      ВалютаДокумента_Key: USD,
      КурсВзаиморасчетов: 453.93,
      КратностьВзаиморасчетов: 1,
      УчитыватьНДС: false,
      СуммаДокумента: 672.64,
      ДатаСовершенияОборотаПоРеализации: "2026-10-12T00:00:00",
      Ответственный_Key: RESP,
      ПунктНазначения: "г. Алматы",
      ДокументОснование: SALE,
      ДокументОснование_Type: SALE_TYPE,
      ДокументыОснования: [{ LineNumber: 1, ДокументОснование: SALE, ДокументОснование_Type: SALE_TYPE }],
    });
    expect(body["Услуги"]).toEqual([
      {
        LineNumber: 1,
        Номенклатура_Key: SERVICE,
        Содержание: "Разработка ПО, октябрь",
        Количество: 1,
        Цена: 672.64,
        Сумма: 672.64,
        СтавкаНДС_Key: VAT_NONE,
        СуммаНДС: 0,
        ОборотПоРеализации: 672.64,
      },
    ]);
    // Поля обмена с ИС ЭСФ и проведение не заполняются.
    for (const k of ["Posted", "СтатусЭСФ", "РегистрационныйНомер", "НомерЭСФ", "ЭСФ_Key"])
      expect(body).not.toHaveProperty(k);

    // Повтор confirm с тем же operationId — без второго документа.
    const again = sc(await f.call(TOOL, { ...base, confirm: true, operationId: plan["operationId"] }));
    expect(again).toMatchObject({ created: true, replayed: true });
    expect(f.posts.filter((p) => p.set === SF_SET)).toHaveLength(1);
  });

  it("явная дата оборота — в шапке; поиск реализации по номеру", async () => {
    const f = fake1C({ store: saleStore() });
    const plan = sc(await f.call(TOOL, { ...base, sale: "13", saleYear: 2026, turnoverDate: "2026-10-13" }));
    expect(plan).toMatchObject({
      ready: true,
      turnoverDate: "2026-10-13",
      sale: { ref: SALE, number: "13" },
    });
    expect((plan["notes"] ?? []).join(" ")).not.toMatch(/дата подписания акта/);
  });

  it("comment — перед автокомментарием", async () => {
    const f = fake1C({ store: saleStore() });
    const args = { ...base, comment: "ZZ-TEST" };
    const plan = sc(await f.call(TOOL, args));
    await f.call(TOOL, { ...args, confirm: true, operationId: plan["operationId"] });
    expect(f.posts.find((p) => p.set === SF_SET)!.body["Комментарий"]).toBe(
      "ZZ-TEST. Создан по реализации № 13 от 12.10.2026",
    );
  });

  it("реализация в тенге — курс 1, валюта тенге без вопроса о режиме", async () => {
    const f = fake1C({
      store: saleStore({
        ВалютаДокумента_Key: KZT,
        КурсВзаиморасчетов: 1,
        БанковскийСчетОрганизации_Key: BANK_ACC,
      }),
    });
    const plan = sc(await f.call(TOOL, { sale: SALE, date: "2026-10-14" }));
    expect(plan).toMatchObject({
      ready: true,
      currency: { code: "398", rate: 1 },
      bankAccount: { ref: BANK_ACC },
    });
  });
});

describe("tax_invoice_from_sale: валютная реализация", () => {
  it("tenge — суммы × курс регистра на дату оборота", async () => {
    const f = fake1C({ store: saleStore() });
    const plan = sc(
      await f.call(TOOL, { ...base, currencyMode: "tenge", turnoverDate: "2026-10-13", date: "2026-10-14" }),
    );
    // Курс на 13.10 — последний до даты: 453.93 от 12.10.
    expect(plan).toMatchObject({
      ready: true,
      currency: { code: "398", rate: 453.93, mode: "в тенге" },
      totals: { total: 305331.48 },
    });
    await f.call(TOOL, {
      ...base,
      currencyMode: "tenge",
      turnoverDate: "2026-10-13",
      date: "2026-10-14",
      confirm: true,
      operationId: plan["operationId"],
    });
    const body = f.posts.find((p) => p.set === SF_SET)!.body;
    expect(body).toMatchObject({
      ВалютаДокумента_Key: KZT,
      КурсВзаиморасчетов: 453.93,
      СуммаДокумента: 305331.48,
    });
    expect((body["Услуги"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      Цена: 305331.48,
      Сумма: 305331.48,
      ОборотПоРеализации: 305331.48,
    });
  });

  it("auto без прошлых СФ — вопрос currencyMode; auto с прошлым СФ в тенге — тенге", async () => {
    const store = saleStore();
    const f = fake1C({ store });
    const ask = sc(await f.call(TOOL, { sale: SALE, date: "2026-10-14" }));
    expect(ask).toMatchObject({ ready: false });
    expect(ask["choices"]).toEqual([expect.objectContaining({ field: "currencyMode" })]);

    const prevSale = id(63);
    store[SALE_SET]!.push({
      ...store[SALE_SET]![0]!,
      Ref_Key: prevSale,
      Number: "00000000012",
      Date: "2026-10-01T00:00:00",
    });
    store[SF_SET]!.push({
      Ref_Key: id(64),
      Number: "00000000003",
      Date: "2026-10-02T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ВалютаДокумента_Key: KZT,
      ДокументОснование: prevSale,
      ДокументОснование_Type: SALE_TYPE,
      СуммаДокумента: 300000,
    });
    const auto = sc(await f.call(TOOL, { sale: SALE, date: "2026-10-14" }));
    expect(auto).toMatchObject({ ready: true, currency: { code: "398", mode: "в тенге" } });
    expect(auto["currency"]["source"]).toMatch(/как в СФ № 3 от 02\.10\.2026/);
  });

  it("уже есть СФ по этой реализации — предупреждение и possibleDuplicates; валюта ≠ договору — предупреждение", async () => {
    const store = saleStore();
    Object.assign(store["Catalog_ДоговорыКонтрагентов"]![0]!, { ВалютаВзаиморасчетов_Key: KZT });
    store[SF_SET]!.push({
      Ref_Key: id(65),
      Number: "00000000004",
      Date: "2026-10-13T00:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      ДокументОснование: SALE,
      ДокументОснование_Type: SALE_TYPE,
      СуммаДокумента: 672.64,
    });
    const f = fake1C({ store });
    const plan = sc(await f.call(TOOL, base));
    expect(plan["possibleDuplicates"]).toEqual([expect.objectContaining({ ref: id(65), number: "4" })]);
    expect(plan["warnings"].join(" ")).toMatch(/уже есть счёт-фактура: № 4 от 13\.10\.2026/);
    expect(plan["warnings"].join(" ")).toMatch(/не совпадает с валютой договора/);
  });

  it("дата СФ раньше даты оборота — предупреждение", async () => {
    const f = fake1C({ store: saleStore() });
    const plan = sc(await f.call(TOOL, { ...base, date: "2026-10-10" }));
    expect(plan["warnings"].join(" ")).toMatch(/раньше даты оборота/);
  });
});
