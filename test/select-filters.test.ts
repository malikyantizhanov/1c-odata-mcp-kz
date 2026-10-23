import { describe, expect, it } from "vitest";
import { BANK_ACC, BUYER, CONTRACT, ORG, baseStore, fake1C, id } from "./support/fake-1c.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Отборы: owner у справочников, number/query у поиска документов. */

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SALE = "Document_РеализацияТоваровУслуг";

describe("list_catalog: owner", () => {
  it("договоры — по контрагенту-владельцу (Owner_Key)", async () => {
    const f = fake1C();
    const mine = sc(
      await f.call("read.catalog.list_catalog", {
        entitySet: "Catalog_ДоговорыКонтрагентов",
        owner: BUYER,
      }),
    );
    expect(mine["rows"].map((r: { ref: string }) => r["ref"])).toEqual([CONTRACT]);
    const other = sc(
      await f.call("read.catalog.list_catalog", {
        entitySet: "Catalog_ДоговорыКонтрагентов",
        owner: ORG,
      }),
    );
    expect(other["rows"]).toEqual([]);
    expect(String(other["note"])).toContain(ORG);
  });

  it("банковские счета — по организации-владельцу (полиморфный Owner)", async () => {
    const f = fake1C();
    const res = sc(
      await f.call("read.catalog.list_catalog", {
        entitySet: "Catalog_БанковскиеСчета",
        owner: ORG,
      }),
    );
    expect(res["rows"].map((r: { ref: string }) => r["ref"])).toEqual([BANK_ACC]);
    const none = sc(
      await f.call("read.catalog.list_catalog", {
        entitySet: "Catalog_БанковскиеСчета",
        owner: BUYER,
      }),
    );
    expect(none["rows"]).toEqual([]);
  });

  it("без владельца — по всему справочнику; чужой владелец у номенклатуры — отказ", async () => {
    const f = fake1C();
    const all = sc(await f.call("read.catalog.list_catalog", { entitySet: "Catalog_ДоговорыКонтрагентов" }));
    expect(all["rows"]).toHaveLength(1);
    const bad = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_Номенклатура",
      owner: BUYER,
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("нет владельца");
  });
});

describe("search_documents: number и query", () => {
  const docs = () => {
    const store = baseStore();
    store[SALE] = [
      {
        Ref_Key: id(301),
        Number: "00000000018",
        Date: "2026-10-08T15:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        СуммаДокумента: 100,
      },
      {
        Ref_Key: id(302),
        Number: "00000000118",
        Date: "2026-10-09T15:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        СуммаДокумента: 200,
      },
    ];
    return fake1C({ store });
  };

  it("number: точное совпадение с учётом ведущих нулей («18» — только № 18)", async () => {
    const f = docs();
    const res = sc(await f.call("read.document.search_documents", { entitySet: SALE, number: "18" }));
    expect(res["rows"].map((r: { number: string }) => r["number"])).toEqual(["00000000018"]);
    const full = sc(
      await f.call("read.document.search_documents", { entitySet: SALE, number: "00000000018" }),
    );
    expect(full["rows"]).toHaveLength(1);
  });

  it("query: подстрока номера", async () => {
    const f = docs();
    const res = sc(await f.call("read.document.search_documents", { entitySet: SALE, query: "118" }));
    expect(res["rows"].map((r: { number: string }) => r["number"])).toEqual(["00000000118"]);
  });
});
