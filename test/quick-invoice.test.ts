import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Connection } from "../src/context.js";
import type { Behavior } from "../src/config/env.js";
import { ODataError } from "../src/odata/errors.js";
import { createServer } from "../src/mcp/server.js";
import { almatyNow, normName, subOperationId } from "../src/tools/quick-invoice.js";

/**
 * write.sales.quick_invoice на «1С в памяти»: настоящий Connection/ODataClient/журнал записи, подменён только
 * HTTP-запрос (request). Фильтры $filter вычисляются (eq/ge/le/substringof, and/or) — как отбирает 1С.
 */

const tmpRoots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "1c-quick-test-"));
  tmpRoots.push(d);
  return d;
};
afterAll(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const BUYER = id(2);
const CONTRACT = id(3);
const SERVICE = id(4);
const BANK_ACC = id(5);
const BANK = id(6);
const KZT = id(7);
const UNIT = id(8);
const VAT16 = id(9);
const VAT_NONE = id(10);
const BIN = "240440007327";
const SERVICE_NAME = "Разработка программного обеспечения";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

function baseStore(): Store {
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
    Catalog_Валюты: [{ Ref_Key: KZT, Code: "398", Description: "KZT" }],
    Catalog_КлассификаторЕдиницИзмерения: [{ Ref_Key: UNIT, Code: "796", Description: "шт" }],
    Catalog_СтавкиНДС: [
      { Ref_Key: VAT16, Description: "16%" },
      { Ref_Key: VAT_NONE, Description: "без НДС" },
    ],
    Document_СчетНаОплатуПокупателю: [],
  };
}

