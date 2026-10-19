/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import { odataTypeOf } from "../src/tools/chart.js";
import { aggregateByCurrency } from "../src/tools/registers.js";
import {
  baseStore,
  fake1C,
  id,
  ORG,
  BUYER,
  KZT,
  SERVICE,
  UNIT,
  VAT16,
  VAT_NONE,
  type Row,
} from "./support/fake-1c.js";

/**
 * Пакет 2: план счетов, регистры сведений и курсы валют, проводки ручной операции (набор записей регистра
 * бухгалтерии), ЭСФ/ЭАВР по основанию, «Ценные бумаги», валютные суммы ОСВ. 1С — fake1C.
 */

const EMPTY = "00000000-0000-0000-0000-000000000000";
const USD = id(20);
const K_BANK = id(30);
const K_CP = id(31);
const K_NOM = id(32);
const K_PAY = id(33);
const K_ANY = id(34);
const A1030 = id(40);
const A3310 = id(41);
const A3380 = id(42);
const A3381 = id(43);
const A1330 = id(44);
const A001 = id(45);
const A7210 = id(46);
const OP = id(50);
const OP_DEL = id(51);
const BANK_ACC = id(5);
const REG = "AccountingRegister_Типовой";
const EXT = `${REG}/RecordsWithExtDimensions`;

const acc = (ref: string, code: string, o: Row = {}): Row => ({
  Ref_Key: ref,
  Code: code,
  Description: `Счёт ${code}`,
  Parent_Key: EMPTY,
  Type: "ActivePassive",
  OffBalance: false,
  DeletionMark: false,
  Валютный: false,
  Количественный: false,
  ЗапретитьИспользоватьВПроводках: false,
  ExtDimensionTypes: [],
  ...o,
});
const dim = (n: number, kind: string, o: Row = {}): Row => ({
  LineNumber: String(n),
  ExtDimensionType_Key: kind,
  TurnoversOnly: false,
  Суммовой: true,
  Валютный: false,
  Количественный: false,
  ...o,
});

function store(): Record<string, Row[]> {
  const s = baseStore();
  s["Catalog_Валюты"]!.push({ Ref_Key: USD, Code: "840", Description: "USD" });
  s["Catalog_СтавкиНДС"] = [
    { Ref_Key: VAT16, Description: "16%", Ставка: 16 },
    { Ref_Key: VAT_NONE, Description: "Без НДС" },
  ];
  return {
    ...s,
    ChartOfAccounts_Типовой: [
      acc(A001, "001", { OffBalance: true, Type: "Active" }),
      acc(A1030, "1030", {
        Type: "Active",
        Валютный: true,
        ExtDimensionTypes: [dim(1, K_BANK, { Валютный: true })],
      }),
      acc(A1330, "1330", { Type: "Active", Количественный: true, ExtDimensionTypes: [dim(1, K_NOM)] }),
      acc(A3310, "3310", { Type: "Passive", ExtDimensionTypes: [dim(1, K_CP), dim(2, K_ANY)] }),
      acc(A3380, "3380", { ЗапретитьИспользоватьВПроводках: true }),
      acc(A3381, "3381", { Parent_Key: A3380 }),
      acc(A7210, "7210", { Type: "Active", ExtDimensionTypes: [dim(1, K_PAY)] }),
    ],
    ChartOfCharacteristicTypes_ВидыСубконтоТиповые: [
      {
        Ref_Key: K_BANK,
        Description: "Денежные средства",
        ValueType: { Types: ["CatalogRef.БанковскиеСчета"] },
      },
      { Ref_Key: K_CP, Description: "Контрагенты", ValueType: { Types: ["CatalogRef.Контрагенты"] } },
      { Ref_Key: K_NOM, Description: "Номенклатура", ValueType: { Types: ["CatalogRef.Номенклатура"] } },
      {
        Ref_Key: K_PAY,
        Description: "Виды платежей",
        ValueType: { Types: ["EnumRef.ВидыПлатежейВБюджетИФонды"] },
      },
      {
        Ref_Key: K_ANY,
        Description: "Договоры / организации",
        ValueType: { Types: ["CatalogRef.ДоговорыКонтрагентов", "CatalogRef.Организации"] },
      },
    ],
    [REG]: [],
    [EXT]: [],
    Document_ОперацияБух: [
      {
        Ref_Key: OP,
        Number: "00000000222",
        Date: "2026-10-12T12:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: ORG,
        СпособЗаполнения: "Вручную",
        СуммаОперации: 0,
      },
      {
        Ref_Key: OP_DEL,
        Number: "00000000230",
        Date: "2026-10-12T12:00:00",
        Posted: false,
        DeletionMark: true,
        Организация_Key: ORG,
        СпособЗаполнения: "Вручную",
        СуммаОперации: 0,
      },
    ],
    InformationRegister_КурсыВалют: [
      { Period: "2026-10-12T00:00:00", Валюта_Key: USD, Курс: 450, Кратность: "1" },
      { Period: "2026-10-11T00:00:00", Валюта_Key: USD, Курс: 449, Кратность: "1" },
    ],
    "InformationRegister_КурсыВалют/SliceLast": [
      { Period: "2026-10-12T00:00:00", Валюта_Key: USD, Курс: 450, Кратность: "1" },
    ],
    Catalog_ЦенныеБумаги: [
      { Ref_Key: id(60), Code: "000000001", Description: "Облигации КЕГОК", DeletionMark: false },
    ],
  };
}

