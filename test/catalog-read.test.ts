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
    ).toEqual(["Комиссия банка", "Прочие расходы"]);
    expect(rowsOf(res)[0]).toMatchObject({ ref: expect.any(String), isFolder: false, deletionMark: false });
  });

  it("includeFolders / includeDeleted возвращают скрытое", async () => {
    const { call } = setup();
    const res = await call("read.catalog.list_catalog", {
      entitySet: "Catalog_СтатьиЗатрат",
      includeFolders: true,
      includeDeleted: true,
    });
    expect(rowsOf(res)).toHaveLength(4);
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
    expect(rowsOf(bySyntax)).toHaveLength(2);
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
});
