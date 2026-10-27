import type { Connection } from "../context.js";
import { CATALOGS, resolveEntity } from "../config/mapping.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, odataString } from "../odata/query.js";
import type { ODataEntity } from "../types/odata.js";
import { rateOn } from "./registers-info.js";

/**
 * Валюта, курс и банковский счёт документа продажи (Казахстан): валюта — из договора или явно, курс — срез последних
 * регистра «Курсы валют» на дату документа (с кратностью), банковский счёт организации — в валюте документа.
 * Общие для быстрых инструментов продаж (quick_invoice, quick_sale).
 */

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const low = (v: unknown): string => str(v).replace(/[{}']/g, "").toLowerCase();
export const refOrNone = (v: unknown): string | undefined => {
  const s = str(v);
  return s && s !== EMPTY ? s : undefined;
};
const dateSet = (v: unknown): boolean => {
  const d = str(v).slice(0, 10);
  return !!d && !d.startsWith("0001");
};

export interface CurrencyInfo {
  ref: string;
  /** Цифровой код (398, 840). */
  code: string;
  /** Буквенный код / наименование в справочнике (KZT, USD). */
  name: string;
  isTenge: boolean;
}

export interface DocRate {
  /** Курс взаиморасчётов (тенге за `multiplier` единиц валюты). */
  rate: number;
  multiplier: number;
  /** Дата записи регистра, из которой взят курс (для тенге — пусто). */
  period?: string | undefined;
}

async function currencyRows(conn: Connection): Promise<ODataEntity[]> {
  const set = await requireEntity(conn, CATALOGS.currencies, "Справочник «Валюты»");
  const { rows } = await fetchAll(
    conn.client,
    set,
    { select: ["Ref_Key", "Code", "Description", "DeletionMark"] },
    200,
    500,
  );
  return rows;
}

const toInfo = (r: ODataEntity): CurrencyInfo => ({
  ref: str(r["Ref_Key"]),
  code: str(r["Code"]),
  name: str(r["Description"]),
  isTenge: str(r["Code"]) === "398",
});

/** Валюта по Ref_Key, цифровому коду (840) или буквенному коду / наименованию (USD). Не нашлась — InputError. */
export async function resolveCurrency(conn: Connection, query: string): Promise<CurrencyInfo> {
  const q = query.trim();
  const rows = await currencyRows(conn);
  const hit =
    rows.find((r) => GUID_RE.test(q) && low(r["Ref_Key"]) === low(q)) ??
    rows.find((r) => str(r["Code"]) === q) ??
    rows.find((r) => str(r["Description"]).toLowerCase() === q.toLowerCase());
  if (!hit)
    throw new InputError(
      `Валюта «${q}» не найдена в справочнике «Валюты». Укажите цифровой код (398, 840) или буквенный (KZT, USD).`,
    );
  return toInfo(hit);
}

/** Карточка валюты по ссылке; пустая ссылка или нет в справочнике — undefined. */
export async function currencyByRef(
  conn: Connection,
  ref: string | undefined,
): Promise<CurrencyInfo | undefined> {
  if (!refOrNone(ref)) return undefined;
  const rows = await currencyRows(conn);
  const hit = rows.find((r) => low(r["Ref_Key"]) === low(ref));
  return hit ? toInfo(hit) : undefined;
}

/** Валюта взаиморасчётов договора (ВалютаВзаиморасчетов_Key); не прочиталась — undefined. */
export async function contractCurrencyRef(
  conn: Connection,
  contractSet: string | undefined,
  contractRef: string | undefined,
): Promise<string | undefined> {
  if (!contractSet || !refOrNone(contractRef)) return undefined;
  try {
    const c = await conn.client.getEntity(
      `${contractSet}(guid'${str(contractRef).replace(/[{}']/g, "")}')${buildQuery({ select: ["Ref_Key", "ВалютаВзаиморасчетов_Key"] })}`,
    );
    return refOrNone(c["ВалютаВзаиморасчетов_Key"]);
  } catch {
    return undefined;
  }
}

/**
 * Курс взаиморасчётов на дату: тенге — 1/1; иначе срез последних InformationRegister_КурсыВалют на конец дня
 * `date` (Курс и Кратность как в регистре). Курса в регистре нет — undefined (вызывающий предупреждает).
 */
export async function rateForDocument(
  conn: Connection,
  currency: CurrencyInfo,
  date: string,
): Promise<DocRate | undefined> {
  if (currency.isTenge) return { rate: 1, multiplier: 1 };
  const r = await rateOn(conn, currency.ref, date);
  if (!r || !(r.rate > 0)) return undefined;
  // Курс 1 к 1 у иностранной валюты — заглушка «курсы не загружены» (запись от 01.01.1980 в новой базе), а не курс:
  // счёт по нему вышел бы «в долларах по курсу 1». Считаем, что курса нет.
  if (r.rate === 1 && (r.multiplier || 1) === 1) return undefined;
  return { rate: r.rate, multiplier: r.multiplier || 1, period: r.period };
}

export interface OrgBankAccount {
  ref: string;
  name: string;
  number: string;
  currencyRef?: string | undefined;
  closed: boolean;
}

/** Банковские счета организации с валютой; помеченные на удаление не берём. Ошибка чтения — пустой список. */
export async function orgBankAccountsWithCurrency(
  conn: Connection,
  orgRef: string,
): Promise<OrgBankAccount[]> {
  const available = await conn.available();
  const set = resolveEntity(CATALOGS.bankAccounts, available);
  if (!set) return [];
  const orgSet = resolveEntity(CATALOGS.organizations, available);
  try {
    const { rows } = await fetchAll(
      conn.client,
      set,
      {
        filter: and(
          orgSet ? cmp("Owner_Type", "eq", odataString(`StandardODATA.${orgSet}`)) : undefined,
          cmp("DeletionMark", "eq", "false"),
        ),
        select: [
          "Ref_Key",
          "Description",
          "НомерСчета",
          "Owner",
          "ВалютаДенежныхСредств_Key",
          "ДатаЗакрытия",
        ],
      },
      conn.behavior.pageSize,
      200,
    );
    return rows
      .filter((r) => low(r["Owner"]) === low(orgRef))
      .map((r) => ({
        ref: str(r["Ref_Key"]),
        name: str(r["Description"]),
        number: str(r["НомерСчета"]),
        currencyRef: refOrNone(r["ВалютаДенежныхСредств_Key"]),
        closed: dateSet(r["ДатаЗакрытия"]),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  } catch {
    return [];
  }
}

export interface BankPick {
  ref?: string | undefined;
  /** Предупреждение для плана (несовпадение валюты, выбор из нескольких, нет счёта в валюте). */
  note?: string | undefined;
}

const accountText = (a: OrgBankAccount) => `«${a.name}»${a.number ? ` (${a.number})` : ""}`;

/**
 * Банковский счёт организации под валюту документа.
 * - Явный счёт (`explicitRef`) не меняем; валюта не совпала — предупреждение.
 * - Иначе предпочтительный (`preferredRef`, обычно основной) — если он в валюте документа.
 * - Иначе действующий счёт в валюте документа: один — берём; несколько — первый по названию с предупреждением.
 * - Счёта в валюте нет — оставляем предпочтительный и предупреждаем.
 * Счёт без валюты в карточке считаем тенговым (так в типовой 1С: пустая — национальная).
 */
export function pickBankForCurrency(
  accounts: OrgBankAccount[],
  currency: CurrencyInfo | undefined,
  opts: {
    explicitRef?: string | undefined;
    preferredRef?: string | undefined;
    tengeRef?: string | undefined;
  },
): BankPick {
  const byRef = (ref: string | undefined) => accounts.find((a) => low(a.ref) === low(ref));
  if (!currency) return { ref: opts.explicitRef ?? opts.preferredRef ?? accounts[0]?.ref };
  const accCurrency = (a: OrgBankAccount) => a.currencyRef ?? opts.tengeRef;
  const fits = (a: OrgBankAccount | undefined) =>
    !!a && (accCurrency(a) ? low(accCurrency(a)) === low(currency.ref) : currency.isTenge);
  if (opts.explicitRef) {
    const a = byRef(opts.explicitRef);
    if (a && !fits(a))
      return {
        ref: opts.explicitRef,
        note:
          `Банковский счёт ${accountText(a)} не в валюте документа (${currency.name}). ` +
          "Оставлен, как указано; проверьте реквизиты для оплаты.",
      };
    return { ref: opts.explicitRef };
  }
  const preferred = byRef(opts.preferredRef);
  if (preferred && fits(preferred) && !preferred.closed) return { ref: preferred.ref };
  const candidates = accounts.filter((a) => fits(a) && !a.closed);
  if (candidates.length === 1) {
    const a = candidates[0]!;
    return {
      ref: a.ref,
      note: preferred
        ? `Основной банковский счёт ${accountText(preferred)} не в валюте ${currency.name} — взят счёт в ${currency.name}: ${accountText(a)}.`
        : undefined,
    };
  }
  if (candidates.length > 1) {
    const a = candidates[0]!;
    return {
      ref: a.ref,
      note:
        `У организации несколько счетов в ${currency.name}: ${candidates.map(accountText).join("; ")}. ` +
        `Взят ${accountText(a)}; другой — передайте bankAccount.`,
    };
  }
  return {
    ref: opts.preferredRef ?? accounts[0]?.ref,
    note:
      `У организации нет действующего банковского счёта в ${currency.name}` +
      (preferred ? ` — оставлен ${accountText(preferred)}; проверьте реквизиты для оплаты.` : "."),
  };
}

/** Текст курса для плана: «451,05 за 1 USD (курс на 27.10.2026)». */
export function rateText(currency: CurrencyInfo, r: DocRate): string {
  if (currency.isTenge) return "тенге, курс 1";
  const d = r.period ? ` (курс регистра на ${r.period.split("-").reverse().join(".")})` : "";
  return `${r.rate} тенге за ${r.multiplier} ${currency.name}${d}`;
}