const entities = {
  ChartOfAccounts_Типовой: { properties: [] },
  InformationRegister_КурсыВалют: {
    properties: [
      { name: "Period", type: "Edm.DateTime" },
      { name: "Валюта_Key", type: "Edm.Guid" },
      { name: "Курс", type: "Edm.Double" },
      { name: "Кратность", type: "Edm.Int64" },
    ],
  },
  InformationRegister_АктуальныеЭСФ: {
    properties: [
      { name: "СчетФактура", type: "Edm.String" },
      { name: "СчетФактура_Type", type: "Edm.String" },
      { name: "ЭСФ_Key", type: "Edm.Guid" },
      { name: "Пароль", type: "Edm.String" },
    ],
  },
  InformationRegister_АвторизацияВСервисе: { properties: [{ name: "Логин", type: "Edm.String" }] },
};

const make = (o: { writable?: boolean; dropSubcontoOnPut?: boolean; extra?: Record<string, Row[]> } = {}) =>
  fake1C({
    store: { ...store(), ...(o.extra ?? {}) },
    entities,
    ...(o.writable !== undefined ? { writable: o.writable } : {}),
    ...(o.dropSubcontoOnPut ? { dropSubcontoOnPut: true } : {}),
  });
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");
const sc = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;

describe("план счетов", () => {
  it("odataTypeOf: CatalogRef / DocumentRef / EnumRef", () => {
    expect(odataTypeOf("CatalogRef.Контрагенты")).toEqual({ entity: "Catalog_Контрагенты", kind: "catalog" });
    expect(odataTypeOf("DocumentRef.ГТДИмпорт")).toEqual({ entity: "Document_ГТДИмпорт", kind: "document" });
    expect(odataTypeOf("EnumRef.ВидыПлатежей")).toEqual({ entity: "ВидыПлатежей", kind: "enum" });
    expect(odataTypeOf("String").kind).toBe("other");
  });

  it("get_account: вид, валютный учёт, субконто с типами, субсчета", async () => {
    const f = make();
    const a = sc(await f.call("read.accounting.get_account", { account: "1030" }))["account"];
    expect(a).toMatchObject({ code: "1030", typeShort: "А", currency: true, quantity: false });
    expect(a.subconto[0]).toMatchObject({
      index: 1,
      kind: "Денежные средства",
      types: ["Catalog_БанковскиеСчета"],
    });
    const g = sc(await f.call("read.accounting.get_account", { account: "3380" }))["account"];
    expect(g).toMatchObject({ forbiddenInEntries: true, subaccounts: ["3381"] });
    const sub = sc(await f.call("read.accounting.get_account", { account: "3381" }))["account"];
    expect(sub.parentCode).toBe("3380");
    expect(text(await f.call("read.accounting.get_account", { account: "9999" }))).toMatch(/не найден/);
  });

  it("get_chart_of_accounts: фильтры currencyOnly / quantityOnly / codePrefix", async () => {
    const f = make();
    const cur = sc(await f.call("read.accounting.get_chart_of_accounts", { currencyOnly: true }));
    expect(cur["accounts"].map((a: any) => a.code)).toEqual(["1030"]);
    const q = sc(await f.call("read.accounting.get_chart_of_accounts", { quantityOnly: true }));
    expect(q["accounts"].map((a: any) => a.code)).toEqual(["1330"]);
    const p = sc(await f.call("read.accounting.get_chart_of_accounts", { codePrefix: "33" }));
    expect(p["accounts"].map((a: any) => a.code)).toEqual(["3310", "3380", "3381"]);
    expect(p["accounts"].find((a: any) => a.code === "3380").hasSubaccounts).toBe(true);
  });
});

