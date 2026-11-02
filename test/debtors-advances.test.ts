import { describe, expect, it } from "vitest";
import { BUYER, ORG, baseStore, fake1C, id, type Row, type Store } from "./support/fake-1c.js";
import { computeDebtors } from "../src/odata/debtors.js";

/**
 * Дебиторка Казахстана: долг по 1210 минус полученный аванс по 3510 по тому же контрагенту.
 * Суммы «Бизнес Мышление» — сверка логики с боевой базой (902 786 − 392 268 = 510 518); в коде их нет.
 */
const cpType = "StandardODATA.Catalog_Контрагенты";
const CP_BM = id(700);
const CP_OVER = id(701);
const CP_ONLY_ADV = id(702);
const CP_NO_ADV = id(703);
const CP_EQUAL = id(704);
const A1210 = id(710);
const A3510 = id(711);
const A6010 = id(712);

const bal = (account: string, cp: string, dr: number, cr: number, extra: Row = {}): Row => ({
  Account_Key: account,
  ExtDimension1: cp,
  ExtDimension1_Type: cpType,
  Организация_Key: ORG,
  СуммаBalanceDr: dr,
  СуммаBalanceCr: cr,
  ...extra,
});

describe("computeDebtors — 1210 минус 3510 по контрагенту", () => {
  it("долг больше аванса: итог = 1210 − 3510 (пример «Бизнес Мышление»)", () => {
    const r = computeDebtors([bal(A1210, CP_BM, 902786, 0)], [bal(A3510, CP_BM, 0, 392268)], {
      names: new Map([[CP_BM, "Бизнес Мышление"]]),
    });
    expect(r.debtors).toEqual([
      expect.objectContaining({
        counterparty: "Бизнес Мышление",
        receivable: 902786,
        advance: 392268,
        amount: 510518,
        status: "debt_with_advance",
        advanceExceedsDebt: false,
      }),
    ]);
    expect(r.debtors[0]!.note).toMatch(/не зачтён/);
    expect(r.advancesOverDebt).toEqual([]);
    expect(r.totals).toEqual({
      debtCents: 90278600,
      advanceCents: 39226800,
      netCents: 51051800,
      advanceOverDebtCents: 0,
    });
  });

  it("аванс больше долга: отрицательный итог, флаг и отдельный список", () => {
    const r = computeDebtors([bal(A1210, CP_OVER, 100, 0)], [bal(A3510, CP_OVER, 0, 250.5)]);
    expect(r.debtors).toEqual([]);
    expect(r.advancesOverDebt).toEqual([
      expect.objectContaining({
        receivable: 100,
        advance: 250.5,
        amount: -150.5,
        status: "advance_exceeds_debt",
        advanceExceedsDebt: true,
      }),
    ]);
    expect(r.advancesOverDebt[0]!.note).toMatch(/^Аванс больше долга/);
    expect(r.totals.advanceOverDebtCents).toBe(15050);
    expect(r.totals.netCents).toBe(0);
  });

  it("аванс равен долгу — итог 0, в список авансов, не в должники", () => {
    const r = computeDebtors([bal(A1210, CP_EQUAL, 500, 0)], [bal(A3510, CP_EQUAL, 0, 500)]);
    expect(r.debtors).toEqual([]);
    expect(r.advancesOverDebt).toEqual([
      expect.objectContaining({ amount: 0, status: "advance_equals_debt", advanceExceedsDebt: false }),
    ]);
  });

  it("только аванс 3510 без долга 1210 — виден со статусом advance_only", () => {
    const r = computeDebtors([], [bal(A3510, CP_ONLY_ADV, 0, 1000)]);
    expect(r.advancesOverDebt).toEqual([
      expect.objectContaining({
        ref: CP_ONLY_ADV,
        receivable: 0,
        advance: 1000,
        amount: -1000,
        status: "advance_only",
        advanceExceedsDebt: true,
      }),
    ]);
    expect(r.totals).toEqual({
      debtCents: 0,
      advanceCents: 100000,
      netCents: 0,
      advanceOverDebtCents: 100000,
    });
  });

  it("без аванса — как раньше: долг = итог, статус debt, без примечания", () => {
    const r = computeDebtors([bal(A1210, CP_NO_ADV, 700, 200)], []);
    expect(r.debtors).toEqual([
      {
        counterparty: CP_NO_ADV,
        ref: CP_NO_ADV,
        receivable: 500,
        advance: 0,
        amount: 500,
        status: "debt",
        advanceExceedsDebt: false,
      },
    ]);
  });

  it("аванс одного контрагента не уменьшает долг другого; сортировка по итогу", () => {
    const r = computeDebtors(
      [bal(A1210, CP_BM, 300, 0), bal(A1210, CP_NO_ADV, 1000, 0), bal(A1210, CP_BM, 200, 0)],
      [bal(A3510, CP_BM, 0, 100), bal(A3510, CP_ONLY_ADV, 0, 50)],
    );
    expect(r.debtors.map((d) => [d.ref, d.receivable, d.advance, d.amount])).toEqual([
      [CP_NO_ADV, 1000, 0, 1000],
      [CP_BM, 500, 100, 400],
    ]);
    expect(r.advancesOverDebt.map((d) => [d.ref, d.status])).toEqual([[CP_ONLY_ADV, "advance_only"]]);
    expect(r.totals).toEqual({
      debtCents: 150000,
      advanceCents: 15000,
      netCents: 140000,
      advanceOverDebtCents: 5000,
    });
  });

  it("строки 3510 с другим типом субконто (не контрагент) пропускаются", () => {
    const r = computeDebtors(
      [bal(A1210, CP_BM, 1000, 0)],
      [bal(A3510, CP_BM, 0, 400, { ExtDimension1_Type: "StandardODATA.Catalog_Сотрудники" })],
      { counterpartyTypes: ["Catalog_Контрагенты"] },
    );
    expect(r.debtors[0]).toMatchObject({ advance: 0, amount: 1000, status: "debt" });
  });

  it("копейки без float-дрейфа", () => {
    const r = computeDebtors(
      [bal(A1210, CP_BM, 0.1, 0), bal(A1210, CP_BM, 0.2, 0)],
      [bal(A3510, CP_BM, 0, 0.1)],
    );
    expect(r.debtors[0]).toMatchObject({ receivable: 0.3, advance: 0.1, amount: 0.2 });
  });
});

