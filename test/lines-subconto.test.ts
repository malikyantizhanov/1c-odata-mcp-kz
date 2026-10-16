import { describe, expect, it } from "vitest";
import { baseStore, BUYER, fake1C, id, ORG, SERVICE, type Row } from "./support/fake-1c.js";

/**
 * Аналитика затрат в строках УЖЕ существующего поступления (форма как у №471–473 на ea165: строка «Услуги» со счётом
 * затрат 7310/НУ и пустыми значениями субконто, но с _Type): точечная правка update_document_lines (analytics),
 * строка с аналитикой в add_document_line/update_document_lines и автодополнение _Type в update_document.
 */

const KIND_ART = id(201);
const KIND_DEP = id(202);
const KIND_GRP = id(203);
const KIND_CP = id(204);
const ACC_7310 = id(247); // 1 Статьи затрат, 2 Контрагенты
const ART_PROCHIE = id(211);
const ART_BANK = id(212);
const ART_LOAN = id(215);
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
const DOC = id(301);
const DOC_POSTED = id(302);
const CP_IGS = id(303);

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
    f(ART_PROCHIE, "Прочие расходы", { Code: "000000001" }),
    f(ART_LOAN, "Проценты по займу", { Code: "000000104" }),
    f(ART_BANK, "Комиссия банка", { Code: "000000002" }),
    f(ART_PENYA1, "Пеня по ОПВ", { Code: "000000003" }),
    f(ART_PENYA2, "Пеня по СО", { Code: "000000004" }),
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
  const EMPTYG = "00000000-0000-0000-0000-000000000000";
  const row = (): Row => ({
    LineNumber: "1",
    Номенклатура_Key: SERVICE,
    Содержание: "Вознаграждение по займу за 14.10.2026",
    Количество: 1,
    Цена: 320.25,
    Сумма: 320.25,
    СуммаНДС: 0,
    СчетЗатратБУ_Key: ACC_7310,
    СубконтоЗатратБУ1: EMPTYG,
    СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
    СубконтоЗатратБУ2: EMPTYG,
    СубконтоЗатратБУ2_Type: TYPE("Catalog_Контрагенты"),
    СчетЗатратНУ_Key: ACC_7210N,
    СубконтоЗатратНУ1: EMPTYG,
    СубконтоЗатратНУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
  });
  const doc = (ref: string, posted: boolean): Row => ({
    Ref_Key: ref,
    Number: "00000000473",
    Date: "2026-10-14T00:00:00",
    Posted: posted,
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: BUYER,
    ВидОперации: "Услуги",
    СуммаДокумента: 320.25,
    Товары: [],
    Услуги: [{ ...row(), Ref_Key: ref }],
  });
  store["Document_ПоступлениеТоваровУслуг"] = [doc(DOC, false), doc(DOC_POSTED, true)];
  store["Catalog_Контрагенты"] = [
    ...(store["Catalog_Контрагенты"] ?? []),
    f(CP_IGS, "Integrated Global Services Inc.", { Code: "00000231" }),
  ];
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
          { name: "Товары", type: `Collection(${TYPE("Document_ПоступлениеТоваровУслуг_Товары")}_RowType)` },
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

type Res = {
  structuredContent?: unknown;
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};
const text = (r: Res) => r.content.map((c) => c.text).join("\n");
const plan = (r: Res) =>
  r.structuredContent as {
    fields: { Услуги: Row[]; СуммаДокумента?: number };
    notes?: string[];
    dryRun?: boolean;
  };
const UPD = "write.document.update_document_lines";
const ES = "Document_ПоступлениеТоваровУслуг";