/** Вычисляет $filter OData v3 в объёме, который строит MCP: eq/ne/ge/le/gt/lt, substringof, and/or, скобки. */
function matches(row: Row, filter: string | undefined): boolean {
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

function fake1C(opts: { writable?: boolean; readOnly?: boolean; store?: Store } = {}) {
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

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const errText = (r: CallToolResult) => JSON.stringify(r.content);
const TRADESPACE = {
  buyer: BIN,
  date: "2026-10-08",
  lines: [{ name: SERVICE_NAME, quantity: 1, price: 1550000, kind: "service" }],
  paymentCode: "851",
};

describe("quick_invoice: помощники", () => {
  it("id шага — детерминированный UUID v8, разный для шагов; журнал его принимает", () => {
    const op = "11111111-1111-4111-8111-111111111111";
    const a = subOperationId(op, "invoice");
    expect(a).toBe(subOperationId(op, "invoice"));
    expect(a).not.toBe(subOperationId(op, "contract"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("наименования сравниваются без учёта регистра, «ё», кавычек и пробелов", () => {
    expect(normName("  Разработка   ПО «Ёлка» ")).toBe(normName('разработка по "елка"'));
  });
  it("дата по умолчанию — сегодня по Алматы (UTC+5), а не по часовому поясу хоста", () => {
    expect(almatyNow(new Date("2026-10-08T20:30:00Z"))).toEqual({
      date: "2026-10-09",
      dateTime: "2026-10-09T01:30:00",
    });
  });
});

describe("quick_invoice: план (confirm=false)", () => {
  it("TRADESPACE: находит договор и услугу, ничего не создаёт и не пишет в 1С", async () => {
    const f = fake1C();
    const res = await f.quick(TRADESPACE);
    expect(res.isError).toBeFalsy();
    const plan = sc(res);
    expect(plan).toMatchObject({
      dryRun: true,
      ready: true,
      buyer: { ref: BUYER, bin: BIN },
      contract: { action: "найден", ref: CONTRACT },
      bankAccount: { ref: BANK_ACC, number: "KZ86125KZT1004100100" },
      organization: { ref: ORG, vatPayer: false },
      lines: [{ action: "найдена", ref: SERVICE, sum: 1550000, vatRate: "без НДС" }],
      totals: { sum: 1550000, vat: 0, total: 1550000, withVat: false },
      willCreate: ["Счёт на оплату покупателю (без проведения) + PDF"],
    });
    expect(plan["operationId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.posts).toEqual([]);
  });

  it("два действующих договора — варианты, без догадки", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"]!.push({
      ...store["Catalog_ДоговорыКонтрагентов"]![0]!,
      Ref_Key: id(20),
      Description: "Договор №2",
      НомерДоговора: "2",
    });
    const plan = sc(await fake1C({ store }).quick(TRADESPACE));
    expect(plan).toMatchObject({ ready: false, choices: [{ field: "contract" }] });
    expect(plan["choices"][0].options.map((o: Row) => o["ref"]).sort()).toEqual([CONTRACT, id(20)].sort());
    expect(plan).not.toHaveProperty("operationId");
  });

  it("основной договор контрагента среди нескольких — берётся он", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"]!.push({
      ...store["Catalog_ДоговорыКонтрагентов"]![0]!,
      Ref_Key: id(20),
    });
    store["Catalog_Контрагенты"]![0]!["ОсновнойДоговорКонтрагента_Key"] = id(20);
    expect(sc(await fake1C({ store }).quick(TRADESPACE))).toMatchObject({
      ready: true,
      contract: { action: "найден", ref: id(20) },
    });
  });

  it("недействующий договор и неточное наименование услуги — варианты; createNew — «создать»", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"]![0]!["ДатаОкончанияДействияДоговора"] = "2025-12-31T00:00:00";
    const f = fake1C({ store });
    const args = { ...TRADESPACE, lines: [{ name: "Разработка", price: 1000 }] };
    const ambiguous = sc(await f.quick(args));
    expect(ambiguous).toMatchObject({ ready: false, choices: [{ field: "lines[0]" }] });
    expect(ambiguous["choices"][0].options).toHaveLength(2);

    const plan = sc(
      await f.quick({ ...args, lines: [{ name: "Разработка", price: 1000, createNew: true }] }),
    );
    expect(plan).toMatchObject({
      ready: true,
      contract: { action: "создать", name: "Договор б/н", date: "2026-10-08" },
      lines: [{ action: "создать", name: "Разработка" }],
      willCreate: [
        "Договор «Договор б/н»",
        "Услуга «Разработка»",
        "Счёт на оплату покупателю (без проведения) + PDF",
      ],
    });
    expect(f.posts).toEqual([]);
  });

  it("покупатель не найден по БИН — понятная ошибка", async () => {
    const res = await fake1C().quick({ ...TRADESPACE, buyer: "999999999999" });
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/не найден/);
  });

  it("плательщик НДС (свидетельство в карточке) — 16% по умолчанию, НДС в сумме", async () => {
    const store = baseStore();
    store["Catalog_Организации"]![0]!["НомерСвидетельстваПоНДС"] = "0012345";
    const plan = sc(
      await fake1C({ store }).quick({ ...TRADESPACE, lines: [{ name: SERVICE_NAME, price: 1160 }] }),
    );
    expect(plan).toMatchObject({
      organization: { vatPayer: true },
      lines: [{ vatRate: "16%", vat: 160 }],
      totals: { sum: 1160, vat: 160, total: 1160, withVat: true },
    });
  });

  it("в режиме только-чтение план строится, журнал не трогается, confirm отклоняется", async () => {
    const f = fake1C({ readOnly: true });
    const plan = sc(await f.quick(TRADESPACE));
    expect(plan).toMatchObject({ ready: true });
    expect(String(plan["note"])).toMatch(/только-чтение/);
    const res = await f.quick({ ...TRADESPACE, confirm: true, operationId: plan["operationId"] });
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/только-чтение/);
    expect(f.posts).toEqual([]);
  });
});

