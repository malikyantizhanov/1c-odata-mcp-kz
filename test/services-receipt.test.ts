import { describe, expect, it } from "vitest";
import { baseStore, BUYER, CONTRACT, fake1C, id, ORG, SERVICE, type Row } from "./support/fake-1c.js";

/**
 * Поступление услуг с аналитикой затрат: статья затрат и подразделение — субконто счёта затрат, составная ссылка
 * (значение + _Type). Форма сверена с поступлениями, созданными в 1С (Aru Market): СубконтоЗатратБУ1 + _Type
 * StandardODATA.Catalog_СтатьиЗатрат, СубконтоЗатратБУ2/3 — подразделение, номенклатурная группа.
 */

const KIND_ART = id(201);
const KIND_DEP = id(202);
const KIND_GRP = id(203);
const KIND_CP = id(204);
const ACC_7310 = id(247); // 1 Статьи затрат, 2 Контрагенты
const ART_PROCHIE = id(211);
const ART_BANK = id(212);
const ART_PENYA1 = id(213);
const ART_PENYA2 = id(214);
const DEP_ADM = id(221);
const DEP_SALES = id(222);
const GRP = id(231);
const ACC_7210 = id(241); // субконто: 1 Статьи затрат, 2 Подразделения
const ACC_7110 = id(242); // только Подразделения
const ACC_3310 = id(243);
const ACC_1610 = id(244);
const ACC_7210N = id(245); // налоговый: Статьи затрат
const ACC_8110 = id(246); // 1 Статьи затрат, 2 Номенклатурные группы, 3 Подразделения
const CUR = id(251);

const dims = (...keys: string[]) =>
  keys.map((k, i) => ({ LineNumber: String(i + 1), ExtDimensionType_Key: k }));
const TYPE = (e: string) => `StandardODATA.${e}`;
const ROW = "Document_ПоступлениеТоваровУслуг_Услуги";

const rowProps = [
  "Ref_Key",
  "LineNumber",
  "Номенклатура_Key",
  "Содержание",
  "Количество",
  "Цена",
  "Сумма",
  "СтавкаНДС_Key",
  "СуммаНДС",
  "СчетЗатратБУ_Key",
  "СчетЗатратНУ_Key",
  ...["БУ", "НУ"].flatMap((s) =>
    [1, 2, 3].flatMap((n) => [`СубконтоЗатрат${s}${n}`, `СубконтоЗатрат${s}${n}_Type`]),
  ),
];
const docProps = [
  "Ref_Key",
  "Number",
  "Date",
  "Posted",
  "Организация_Key",
  "Контрагент_Key",
  "ДоговорКонтрагента_Key",
  "ВидОперации",
  "ВалютаДокумента_Key",
  "КурсВзаиморасчетов",
  "КратностьВзаиморасчетов",
  "Комментарий",
  "СуммаДокумента",
  "СуммаВключаетНДС",
  "НомерВходящегоДокумента",
  "ДатаВходящегоДокумента",
  "СчетУчетаРасчетовСКонтрагентом_Key",
  "СчетУчетаРасчетовПоАвансам_Key",
];