describe("update_document_lines: analytics (точечная правка существующих строк)", () => {
  it("статья по коду 104 и контрагент по названию → слоты БУ с _Type; остальное в строке и сумма не меняются", async () => {
    const { call, posts } = setup();
    const res = (await call(UPD, {
      entitySet: ES,
      ref: DOC,
      analytics: [{ lineNumber: 1, costArticle: "104", subcontoCounterparty: "Integrated Global Services" }],
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    const p = plan(res);
    expect(p.dryRun).toBe(true);
    const r = p.fields.Услуги[0]!;
    expect(r).toMatchObject({
      СубконтоЗатратБУ1: ART_LOAN,
      СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
      СубконтоЗатратБУ2: CP_IGS,
      СубконтоЗатратБУ2_Type: TYPE("Catalog_Контрагенты"),
      Содержание: "Вознаграждение по займу за 14.10.2026",
      Цена: 320.25,
      Сумма: 320.25,
      СчетЗатратБУ_Key: ACC_7310,
      LineNumber: 1,
    });
    expect(r).not.toHaveProperty("Ref_Key");
    expect(p.fields).not.toHaveProperty("СуммаДокумента");
    const notes = (p.notes ?? []).join("\n");
    expect(notes).toMatch(/Строка 1 \(Услуги\): .*СубконтоЗатратБУ1: пусто → /);
    expect(notes).toContain("Проценты по займу");
    expect(posts).toHaveLength(0);
  });

  it("контрагент документа подставляется в слот «Контрагенты» по умолчанию (молча)", async () => {
    const { call } = setup();
    const res = (await call(UPD, {
      entitySet: ES,
      ref: DOC,
      analytics: [{ lineNumber: 1, costArticle: "000000001" }],
    })) as Res;
    const r = plan(res).fields.Услуги[0]!;
    expect(r["СубконтоЗатратБУ1"]).toBe(ART_PROCHIE);
    expect(r["СубконтоЗатратБУ2"]).toBe(BUYER);
    expect((plan(res).notes ?? []).join("\n")).not.toContain("нет субконто «контрагенты»");
  });

  it("явные СубконтоЗатратБУ1 и НУ1 без _Type — тип дописывается; НУ по счёту налогового плана", async () => {
    const { call } = setup();
    const res = (await call(UPD, {
      entitySet: ES,
      ref: DOC,
      analytics: [
        {
          lineNumber: 1,
          subconto: { СубконтоЗатратБУ1: ART_LOAN, СубконтоЗатратНУ1: ART_LOAN },
        },
      ],
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(plan(res).fields.Услуги[0]).toMatchObject({
      СубконтоЗатратБУ1: ART_LOAN,
      СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
      СубконтоЗатратНУ1: ART_LOAN,
      СубконтоЗатратНУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
    });
  });

  it("смена счёта затрат: прежние субконто очищаются, пустой слот статьи даёт предупреждение", async () => {
    const { call } = setup();
    const res = (await call(UPD, {
      entitySet: ES,
      ref: DOC,
      analytics: [{ lineNumber: 1, costAccount: "7210", department: "Администрация" }],
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    const r = plan(res).fields.Услуги[0]!;
    expect(r["СчетЗатратБУ_Key"]).toBe(ACC_7210);
    expect(r["СубконтоЗатратБУ2"]).toBe(DEP_ADM);
    expect(r["СубконтоЗатратБУ2_Type"]).toBe(TYPE("Catalog_ПодразделенияОрганизаций"));
    expect(r["СубконтоЗатратБУ1"]).toBe("00000000-0000-0000-0000-000000000000");
    expect((plan(res).notes ?? []).join("\n")).toMatch(/слот 1 \(вид «Статьи затрат»\).*не заполнен/);
  });

  it("проведённый документ: dry-run показывает план с пометкой, confirm=true — отказ", async () => {
    const { call } = setup();
    const args = { entitySet: ES, ref: DOC_POSTED, analytics: [{ lineNumber: 1, costArticle: "104" }] };
    const dry = (await call(UPD, args)) as Res;
    expect(dry.isError, text(dry)).toBeFalsy();
    expect((plan(dry).notes ?? []).join("\n")).toContain("ПРОВЕДЁН");
    const real = (await call(UPD, { ...args, confirm: true })) as Res;
    expect(real.isError).toBe(true);
    expect(text(real)).toContain("проведён");
  });

  it("ошибки ввода: нет такой строки, статья не найдена, не GUID в subconto, нет lines и analytics", async () => {
    const { call } = setup();
    const bad = async (extra: Record<string, unknown>) =>
      text((await call(UPD, { entitySet: ES, ref: DOC, ...extra })) as Res);
    expect(await bad({ analytics: [{ lineNumber: 3, costArticle: "104" }] })).toContain("для строки 3");
    expect(await bad({ analytics: [{ lineNumber: 1, costArticle: "Нет такой статьи" }] })).toMatch(
      /не найден/i,
    );
    expect(await bad({ analytics: [{ lineNumber: 1, subconto: { СубконтоЗатратБУ1: "abc" } }] })).toContain(
      "Ref_Key",
    );
    expect(await bad({})).toContain("lines и/или analytics");
  });

  it("в казахстанской базе режим lines закрыт (российские счета/НДС) — отказ с указанием на update_document", async () => {
    const { call } = setup();
    const res = (await call(UPD, {
      entitySet: ES,
      ref: DOC,
      lines: [{ nomenclatureRef: SERVICE, quantity: 1, price: 500 }],
    })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("update_document");
  });

  it("документ вне списка казахстанских — отказ", async () => {
    const { call } = setup();
    const res = (await call(UPD, {
      entitySet: "Document_СчетНаОплатуПокупателю",
      ref: DOC,
      analytics: [{ lineNumber: 1, costArticle: "104" }],
    })) as Res;
    expect(res.isError).toBe(true);
  });
});

describe("update_document: аналитика", () => {
  it("update_document: табличная часть с СубконтоЗатратБУ1 без _Type — тип дописывается, в notes итог", async () => {
    const { call } = setup();
    const res = (await call("write.document.update_document", {
      entitySet: ES,
      ref: DOC,
      tables: {
        Услуги: [
          {
            Номенклатура_Key: SERVICE,
            Количество: 1,
            Цена: 10,
            Сумма: 10,
            СчетЗатратБУ_Key: "7310",
            СубконтоЗатратБУ1: ART_LOAN,
          },
        ],
      },
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    const p = res.structuredContent as { fields: { Услуги: Row[] }; notes?: string[] };
    expect(p.fields.Услуги[0]).toMatchObject({
      СчетЗатратБУ_Key: ACC_7310,
      СубконтоЗатратБУ1_Type: TYPE("Catalog_СтатьиЗатрат"),
    });
    expect((p.notes ?? []).join("\n")).toContain("Проценты по займу");
  });
});
