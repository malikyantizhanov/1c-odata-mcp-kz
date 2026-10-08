import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Connection } from "../../src/context.js";
import type { Behavior } from "../../src/config/env.js";
import { ODataError } from "../../src/odata/errors.js";
import { createServer } from "../../src/mcp/server.js";

/**
 * «1С в памяти» для тестов инструментов записи: настоящий Connection/ODataClient/журнал записи, подменён только
 * HTTP-запрос (request). Фильтры $filter вычисляются (eq/ge/le/substringof, and/or) — как отбирает 1С.
 */

export const tmpRoots: string[] = [];
export const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "1c-quick-test-"));
  tmpRoots.push(d);
  return d;
};
afterAll(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ORG = id(1);
export const BUYER = id(2);
export const CONTRACT = id(3);
export const SERVICE = id(4);
export const BANK_ACC = id(5);
export const BANK = id(6);
export const KZT = id(7);
export const UNIT = id(8);
export const VAT16 = id(9);
export const VAT_NONE = id(10);
export const BIN = "240440007327";
export const SERVICE_NAME = "Разработка программного обеспечения";

export type Row = Record<string, unknown>;
export type Store = Record<string, Row[]>;

export function baseStore(): Store {
  return {
    Catalog_Организации: [
      {
        Ref_Key: ORG,
        Description: "Aru Market ИП",
        НаименованиеПолное: "ИП Aru Market",
        ИдентификационныйНомер: "123123123123",
        КБЕ: "19",
        ЮрФизЛицо: "ФизЛицо",
        ОсновнойБанковскийСчет_Key: BANK_ACC,
        НомерСвидетельстваПоНДС: "",
        СерияСвидетельстваПоНДС: "",
        ДатаПостановкиНаУчетПоНДС: "0001-01-01T00:00:00",
        DeletionMark: false,
      },
    ],
    Catalog_Контрагенты: [
      {
        Ref_Key: BUYER,
        Description: 'ТОО "TRADESPACE"',
        НаименованиеПолное: 'ТОО "TRADESPACE"',
        ИдентификационныйКодЛичности: BIN,
        ОсновнойДоговорКонтрагента_Key: "00000000-0000-0000-0000-000000000000",
        DeletionMark: false,
      },
    ],
    Catalog_ДоговорыКонтрагентов: [
      {
        Ref_Key: CONTRACT,
        Description: "Договор б/н",
        НомерДоговора: "б/н",
        ДатаДоговора: "2026-10-08T00:00:00",
        Owner_Key: BUYER,
        Организация_Key: ORG,
        ВидДоговора: "СПокупателем",
        ДатаНачалаДействияДоговора: "0001-01-01T00:00:00",
        ДатаОкончанияДействияДоговора: "0001-01-01T00:00:00",
        IsFolder: false,
        DeletionMark: false,
      },
    ],
    Catalog_Номенклатура: [
      {
        Ref_Key: SERVICE,
        Code: "00000000013",
        Description: SERVICE_NAME,
        НаименованиеПолное: SERVICE_NAME,
        Услуга: true,
        БазоваяЕдиницаИзмерения_Key: UNIT,
        IsFolder: false,
        DeletionMark: false,
      },
      {
        Ref_Key: id(11),
        Code: "00000000014",
        Description: "Разработка сайта",
        Услуга: true,
        IsFolder: false,
        DeletionMark: false,
      },
    ],
    Catalog_БанковскиеСчета: [
      {
        Ref_Key: BANK_ACC,
        Description: "Основной",
        НомерСчета: "KZ86125KZT1004100100",
        Банк_Key: BANK,
        Owner: ORG,
      },
    ],
    Catalog_Банки: [
      { Ref_Key: BANK, Description: 'АО "Банк ЦентрКредит"', БИК: "KCJBKZKX", Город: "Алматы" },
    ],
    Catalog_Валюты: [
      {
        Ref_Key: KZT,
        Code: "398",
        Description: "KZT",
        ПараметрыПрописиНаРусском: "теңге, теңге, теңге, м, тиын, тиын, тиын, м, 2",
      },
    ],
    Catalog_КлассификаторЕдиницИзмерения: [
      { Ref_Key: UNIT, Code: "796", Description: "шт", НаименованиеПолное: "Штука" },
    ],
    Catalog_СтавкиНДС: [
      { Ref_Key: VAT16, Description: "16%" },
      { Ref_Key: VAT_NONE, Description: "без НДС" },
    ],
    Document_СчетНаОплатуПокупателю: [],
  };
}

/** Вычисляет $filter OData v3 в объёме, который строит MCP: eq/ne/ge/le/gt/lt, substringof, and/or, скобки. */
export function matches(row: Row, filter: string | undefined): boolean {
  if (!filter) return true;
  const f = filter.trim();
  const split = (s: string, sep: string): string[] | undefined => {
    let depth = 0;
    let quote = false;
    const parts: string[] = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "'") quote = !quote;
      if (quote) continue;
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (depth === 0 && s.startsWith(sep, i)) {
        parts.push(s.slice(start, i));
        start = i + sep.length;
      }
    }
    if (!parts.length) return undefined;
    parts.push(s.slice(start));
    return parts;
  };
  const ors = split(f, " or ");
  if (ors) return ors.some((p) => matches(row, p));
  const ands = split(f, " and ");
  if (ands) return ands.every((p) => matches(row, p));
  if (f.startsWith("(") && f.endsWith(")")) return matches(row, f.slice(1, -1));
  const sub = /^substringof\('((?:[^']|'')*)',\s*(\S+)\)$/.exec(f);
  if (sub)
    return String(row[sub[2]!] ?? "")
      .toLowerCase()
      .includes(sub[1]!.replace(/''/g, "'").toLowerCase());
  // Составное поле: «Объект eq cast(guid'…', 'Catalog_…')» — ссылка и тип (Объект_Type = StandardODATA.Catalog_…).
  const cast = /^(\S+) eq cast\(guid'([^']*)', '([^']*)'\)$/.exec(f);
  if (cast)
    return row[cast[1]!] === cast[2] && String(row[`${cast[1]!}_Type`] ?? "").endsWith(`.${cast[3]!}`);
  const m = /^(\S+) (eq|ne|ge|le|gt|lt) (?:guid|datetime)?'?((?:[^']|'')*?)'?$/.exec(f);
  if (!m) throw new Error(`Фильтр не поддержан тестом: ${f}`);
  const [, field, op, raw] = m;
  const v = raw!.replace(/''/g, "'");
  const actual = row[field!];
  const a = typeof actual === "boolean" ? String(actual) : String(actual ?? "");
  switch (op) {
    case "eq":
      return a === v;
    case "ne":
      return a !== v;
    case "ge":
      return a >= v;
    case "le":
      return a <= v;
    case "gt":
      return a > v;
    default:
      return a < v;
  }
}