function setup() {
  const store = baseStore();
  const f = (Ref_Key: string, Description: string, extra: Row = {}) => ({
    Ref_Key,
    Description,
    IsFolder: false,
    DeletionMark: false,
    ...extra,
  });
  store["Catalog_СтатьиЗатрат"] = [
    f(ART_PROCHIE, "Прочие расходы", { Code: "00001" }),
    f(ART_BANK, "Комиссия банка", { Code: "00002" }),
    f(ART_PENYA1, "Пеня по ОПВ", { Code: "00003" }),
    f(ART_PENYA2, "Пеня по СО", { Code: "00004" }),
  ];
  store["Catalog_ПодразделенияОрганизаций"] = [f(DEP_ADM, "Администрация"), f(DEP_SALES, "Отдел продаж")];
  store["Catalog_НоменклатурныеГруппы"] = [f(GRP, "Услуги")];
  store["ChartOfCharacteristicTypes_ВидыСубконтоТиповые"] = [
    f(KIND_ART, "Статьи затрат"),
    f(KIND_DEP, "Подразделения"),
    f(KIND_GRP, "Номенклатурные группы"),
    f(KIND_CP, "Контрагенты"),
  ];
  store["ChartOfAccounts_Типовой"] = [
    { Ref_Key: ACC_7210, Code: "7210", ExtDimensionTypes: dims(KIND_ART, KIND_DEP) },
    { Ref_Key: ACC_7110, Code: "7110", ExtDimensionTypes: dims(KIND_DEP) },
    { Ref_Key: ACC_8110, Code: "8110", ExtDimensionTypes: dims(KIND_ART, KIND_GRP, KIND_DEP) },
    { Ref_Key: ACC_7310, Code: "7310", ExtDimensionTypes: dims(KIND_ART, KIND_CP) },
    { Ref_Key: ACC_3310, Code: "3310", ExtDimensionTypes: [] },
    { Ref_Key: ACC_1610, Code: "1610", ExtDimensionTypes: [] },
  ];
  store["ChartOfAccounts_Налоговый"] = [
    { Ref_Key: ACC_7210N, Code: "7210Н", ExtDimensionTypes: dims(KIND_ART) },
  ];
  store["Catalog_Валюты"] = [
    ...(store["Catalog_Валюты"] ?? []),
    { Ref_Key: CUR, Code: "840", Description: "USD" },
  ];
  store["Document_ПоступлениеТоваровУслуг"] = [];
  const chart = (to: string) => ({ name: "", toType: to, collection: false });
  const nav = (name: string, to: string) => ({ ...chart(to), name });
  const fake = fake1C({
    store,
    entities: {
      ChartOfAccounts_Типовой: { properties: [{ name: "Ref_Key" }, { name: "Code" }] },
      ChartOfAccounts_Налоговый: { properties: [{ name: "Ref_Key" }, { name: "Code" }] },
      Document_ПоступлениеТоваровУслуг: {
        properties: [
          ...docProps.map((name) => ({ name, type: "Edm.String" })),
          { name: "Услуги", type: `Collection(${TYPE(ROW)}_RowType)` },
        ],
        navigations: [
          nav("СчетУчетаРасчетовСКонтрагентом", "ChartOfAccounts_Типовой"),
          nav("СчетУчетаРасчетовПоАвансам", "ChartOfAccounts_Типовой"),
        ],
      },
      [ROW]: {
        properties: rowProps.map((name) => ({ name, type: "Edm.String" })),
        navigations: [
          nav("СчетЗатратБУ", "ChartOfAccounts_Типовой"),
          nav("СчетЗатратНУ", "ChartOfAccounts_Налоговый"),
        ],
      },
    },
  });
  return fake;
}

const base = {
  counterpartyRef: BUYER,
  contractRef: CONTRACT,
  date: "2026-10-15",
  lines: [{ nomenclatureRef: SERVICE, content: "Вознаграждение по займу", price: 125000 }],
  confirm: false,
};
type Res = {
  structuredContent?: unknown;
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};
const body = (r: Res) =>
  r.structuredContent as { payload: Row & { Услуги: Row[] }; notes?: string[]; dryRun?: boolean };
const text = (r: Res) => r.content.map((c) => c.text).join("\n");
const TOOL = "write.purchase.create_services_receipt";

