import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { copyRows, fixSubconto, operationKind, pickSample } from "../src/tools/quick-sale.js";
import {
  BANK_ACC,
  BIN,
  BUYER,
  CONTRACT,
  KZT,
  ORG,
  SERVICE,
  SERVICE_NAME,
  UNIT,
  VAT_NONE,
  baseStore,
  fake1C,
  id,
  type Row,
  type Store,
} from "./support/fake-1c.js";

/** write.sales.quick_sale на «1С в памяти» (test/support/fake-1c.ts). */

const INVOICE = id(30);
const OTHER_INVOICE = id(31);
const SALE18 = id(40);
const USER = id(50);
const PERSON = id(51);
const GROUP = id(52);
const ACC_INCOME = id(60);
const GOODS = id(70);
const WAREHOUSE = id(71);
const BASIS_TYPE = "StandardODATA.Document_СчетНаОплатуПокупателю";
const SALE_SET = "Document_РеализацияТоваровУслуг";

const serviceRow = (sum: number): Row => ({
  LineNumber: 1,
  Номенклатура_Key: SERVICE,
  Содержание: SERVICE_NAME,
  Количество: 1,
  Цена: sum,
  Сумма: sum,
  СтавкаНДС_Key: VAT_NONE,
  СуммаНДС: 0,
});

function saleStore(): Store {
  const store = baseStore();
  Object.assign(store["Catalog_Организации"]![0]!, { ИндивидуальныйПредприниматель_Key: PERSON });
  Object.assign(store["Catalog_Номенклатура"]![0]!, { НоменклатурнаяГруппа_Key: GROUP });
  store["Catalog_Номенклатура"]!.push({
    Ref_Key: GOODS,
    Code: "00000000020",
    Description: "Кабель UTP",
    НаименованиеПолное: "Кабель UTP cat.6",
    Услуга: false,
    БазоваяЕдиницаИзмерения_Key: UNIT,
    НоменклатурнаяГруппа_Key: GROUP,
    IsFolder: false,
    DeletionMark: false,
  });
  store["Catalog_Пользователи"] = [{ Ref_Key: USER, Description: "Автоматический REST-сервис" }];
  store["Catalog_ФизическиеЛица"] = [{ Ref_Key: PERSON, Description: "Жумабекова Алина Ерлановна" }];
  store["Catalog_Склады"] = [{ Ref_Key: WAREHOUSE, Description: "Основной склад", DeletionMark: false }];
  store["Document_СчетНаОплатуПокупателю"] = [
    {
      Ref_Key: INVOICE,
      Number: "00000000003",
      Date: "2026-10-08T12:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      КурсВзаиморасчетов: 1,
      КратностьВзаиморасчетов: 1,
      Ответственный_Key: USER,
      УчитыватьНДС: false,
      СуммаВключаетНДС: true,
      СтруктурнаяЕдиница: BANK_ACC,
      СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
      СуммаДокумента: 1550000,
      Услуги: [serviceRow(1550000)],
      Товары: [],
      ОС: [],
    },
    {
      Ref_Key: OTHER_INVOICE,
      Number: "00000000006",
      Date: "2026-10-08T13:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      СуммаДокумента: 1000000,
      Услуги: [serviceRow(1000000)],
      Товары: [],
    },
  ];
  store[SALE_SET] = [
    {
      Ref_Key: SALE18,
      Number: "00000000018",
      Date: "2026-10-08T15:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      СуммаДокумента: 1000000,
      ДокументОснование: OTHER_INVOICE,
      ДокументОснование_Type: BASIS_TYPE,
      УчитыватьКПН: true,
      Услуги: [
        {
          ...serviceRow(1000000),
          СчетДоходовБУ_Key: ACC_INCOME,
          Субконто1: id(99),
          Субконто1_Type: "StandardODATA.Catalog_Номенклатура",
          Субконто2: id(98),
          Субконто2_Type: "StandardODATA.Catalog_НоменклатурныеГруппы",
        },
      ],
      Товары: [],
    },
  ];
  return store;
}

/** Метаданные реализации с табличными частями и счетами — как их видит fillFromSample. */
async function withSaleMeta(f: ReturnType<typeof fake1C>) {
  const meta = await f.conn.getMetadata();
  const entities = meta.entities as Map<string, unknown>;
  const p = (name: string, type = "Edm.String") => ({ name, type });
  entities.set(SALE_SET, {
    entitySet: SALE_SET,
    properties: [
      ...["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "СуммаДокумента"].map(
        (n) => p(n),
      ),
      p("УчитыватьКПН", "Edm.Boolean"),
      p("Услуги", `Collection(StandardODATA.${SALE_SET}_Услуги_RowType)`),
      p("Товары", `Collection(StandardODATA.${SALE_SET}_Товары_RowType)`),
    ],
    navigations: [],
  });
  const rowMeta = (account: string) => ({
    properties: ["Субконто1", "Субконто1_Type", "Субконто2", "Субконто2_Type"].map((n) => p(n)),
    navigations: [{ name: account, toType: "StandardODATA.ChartOfAccounts_Типовой" }],
  });
  entities.set(`${SALE_SET}_Услуги`, rowMeta("СчетДоходовБУ"));
  entities.set(`${SALE_SET}_Товары`, rowMeta("СчетУчетаБУ"));
  return f;
}