function kzStore(): Store {
  return {
    ...baseStore(),
    ChartOfAccounts_Типовой: [
      {
        Ref_Key: A1210,
        Code: "1210",
        Description: "Краткосрочная дебиторская задолженность покупателей и заказчиков",
      },
      { Ref_Key: A3510, Code: "3510", Description: "Краткосрочные авансы полученные" },
      { Ref_Key: A6010, Code: "6010", Description: "Доход от реализации" },
    ],
    AccountingRegister_Типовой: [],
    "AccountingRegister_Типовой/Balance": [
      bal(A1210, BUYER, 902786, 0),
      bal(A3510, BUYER, 0, 392268),
      bal(A3510, CP_ONLY_ADV, 0, 1000),
      bal(A6010, BUYER, 0, 5000000),
    ],
  };
}

describe("read.analytics.get_debtors — Казахстан (1210 и 3510)", () => {
  it("по каждому должнику: долг 1210, аванс 3510, итог; аванс без долга — отдельно", async () => {
    const f = fake1C({ store: kzStore() });
    const r = await f.call("read.analytics.get_debtors", {});
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const sc = r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(sc["accounts"]).toEqual(["1210 Краткосрочная дебиторская задолженность покупателей и заказчиков"]);
    expect(sc["advanceAccounts"]).toEqual(["3510 Краткосрочные авансы полученные"]);
    expect(sc["debtors"]).toEqual([
      expect.objectContaining({
        counterparty: 'ТОО "TRADESPACE"',
        ref: BUYER,
        receivable: 902786,
        advance: 392268,
        amount: 510518,
        status: "debt_with_advance",
      }),
    ]);
    expect(sc["advancesOverDebt"]).toEqual([
      expect.objectContaining({ ref: CP_ONLY_ADV, advance: 1000, amount: -1000, status: "advance_only" }),
    ]);
    expect(sc["totalReceivable"]).toBe(510518);
    expect(sc["totalDebt"]).toBe(902786);
    expect(sc["totalAdvances"]).toBe(393268);
    expect(sc["totalAdvancesOverDebt"]).toBe(1000);
    expect(sc["count"]).toBe(1);
    expect(sc["advanceNote"]).toMatch(/не зачтены автоматически/);
  });
});