describe("write.purchase.create_services_receipt", () => {
  it("статья затрат и подразделение по названию → субконто БУ с _Type; план ничего не пишет", async () => {
    const { call, posts } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7210",
      costArticle: "Прочие расходы",
      department: "Администрация",
      settlementAccount: "3310",
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    const b = body(res);
    expect(b.dryRun).toBe(true);
    expect(posts).toHaveLength(0);
    expect(b.payload).toMatchObject({
      ВидОперации: "Услуги",
      Контрагент_Key: BUYER,
      Организация_Key: ORG,
      СуммаДокумента: 125000,
      СчетУчетаРасчетовСКонтрагентом_Key: ACC_3310,
    });
    expect(b.payload.Услуги[0]).toMatchObject({
      Номенклатура_Key: SERVICE,
      Содержание: "Вознаграждение по займу",
      Количество: 1,
      Цена: 125000,
      Сумма: 125000,
      СчетЗатратБУ_Key: ACC_7210,
      СубконтоЗатратБУ1: ART_PROCHIE,
      СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
      СубконтоЗатратБУ2: DEP_ADM,
      СубконтоЗатратБУ2_Type: TYPE("Catalog_ПодразделенияОрганизаций"),
    });
    expect(b.payload.Услуги[0]).not.toHaveProperty("СубконтоЗатратБУ3");
    const notes = (b.notes ?? []).join("\n");
    expect(notes).toContain("1) Статьи затрат: «Прочие расходы» [Catalog_СтатьиЗатрат]");
    expect(notes).toContain("2) Подразделения: «Администрация» [Catalog_ПодразделенияОрганизаций]");
    expect(notes).not.toContain("не задан");
  });

  it("слот субконто определяет счёт: у 8110 подразделение — третье, группа — второе", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "8110",
      costArticle: ART_BANK,
      department: DEP_SALES,
      nomenclatureGroup: "Услуги",
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(body(res).payload.Услуги[0]).toMatchObject({
      СубконтоЗатратБУ1: ART_BANK,
      СубконтоЗатратБУ2: GRP,
      СубконтоЗатратБУ2_Type: TYPE("Catalog_НоменклатурныеГруппы"),
      СубконтоЗатратБУ3: DEP_SALES,
      СубконтоЗатратБУ3_Type: TYPE("Catalog_ПодразделенияОрганизаций"),
    });
  });

  it("предупреждает о незаданных счетах расчётов", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7210", costArticle: "банка" })) as Res;
    const notes = (body(res).notes ?? []).join("\n");
    expect(notes).toContain("Не заполнены счета расчётов");
    expect(notes).toContain("settlementAccount");
  });

  it("валюта, курс и кратность идут в шапку (ставка овернайт и курс — в комментарий)", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      currencyRef: CUR,
      exchangeRate: 523.45,
      rateMultiplicity: 1,
      comment: "Овернайт 15,5% × 30/365",
      advanceAccount: "1610",
      settlementAccount: "3310",
    })) as Res;
    expect(body(res).payload).toMatchObject({
      ВалютаДокумента_Key: CUR,
      КурсВзаиморасчетов: 523.45,
      КратностьВзаиморасчетов: 1,
      Комментарий: "Овернайт 15,5% × 30/365",
      СчетУчетаРасчетовПоАвансам_Key: ACC_1610,
    });
  });

  it("налоговый счёт: кладёт доступные субконто, об остальных говорит в notes", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7210",
      taxExpenseAccount: "7210Н",
      costArticle: ART_PROCHIE,
      department: DEP_ADM,
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    const row = body(res).payload.Услуги[0]!;
    expect(row).toMatchObject({
      СчетЗатратНУ_Key: ACC_7210N,
      СубконтоЗатратНУ1: ART_PROCHIE,
      СубконтоЗатратНУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
    });
    expect(row).not.toHaveProperty("СубконтоЗатратНУ2");
    expect((body(res).notes ?? []).join("\n")).toContain("нет субконто «подразделения»");
  });

  it("аналитика строки перекрывает аналитику документа", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7210",
      costArticle: "Прочие расходы",
      lines: [
        { nomenclatureRef: SERVICE, price: 10 },
        { nomenclatureRef: SERVICE, price: 20, quantity: 2, costArticle: "Комиссия банка" },
      ],
    })) as Res;
    const rows = body(res).payload.Услуги;
    expect(rows[0]!["СубконтоЗатратБУ1"]).toBe(ART_PROCHIE);
    expect(rows[1]!["СубконтоЗатратБУ1"]).toBe(ART_BANK);
    expect(rows[1]).toMatchObject({ Количество: 2, Сумма: 40 });
    expect(body(res).payload["СуммаДокумента"]).toBe(50);
  });

  it("статья не найдена — ошибка с подсказкой read.catalog.list_catalog", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7210",
      costArticle: "Вознаграждение по займу",
    })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("не найдена в Catalog_СтатьиЗатрат");
    expect(text(res)).toContain("read.catalog.list_catalog");
  });

  it("неоднозначное название — список вариантов", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7210", costArticle: "Пеня" })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("неоднозначна");
    expect(text(res)).toContain("Пеня по ОПВ");
    expect(text(res)).toContain("Пеня по СО");
  });

  it("Ref_Key несуществующего элемента — ошибка", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7210", costArticle: id(999) })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("нет в Catalog_СтатьиЗатрат");
  });

  it("у счёта нет такого субконто — ошибка вместо значения не в том слоте", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7110", costArticle: "Прочие расходы" })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("нет субконто «статьи затрат»");
    expect(text(res)).toContain("1) Подразделения");
  });

  it("аналитика без счёта затрат — ошибка", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, costArticle: "Прочие расходы" })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("expenseAccount");
  });

  it("счёт без аналитики: предупреждает о пустой статье затрат", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7210" })) as Res;
    expect((body(res).notes ?? []).join("\n")).toContain(
      "слот 1 (вид «Статьи затрат») счёта 7210 (БУ) не заполнен",
    );
  });

  it("confirm=true записывает тот же payload", async () => {
    const { call, posts } = setup();
    const args = {
      ...base,
      expenseAccount: "7210",
      costArticle: "Прочие расходы",
      settlementAccount: "3310",
    };
    const planRes = (await call(TOOL, args)) as Res;
    const plan = body(planRes).payload;
    const operationId = (planRes.structuredContent as { operationId: string }).operationId;
    const res = (await call(TOOL, { ...args, confirm: true, operationId })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.set).toBe("Document_ПоступлениеТоваровУслуг");
    expect(posts[0]!.body["Услуги"]).toEqual(plan.Услуги);
  });
});

