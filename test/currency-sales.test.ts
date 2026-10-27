import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pickBankForCurrency, type CurrencyInfo, type OrgBankAccount } from "../src/tools/currency-kz.js";
import {
  BANK_ACC,
  BIN,
  BUYER,
  CONTRACT,
  KZT,
  ORG,
  SERVICE,
  SERVICE_NAME,
  VAT_NONE,
  fake1C,
  id,
  type Row,
  type Store,
} from "./support/fake-1c.js";
import { USD, USD_ACC, USD_ACC2, usdStore } from "./support/usd-store.js";

/**
 * Валюта, курс и банковский счёт в quick_invoice / quick_sale (Казахстан): валюта — из договора, курс — срез последних
 * InformationRegister_КурсыВалют на дату документа с кратностью, банковский счёт — в валюте документа.
 */

const INVOICE = id(30);
const SALE_SET = "Document_РеализацияТоваровУслуг";
const INVOICE_SET = "Document_СчетНаОплатуПокупателю";
const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const errText = (r: CallToolResult) => JSON.stringify(r.content);

const USD_INVOICE = {
  buyer: BIN,
  date: "2026-10-08",
  lines: [{ name: SERVICE_NAME, quantity: 1, price: 672.64, kind: "service" }],
  paymentCode: "851",
};

describe("pickBankForCurrency", () => {
  const usd: CurrencyInfo = { ref: USD, code: "840", name: "USD", isTenge: false };
  const kzt: CurrencyInfo = { ref: KZT, code: "398", name: "KZT", isTenge: true };
  const acc = (ref: string, cur: string | undefined, closed = false): OrgBankAccount => ({
    ref,
    name: ref.slice(-3),
    number: "",
    currencyRef: cur,
    closed,
  });
  it("основной в валюте документа — он; иначе единственный счёт в валюте", () => {
    const list = [acc(BANK_ACC, KZT), acc(USD_ACC, USD)];
    expect(pickBankForCurrency(list, kzt, { preferredRef: BANK_ACC }).ref).toBe(BANK_ACC);
    const p = pickBankForCurrency(list, usd, { preferredRef: BANK_ACC });
    expect(p.ref).toBe(USD_ACC);
    expect(p.note).toMatch(/не в валюте USD/);
  });
  it("закрытые счета не берём; несколько в валюте — первый с предупреждением; нет — основной с предупреждением", () => {
    expect(pickBankForCurrency([acc(USD_ACC, USD, true)], usd, { preferredRef: BANK_ACC }).note).toMatch(
      /нет действующего банковского счёта в USD/,
    );
    const many = pickBankForCurrency([acc(USD_ACC, USD), acc(USD_ACC2, USD)], usd, {});
    expect(many.ref).toBe(USD_ACC);
    expect(many.note).toMatch(/несколько счетов в USD/);
  });
  it("явный счёт не меняем, но предупреждаем о чужой валюте; счёт без валюты — тенговый", () => {
    const p = pickBankForCurrency([acc(BANK_ACC, undefined)], usd, { explicitRef: BANK_ACC, tengeRef: KZT });
    expect(p.ref).toBe(BANK_ACC);
    expect(p.note).toMatch(/не в валюте документа \(USD\)/);
    expect(
      pickBankForCurrency([acc(BANK_ACC, undefined)], kzt, { preferredRef: BANK_ACC }).note,
    ).toBeUndefined();
  });
});