describe("quick_invoice: создание (confirm=true)", () => {
  it("находит всё → только счёт, без проведения, перечитан из базы, PDF на диске; повтор — без дубликата", async () => {
    const f = fake1C();
    const plan = sc(await f.quick(TRADESPACE));
    const done = await f.quick({ ...TRADESPACE, confirm: true, operationId: plan["operationId"] });
    expect(done.isError).toBeFalsy();
    const out = sc(done);
    expect(f.posts).toHaveLength(1);
    const body = f.posts[0]!.body;
    expect(f.posts[0]!.set).toBe("Document_СчетНаОплатуПокупателю");
    expect(body).toMatchObject({
      Posted: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      УчитыватьНДС: false,
      СуммаДокумента: 1550000,
      КодНазначенияПлатежа: "851",
      СтруктурнаяЕдиница: BANK_ACC,
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Количество: 1,
          Цена: 1550000,
          Сумма: 1550000,
          Содержание: SERVICE_NAME,
        },
      ],
    });
    expect(body).not.toHaveProperty("Товары");
    expect(String(body["Date"])).toMatch(/^2026-10-08T00:00:00$/);
    expect(out).toMatchObject({
      created: true,
      invoice: { number: expect.stringMatching(/^\d+$/), total: 1550000, posted: false, date: "2026-10-08" },
    });
    expect(out["invoice"].ref).toBe(body["Ref_Key"]);
    expect(readFileSync(out["pdf"].path).subarray(0, 4).toString()).toBe("%PDF");
    expect(
      f.gets.some((g) => g.startsWith(`Document_СчетНаОплатуПокупателю(guid'${out["invoice"].ref}')`)),
    ).toBe(true);

    const again = sc(await f.quick({ ...TRADESPACE, confirm: true, operationId: plan["operationId"] }));
    expect(again).toMatchObject({ created: true, replayed: true, invoice: { ref: out["invoice"].ref } });
    expect(f.posts).toHaveLength(1);
  });

  it("недостающие договор и услуга создаются, счёт ссылается на их Ref; без плана с этим operationId — ничего", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"] = [];
    const f = fake1C({ store });
    const args = { ...TRADESPACE, lines: [{ name: "Аудит", price: 500000 }] };
    const stranger = await f.quick({
      ...args,
      confirm: true,
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(stranger.isError).toBe(true);
    expect(errText(stranger)).toMatch(/не подготовлен планом/);
    expect(f.posts).toEqual([]);

    const plan = sc(await f.quick(args));
    expect(plan["willCreate"]).toHaveLength(3);
    const out = sc(await f.quick({ ...args, confirm: true, operationId: plan["operationId"] }));
    expect(f.posts.map((p) => p.set)).toEqual([
      "Catalog_ДоговорыКонтрагентов",
      "Catalog_Номенклатура",
      "Document_СчетНаОплатуПокупателю",
    ]);
    const [contract, nom, invoice] = f.posts.map((p) => p.body);
    expect(contract).toMatchObject({
      Description: "Договор б/н",
      НомерДоговора: "б/н",
      ДатаДоговора: "2026-10-08T00:00:00",
      Owner_Key: BUYER,
      ВидДоговора: "СПокупателем",
      Организация_Key: ORG,
      ВалютаВзаиморасчетов_Key: KZT,
    });
    expect(nom).toMatchObject({ Description: "Аудит", Услуга: true, БазоваяЕдиницаИзмерения_Key: UNIT });
    expect(invoice!["ДоговорКонтрагента_Key"]).toBe(contract!["Ref_Key"]);
    expect((invoice!["Услуги"] as Row[])[0]!["Номенклатура_Key"]).toBe(nom!["Ref_Key"]);
    expect(out["createdObjects"].map((o: Row) => o["ref"])).toEqual([contract!["Ref_Key"], nom!["Ref_Key"]]);
  });

  it("сбой на счёте: сказано, что создано; повтор не дублирует договор и услугу", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"] = [];
    const f = fake1C({ store });
    const args = { ...TRADESPACE, lines: [{ name: "Аудит", price: 500000 }] };
    const plan = sc(await f.quick(args));
    f.failOn((set) =>
      set.startsWith("Document_")
        ? new ODataError({ kind: "bad_request", status: 400, message: "Поле не заполнено" })
        : undefined,
    );
    const failed = await f.quick({ ...args, confirm: true, operationId: plan["operationId"] });
    expect(failed.isError).toBe(true);
    const text = errText(failed);
    expect(text).toMatch(/Счёт на оплату покупателю/);
    expect(text).toMatch(/Уже создано: Договор «Договор б\/н» \(ref [0-9a-f-]{36}\); Услуга «Аудит»/);
    expect(text).toMatch(/новый план/);
    expect(f.posts.map((p) => p.set)).toEqual(["Catalog_ДоговорыКонтрагентов", "Catalog_Номенклатура"]);

    // Новый план находит созданное — повторно не создаёт.
    f.failOn(undefined);
    const replan = sc(await f.quick(args));
    expect(replan).toMatchObject({
      contract: { action: "найден", ref: f.posts[0]!.body["Ref_Key"] },
      lines: [{ action: "найдена", ref: f.posts[1]!.body["Ref_Key"] }],
    });
    await f.quick({ ...args, confirm: true, operationId: replan["operationId"] });
    expect(f.posts.map((p) => p.set)).toEqual([
      "Catalog_ДоговорыКонтрагентов",
      "Catalog_Номенклатура",
      "Document_СчетНаОплатуПокупателю",
    ]);
  });

  it("неизвестный исход шага — указывает id шага для write.operation.status", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"] = [];
    const f = fake1C({ store });
    const plan = sc(await f.quick(TRADESPACE));
    f.failOn((set) =>
      set.startsWith("Catalog_Договоры")
        ? new ODataError({ kind: "network", message: "socket hang up" })
        : undefined,
    );
    const failed = await f.quick({ ...TRADESPACE, confirm: true, operationId: plan["operationId"] });
    expect(errText(failed)).toContain(subOperationId(plan["operationId"], "contract"));
    expect(errText(failed)).toMatch(/Этим вызовом ничего не создано/);
  });

  it("запись выключена для базы — confirm отклоняется до обращения к 1С", async () => {
    const f = fake1C({ writable: false });
    const plan = sc(await f.quick(TRADESPACE));
    const res = await f.quick({ ...TRADESPACE, confirm: true, operationId: plan["operationId"] });
    expect(errText(res)).toMatch(/WRITABLE=true/);
    expect(f.posts).toEqual([]);
  });
});