describe("статья по коду, контрагент в субконто, предупреждения по слотам", () => {
  it("costArticle принимает код справочника: точный, без нулей, с нулями до длины кодов", async () => {
    const { call } = setup();
    for (const code of ["00002", "2", "0000002"]) {
      const res = (await call(TOOL, { ...base, expenseAccount: "7210", costArticle: code })) as Res;
      expect(res.isError, `${code}: ${text(res)}`).toBeFalsy();
      expect(body(res).payload.Услуги[0]!["СубконтоЗатратБУ1"], code).toBe(ART_BANK);
    }
  });

  it("код, которого нет, а потом и названия — понятная ошибка", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7210", costArticle: "104" })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("не найдена в Catalog_СтатьиЗатрат");
  });

  it("слот «Контрагенты» (счёт 7310) заполняется контрагентом документа без предупреждений", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7310",
      costArticle: "00001",
      settlementAccount: "3310",
      advanceAccount: "1610",
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(body(res).payload.Услуги[0]).toMatchObject({
      СчетЗатратБУ_Key: ACC_7310,
      СубконтоЗатратБУ1: ART_PROCHIE,
      СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
      СубконтоЗатратБУ2: BUYER,
      СубконтоЗатратБУ2_Type: TYPE("Catalog_Контрагенты"),
    });
    const notes = (body(res).notes ?? []).join("\n");
    expect(notes).toContain("2) Контрагенты:");
    expect(notes).not.toContain("не заполнен");
    expect(notes).not.toContain("Пропущено");
  });

  it("subcontoCounterparty по названию заменяет контрагента документа; у счёта нет такого слота — предупреждение", async () => {
    const { call } = setup();
    const ok = (await call(TOOL, {
      ...base,
      expenseAccount: "7310",
      costArticle: "00001",
      subcontoCounterparty: "TRADESPACE",
    })) as Res;
    expect(body(ok).payload.Услуги[0]!["СубконтоЗатратБУ2"]).toBe(BUYER);
    const warn = (await call(TOOL, {
      ...base,
      expenseAccount: "7210",
      costArticle: "00001",
      subcontoCounterparty: "TRADESPACE",
    })) as Res;
    expect(warn.isError, text(warn)).toBeFalsy();
    expect((body(warn).notes ?? []).join("\n")).toContain("нет субконто «контрагенты»");
  });

  it("контрагент по умолчанию у счёта без такого субконто — молча, без предупреждения", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7210",
      costArticle: "00001",
      department: DEP_ADM,
    })) as Res;
    expect((body(res).notes ?? []).join("\n")).not.toContain("«контрагенты»");
  });

  it("незаполненный слот любого вида — предупреждение «слот N (вид X) не заполнен»", async () => {
    const { call } = setup();
    const res = (await call(TOOL, { ...base, expenseAccount: "7210", costArticle: "00001" })) as Res;
    expect((body(res).notes ?? []).join("\n")).toContain(
      "слот 2 (вид «Подразделения») счёта 7210 (БУ) не заполнен",
    );
  });

  it("подразделение/группа, которых нет у счёта, — предупреждение, а не ошибка; статья — по-прежнему ошибка", async () => {
    const { call } = setup();
    const res = (await call(TOOL, {
      ...base,
      expenseAccount: "7310",
      costArticle: "00001",
      department: DEP_ADM,
      nomenclatureGroup: GRP,
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    const row = body(res).payload.Услуги[0]!;
    expect(row).not.toHaveProperty("СубконтоЗатратБУ3");
    const notes = (body(res).notes ?? []).join("\n");
    expect(notes).toContain("нет субконто «подразделения»");
    expect(notes).toContain("нет субконто «номенклатурные группы»");
    const noArt = (await call(TOOL, { ...base, expenseAccount: "7110", costArticle: "00001" })) as Res;
    expect(noArt.isError).toBe(true);
  });
});

describe("create_document: _Type субконто затрат подставляется и проверяется", () => {
  const doc = (row: Row) => ({
    entitySet: "Document_ПоступлениеТоваровУслуг",
    date: "2026-10-15",
    confirm: false,
    fields: { Контрагент_Key: BUYER, ДоговорКонтрагента_Key: CONTRACT, ВидОперации: "Услуги" },
    tables: { Услуги: [{ Номенклатура_Key: SERVICE, Количество: 1, Цена: 5, Сумма: 5, ...row }] },
  });

  it("значение без _Type получает тип по субконто счёта", async () => {
    const { call } = setup();
    const res = (await call(
      "write.document.create_document",
      doc({
        СчетЗатратБУ_Key: "7210",
        СубконтоЗатратБУ1: ART_PROCHIE,
        СубконтоЗатратБУ2: DEP_ADM,
      }),
    )) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(body(res).payload.Услуги[0]).toMatchObject({
      СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
      СубконтоЗатратБУ2_Type: TYPE("Catalog_ПодразделенияОрганизаций"),
    });
  });

  it("_Type без StandardODATA. дополняется; несовпадение с субконто счёта — в notes", async () => {
    const { call } = setup();
    const res = (await call(
      "write.document.create_document",
      doc({
        СчетЗатратБУ_Key: "7210",
        СубконтоЗатратБУ1: DEP_ADM,
        СубконтоЗатратБУ1_Type: "Catalog_ПодразделенияОрганизаций",
      }),
    )) as Res;
    expect(body(res).payload.Услуги[0]!["СубконтоЗатратБУ1_Type"]).toBe(
      TYPE("Catalog_ПодразделенияОрганизаций"),
    );
    expect((body(res).notes ?? []).join("\n")).toContain("субконто 1 счёта 7210 — «Статьи затрат»");
  });

  it("субконто без счёта затрат — предупреждение, значение не теряется", async () => {
    const { call } = setup();
    const res = (await call(
      "write.document.create_document",
      doc({ СубконтоЗатратБУ1: ART_PROCHIE }),
    )) as Res;
    expect(body(res).payload.Услуги[0]!["СубконтоЗатратБУ1"]).toBe(ART_PROCHIE);
    expect((body(res).notes ?? []).join("\n")).toContain("счёт затрат БУ не задан");
  });
});