describe("регистры сведений и курсы валют", () => {
  it("get_rates: срез последних, perUnit = Курс / Кратность", async () => {
    const r = sc(await make().call("read.currency.get_rates", { date: "2026-10-12", currencies: ["USD"] }));
    expect(r["rates"]).toEqual([
      expect.objectContaining({ code: "840", name: "USD", period: "2026-10-12", rate: 450, perUnit: 450 }),
    ]);
  });

  it("get_rates: период from/to — строки регистра", async () => {
    const r = sc(
      await make().call("read.currency.get_rates", {
        from: "2026-10-01",
        to: "2026-10-12",
        currencies: ["840"],
      }),
    );
    expect(r["rates"]).toHaveLength(2);
    expect(text(await make().call("read.currency.get_rates", { currencies: ["XXX"] }))).toMatch(/не найдена/);
  });

  it("get_information_register: отбор по GUID на стороне 1С, типизированный литерал", async () => {
    const f = make();
    const r = sc(
      await f.call("read.register.get_information_register", {
        register: "КурсыВалют",
        filters: [{ field: "Валюта_Key", op: "eq", value: USD }],
        from: "2026-10-12",
      }),
    );
    expect(r).toMatchObject({ register: "InformationRegister_КурсыВалют", periodic: true, count: 1 });
    expect(decodeURIComponent(f.gets.at(-1)!)).toContain(`Валюта_Key eq guid'${USD}'`);
    expect(
      text(
        await f.call("read.register.get_information_register", {
          register: "КурсыВалют",
          filters: [{ field: "Курс", op: "gt", value: "abc" }],
        }),
      ),
    ).toMatch(/не число/);
    expect(
      text(
        await f.call("read.register.get_information_register", {
          register: "КурсыВалют",
          filters: [{ field: "Нет", op: "eq", value: "1" }],
        }),
      ),
    ).toMatch(/нет поля/);
  });

  it("составное поле — отбор на стороне MCP; секретные колонки вырезаются; служебный регистр закрыт", async () => {
    const f = make({
      extra: {
        InformationRegister_АктуальныеЭСФ: [
          {
            СчетФактура: id(70),
            СчетФактура_Type: "StandardODATA.Document_СчетФактураПолученный",
            ЭСФ_Key: id(71),
            Пароль: "x",
          },
          {
            СчетФактура: id(72),
            СчетФактура_Type: "StandardODATA.Document_СчетФактураПолученный",
            ЭСФ_Key: id(73),
            Пароль: "y",
          },
        ],
        InformationRegister_АвторизацияВСервисе: [{ Логин: "a" }],
      },
    });
    const r = sc(
      await f.call("read.register.get_information_register", {
        register: "InformationRegister_АктуальныеЭСФ",
        filters: [{ field: "СчетФактура", op: "eq", value: id(72) }],
      }),
    );
    expect(r["count"]).toBe(1);
    expect(r["rows"][0]["ЭСФ_Key"]).toBe(id(73));
    expect(r["rows"][0]).not.toHaveProperty("Пароль");
    expect(r["notes"].join(" ")).toMatch(/на стороне MCP/);
    expect(
      text(await f.call("read.register.get_information_register", { register: "АвторизацияВСервисе" })),
    ).toMatch(/чтение закрыто/);
  });
});

