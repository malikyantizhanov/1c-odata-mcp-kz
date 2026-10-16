/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в тестах */
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { annotateBatch, rankCandidates } from "../src/tools/esf-avr.js";

type Tool = { handler: (a: Record<string, unknown>, e: Record<string, unknown>) => Promise<CallToolResult> };
const toolsOf = (c: unknown): Record<string, Tool> =>
  (createServer({ db: () => c } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const ORG = "00000000-0000-4000-8000-000000000001";
const CP = "00000000-0000-4000-8000-000000000002";
const CP2 = "00000000-0000-4000-8000-000000000003";
const CTR = "00000000-0000-4000-8000-000000000004";
const AVR1 = "00000000-0000-4000-8000-0000000000a1";
const AVR2 = "00000000-0000-4000-8000-0000000000a2";
const AVR3 = "00000000-0000-4000-8000-0000000000a3";
const AVR4 = "00000000-0000-4000-8000-0000000000a4";
const R1 = "00000000-0000-4000-8000-0000000000b1";
const R2 = "00000000-0000-4000-8000-0000000000b2";
const R3 = "00000000-0000-4000-8000-0000000000b3";
const R4 = "00000000-0000-4000-8000-0000000000b4";
const EMPTY = "00000000-0000-0000-0000-000000000000";

const avr = (ref: string, over: Record<string, unknown>) => ({
  Ref_Key: ref,
  Number: ref.slice(-2),
  Date: "2026-09-30T00:00:00",
  ДатаВыполненияРабот: "2026-09-30T00:00:00",
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент: CP,
  Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
  Договор_Key: CTR,
  Направление: "Входящий",
  Статус: "Подтвержденный",
  Состояние: "ПодтвержденПолучателем",
  ИтогоСтоимостьСУчетомКосвенныхНалогов: 112000,
  ИтогоСтоимостьБезУчетаКосвенныхНалогов: 100000,
  ДокументОснование: EMPTY,
  ДокументОснование_Type: "StandardODATA.Undefined",
  ...over,
});
const rec = (ref: string, over: Record<string, unknown>) => ({
  Ref_Key: ref,
  Number: ref.slice(-2),
  Date: "2026-09-30T00:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: CP,
  ДоговорКонтрагента_Key: CTR,
  СуммаДокумента: 112000,
  ...over,
});

function connection(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    cfg: { name: "default" },
    behavior: { pageSize: 100, maxRows: 1000, analyticsMaxRows: 10000 },
    getMetadata: async () => ({ entities: new Map() }),
    available: async () => new Set(Object.keys(rows)),
    client: {
      getEntity: async () => ({}),
      getCollection: async (path: string) => {
        const key = Object.keys(rows).find((k) => path.startsWith(k));
        return { value: key ? rows[key]! : [] };
      },
    },
  };
}
const call = async (c: unknown, t: string, a: Record<string, unknown> = {}) =>
  await toolsOf(c)[t]!.handler({ database: "default", ...a }, {});
const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>;

const doc = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  number: ref,
  date: "2026-09-30",
  posted: true,
  deleted: false,
  org: ORG,
  counterparty: CP,
  contract: CTR,
  amount: 100,
  dates: [Date.parse("2026-09-30") / 864e5],
  ...over,
});
const subj = {
  org: ORG,
  counterparty: CP,
  contract: CTR,
  amounts: [100, 90],
  dates: [Date.parse("2026-09-30") / 864e5],
};
const opts = { windowDays: 31, tolerance: 0.01, taken: new Set<string>() };

describe("rankCandidates", () => {
  it("один подходящий — unique; сумма без налогов тоже подходит", () => {
    expect(rankCandidates(subj, [doc("a", { amount: 90 })], opts).verdict).toBe("unique");
  });
  it("чужой контрагент, сумма, дата вне окна, удалённый и занятый — не кандидаты", () => {
    const docs = [
      doc("cp", { counterparty: CP2 }),
      doc("sum", { amount: 101 }),
      doc("far", { dates: [Date.parse("2026-01-01") / 864e5] }),
      doc("del", { deleted: true }),
      doc("busy"),
    ];
    const r = rankCandidates(subj, docs, { ...opts, taken: new Set(["busy"]) });
    expect(r).toEqual({ candidates: [], verdict: "none" });
  });
  it("несколько — ambiguous, лучший выше: договор и близкая дата", () => {
    const r = rankCandidates(
      subj,
      [doc("far", { dates: [Date.parse("2026-09-10") / 864e5], contract: undefined }), doc("near")],
      opts,
    );
    expect(r.verdict).toBe("ambiguous");
    expect(r.candidates.map((c) => c.ref)).toEqual(["near", "far"]);
    expect(r.candidates[0]!.matchedBy).toContain("договор");
  });
  it("без контрагента — no_counterparty, но с кандидатами по сумме и дате", () => {
    const r = rankCandidates({ ...subj, counterparty: undefined }, [doc("a")], opts);
    expect(r.verdict).toBe("no_counterparty");
    expect(r.candidates).toHaveLength(1);
  });
  it("annotateBatch: общий кандидат получает sharedWith, лидер — при разрыве оценок", () => {
    const c = (ref: string, score: number) => ({ ref, score });
    const items = [
      { verdict: "ambiguous", candidates: [c("x", 104), c("y", 80)] },
      { verdict: "unique", candidates: [c("x", 90)] },
    ];
    annotateBatch(items as never);
    expect((items[0] as any).leader).toBe("x");
    expect((items[0] as any).candidates[0].sharedWith).toBe(1);
    expect((items[0] as any).candidates[1].sharedWith).toBeUndefined();
  });
});