describe("print_invoice по номеру", () => {
  const withInvoices = () => {
    const store = baseStore();
    const doc = (ref: string, number: string, date: string, extra: Row = {}) => ({
      Ref_Key: ref,
      Number: number,
      Date: `${date}T00:00:00`,
      СуммаДокумента: 1550000,
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      Услуги: [
        { Номенклатура_Key: SERVICE, Содержание: SERVICE_NAME, Количество: 1, Цена: 1550000, Сумма: 1550000 },
      ],
      ...extra,
    });
    store["Document_СчетНаОплатуПокупателю"] = [
      doc(id(30), "00000000003", "2026-10-08"),
      doc(id(31), "00000000003", "2025-03-01"),
      doc(id(32), "00000000013", "2026-10-08"),
      doc(id(33), "00000000003", "2026-10-08", { DeletionMark: true }),
    ];
    return fake1C({ store });
  };

  it("номер + дата — один счёт (помеченный на удаление не мешает), PDF сохранён", async () => {
    const f = withInvoices();
    const res = await f.call("read.document.print_invoice", { number: "3", date: "2026-10-08" });
    expect(res.isError).toBeFalsy();
    expect(sc(res)).toMatchObject({
      ref: id(30),
      fileName: "Счет на оплату покупателю № 3 от 08.10.2026.pdf",
    });
    const byYear = await f.call("read.document.print_invoice", { number: "00000000003", year: 2025 });
    expect(sc(byYear)).toMatchObject({ ref: id(31) });
  });

  it("номер без даты при повторах по годам — варианты; несуществующий — ошибка; ни ref, ни номера — ошибка", async () => {
    const f = withInvoices();
    const many = await f.call("read.document.print_invoice", { number: "3" });
    expect(many.isError).toBe(true);
    expect(errText(many)).toContain(id(30));
    expect(errText(many)).toContain(id(31));
    expect(errText(many)).not.toContain(id(32));
    expect(errText(await f.call("read.document.print_invoice", { number: "77" }))).toMatch(/не найден/);
    expect((await f.call("read.document.print_invoice", {})).isError).toBe(true);
  });
});