describe("quick_invoice: валюта, курс и банк", () => {
  it("валюта по умолчанию — из договора, курс — из регистра на дату счёта, банк — в валюте счёта", async () => {
    const f = fake1C({ store: usdStore() });
    const plan = sc(await f.quick(USD_INVOICE));
    expect(plan).toMatchObject({
      ready: true,
      currency: { code: "840", name: "USD", rate: 453.65, multiplier: 1, ratePeriod: "2026-10-07" },
      bankAccount: { ref: USD_ACC, number: "KZ25914002203US00773" },
    });
    expect(plan["notes"].join(" ")).toMatch(/Валюта счёта USD \(из договора\); курс 453.65/);
    expect(plan["notes"].join(" ")).toMatch(/Основной банковский счёт .* не в валюте USD/);
    expect(
      f.gets.some((g) =>
        g.includes("InformationRegister_КурсыВалют/SliceLast(Period=datetime'2026-10-08T23:59:59'"),
      ),
    ).toBe(true);
    const out = sc(await f.quick({ ...USD_INVOICE, confirm: true, operationId: plan["operationId"] }));
    expect(out).toMatchObject({ created: true });
    const body = f.posts.find((p) => p.set === INVOICE_SET)!.body;
    expect(body).toMatchObject({
      ВалютаДокумента_Key: USD,
      КурсВзаиморасчетов: 453.65,
      КратностьВзаиморасчетов: 1,
      СтруктурнаяЕдиница: USD_ACC,
      СуммаДокумента: 672.64,
    });
  });

  it("договор в тенге — курс 1, кратность 1, основной банковский счёт", async () => {
    const store = usdStore();
    Object.assign(store["Catalog_ДоговорыКонтрагентов"]![0]!, { ВалютаВзаиморасчетов_Key: KZT });
    const f = fake1C({ store });
    const plan = sc(await f.quick(USD_INVOICE));
    expect(plan).toMatchObject({
      currency: { code: "398", rate: 1, multiplier: 1 },
      bankAccount: { ref: BANK_ACC },
    });
    expect(f.gets.some((g) => g.includes("SliceLast"))).toBe(false);
  });

  it("явная валюта и курс: кратность из регистра (JPY ×100), явный rate — за 1 единицу; несовпадение с договором — в notes", async () => {
    const f = fake1C({ store: usdStore() });
    const jpy = sc(await f.quick({ ...USD_INVOICE, currency: "JPY" }));
    expect(jpy["currency"]).toMatchObject({ code: "392", rate: 298.5, multiplier: 100 });
    expect(jpy["notes"].join(" ")).toMatch(/не совпадает с валютой договора USD/);
    expect(jpy["notes"].join(" ")).toMatch(/нет действующего банковского счёта в JPY/);
    const manual = sc(await f.quick({ ...USD_INVOICE, rate: 455 }));
    expect(manual["currency"]).toMatchObject({ code: "840", rate: 455, multiplier: 1 });
    expect(manual["notes"].join(" ")).toMatch(/передан явно/);
  });

  it("курса на дату нет (только заглушка 1 от 1980 г.) — план не готов (choices.rate), счёт с курсом 1 не создаётся", async () => {
    const f = fake1C({ store: usdStore() });
    const plan = sc(await f.quick({ ...USD_INVOICE, date: "2026-09-01" }));
    expect(plan).toMatchObject({ ready: false });
    expect(plan["choices"]).toEqual(expect.arrayContaining([expect.objectContaining({ field: "rate" })]));
    expect(f.posts).toEqual([]);
  });

  it("явный банковский счёт в другой валюте — остаётся, с предупреждением", async () => {
    const f = fake1C({ store: usdStore() });
    const plan = sc(await f.quick({ ...USD_INVOICE, bankAccount: BANK_ACC }));
    expect(plan["bankAccount"]).toMatchObject({ ref: BANK_ACC });
    expect(plan["notes"].join(" ")).toMatch(/не в валюте документа \(USD\)/);
  });

  it("неизвестная валюта — понятный отказ", async () => {
    const f = fake1C({ store: usdStore() });
    const res = await f.quick({ ...USD_INVOICE, currency: "XYZ" });
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/Валюта «XYZ» не найдена/);
  });
});