export function fake1C(opts: { writable?: boolean; readOnly?: boolean; store?: Store } = {}) {
  const store = opts.store ?? baseStore();
  const behavior: Behavior = {
    timeoutMs: 1000,
    retries: 0,
    pageSize: 100,
    maxRows: 1000,
    analyticsMaxRows: 1000,
    readOnly: opts.readOnly ?? false,
    writeJournalDir: tmp(),
    printDir: tmp(),
    writeOperationMarker: false,
  };
  const conn = new Connection(
    {
      name: "default",
      baseUrl: "https://1c.test/odata/",
      username: "u",
      password: "p",
      writable: opts.writable ?? true,
    },
    behavior,
  );
  const props = (set: string) => ({
    properties: [...new Set((store[set] ?? []).flatMap((r) => Object.keys(r)))].map((name) => ({ name })),
  });
  const entities = new Map<string, { properties: { name: string }[] }>([
    ...Object.keys(store).map((s) => [s, props(s)] as [string, { properties: { name: string }[] }]),
    ["ChartOfAccounts_Типовой", { properties: [] }],
  ]);
  vi.spyOn(conn, "getMetadata").mockResolvedValue({ entities } as never);
  const posts: Array<{ set: string; body: Row }> = [];
  const gets: string[] = [];
  let failNext: ((set: string) => Error | undefined) | undefined;
  let failGet: ((path: string) => Error | undefined) | undefined;
  let counter = 0;
  vi.spyOn(conn.client, "request").mockImplementation((async (path: string, method = "GET", body?: Row) => {
    const p = decodeURIComponent(path);
    const set = /^[^(?]+/.exec(p)![0];
    if (method === "POST") {
      const err = failNext?.(set);
      if (err) throw err;
      const ref = (body?.["Ref_Key"] as string) ?? id(900 + ++counter);
      const created: Row = { ...body, Ref_Key: ref };
      if (set.startsWith("Document_")) created["Number"] = String(++counter).padStart(11, "0");
      else created["Code"] = String(++counter).padStart(11, "0");
      created["DeletionMark"] = false;
      created["IsFolder"] = false;
      (store[set] ??= []).push(created);
      posts.push({ set, body: body ?? {} });
      return created;
    }
    gets.push(p);
    const getErr = failGet?.(p);
    if (getErr) throw getErr;
    const key = /\(guid'([^']+)'\)/.exec(p)?.[1];
    if (key) {
      const row = (store[set] ?? []).find((r) => r["Ref_Key"] === key);
      if (!row) throw new ODataError({ kind: "not_found", status: 404, message: `${set}(${key}) не найден` });
      return { ...row };
    }
    const q = new URLSearchParams(p.slice(p.indexOf("?") + 1).replace(/\+/g, "%2B"));
    const all = (store[set] ?? []).filter((r) => matches(r, q.get("$filter") ?? undefined));
    const skip = Number(q.get("$skip") ?? 0);
    const top = Number(q.get("$top") ?? all.length);
    return { value: all.slice(skip, skip + top) };
  }) as never);
  const tools = (
    createServer({ db: () => conn } as never) as unknown as {
      _registeredTools: Record<string, { handler: (a: Row, e: Row) => Promise<CallToolResult> }>;
    }
  )._registeredTools;
  const call = (name: string, args: Row) => tools[name]!.handler({ database: "default", ...args }, {});
  return {
    conn,
    store,
    posts,
    gets,
    call,
    quick: (args: Row) => call("write.sales.quick_invoice", args),
    failOn: (fn: typeof failNext) => (failNext = fn),
    failGetOn: (fn: typeof failGet) => (failGet = fn),
  };
}