describe("quick_invoice: возможные дубли", () => {
  const invoice = (ref: string, number: string, extra: Row = {}): Row => ({
    Ref_Key: ref,
    Number: number,
    Date: "2026-10-08T10:15:00",
    Posted: false,
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: BUYER,
    СуммаДокумента: 1550000,
    Услуги: [{ LineNumber: 1, Номенклатура_Key: SERVICE, Количество: 1, Цена: 1550000, Сумма: 1550000 }],
    ...extra,
  });

  it("тот же покупатель, день и сумма — в possibleDuplicates (с linesMatch); план не блокируется", async () => {
    const store = baseStore();
    store["Document_СчетНаОплатуПокупателю"] = [
      invoice(id(40), "00000000003"),
      invoice(id(41), "00000000004", {
        Posted: true,
        Услуги: [{ Номенклатура_Key: id(11), Количество: 1, Цена: 1550000, Сумма: 1550000 }],
      }),
      invoice(id(42), "00000000005", { DeletionMark: true }),
      invoice(id(43), "00000000006", { СуммаДокумента: 99000 }),
      invoice(id(44), "00000000007", { Date: "2026-10-07T10:00:00" }),
      invoice(id(45), "00000000008", { Контрагент_Key: id(99) }),
      invoice(id(46), "00000000009", { Организация_Key: id(98) }),
    ];
    const f = fake1C({ store });
    const plan = sc(await f.quick(TRADESPACE));
    expect(plan).toMatchObject({ ready: true, dryRun: true });
    expect(plan["operationId"]).toBeTruthy();
    expect(plan["possibleDuplicates"]).toEqual([
      { number: "3", date: "2026-10-08", ref: id(40), total: 1550000, posted: false, linesMatch: true },
      { number: "4", date: "2026-10-08", ref: id(41), total: 1550000, posted: true, linesMatch: false },
    ]);
    expect(String(plan["note"])).toMatch(/^ВОЗМОЖНЫЙ ДУБЛЬ: № 3 от 2026-10-08/);
    expect(plan["notes"][0]).toMatch(/ВНИМАНИЕ, возможный дубль/);
    expect(plan["notes"].join(" ")).toMatch(/1 счёт\(а\) с той же суммой за этот день помечены на удаление/);
    expect(plan["notes"].join(" ")).toMatch(/ещё 1 счёт\(а\) на другие суммы/);
    expect(f.posts).toEqual([]);
    // Поиск идёт по покупателю, организации и дню — не по всей таблице.
    const q = f.gets.find((g) => g.startsWith("Document_СчетНаОплатуПокупателю?"))!;
    expect(q).toContain(`Контрагент_Key eq guid'${BUYER}'`);
    expect(q).toContain(`Организация_Key eq guid'${ORG}'`);
    expect(q).toContain("Date ge datetime'2026-10-08T00:00:00'");
  });

  it("похожих нет — possibleDuplicates пуст, обычная подсказка", async () => {
    const plan = sc(await fake1C().quick(TRADESPACE));
    expect(plan["possibleDuplicates"]).toEqual([]);
    expect(String(plan["note"])).toMatch(/^План\. Ничего не создано/);
  });

  it("сбой поиска дублей не ломает план — причина в notes", async () => {
    const f = fake1C();
    f.failGetOn((p) =>
      p.startsWith("Document_СчетНаОплатуПокупателю?")
        ? new ODataError({ kind: "server", status: 500, message: "boom" })
        : undefined,
    );
    const plan = sc(await f.quick(TRADESPACE));
    expect(plan).toMatchObject({ ready: true, possibleDuplicates: [] });
    expect(plan["notes"].join(" ")).toMatch(/Проверка на дубли не выполнена: boom/);
  });

  it("confirm перепроверяет: дубль, появившийся после плана, не блокирует, но виден в ответе", async () => {
    const f = fake1C();
    const plan = sc(await f.quick(TRADESPACE));
    expect(plan["possibleDuplicates"]).toEqual([]);
    f.store["Document_СчетНаОплатуПокупателю"]!.push(invoice(id(40), "00000000003"));
    const out = sc(await f.quick({ ...TRADESPACE, confirm: true, operationId: plan["operationId"] }));
    expect(out).toMatchObject({ created: true, invoice: { posted: false } });
    expect(out["possibleDuplicates"]).toEqual([expect.objectContaining({ ref: id(40), linesMatch: true })]);
    expect(out["invoice"].ref).not.toBe(id(40));
    expect(out["notes"][0]).toMatch(/создан ещё один счёт.*№ 3/);
    expect(f.posts).toHaveLength(1);
  });
});
