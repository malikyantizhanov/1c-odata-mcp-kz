import { describe, expect, it } from "vitest";
import { BUYER, ORG, baseStore, fake1C, id } from "./support/fake-1c.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** search_documents: отбор по назначению, виду операции, сумме «до», доп. поля и постранично (rag-buh 13.11.2026:
 * агенту — «запрос списка документов по чему угодно»; 370 оплат Mybuh.kz без открытия каждого документа). */

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PP = "Document_ПлатежноеПоручениеВходящее";

const pp = (n: number, sum: number, purpose: string, op = "ОплатаПокупателя") => ({
  Ref_Key: id(500 + n),
  Number: String(n).padStart(11, "0"),
  Date: `2026-10-${String(10 + n).padStart(2, "0")}T10:00:00`,
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  СуммаДокумента: sum,
  НазначениеПлатежа: purpose,
  ВидОперации: op,
  Комментарий: "",
});

const docs = () => {
  const store = baseStore();
  store[PP] = [
    pp(1, 14900, "Счет на оплату № 22664 от 22.10.2026, Доступ по подписке"),
    pp(2, 149000, "Счет на оплату № 22700, тариф Pro"),
    pp(3, 5000, "Возврат займа", "ПрочиеРасчетыСКонтрагентами"),
  ];
  return fake1C({ store });
};

describe("search_documents: поля и отборы", () => {
  it("назначение содержит + вид операции + сумма «до»", async () => {
    const f = docs();
    const byPurpose = sc(
      await f.call("read.document.search_documents", { entitySet: PP, purposeContains: "Счет на оплату" }),
    );
    expect(byPurpose["rows"].map((r: { amount: number }) => r["amount"]).sort()).toEqual([14900, 149000]);
    const byOp = sc(
      await f.call("read.document.search_documents", {
        entitySet: PP,
        operationKind: "ОплатаПокупателя",
        maxAmount: 20000,
      }),
    );
    expect(byOp["rows"].map((r: { amount: number }) => r["amount"])).toEqual([14900]);
  });

  it("fields: значения шапки и название контрагента рядом со ссылкой", async () => {
    const f = docs();
    const res = sc(
      await f.call("read.document.search_documents", {
        entitySet: PP,
        purposeContains: "22664",
        fields: ["Контрагент_Key", "НазначениеПлатежа", "НетТакогоПоля"],
      }),
    );
    const [row] = res["rows"];
    expect(row["fields"]["НазначениеПлатежа"]).toContain("22664");
    expect(row["fields"]["Контрагент_Key"]).toBe(BUYER);
    expect(typeof row["counterparty"]).toBe("string");
    expect(res["filterNotes"].join(" ")).toContain("НетТакогоПоля");
  });

  it("постранично: nextOffset, пока есть следующие", async () => {
    const f = docs();
    const first = sc(await f.call("read.document.search_documents", { entitySet: PP, limit: 2 }));
    expect(first["rows"]).toHaveLength(2);
    expect(first["truncated"]).toBe(true);
    expect(first["nextOffset"]).toBe(2);
    const second = sc(await f.call("read.document.search_documents", { entitySet: PP, limit: 2, offset: 2 }));
    expect(second["rows"]).toHaveLength(1);
    expect(second["truncated"]).toBe(false);
    expect(second["nextOffset"]).toBeUndefined();
  });
});
