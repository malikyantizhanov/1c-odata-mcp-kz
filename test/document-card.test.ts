import { describe, expect, it } from "vitest";
import { ODataError } from "../src/odata/errors.js";
import { readDocumentCard } from "../src/tools/preview-view.js";

const REF = "00000000-0000-4000-8000-0000000000d1";

function conn(set: string, props: string[], row: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    getMetadata: async () => ({ entities: new Map([[set, { properties: props.map((name) => ({ name })) }]]) }),
    client: {
      getEntity: async (path: string) => {
        const select = decodeURIComponent(/\$select=([^&]*)/.exec(path)?.[1] ?? "").split(",");
        asked.push(select.join(","));
        // как 1С: поле, которого нет у документа, в $select — 400
        if (select.some((f) => f && !props.includes(f)))
          throw new ODataError({ kind: "bad_request", status: 400, message: "нет такого поля" });
        return row;
      },
    },
  };
}

describe("readDocumentCard", () => {
  it("ЭАВР: без Posted/СуммаДокумента — сумма из итога с налогами", async () => {
    const c = conn("Document_ЭлектронныйАктВыполненныхРабот",
      ["Ref_Key", "Number", "Date", "ИтогоСтоимостьСУчетомКосвенныхНалогов"],
      { Number: "7", Date: "2026-11-05T00:00:00", ИтогоСтоимостьСУчетомКосвенныхНалогов: 77400 });
    expect(await readDocumentCard(c as never, "Document_ЭлектронныйАктВыполненныхРабот", REF))
      .toEqual({ date: "2026-11-05", total: 77400 });
    expect(c.asked).toEqual(["Number,Date,ИтогоСтоимостьСУчетомКосвенныхНалогов"]);
  });

  it("операция — СуммаОперации и Posted; обычный документ — СуммаДокумента", async () => {
    const op = conn("Document_ОперацияБух", ["Number", "Date", "Posted", "СуммаОперации"],
      { Date: "2026-11-06T10:00:00", Posted: true, СуммаОперации: 1500 });
    expect(await readDocumentCard(op as never, "Document_ОперацияБух", REF))
      .toEqual({ date: "2026-11-06", total: 1500, posted: true });
    const sale = conn("Document_РеализацияТоваровУслуг", ["Number", "Date", "Posted", "СуммаДокумента"],
      { Date: "2026-11-07T00:00:00", Posted: false, СуммаДокумента: 50750 });
    expect(await readDocumentCard(sale as never, "Document_РеализацияТоваровУслуг", REF))
      .toEqual({ date: "2026-11-07", total: 50750, posted: false });
  });
});