const make = async (opts: { store?: Store; readOnly?: boolean } = {}) =>
  withSaleMeta(fake1C({ store: opts.store ?? saleStore(), readOnly: opts.readOnly }));
const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const errText = (r: CallToolResult) => JSON.stringify(r.content);
const quick = (f: Awaited<ReturnType<typeof make>>, args: Row) => f.call("write.sales.quick_sale", args);
const ON_BASIS = { basis: INVOICE, date: "2026-10-08" };

describe("quick_sale: помощники", () => {
  it("вид операции по составу строк — как в 1С", () => {
    expect(operationKind(1, 0)).toBe("Товары");
    expect(operationKind(0, 2)).toBe("Услуги");
    expect(operationKind(1, 1)).toBe("ПродажаКомиссия");
  });
  it("копия строк счёта — только колонки реализации, по порядку LineNumber", () => {
    const rows = copyRows(
      [
        { LineNumber: 2, Содержание: "Б", Цена: 2, Лишнее: "x" },
        { LineNumber: 1, Содержание: "А", Цена: 1, Количество: null },
      ],
      ["Содержание", "Цена", "Количество"],
    );
    expect(rows).toEqual([
      { LineNumber: 1, Содержание: "А", Цена: 1 },
      { LineNumber: 2, Содержание: "Б", Цена: 2 },
    ]);
  });
  it("субконто «Номенклатура» и «Номенклатурные группы» — по позиции строки, прочие — как в образце", () => {
    const [r] = fixSubconto(
      [
        {
          Номенклатура_Key: SERVICE,
          Субконто1: "old",
          Субконто1_Type: "StandardODATA.Catalog_Номенклатура",
          Субконто2: "oldGroup",
          Субконто2_Type: "StandardODATA.Catalog_НоменклатурныеГруппы",
          Субконто3: "income",
          Субконто3_Type: "StandardODATA.Catalog_ПрочиеДоходыИРасходы",
        },
      ],
      new Map([[SERVICE, GROUP]]),
    );
    expect(r).toMatchObject({ Субконто1: SERVICE, Субконто2: GROUP, Субконто3: "income" });
  });
  it("образец: та же организация, не помечен, со счетами в строках; проведённый — в приоритете", () => {
    const row = { СчетДоходовБУ_Key: ACC_INCOME };
    const c = [
      { Ref_Key: "a", Организация_Key: ORG, Услуги: [row], Posted: false },
      { Ref_Key: "b", Организация_Key: ORG, Услуги: [row], Posted: true, DeletionMark: true },
      { Ref_Key: "c", Организация_Key: id(77), Услуги: [row], Posted: true },
      { Ref_Key: "d", Организация_Key: ORG, Услуги: [row], Posted: true },
    ];
    expect(pickSample(c, ORG, "Услуги")?.["Ref_Key"]).toBe("d");
    expect(pickSample(c.slice(0, 3), ORG, "Услуги")?.["Ref_Key"]).toBe("a");
    expect(pickSample(c, ORG, "Товары")).toBeUndefined();
  });
});

