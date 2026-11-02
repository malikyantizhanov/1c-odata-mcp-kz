import type { ODataEntity } from "../types/odata.js";
import { num } from "./accounting.js";

/**
 * Дебиторка с учётом полученных авансов (чистая логика, без OData — для юнит-тестов).
 *
 * По каждому контрагенту (ExtDimension1):
 *  - receivable — сальдо счетов расчётов с покупателями (Дт − Кт; в Казахстане 1210);
 *  - advance — сальдо счетов полученных авансов (Кт − Дт; в Казахстане 3510);
 *  - amount — итог: receivable − advance.
 * Аванс НЕ зачитывается в 1С и не «прячется»: показываются все три числа, а решение о зачёте
 * (проводка Дт 3510 Кт 1210) остаётся за бухгалтером.
 */

export type DebtorStatus =
  | "debt" // долг без аванса
  | "debt_with_advance" // долг больше аванса
  | "advance_equals_debt" // аванс равен долгу — итог 0
  | "advance_exceeds_debt" // аванс больше долга — итог отрицательный
  | "advance_only"; // аванс без долга по счёту покупателей

export interface DebtorLine {
  counterparty: string;
  ref: string;
  /** Долг по счёту расчётов с покупателями (1210). */
  receivable: number;
  /** Полученный аванс по тому же контрагенту (3510). */
  advance: number;
  /** Итог с учётом аванса: receivable − advance (отрицательный — аванс больше долга). */
  amount: number;
  status: DebtorStatus;
  /** true — аванс больше долга (или долга нет вовсе). */
  advanceExceedsDebt: boolean;
  note?: string;
}

export interface DebtorsComputation {
  /** Итог > 0: контрагент должен и после учёта аванса. По убыванию итога. */
  debtors: DebtorLine[];
  /** Аванс ≥ долга (в т.ч. аванс без долга). По убыванию превышения аванса. */
  advancesOverDebt: DebtorLine[];
  totals: {
    /** Сумма положительных долгов по счёту покупателей. */
    debtCents: number;
    /** Сумма положительных авансов. */
    advanceCents: number;
    /** Сумма положительных итогов (к получению с учётом авансов). */
    netCents: number;
    /** Сумма превышений аванса над долгом. */
    advanceOverDebtCents: number;
  };
}

export interface ComputeDebtorsOptions {
  /** Коды счетов для текста примечания, напр. «1210» и «3510». */
  receivableCode?: string;
  advanceCode?: string;
  /**
   * Типы субконто, которые считаем контрагентом (по ExtDimension1_Type). Строка аванса с другим
   * типом субконто (не контрагент) пропускается. Нет поля типа в строке — строка берётся.
   */
  counterpartyTypes?: readonly string[];
  names?: ReadonlyMap<string, string>;
  limit?: number;
}

const toCents = (v: unknown): number => Math.round(num(v) * 100);
const fromCents = (c: number): number => Math.round(c) / 100;

function isCounterparty(row: ODataEntity, types: readonly string[] | undefined): boolean {
  if (!types || types.length === 0) return true;
  const t = row["ExtDimension1_Type"];
  if (typeof t !== "string" || !t) return true;
  return types.some((name) => t === name || t.endsWith(`.${name}`));
}

function sumBy(rows: readonly ODataEntity[], sign: 1 | -1, types?: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const cp = String(r["ExtDimension1"] ?? "");
    if (!cp || !isCounterparty(r, types)) continue;
    const dr = toCents(r["СуммаBalanceDr"]);
    const cr = toCents(r["СуммаBalanceCr"]);
    out.set(cp, (out.get(cp) ?? 0) + sign * (dr - cr));
  }
  return out;
}

export function computeDebtors(
  receivableRows: readonly ODataEntity[],
  advanceRows: readonly ODataEntity[],
  opts: ComputeDebtorsOptions = {},
): DebtorsComputation {
  const recCode = opts.receivableCode ?? "1210";
  const advCode = opts.advanceCode ?? "3510";
  const rec = sumBy(receivableRows, 1);
  const adv = sumBy(advanceRows, -1, opts.counterpartyTypes);
  const refs = new Set<string>([...rec.keys(), ...adv.keys()]);

  const debtors: Array<DebtorLine & { _net: number }> = [];
  const over: Array<DebtorLine & { _net: number }> = [];
  const totals = { debtCents: 0, advanceCents: 0, netCents: 0, advanceOverDebtCents: 0 };

  for (const ref of refs) {
    const r = rec.get(ref) ?? 0;
    const a = adv.get(ref) ?? 0;
    const posR = Math.max(r, 0);
    const posA = Math.max(a, 0);
    if (posR === 0 && posA === 0) continue; // ни долга, ни аванса (закрыто или переплата на самом 1210 без 3510)
    // Отрицательное сальдо 1210 (переплата, учтённая на счёте покупателей) — как и раньше, уменьшает долг.
    const net = r - posA;
    totals.debtCents += posR;
    totals.advanceCents += posA;

    let status: DebtorStatus;
    if (posA === 0) status = "debt";
    else if (posR === 0) status = "advance_only";
    else if (net > 0) status = "debt_with_advance";
    else if (net === 0) status = "advance_equals_debt";
    else status = "advance_exceeds_debt";

    let note: string | undefined;
    if (
      status === "debt_with_advance" ||
      status === "advance_equals_debt" ||
      status === "advance_exceeds_debt"
    ) {
      note =
        `Есть полученный аванс (${advCode}) — итог показан с его учётом. В 1С аванс не зачтён: ` +
        `зачёт (Дт ${advCode} Кт ${recCode}) — решение бухгалтера.`;
    } else if (status === "advance_only") {
      note = `Долга по ${recCode} нет, есть полученный аванс (${advCode}) — покупатель должен нам поставку/услугу.`;
    }
    if (status === "advance_exceeds_debt") note = `Аванс больше долга. ${note}`;

    const line = {
      counterparty: opts.names?.get(ref) ?? ref,
      ref,
      receivable: fromCents(r),
      advance: fromCents(posA),
      amount: fromCents(net),
      status,
      advanceExceedsDebt: status === "advance_exceeds_debt" || status === "advance_only",
      ...(note ? { note } : {}),
      _net: net,
    };
    if (net > 0) {
      totals.netCents += net;
      debtors.push(line);
    } else {
      if (net < 0) totals.advanceOverDebtCents += -net;
      over.push(line);
    }
  }

  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const strip = ({ _net, ...rest }: DebtorLine & { _net: number }): DebtorLine => {
    void _net;
    return rest;
  };
  debtors.sort((x, y) => y._net - x._net);
  over.sort((x, y) => x._net - y._net);
  return {
    debtors: debtors.slice(0, limit).map(strip),
    advancesOverDebt: over.slice(0, limit).map(strip),
    totals,
  };
}

export const centsToAmount = fromCents;