describe("write.accounting.set_operation_entries", () => {
  const usdEntry = {
    debit: "1030",
    credit: "3310",
    amount: 45000,
    debitSubconto: [BANK_ACC],
    creditSubconto: [BUYER],
    debitCurrency: "USD",
    debitCurrencyAmount: 100,
    content: "Поступление USD",
  };
  const set = (f: ReturnType<typeof make>, args: Row) =>
    f.call("write.accounting.set_operation_entries", { documentRef: OP, ...args });

  it("предпросмотр: таблица проводок, курс сверен, ничего не пишется", async () => {
    const f = make();
    const r = await set(f, { entries: [usdEntry] });
    expect(r.isError).toBeFalsy();
    const d = sc(r);
    expect(d["dryRun"]).toBe(true);
    expect(d["entries"][0]).toMatchObject({
      amount: 45000,
      debit: { account: "1030", currency: "USD", currencyAmount: 100 },
      credit: { account: "3310" },
    });
    expect(d["entries"][0].credit.subconto[0]).toMatchObject({
      type: "Catalog_Контрагенты",
      name: 'ТОО "TRADESPACE"',
    });
    expect(d["checks"].join(" ")).toMatch(/согласуется с курсом USD 450/);
    expect(d["willPut"]).toContain(`Recorder=guid'${OP}'`);
    expect(f.puts).toHaveLength(0);
    expect(f.patches).toHaveLength(0);
  });

  it("confirm=true: PUT всего набора с субконто и валютой, перечитывание, СуммаОперации", async () => {
    const f = make();
    const r = await set(f, { entries: [usdEntry], confirm: true });
    expect(r.isError).toBeFalsy();
    expect(sc(r)).toMatchObject({ updated: true, verified: true, operationAmountUpdated: 45000 });
    expect(f.puts).toHaveLength(1);
    const body = f.puts[0]!.body as any;
    expect(body.Recorder_Type).toBe("StandardODATA.Document_ОперацияБух");
    expect(body.RecordSet[0]).toMatchObject({
      LineNumber: "1",
      AccountDr_Key: A1030,
      AccountCr_Key: A3310,
      Сумма: 45000,
      ExtDimensionDr1: BANK_ACC,
      ExtDimensionDr1_Type: "StandardODATA.Catalog_БанковскиеСчета",
      ExtDimensionTypeDr1_Key: K_BANK,
      ExtDimensionCr1: BUYER,
      ВалютаDr_Key: USD,
      ВалютнаяСуммаDr: 100,
      Организация_Key: ORG,
      Содержание: "Поступление USD",
    });
    expect(f.patches[0]!.body).toEqual({ СуммаОперации: 45000 });
  });

  it("тенге на валютном счёте — подставляются KZT и валютная сумма = сумме; курс расходится — предупреждение", async () => {
    const f = make();
    const d = sc(
      await set(f, {
        entries: [
          { debit: "1030", credit: "3310", amount: 1000, debitSubconto: [BANK_ACC], creditSubconto: [BUYER] },
          { ...usdEntry, amount: 50000 },
        ],
      }),
    );
    expect(d["entries"][0].debit).toMatchObject({ currency: "KZT", currencyAmount: 1000 });
    expect(d["warnings"].join(" ")).toMatch(/× 450 .* = 45 000,00 ₸, а сумма проводки 50 000,00/);
    void KZT;
  });

  it("enum-субконто строкой; несколько типов — нужен type; тип вне списка — отказ", async () => {
    const f = make();
    const ok1 = sc(
      await set(f, { entries: [{ debit: "7210", credit: "3381", amount: 10, debitSubconto: ["Налог"] }] }),
    );
    expect(ok1["entries"][0].debit.subconto[0]).toMatchObject({
      type: "ВидыПлатежейВБюджетИФонды",
      value: "Налог",
    });
    const amb = await set(f, {
      entries: [
        {
          debit: "1330",
          credit: "3310",
          amount: 10,
          debitQuantity: 1,
          debitSubconto: [SERVICE],
          creditSubconto: [BUYER, id(3)],
        },
      ],
    });
    expect(text(amb)).toMatch(/укажите type — допустимы: Catalog_ДоговорыКонтрагентов, Catalog_Организации/);
    const wrong = await set(f, {
      entries: [
        {
          debit: "1030",
          credit: "3310",
          amount: 10,
          debitSubconto: [{ value: BUYER, type: "Catalog_Контрагенты" }],
        },
      ],
    });
    expect(text(wrong)).toMatch(/не принимает тип Catalog_Контрагенты/);
    const okType = sc(
      await set(f, {
        entries: [
          {
            debit: "1330",
            credit: "3310",
            amount: 10,
            debitQuantity: 2,
            debitSubconto: [SERVICE],
            creditSubconto: [BUYER, { value: id(3), type: "Catalog_ДоговорыКонтрагентов" }],
          },
        ],
      }),
    );
    expect(okType["entries"][0].debit.quantity).toBe(2);
  });

  it("отказы: группа, нет счёта, несуществующее субконто, валюта/количество не по счёту, одна сторона, забаланс", async () => {
    const f = make();
    const cases: Array<[Row, RegExp]> = [
      [{ debit: "3380", credit: "3310", amount: 1 }, /3380.*(групп|запрещ).*3381|3381/],
      [{ debit: "9999", credit: "3310", amount: 1 }, /9999/],
      [{ debit: "3310", credit: "3381", amount: 1, debitSubconto: [id(999)] }, /не найден в базе/],
      [
        { debit: "3310", credit: "3381", amount: 1, debitCurrency: "USD", debitCurrencyAmount: 1 },
        /не ведёт валютный учёт/,
      ],
      [{ debit: "3310", credit: "3381", amount: 1, debitQuantity: 1 }, /не ведёт количественный учёт/],
      [{ debit: "3310", amount: 1 }, /без корреспондирующего счёта.*балансовый/],
      [{ debit: "001", credit: "3310", amount: 1 }, /забалансовый счёт не корреспондирует/],
      [{ debit: "1030", credit: "3310", amount: 1, debitCurrency: "USD" }, /укажите валютную сумму/],
      [{ debit: "1030", credit: "3310", amount: 1, debitSubconto: [BANK_ACC, BANK_ACC] }, /субконто/i],
    ];
    for (const [e, re] of cases) {
      const r = await set(f, { entries: [e] });
      expect(r.isError, JSON.stringify(e)).toBe(true);
      expect(text(r)).toMatch(re);
    }
    const off = sc(await set(f, { entries: [{ debit: "001", amount: 5 }] }));
    expect(off["dryRun"]).toBe(true);
    expect(f.puts).toHaveLength(0);
  });

  it("отказ: документ помечен на удаление; не «Вручную»; уже есть проводки без replaceExisting", async () => {
    const f = make();
    expect(text(await set(f, { documentRef: OP_DEL, entries: [usdEntry] }))).toMatch(/помечена на удаление/);
    f.store["Document_ОперацияБух"]![0]!["СпособЗаполнения"] = "Автоматически";
    expect(text(await set(f, { entries: [usdEntry] }))).toMatch(/Способ заполнения/);
    f.store["Document_ОперацияБух"]![0]!["СпособЗаполнения"] = "Вручную";
    f.store[EXT] = [
      { Recorder: OP, LineNumber: "1", Period: "2026-10-12T12:00:00", Сумма: 5, AccountDr_Key: A3310 },
    ];
    expect(text(await set(f, { entries: [usdEntry] }))).toMatch(
      /уже 1 проводок — для замены передайте replaceExisting/,
    );
    const d = sc(await set(f, { entries: [usdEntry], replaceExisting: true }));
    expect(d["warnings"].join(" ")).toMatch(/Будут заменены 1/);
  });

  it("1С не сохранила субконто: набор был пуст — откат пустым набором и ошибка", async () => {
    const f = make({ dropSubcontoOnPut: true });
    const r = await set(f, { entries: [usdEntry], confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/ExtDimensionDr1.*откатана \(набор проводок документа снова пуст\)/s);
    expect(f.puts).toHaveLength(2);
    expect((f.puts[1]!.body as any).RecordSet).toEqual([]);
    expect(f.patches).toHaveLength(0);
  });

  it("1С не сохранила субконто при замене: прежние проводки записываются обратно", async () => {
    const f = make({ dropSubcontoOnPut: true });
    const old = {
      Recorder: OP,
      Recorder_Type: "StandardODATA.Document_ОперацияБух",
      LineNumber: "1",
      Period: "2026-10-12T12:00:00",
      Сумма: 5,
      AccountDr_Key: A3310,
      AccountCr_Key: A3381,
      ExtDimensionDr1: BUYER,
      AccountDr: "lookup",
    };
    f.store[EXT] = [old];
    const r = await set(f, { entries: [usdEntry], replaceExisting: true, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/возвращены прежние 1 проводок/);
    const restored = (f.puts[1]!.body as any).RecordSet[0];
    expect(restored).toMatchObject({ Сумма: 5, AccountDr_Key: A3310, ExtDimensionDr1: BUYER });
    expect(restored).not.toHaveProperty("AccountDr");
  });

  it("без writable базы — не пишет", async () => {
    const f = make({ writable: false });
    const r = await set(f, { entries: [usdEntry], confirm: true });
    expect(r.isError).toBe(true);
    expect(f.puts).toHaveLength(0);
  });
});

describe("write.catalog.create_security", () => {
  it("дубль по наименованию (без учёта регистра) — отказ с Ref_Key; новое — предпросмотр", async () => {
    const f = make();
    const dup = await f.call("write.catalog.create_security", { name: "облигации  кегок" });
    expect(text(dup)).toMatch(new RegExp(`уже есть «Облигации КЕГОК».*${id(60)}`));
    const r = await f.call("write.catalog.create_security", { name: "Акции Казатомпром" });
    expect(sc(r)).toMatchObject({ dryRun: true, payload: { Description: "Акции Казатомпром" } });
    expect(f.posts).toHaveLength(0);
    const c = await f.call("write.catalog.create_security", {
      name: "Акции Казатомпром",
      confirm: true,
      operationId: sc(r)["operationId"],
    });
    expect(c.isError).toBeFalsy();
    expect(f.posts[0]).toMatchObject({
      set: "Catalog_ЦенныеБумаги",
      body: { Description: "Акции Казатомпром" },
    });
  });
});

describe("ЭСФ и ЭАВР по основанию", () => {
  const INV = id(80);
  const SALE = id(81);
  const sale = (o: Row = {}): Row => ({
    Ref_Key: SALE,
    Number: "00000000016",
    Date: "2026-10-08T10:00:00",
    Posted: true,
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: BUYER,
    ДоговорКонтрагента_Key: id(3),
    БанковскийСчетОрганизации_Key: BANK_ACC,
    СуммаВключаетНДС: false,
    СуммаДокумента: 116000,
    Товары: [],
    Услуги: [
      {
        LineNumber: "1",
        Номенклатура_Key: SERVICE,
        Содержание: "",
        Количество: 1,
        Цена: 100000,
        Сумма: 100000,
        СтавкаНДС_Key: VAT16,
        СуммаНДС: 16000,
      },
    ],
    ...o,
  });
  const inv = (o: Row = {}): Row => ({
    Ref_Key: INV,
    Number: "00000000002",
    Date: "2026-10-08T10:00:00",
    Posted: true,
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: BUYER,
    ДоговорКонтрагента_Key: id(3),
    ДокументОснование: SALE,
    ДокументОснование_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
    СчетОрганизации_Key: BANK_ACC,
    ВалютаДокумента_Key: KZT,
    КурсВзаиморасчетов: 1,
    ВидСчетаФактуры: "Обычный",
    СпособВыставления: "Электронно",
    СуммаВключаетНДС: false,
    СуммаДокумента: 116000,
    ДатаСовершенияОборотаПоРеализации: "2026-10-08T00:00:00",
    Товары: [],
    Услуги: (sale()["Услуги"] as Row[]).map((r) => ({ ...r })),
    ...o,
  });
  const esfMake = (extra: Record<string, Row[]> = {}) =>
    make({
      extra: {
        Document_ЭСФ: [],
        Document_СчетФактураВыданный: [inv()],
        Document_РеализацияТоваровУслуг: [sale()],
        Document_ЭлектронныйАктВыполненныхРабот: [],
        ...extra,
      },
    });

  it("ЭСФ по счёту-фактуре: шапка, поставщик, получатель, строки; без полей обмена; запись — только confirm", async () => {
    const f = esfMake();
    const r = await f.call("write.esf.create_draft", { basisRef: INV });
    expect(r.isError, text(r)).toBeFalsy();
    const p = sc(r)["payload"];
    expect(p).toMatchObject({
      Направление: "Исходящий",
      Вид: "Обычный",
      СчетФактура: INV,
      СчетФактура_Type: "StandardODATA.Document_СчетФактураВыданный",
      СуммаДокумента: 116000,
      ДатаОборота: "2026-10-08T00:00:00",
    });
    expect(p.Поставщики[0]).toMatchObject({
      ПоставщикИдентификатор: "123123123123",
      ИИК: "KZ86125KZT1004100100",
      БИК: "KCJBKZKX",
    });
    expect(p.Получатели[0]).toMatchObject({ ПолучательИдентификатор: "240440007327" });
    expect(p.Товары[0]).toMatchObject({ СуммаНДС: 16000, Сумма: 116000, СтавкаНДСЧисло: 16 });
    for (const k of ["РегистрационныйНомер", "Статус", "Состояние"]) expect(p).not.toHaveProperty(k);
    expect(sc(r)["notes"].join(" ")).toMatch(/Версия бланка ЭСФ не определена/);
    expect(f.posts).toHaveLength(0);
    const c = await f.call("write.esf.create_draft", {
      basisRef: INV,
      confirm: true,
      operationId: sc(r)["operationId"],
    });
    expect(c.isError, text(c)).toBeFalsy();
    expect(f.posts[0]!.set).toBe("Document_ЭСФ");
  });

  it("ЭСФ по реализации находит её счёт-фактуру; дубль — отказ; бумажная / не обычная — отказ", async () => {
    const f = esfMake();
    const r = await f.call("write.esf.create_draft", { basisRef: SALE });
    expect(sc(r)["payload"].СчетФактура).toBe(INV);
    f.store["Document_ЭСФ"]!.push({
      Ref_Key: id(85),
      Number: "3",
      Date: "2026-10-09T00:00:00",
      СчетФактура: INV,
      СчетФактура_Type: "StandardODATA.Document_СчетФактураВыданный",
      Статус: "Черновик",
      DeletionMark: false,
    });
    expect(text(await f.call("write.esf.create_draft", { basisRef: INV }))).toMatch(
      /уже есть ЭСФ.*Дубль не создаём/s,
    );
    const paper = esfMake({
      Document_СчетФактураВыданный: [inv({ СпособВыставления: "НаБумажномНосителе" })],
    });
    expect(text(await paper.call("write.esf.create_draft", { basisRef: INV }))).toMatch(/не электронно/);
    const fix = esfMake({ Document_СчетФактураВыданный: [inv({ ВидСчетаФактуры: "Исправленный" })] });
    expect(text(await fix.call("write.esf.create_draft", { basisRef: INV }))).toMatch(/только обычный ЭСФ/);
    const none = esfMake({ Document_СчетФактураВыданный: [] });
    expect(text(await none.call("write.esf.create_draft", { basisRef: SALE }))).toMatch(
      /нет счёта-фактуры выданного/,
    );
  });

  it("«Без НДС» → БезНДС, без ставки; нулевой БИН покупателя — предупреждение", async () => {
    const line = {
      LineNumber: "1",
      Номенклатура_Key: SERVICE,
      Количество: 1,
      Цена: 1000,
      Сумма: 1000,
      СтавкаНДС_Key: VAT_NONE,
      СуммаНДС: 0,
    };
    const f = esfMake({
      Document_СчетФактураВыданный: [inv({ Услуги: [line], СуммаДокумента: 1000 })],
    });
    f.store["Catalog_Контрагенты"]![0]!["ИдентификационныйКодЛичности"] = "000000000000";
    const d = sc(await f.call("write.esf.create_draft", { basisRef: INV }));
    expect(d["payload"].Товары[0]).toMatchObject({ БезНДС: true, СуммаНДС: 0 });
    expect(d["payload"].Товары[0]).not.toHaveProperty("СтавкаНДСЧисло");
    expect(d["notes"].join(" ")).toMatch(/не заполнен БИН\/ИИН \(000000000000\)/);
  });

  it("ЭАВР по реализации: исполнитель, заказчик, услуги, договор; товары — предупреждение; дубль — отказ", async () => {
    const f = esfMake({
      Document_РеализацияТоваровУслуг: [
        sale({
          Товары: [
            { LineNumber: "1", Номенклатура_Key: id(11), Количество: 1, Цена: 1, Сумма: 1, СуммаНДС: 0 },
          ],
        }),
      ],
    });
    const r = await f.call("write.avr.create_draft", { basisRef: SALE });
    expect(r.isError, text(r)).toBeFalsy();
    const d = sc(r);
    expect(d["payload"]).toMatchObject({
      Направление: "Исходящий",
      ТипАВР: "Первичный",
      Контрагент: BUYER,
      Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
      ДокументОснование: SALE,
    });
    expect(d["payload"].Услуги[0]).toMatchObject({
      Количество: 1,
      СтоимостьБезУчетаКосвенныхНалогов: 100000,
      СуммаНДС: 16000,
      СтоимостьСУчетомКосвенныхНалогов: 116000,
      ЕдиницаИзмерения_Key: UNIT,
    });
    expect(d["notes"].join(" ")).toMatch(/строк\(и\) товаров — в ЭАВР не включаются/);
    f.store["Document_ЭлектронныйАктВыполненныхРабот"]!.push({
      Ref_Key: id(86),
      Number: "1",
      Date: "2026-10-09T00:00:00",
      ДокументОснование: SALE,
      ДокументОснование_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
      DeletionMark: false,
    });
    expect(text(await f.call("write.avr.create_draft", { basisRef: SALE }))).toMatch(/уже есть ЭАВР/);
  });
});

describe("ОСВ: валютные суммы", () => {
  it("aggregateByCurrency: по валютам, без строк без валюты", () => {
    const row = (cur: string, cd: number, amt: number): Row => ({
      Валюта_Key: cur,
      ВалютнаяСуммаOpeningBalanceDr: 0,
      ВалютнаяСуммаOpeningBalanceCr: 0,
      ВалютнаяСуммаTurnoverDr: cd,
      ВалютнаяСуммаTurnoverCr: 0,
      ВалютнаяСуммаClosingBalanceDr: cd,
      ВалютнаяСуммаClosingBalanceCr: 0,
      СуммаOpeningBalanceDr: 0,
      СуммаOpeningBalanceCr: 0,
      СуммаTurnoverDr: amt,
      СуммаTurnoverCr: 0,
      СуммаClosingBalanceDr: amt,
      СуммаClosingBalanceCr: 0,
    });
    const g = aggregateByCurrency([
      row(USD, 100, 45000),
      row(USD, 50.5, 22725),
      row(KZT, 10, 10),
      { Сумма: 1 },
    ]);
    expect(g).toHaveLength(2);
    const usd = g.find((x) => x.currencyRef === USD)!;
    expect(usd.currency.turnoverDr).toBe(15050);
    expect(usd.amount.turnoverDr).toBe(6772500);
  });
});
