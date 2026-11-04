import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/context.js";
import { CHART_CACHE_TTL_MS, getAccount, invalidateChart, loadChart } from "../src/tools/chart.js";

const account = (code: string) => ({
  Ref_Key: `00000000-0000-0000-0000-${code.padStart(12, "0")}`,
  Code: code,
  Description: `Счёт ${code}`,
});
function connection() {
  const rows = [account("1030")];
  const getCollection = vi.fn(async () => ({ value: rows.map((row) => ({ ...row })) }));
  const conn = {
    available: async () => new Set(["ChartOfAccounts_Типовой"]),
    getMetadata: async () => ({ entities: new Map() }),
    client: { getCollection },
  } as unknown as Connection;
  return { conn, rows, getCollection };
}

afterEach(() => vi.restoreAllMocks());

describe("chart cache freshness", () => {
  it("expires snapshots after TTL and isolates connections", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const a = connection(),
      b = connection();
    await loadChart(a.conn);
    a.rows.push(account("008"));
    expect((await loadChart(a.conn)).rows).toHaveLength(1);
    now += CHART_CACHE_TTL_MS;
    expect((await loadChart(a.conn)).rows).toHaveLength(2);
    expect((await loadChart(b.conn)).rows).toHaveLength(1);
    expect(a.getCollection).toHaveBeenCalledTimes(2);
  });

  it("finds a newly-created 008 on a cache miss without process restart", async () => {
    const f = connection();
    await loadChart(f.conn);
    f.rows.push(account("008"));
    expect(await getAccount(f.conn, "008")).toMatchObject({ code: "008" });
    expect(f.getCollection).toHaveBeenCalledTimes(2);
    expect((await loadChart(f.conn)).rows).toHaveLength(2);
  });

  it("refreshes changed existing accounts explicitly and invalidates on demand", async () => {
    const f = connection();
    await loadChart(f.conn);
    f.rows[0]!.Description = "Новое название";
    expect((await getAccount(f.conn, "1030", true)).description).toBe("Новое название");
    invalidateChart(f.conn);
    await loadChart(f.conn);
    expect(f.getCollection).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent misses and bounds a failed lookup", async () => {
    const f = connection();
    await loadChart(f.conn);
    const results = await Promise.allSettled([getAccount(f.conn, "008"), getAccount(f.conn, "009")]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(f.getCollection).toHaveBeenCalledTimes(2);
    const result = results[0];
    if (result?.status === "rejected")
      expect(String(result.reason)).toMatch(/008.*План перечитан.*UTC.*refresh=true/s);
  });

  it("does not return stale data when refresh fails, and permits recovery", async () => {
    const f = connection();
    await loadChart(f.conn);
    f.getCollection.mockRejectedValueOnce(new Error("1C unavailable"));
    await expect(getAccount(f.conn, "008")).rejects.toThrow("1C unavailable");
    f.rows.push(account("008"));
    expect((await getAccount(f.conn, "008")).code).toBe("008");
  });

  it("an older rejected load cannot evict a newer invalidated snapshot", async () => {
    const f = connection();
    let reject!: (reason: Error) => void;
    f.getCollection.mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const old = loadChart(f.conn);
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    invalidateChart(f.conn);
    const current = await loadChart(f.conn);
    reject(new Error("old request failed"));
    await expect(old).rejects.toThrow("old request failed");
    expect(await loadChart(f.conn)).toBe(current);
    expect(f.getCollection).toHaveBeenCalledTimes(2);
  });
});
