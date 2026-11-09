import { describe, expect, it } from "vitest";
import { normalizeFields } from "../src/tools/write-documents.js";

const em = {
  entitySet: "Document_РеализацияТоваровУслуг_Услуги",
  properties: [
    { name: "Содержание", type: "Edm.String" },
    { name: "Количество", type: "Edm.Double" },
    { name: "LineNumber", type: "Edm.Int64" },
  ],
};

describe("normalizeFields", () => {
  it("LineNumber строки — не отказ: номер проставляется сам, поле просто не передаётся", () => {
    expect(
      normalizeFields(
        em as never,
        { LineNumber: 1, Содержание: "Услуга", Количество: 1 },
        "Услуги, строка 1",
      ),
    ).toEqual({ Содержание: "Услуга", Количество: 1 });
  });

  it("служебные поля по-прежнему — понятный отказ", () => {
    expect(() =>
      normalizeFields(em as never, { Ref_Key: "x", Содержание: "Услуга" }, "Услуги, строка 1"),
    ).toThrow(/Ref_Key — ссылку назначает 1С/);
  });
});