/** Счёт-основание для quick_sale в нужной валюте. */
function withInvoice(store: Store, cur: string, rate: number): Store {
  store[INVOICE_SET] = [
    {
      Ref_Key: INVOICE,
      Number: "00000000004",
      Date: "2026-10-07T12:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: cur,
      КурсВзаиморасчетов: rate,
      КратностьВзаиморасчетов: 1,
      УчитыватьНДС: false,
      СуммаВключаетНДС: false,
      СтруктурнаяЕдиница: USD_ACC,
      СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
      СуммаДокумента: 672.64,
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Содержание: SERVICE_NAME,
          Количество: 1,
          Цена: 672.64,
          Сумма: 672.64,
          СтавкаНДС_Key: VAT_NONE,
          СуммаНДС: 0,
        },
      ],
      Товары: [],
    },
  ];
  store[SALE_SET] = [];
  return store;
}

const sale = (f: ReturnType<typeof fake1C>, args: Row) => f.call("write.sales.quick_sale", args);

describe("quick_sale: курс на дату реализации и валюта основания", () => {
  it("валюта договора USD — курс из регистра на дату реализации, а не скопированный из счёта", async () => {
    const f = fake1C({ store: withInvoice(usdStore(), USD, 453.65) });
    const plan = sc(await sale(f, { basis: INVOICE, date: "2026-10-12" }));
    expect(plan["ready"]).toBe(true);
    expect(plan["currency"]).toMatchObject({ ref: USD, rate: 453.93, multiplier: 1 });
    expect(plan["warnings"]).toBeUndefined();
    expect(plan["notes"].join(" ")).toMatch(/курс 453.93 тенге за 1 USD .* на дату реализации/);
  });

  it("валюта счёта (KZT) ≠ валюте договора (USD) — предупреждение в warnings плана", async () => {
    const f = fake1C({ store: withInvoice(usdStore(), KZT, 1) });
    const plan = sc(await sale(f, { basis: INVOICE, date: "2026-10-27" }));
    expect(plan["warnings"]).toEqual([
      expect.stringMatching(/Валюта счёта-основания № 4 \(KZT\) не совпадает с валютой договора \(USD\)/),
    ]);
    expect(plan["currency"]).toMatchObject({ ref: USD, rate: 453.93 });
  });

  it("реализация в тенге — курс 1, регистр курсов не читается", async () => {
    const store = withInvoice(usdStore(), KZT, 1);
    Object.assign(store["Catalog_ДоговорыКонтрагентов"]![0]!, { ВалютаВзаиморасчетов_Key: KZT });
    store[INVOICE_SET]![0]!["СтруктурнаяЕдиница"] = BANK_ACC;
    const f = fake1C({ store });
    const plan = sc(await sale(f, { basis: INVOICE, date: "2026-10-12" }));
    expect(plan["currency"]).toMatchObject({ ref: KZT, rate: 1, multiplier: 1 });
    expect(plan["warnings"]).toBeUndefined();
    expect(f.gets.some((g) => g.includes("SliceLast"))).toBe(false);
  });

  it("курса на дату реализации нет — курс из счёта и предупреждение", async () => {
    const store = withInvoice(usdStore(), USD, 453.65);
    store["InformationRegister_КурсыВалют"] = store["InformationRegister_КурсыВалют"]!.filter(
      (r) => r["Валюта_Key"] !== USD,
    );
    const f = fake1C({ store });
    const plan = sc(await sale(f, { basis: INVOICE, date: "2026-10-12" }));
    expect(plan["currency"]).toMatchObject({ rate: 453.65 });
    expect(plan["warnings"].join(" ")).toMatch(/нет курса USD на 2026-10-12/);
  });

  it("без основания — валюта договора и курс регистра на дату реализации", async () => {
    const f = fake1C({ store: withInvoice(usdStore(), USD, 453.65) });
    const plan = sc(
      await sale(f, {
        buyer: BIN,
        date: "2026-10-12",
        lines: [{ name: SERVICE_NAME, quantity: 1, price: 672.64, kind: "service" }],
      }),
    );
    expect(plan["currency"]).toMatchObject({ ref: USD, rate: 453.93 });
    expect(plan["bankAccount"]).toBe(USD_ACC);
  });
});
