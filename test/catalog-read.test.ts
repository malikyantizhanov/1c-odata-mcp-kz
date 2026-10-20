import { describe, expect, it } from "vitest";
import { ODataError } from "../src/odata/errors.js";
import { baseStore, fake1C, id } from "./support/fake-1c.js";

/** read.catalog.list_catalog: любой справочник и план видов характеристик, а не только номенклатура/контрагенты. */

const A = {
  prochie: id(101),
  bank: id(102),
  folder: id(103),
  deleted: id(104),
};
const kind = id(110);

function setup() {
  const store = baseStore();
  store["Catalog_СтатьиЗатрат"] = [
    {
      Ref_Key: A.prochie,
      Code: "00001",
      Description: "Прочие расходы",
      IsFolder: false,
      DeletionMark: false,
      КатегорияЗатрат: "Прочие",
    },
    {
      Ref_Key: A.bank,
      Code: "00002",
      Description: "Комиссия банка",
      IsFolder: false,
      DeletionMark: false,
      КатегорияЗатрат: "Банк",
    },
    { Ref_Key: A.folder, Code: "00003", Description: "Прочие группы", IsFolder: true, DeletionMark: false },
    { Ref_Key: id(105), Code: "00005", Description: "Налог 2026", IsFolder: false, DeletionMark: false },
    { Ref_Key: A.deleted, Code: "00004", Description: "Прочие старые", IsFolder: false, DeletionMark: true },
  ];
  store["ChartOfCharacteristicTypes_ВидыСубконтоТиповые"] = [
    { Ref_Key: kind, Code: "00001", Description: "Статьи затрат", IsFolder: false, DeletionMark: false },
  ];
  store["Catalog_ВидыПрочихВыплат"] = [{ Ref_Key: id(120), Description: "Закрытый", DeletionMark: false }];
  return fake1C({ store });
}

const rowsOf = (r: { structuredContent?: unknown }) =>
  (r.structuredContent as { rows: Array<Record<string, unknown>> }).rows;
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text).join("\n");