describe("quick_sale: план на основании счёта (confirm=false)", () => {
  it("заполняет как 1С: шапка и строки из счёта, валюта из договора, банк — структурная единица, ДокументОснование", async () => {
    const store = saleStore();
    Object.assign(store["Catalog_ДоговорыКонтрагентов"]![0]!, { ВалютаВзаиморасчетов_Key: KZT });
    const f = await make({ store });
    const res = await quick(f, ON_BASIS);
    expect(res.isError).toBeFalsy();
    const plan = sc(res);
    expect(plan).toMatchObject({
      dryRun: true,
      ready: true,
      mode: "на основании счёта",
      basis: { ref: INVOICE, number: "3", date: "2026-10-08", total: 1550000, posted: false },
      buyer: { ref: BUYER, bin: BIN },
      contract: { action: "найден", ref: CONTRACT },
      operationKind: "Услуги",
      bankAccount: BANK_ACC,
      lines: [{ kind: "услуга", nomenclatureRef: SERVICE, content: SERVICE_NAME, quantity: 1, sum: 1550000 }],
      totals: { total: 1550000, withVat: false },
      accountsSample: { ref: SALE18, number: "18", posted: false, tables: ["Услуги"] },
      possibleDuplicates: [],
    });
    expect(plan["operationId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan["willCreate"]).toEqual(["Реализация товаров и услуг (без проведения) + PDF (акт Р-1)"]);
    // № 18 — на основании другого счёта и на другую сумму: не дубль, но упомянута.
    expect(plan["notes"].join(" ")).toMatch(/№ 18 на 1000000, основание — счёт ref/);
    expect(f.posts).toEqual([]);
  });

  it("confirm=true: реализация без проведения с ДокументОснование, счетами и субконто из образца; PDF акта; повтор — без дубликата", async () => {
    const f = await make();
    const plan = sc(await quick(f, ON_BASIS));
    const done = await quick(f, { ...ON_BASIS, confirm: true, operationId: plan["operationId"] });
    expect(done.isError).toBeFalsy();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.set).toBe(SALE_SET);
    const body = f.posts[0]!.body;
    expect(body).toMatchObject({
      Date: "2026-10-08T00:00:00",
      Posted: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      Ответственный_Key: USER,
      БанковскийСчетОрганизации_Key: BANK_ACC,
      ДокументОснование: INVOICE,
      ДокументОснование_Type: BASIS_TYPE,
      ВидОперации: "Услуги",
      СпособВыпискиАктовВыполненныхРабот: "ВБумажномВиде",
      ДатаПодписанияГЗ: "2026-10-08T00:00:00",
      СуммаДокумента: 1550000,
      УчитыватьКПН: true,
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Содержание: SERVICE_NAME,
          Количество: 1,
          Цена: 1550000,
          Сумма: 1550000,
          СчетДоходовБУ_Key: ACC_INCOME,
          Субконто1: SERVICE,
          Субконто2: GROUP,
        },
      ],
    });
    expect(body).not.toHaveProperty("Товары");
    expect(body).not.toHaveProperty("Склад_Key");
    const out = sc(done);
    expect(out).toMatchObject({
      created: true,
      sale: { posted: false, total: 1550000, operationKind: "Услуги" },
    });
    const file = out["pdf"].files[0];
    expect(file).toMatchObject({ form: "Р-1" });
    expect(file.path).toMatch(/акты\/Акт выполненных работ Р-1 № \d+ от 08\.10\.2026\.pdf$/);
    expect(readFileSync(file.path).subarray(0, 4).toString()).toBe("%PDF");
    expect(out["notes"].join(" ")).toMatch(/без проведения/);

    const again = sc(await quick(f, { ...ON_BASIS, confirm: true, operationId: plan["operationId"] }));
    expect(again).toMatchObject({ created: true, replayed: true, sale: { ref: out["sale"].ref } });
    expect(f.posts).toHaveLength(1);
  });

  it("счёт по номеру и дате; дубль same_basis (на основании того же счёта) — в плане и в note", async () => {
    const f = await make();
    const plan = sc(await quick(f, { basis: "6", basisDate: "2026-10-08", date: "2026-10-08" }));
    expect(plan).toMatchObject({
      ready: true,
      basis: { ref: OTHER_INVOICE, number: "6" },
      possibleDuplicates: [
        {
          number: "18",
          date: "2026-10-08",
          ref: SALE18,
          total: 1000000,
          posted: false,
          reason: "same_basis",
        },
      ],
    });
    expect(plan["note"]).toMatch(/ВОЗМОЖНЫЙ ДУБЛЬ: № 18/);
    expect(plan["operationId"]).toBeTruthy();
  });

  it("помеченная на удаление реализация дублем не считается; помеченный счёт — ошибка", async () => {
    const store = saleStore();
    store[SALE_SET]![0]!["DeletionMark"] = true;
    const f = await make({ store });
    const plan = sc(await quick(f, { basis: OTHER_INVOICE, date: "2026-10-08" }));
    expect(plan["possibleDuplicates"]).toEqual([]);
    expect(plan["notes"].join(" ")).toMatch(/помечены на удаление — не учитывались/);

    store["Document_СчетНаОплатуПокупателю"]![0]!["DeletionMark"] = true;
    const res = await quick(f, ON_BASIS);
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/помечен на удаление/);
  });

  it("договор другой организации не переносится — выбор; госучреждение — АВР на портале госзакупа", async () => {
    const store = saleStore();
    store["Catalog_ДоговорыКонтрагентов"]![0]!["Организация_Key"] = id(77);
    const plan = sc(await quick(await make({ store }), ON_BASIS));
    expect(plan).toMatchObject({ ready: false, choices: [{ field: "contract" }] });
    expect(plan).not.toHaveProperty("operationId");

    const gov = saleStore();
    gov["Catalog_Контрагенты"]![0]!["ГосударственноеУчреждение"] = true;
    const f = await make({ store: gov });
    const p = sc(await quick(f, { ...ON_BASIS, print: "none" }));
    await quick(f, { ...ON_BASIS, print: "none", confirm: true, operationId: p["operationId"] });
    expect(f.posts[0]!.body).toMatchObject({ СпособВыпискиАктовВыполненныхРабот: "НаПорталеГосЗакупа" });
    expect(f.posts[0]!.body).not.toHaveProperty("ДатаПодписанияГЗ");
  });

  it("товары и услуги в счёте — «Продажа, комиссия», склад единственный, Р-1 и З-2 в своих подкаталогах", async () => {
    const store = saleStore();
    const inv = store["Document_СчетНаОплатуПокупателю"]![0]!;
    inv["Товары"] = [
      {
        LineNumber: 1,
        Номенклатура_Key: GOODS,
        ЕдиницаИзмерения_Key: UNIT,
        Коэффициент: 1,
        Количество: 10,
        Цена: 5000,
        Сумма: 50000,
        СтавкаНДС_Key: VAT_NONE,
        СуммаНДС: 0,
      },
    ];
    inv["СуммаДокумента"] = 1600000;
    const f = await make({ store });
    const plan = sc(await quick(f, ON_BASIS));
    expect(plan).toMatchObject({ ready: true, operationKind: "ПродажаКомиссия", warehouse: WAREHOUSE });
    expect(plan["notes"].join(" ")).toMatch(/Нет реализации этой организации со строками товаров/);
    const done = sc(await quick(f, { ...ON_BASIS, confirm: true, operationId: plan["operationId"] }));
    expect(f.posts[0]!.body).toMatchObject({
      Склад_Key: WAREHOUSE,
      Товары: [{ Номенклатура_Key: GOODS, Количество: 10, ЕдиницаИзмерения_Key: UNIT }],
    });
    const forms = done["pdf"].files.map((x: Row) => [
      x["form"],
      String(x["path"]).split("/").slice(-2, -1)[0],
    ]);
    expect(forms).toEqual([
      ["Р-1", "акты"],
      ["З-2", "накладные"],
    ]);
  });

  it("только-чтение: план строится, confirm отклоняется, в 1С ничего не пишется", async () => {
    const f = await make({ readOnly: true });
    const plan = sc(await quick(f, ON_BASIS));
    expect(plan).toMatchObject({ ready: true });
    expect(String(plan["note"])).toMatch(/только-чтение/);
    const res = await quick(f, { ...ON_BASIS, confirm: true, operationId: plan["operationId"] });
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/только-чтение/);
    expect(f.posts).toEqual([]);
  });

  it("basis вместе с buyer/lines — ошибка ввода; без плана с этим operationId — ничего не создаётся", async () => {
    const f = await make();
    const bad = await quick(f, { ...ON_BASIS, buyer: BIN });
    expect(bad.isError).toBe(true);
    const stranger = await quick(f, {
      ...ON_BASIS,
      confirm: true,
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(stranger.isError).toBe(true);
    expect(errText(stranger)).toMatch(/не подготовлен планом/);
    expect(f.posts).toEqual([]);
  });
});

