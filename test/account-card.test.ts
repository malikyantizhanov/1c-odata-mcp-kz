import { describe, it, expect } from "vitest";
import type { Connection } from "../src/context.js";
import { accountCard } from "../src/tools/account-card.js";

const REG = "AccountingRegister_Типовой";
const CHART = "ChartOfAccounts_Типовой";
const A1030 = "00000000-0000-0000-0000-000000001030";
const A1010 = "00000000-0000-0000-0000-000000001010";
const KASPI = "b7b719ee-a0b1-11ef-aee9-18c04dc17c0c";
const HALYK = "7e5c0c27-a0c7-11ef-aee9-18c04dc17c0c";
const ORG = "a3e17720-0000-0000-0000-000000000001";

function fakeConn(records: Array<Record<string, unknown>>) {
  const paths: string[] = [];
  const client = {
    async getCollection(path: string): Promise<{ value: unknown[] }> {
      paths.push(decodeURIComponent(path));
      if (path.startsWith(CHART))
        return { value: [{ Ref_Key: A1030, Code: "1030", Description: "Деньги на счетах" }] };
      const skip = Number(/\$skip=(\d+)/.exec(path)?.[1] ?? 0);
      return { value: skip ? [] : records };
    },
  };
  const conn = {
    client,
    behavior: { analyticsMaxRows: 100000, pageSize: 500, maxRows: 1000 },
    available: async () => new Set([REG, CHART]),
  } as unknown as Connection;
  return { conn, paths };
}

const rec = (
  recorder: string,
  period: string,
  sum: number,
  side: { dr?: [string, string]; cr?: [string, string] },
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  Recorder: recorder,
  Recorder_Type: "StandardODATA.Document_СписаниеСРасчетногоСчета",
  Period: period,
  Active: true,
  Организация_Key: ORG,
  Сумма: sum,
  AccountDr_Key: side.dr?.[0] ?? A1010,
  ExtDimensionDr1: side.dr?.[1] ?? "",
  AccountCr_Key: side.cr?.[0] ?? A1010,
  ExtDimensionCr1: side.cr?.[1] ?? "",
  ...extra,
});

describe("accountCard", () => {
  it("последняя операция по банковскому счёту: отбор по субконто, по документам, новые первыми", async () => {
    const { conn, paths } = fakeConn([
      rec("d1", "2026-10-20T10:00:00", 50000, { cr: [A1030, KASPI] }, { Содержание: "Оплата поставщику" }),
      rec("d2", "2026-11-03T12:00:00", 1950, { cr: [A1030, KASPI] }, { Содержание: "Комиссия банка" }),
      rec("d3", "2026-11-10T09:00:00", 700000, { dr: [A1030, HALYK] }), // другой счёт — не наш
      rec("d4", "2026-11-01T09:00:00", 120000, { dr: [A1030, KASPI] }),
      rec("d5", "2026-11-05T09:00:00", 999, { cr: [A1030, KASPI] }, { Active: false }), // неактивная запись
      rec(
        "d6",
        "2026-11-12T09:00:00",
        5,
        { cr: [A1030, KASPI] },
        { Организация_Key: "ffffffff-0000-0000-0000-000000000000" },
      ),
    ]);
    const card = await accountCard(conn, {
      account: "1030",
      from: "2026-10-01",
      to: "2026-11-13",
      limit: 20,
      org: ORG,
      subconto: KASPI,
    });
    expect(card.lastDate).toBe("2026-11-03");
    expect(card.rows.map((r) => r.documentRef)).toEqual(["d2", "d4", "d1"]);
    expect(card.rows[0]).toMatchObject({
      credit: 1950,
      debit: 0,
      content: "Комиссия банка",
      documentType: "Document_СписаниеСРасчетногоСчета",
    });
    expect(card.rows[1]).toMatchObject({ debit: 120000, credit: 0 });
    const reg = paths.find((p) => p.startsWith(REG)) ?? "";
    expect(reg).toContain(
      "RecordsWithExtDimensions(StartPeriod=datetime'2026-10-01T00:00:00',EndPeriod=datetime'2026-11-13T23:59:59')",
    );
    // 1С не принимает $filter по полям RecordsWithExtDimensions (500 «Операция не разрешена в предложении ГДЕ»).
    expect(reg).not.toContain("$filter");
  });

  it("без субконто — все движения счёта; limit ограничивает число документов", async () => {
    const { conn } = fakeConn([
      rec("d1", "2026-10-20T10:00:00", 10, { cr: [A1030, KASPI] }),
      rec("d3", "2026-11-10T09:00:00", 20, { dr: [A1030, HALYK] }),
    ]);
    const card = await accountCard(conn, { account: "1030", from: "2026-10-01", to: "2026-11-13", limit: 1 });
    expect(card.rows.map((r) => r.documentRef)).toEqual(["d3"]);
    expect(card.documents).toBe(2);
  });

  it("неверный субконто и период наоборот — понятные ошибки", async () => {
    const { conn } = fakeConn([]);
    await expect(
      accountCard(conn, {
        account: "1030",
        from: "2026-10-01",
        to: "2026-11-13",
        limit: 5,
        subconto: "kaspi",
      }),
    ).rejects.toThrow(/GUID/);
    await expect(
      accountCard(conn, { account: "1030", from: "2026-12-01", to: "2026-11-13", limit: 5 }),
    ).rejects.toThrow(/наоборот/);
  });
});