describe("read.catalog.list_catalog", () => {
  it("читает справочник статей затрат: группы и помеченные на удаление скрыты по умолчанию", async () => {
    const { call } = setup();
    const res = await call("read.catalog.list_catalog", { entitySet: "Catalog_СтатьиЗатрат" });
    expect(res.isError).toBeFalsy();
    expect(
      rowsOf(res)
        .map((r) => r["name"])
        .sort(),
    ).toEqual(["Комиссия банка", "Налог 2026", "Прочие расходы"]);
    expect(rowsOf(res)[0]).toMatchObject({ ref: expect.any(String), isFolder: false, deletionMark: false });
  });

  it("includeFolders / includeDeleted возвращают скрытое", async () => {
    const { call } = setup();
    const res = await call("read.catalog.list_catalog", {
      entitySet: "Catalog_СтатьиЗатрат",
      includeFolders: true,
      includeDeleted: true,
    });
    expect(rowsOf(res)).toHaveLength(5);
    expect(rowsOf(res).find((r) => r["ref"] === A.folder)).toMatchObject({ isFolder: true });
    expect(rowsOf(res).find((r) => r["ref"] === A.deleted)).toMatchObject({ deletionMark: true });
  });

  it("query ищет по части названия без учёта регистра", async () => {
    const { call, gets } = setup();
    const res = await call("read.catalog.list_catalog", {
      entitySet: "Catalog_СтатьиЗатрат",
      query: "ПРОЧИЕ",
    });
    expect(rowsOf(res).map((r) => r["name"])).toEqual(["Прочие расходы"]);
    expect(gets.some((g) => g.includes("substringof('ПРОЧИЕ', Description)"))).toBe(true);
  });

  it("select добавляет поля, неизвестное поле — понятная ошибка", async () => {
    const { call } = setup();
    const ok = await call("read.catalog.list_catalog", {
      entitySet: "Catalog_СтатьиЗатрат",
      query: "банка",
      select: ["КатегорияЗатрат"],
    });
    expect(rowsOf(ok)[0]).toMatchObject({ name: "Комиссия банка", fields: { КатегорияЗатрат: "Банк" } });
    const bad = await call("read.catalog.list_catalog", {
      entitySet: "Catalog_СтатьиЗатрат",
      select: ["Нет"],
    });
    expect(bad.isError).toBe(true);
    expect(text(bad as never)).toContain("нет простых полей: Нет");
  });

  it("limit и nextOffset", async () => {
    const { call } = setup();
    const res = await call("read.catalog.list_catalog", { entitySet: "Catalog_СтатьиЗатрат", limit: 1 });
    expect(rowsOf(res)).toHaveLength(1);
    expect(res.structuredContent).toMatchObject({ truncated: true, nextOffset: 1 });
  });

  it("читает план видов характеристик; имя без префикса и синтаксис 1С", async () => {
    const { call } = setup();
    for (const name of [
      "ChartOfCharacteristicTypes_ВидыСубконтоТиповые",
      "ВидыСубконтоТиповые",
      "ПланВидовХарактеристик.ВидыСубконтоТиповые",
    ]) {
      const res = await call("read.catalog.list_catalog", { entitySet: name });
      expect(res.isError, name).toBeFalsy();
      expect(rowsOf(res).map((r) => r["name"])).toEqual(["Статьи затрат"]);
    }
    const bySyntax = await call("read.catalog.list_catalog", { entitySet: "Справочник.СтатьиЗатрат" });
    expect(rowsOf(bySyntax)).toHaveLength(3);
  });

  it("документ не читает — отсылает к search_documents", async () => {
    const { call } = setup();
    const res = await call("read.catalog.list_catalog", { entitySet: "Document_СчетНаОплатуПокупателю" });
    expect(res.isError).toBe(true);
    expect(text(res as never)).toContain("search_documents");
  });

  it("не опубликованный справочник — подсказка про состав OData", async () => {
    const { call } = setup();
    const res = await call("read.catalog.list_catalog", { entitySet: "Catalog_НетТакого" });
    expect(res.isError).toBe(true);
    expect(text(res as never)).toContain("не опубликованы в OData");
  });

  it("401 — «нет прав OData на справочник», без технического шума", async () => {
    const { call, failGetOn } = setup();
    failGetOn((p) =>
      p.startsWith("Catalog_ВидыПрочихВыплат")
        ? new ODataError({ kind: "auth", status: 401, message: "401" })
        : undefined,
    );
    const res = await call("read.catalog.list_catalog", { entitySet: "Catalog_ВидыПрочихВыплат" });
    expect(res.isError).toBe(true);
    expect(text(res as never)).toContain("Нет прав OData на справочник Catalog_ВидыПрочихВыплат (HTTP 401)");
  });

  describe("поиск по коду", () => {
    const names = (r: { structuredContent?: unknown }) => rowsOf(r).map((x) => x["name"]);

    it("цифровой query: код без нулей дополняется до длины кодов справочника", async () => {
      const { call } = setup();
      const res = await call("read.catalog.list_catalog", { entitySet: "Catalog_СтатьиЗатрат", query: "2" });
      // «2» — код 00002 и (по названию) «Налог 2026».
      expect(names(res).sort()).toEqual(["Комиссия банка", "Налог 2026"]);
      expect(rowsOf(res).find((r) => r["name"] === "Комиссия банка")).toMatchObject({
        code: "00002",
        matchedBy: "code",
      });
    });

    it("цифровой query: точный код с нулями и ведущие нули в избытке", async () => {
      const { call } = setup();
      for (const q of ["00002", "0000002", "000000000002"]) {
        const res = await call("read.catalog.list_catalog", { entitySet: "Catalog_СтатьиЗатрат", query: q });
        expect(names(res), q).toEqual(["Комиссия банка"]);
      }
    });

    it("цифровой query ищет и по названию: «2026» находит статью с годом в названии", async () => {
      const { call } = setup();
      const res = await call("read.catalog.list_catalog", {
        entitySet: "Catalog_СтатьиЗатрат",
        query: "2026",
      });
      expect(names(res)).toEqual(["Налог 2026"]);
      expect(rowsOf(res)[0]).not.toHaveProperty("matchedBy");
    });

    it("параметр code — только по коду, не по названию", async () => {
      const { call } = setup();
      const byCode = await call("read.catalog.list_catalog", {
        entitySet: "Catalog_СтатьиЗатрат",
        code: "5",
      });
      expect(names(byCode)).toEqual(["Налог 2026"]);
      const notByName = await call("read.catalog.list_catalog", {
        entitySet: "Catalog_СтатьиЗатрат",
        code: "2026",
      });
      expect(rowsOf(notByName)).toHaveLength(0);
      expect(text(notByName as never)).toContain("Элемента с кодом «2026» нет");
    });

    it("несуществующий код — пустой результат с пояснением; скрытые (удалённые) не находит без includeDeleted", async () => {
      const { call } = setup();
      const none = await call("read.catalog.list_catalog", {
        entitySet: "Catalog_СтатьиЗатрат",
        query: "104",
      });
      expect(rowsOf(none)).toHaveLength(0);
      expect((none.structuredContent as { note: string }).note).toContain("00104");
      const hidden = await call("read.catalog.list_catalog", {
        entitySet: "Catalog_СтатьиЗатрат",
        code: "4",
      });
      expect(rowsOf(hidden)).toHaveLength(0);
      const shown = await call("read.catalog.list_catalog", {
        entitySet: "Catalog_СтатьиЗатрат",
        code: "4",
        includeDeleted: true,
      });
      expect(names(shown)).toEqual(["Прочие старые"]);
    });

    it("нецифровой query работает как раньше (только название)", async () => {
      const { call, gets } = setup();
      await call("read.catalog.list_catalog", { entitySet: "Catalog_СтатьиЗатрат", query: "банка" });
      expect(gets.some((g) => g.includes("Code eq"))).toBe(false);
    });
  });
});

describe("read.catalog.list_catalog — планы видов расчёта (виды начислений и удержаний)", () => {
  it("читает ChartOfCalculationTypes_*: полное имя, без префикса и синтаксис 1С", async () => {
    const store = baseStore();
    store["ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций"] = [
      { Ref_Key: id(301), Code: "000001", Description: "Оклад по дням", DeletionMark: false },
      { Ref_Key: id(302), Code: "000002", Description: "Оплата отпуска", DeletionMark: false },
    ];
    const { call } = fake1C({ store });
    for (const name of [
      "ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций",
      "ОсновныеНачисленияОрганизаций",
      "ПланВидовРасчета.ОсновныеНачисленияОрганизаций",
    ]) {
      const res = await call("read.catalog.list_catalog", { entitySet: name, query: "отпуск" });
      expect(res.isError, name).toBeFalsy();
      expect(rowsOf(res).map((r) => r["name"])).toEqual(["Оплата отпуска"]);
    }
  });
});