describe("read.esf.list_avr / find_avr_basis", () => {
  const rows = () => ({
    Document_ЭлектронныйАктВыполненныхРабот: [
      avr(AVR1, {}),
      avr(AVR2, { Контрагент: EMPTY, Контрагент_Type: "StandardODATA.Undefined" }),
      avr(AVR3, { ИтогоСтоимостьСУчетомКосвенныхНалогов: 5, ИтогоСтоимостьБезУчетаКосвенныхНалогов: 4 }),
      avr(AVR4, {
        ДокументОснование: R4,
        ДокументОснование_Type: "StandardODATA.Document_ПоступлениеТоваровУслуг",
      }),
    ],
    Document_ПоступлениеТоваровУслуг: [
      rec(R1, {}),
      rec(R2, { Date: "2026-09-25T00:00:00", ДоговорКонтрагента_Key: CP2 }),
      rec(R3, { Контрагент_Key: CP2 }),
      rec(R4, {}),
    ],
  });

  it("list_avr: признак основания и фильтр hasBasis", async () => {
    const all = sc(await call(connection(rows()), "read.esf.list_avr"));
    expect(all["count"]).toBe(4);
    expect(all["avr"].find((a: any) => a.ref === AVR4).hasBasis).toBe(true);
    expect(all["avr"].find((a: any) => a.ref === AVR1)).toMatchObject({
      hasBasis: false,
      amountWithVat: 112000,
      amountWithoutVat: 100000,
    });
    const none = sc(await call(connection(rows()), "read.esf.list_avr", { hasBasis: false }));
    expect(none["avr"].map((a: any) => a.ref).sort()).toEqual([AVR1, AVR2, AVR3]);
  });

  it("find_avr_basis: ЭАВР с основанием пропускаются, занятый R4 не предлагается, ambiguous помечен", async () => {
    const r = sc(await call(connection(rows()), "read.esf.find_avr_basis"));
    expect(r["items"].map((i: any) => i.avrRef).sort()).toEqual([AVR1, AVR2, AVR3]);
    const one = r["items"].find((i: any) => i.avrRef === AVR1);
    expect(one.verdict).toBe("ambiguous");
    expect(one.candidates.map((c: any) => c.ref)).toEqual([R1, R2]);
    expect(one.leader).toBe(R1);
    expect(one.candidates.map((c: any) => c.ref)).not.toContain(R4);
    expect(r["items"].find((i: any) => i.avrRef === AVR3).verdict).toBe("none");
    expect(r["items"].find((i: any) => i.avrRef === AVR2).verdict).toBe("no_counterparty");
    expect(r["summary"]).toEqual({ unique: 0, ambiguous: 1, none: 1, noCounterparty: 1 });
  });
});

describe("read.esf.find_esf_invoice", () => {
  const SF1 = "00000000-0000-4000-8000-0000000000c1";
  const SF2 = "00000000-0000-4000-8000-0000000000c2";
  const esf = (ref: string, over: Record<string, unknown>) => ({
    Ref_Key: ref,
    Number: ref.slice(-2),
    Date: "2026-10-01T00:00:00",
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: CP,
    Направление: "Входящий",
    Статус: "Доставленный",
    СуммаДокумента: 500,
    ДатаОборота: "2026-10-01T00:00:00",
    СчетФактура: EMPTY,
    СчетФактура_Type: "StandardODATA.Undefined",
    ...over,
  });
  const sf = (ref: string, over: Record<string, unknown> = {}) => ({
    Ref_Key: ref,
    Number: ref.slice(-2),
    Date: "2026-10-01T00:00:00",
    Posted: false,
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: CP,
    СуммаДокумента: 500,
    ...over,
  });
  it("кандидат — свободная СФ; отозванный ЭСФ — notNeeded; занятая СФ не предлагается", async () => {
    const e1 = "00000000-0000-4000-8000-0000000000d1";
    const e2 = "00000000-0000-4000-8000-0000000000d2";
    const e3 = "00000000-0000-4000-8000-0000000000d3";
    const c = connection({
      Document_ЭСФ: [
        esf(e1, {}),
        esf(e2, { Статус: "Отозванный" }),
        esf(e3, { СчетФактура: SF2, СчетФактура_Type: "StandardODATA.Document_СчетФактураПолученный" }),
      ],
      Document_СчетФактураПолученный: [sf(SF1), sf(SF2)],
    });
    const r = sc(await call(c, "read.esf.find_esf_invoice"));
    expect(r["count"]).toBe(2);
    const one = r["items"].find((i: any) => i.esfRef === e1);
    expect(one.verdict).toBe("unique");
    expect(one.candidates.map((x: any) => x.ref)).toEqual([SF1]);
    expect(r["items"].find((i: any) => i.esfRef === e2).verdict).toBe("notNeeded");
    expect(r["summary"]).toMatchObject({ unique: 1, notNeeded: 1 });
  });
});