describe("quick_sale: без основания", () => {
  const DIRECT = {
    buyer: BIN,
    date: "2026-10-08",
    lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000000, kind: "service" }],
  };
  it("покупатель по БИН и строки — как quick_invoice; дубль same_day_sum (тот же день и сумма)", async () => {
    const f = await make();
    const plan = sc(await quick(f, { ...DIRECT, print: "none" }));
    expect(plan).toMatchObject({
      ready: true,
      mode: "без основания",
      buyer: { ref: BUYER },
      contract: { action: "найден", ref: CONTRACT },
      operationKind: "Услуги",
      lines: [{ nomenclatureRef: SERVICE, sum: 1000000 }],
      possibleDuplicates: [{ ref: SALE18, reason: "same_day_sum" }],
    });
    const done = sc(
      await quick(f, { ...DIRECT, confirm: true, operationId: plan["operationId"], print: "none" }),
    );
    expect(done).toMatchObject({ created: true, possibleDuplicates: [{ ref: SALE18 }] });
    expect(done["notes"].join(" ")).toMatch(/создана ещё одна реализация/);
    expect(f.posts[0]!.body).toMatchObject({ Контрагент_Key: BUYER, СуммаДокумента: 1000000 });
    expect(f.posts[0]!.body).not.toHaveProperty("ДокументОснование");
    expect(done).not.toHaveProperty("pdf");
  });
});
