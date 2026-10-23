import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Behavior } from "../src/config/env.js";
import { buildHttpServer, sharedToolFilter, writeToolsFrom } from "../src/http.js";
import { ConnectionPool, parseConnectionHeader } from "../src/http/pool.js";
import { guardedLookup, isBlockedAddress, safeFetch } from "../src/odata/safe-fetch.js";

const TOKEN = "t".repeat(32);

const behavior: Behavior = {
  timeoutMs: 5_000,
  retries: 0,
  pageSize: 100,
  maxRows: 1_000,
  analyticsMaxRows: 10_000,
  readOnly: true,
  writeOperationMarker: false,
  writeJournalDir: join(tmpdir(), `1c-http-journal-${process.pid}`),
  printDir: join(tmpdir(), `1c-http-print-${process.pid}`),
  metadataCache: undefined,
  safeNetwork: false, // 1С здесь — подменённый fetch
};

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
<edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
<Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
<EntityType Name="Catalog_Организации"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.String"/><Property Name="Description" Type="Edm.String"/></EntityType>
<EntityContainer Name="EnterpriseV8" m:IsDefaultEntityContainer="true">
<EntitySet Name="Catalog_Организации" EntityType="StandardODATA.Catalog_Организации"/>
</EntityContainer>
</Schema>
</edmx:DataServices>
</edmx:Edmx>`;

const header = (c: Record<string, unknown>) => Buffer.from(JSON.stringify(c)).toString("base64url");
const ALICE = {
  id: "alice-1",
  baseUrl: "https://a.1cfresh.kz/a/ea/1/odata/standard.odata/",
  username: "Алия",
  password: "пароль-a",
  label: "ТОО Альфа",
};
const BOB = {
  id: "bob-1",
  baseUrl: "https://b.1cfresh.kz/a/ea/2/odata/standard.odata",
  username: "bob",
  password: "secret-b",
  label: "ИП Бета",
};

let url = "";
let server: ReturnType<typeof buildHttpServer>;
const pool = new ConnectionPool(behavior);
const calls: Array<{ url: string; auth: string | null }> = [];

beforeAll(async () => {
  server = buildHttpServer({ token: TOKEN, pool });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => vi.unstubAllGlobals());

/** Подмена 1С: $metadata для любой базы, запоминая адрес и учётку каждого запроса. Вызов MCP идёт настоящим fetch. */
function stub1C(): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const u = String(input);
    if (u.startsWith(url)) return real(input, init);
    calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    if (u.endsWith("$metadata")) return new Response(METADATA, { status: 200 });
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function client(conn: Record<string, unknown>): Promise<Client> {
  const c = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, "X-OneC-Connection": header(conn) } },
  });
  await c.connect(transport);
  return c;
}

describe("общий HTTP-режим", () => {
  it("отвечает на /healthz и не пускает без ключа", async () => {
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const res = await fetch(`${url}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const wrong = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("требует корректный заголовок подключения", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${url}/mcp`, { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
    const http = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        ...auth,
        "X-OneC-Connection": header({ ...ALICE, baseUrl: "http://a.1cfresh.kz/odata/standard.odata/" }),
      },
      body: "{}",
    });
    expect(http.status).toBe(400);
    expect(await http.text()).toContain("только https");
    expect((await fetch(`${url}/mcp`, { headers: auth })).status).toBe(405); // без сессий GET-потока нет
  });

  it("каждый пользователь видит только свою базу и ходит в 1С под своей учёткой", async () => {
    stub1C();
    const a = await client(ALICE);
    const b = await client(BOB);
    const names = (await a.listTools()).tools.map((t) => t.name);
    expect(names).toContain("read.system.health_check");
    expect(
      names.some((n) => n.startsWith("meta.") || n.startsWith("read.files.") || n.includes(".print_")),
    ).toBe(false);

    const dbA = (await a.callTool({ name: "read.system.list_databases", arguments: {} }))
      .structuredContent as {
      databases: Array<{ name: string; label?: string }>;
    };
    expect(dbA.databases).toEqual([{ name: "c_alice-1", label: "ТОО Альфа", isDefault: true }]);

    calls.length = 0;
    await a.callTool({ name: "read.system.health_check", arguments: {} });
    await b.callTool({ name: "read.system.health_check", arguments: {} });
    const auth = (u: { username: string; password: string }) =>
      `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`;
    expect(calls.find((c) => c.url.startsWith("https://a."))?.auth).toBe(auth(ALICE));
    expect(calls.find((c) => c.url.startsWith("https://b."))?.auth).toBe(auth(BOB));
    await a.close();
    await b.close();
  });

  it("переиспользует подключение, пока учётка та же", async () => {
    stub1C();
    const before = pool.size;
    const a = await client(ALICE);
    await a.callTool({ name: "read.system.health_check", arguments: {} });
    expect(pool.size).toBe(before); // то же подключение, $metadata не грузится заново
    const metadataLoads = calls.filter((c) => c.url.endsWith("$metadata")).length;
    await a.callTool({ name: "read.system.health_check", arguments: {} });
    expect(calls.filter((c) => c.url.endsWith("$metadata")).length).toBe(metadataLoads);
    const changed = await client({ ...ALICE, password: "новый-пароль" });
    await changed.callTool({ name: "read.system.list_databases", arguments: {} });
    expect(pool.size).toBe(before + 1); // сменился пароль — новое подключение
    await a.close();
    await changed.close();
  });
});

describe("разбор заголовка и фильтр инструментов", () => {
  it("имя базы — из id подключения, адрес с завершающим слэшем", () => {
    const cfg = parseConnectionHeader(header({ ...BOB, writable: true }));
    expect(cfg).toMatchObject({
      name: "c_bob-1",
      baseUrl: `${BOB.baseUrl}/`,
      writable: true,
      label: "ИП Бета",
    });
    expect(() => parseConnectionHeader("не-base64")).toThrow(/base64url JSON/);
    expect(() => parseConnectionHeader(header({ ...BOB, id: "../etc" }))).toThrow(/id/);
  });

  it("в общем режиме нет шлюза, печати и вложений; запись — только из белого списка", () => {
    expect(sharedToolFilter("read.analytics.debtors")).toBe(true);
    expect(sharedToolFilter("write.sales.quick_invoice")).toBe(false); // список пуст — записи нет
    expect(sharedToolFilter("write.operation.status")).toBe(false);
    const writes = writeToolsFrom({
      ODATA_HTTP_WRITE_TOOLS: " write.sales.quick_invoice ,read.x, write.sales.quick_sale",
    });
    expect([...writes]).toEqual(["write.sales.quick_invoice", "write.sales.quick_sale"]);
    expect(sharedToolFilter("write.sales.quick_invoice", writes)).toBe(true);
    expect(sharedToolFilter("write.document.post_document", writes)).toBe(false);
    expect(sharedToolFilter("write.operation.status", writes)).toBe(true); // сверка после сбоя — вместе с записью
    expect(sharedToolFilter("meta.call_tool")).toBe(false);
    expect(sharedToolFilter("read.document.print_invoice")).toBe(false);
    expect(sharedToolFilter("read.files.get_attachment")).toBe(false);
  });
});

describe("сеть общего режима", () => {
  it("внутренние и служебные адреса запрещены", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
    ])
      expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["185.22.66.10", "8.8.8.8", "2a00:1450:4001::64", "::ffff:8.8.8.8"])
      expect(isBlockedAddress(ip), ip).toBe(false);
    expect(isBlockedAddress("localhost")).toBe(true); // не IP — не пускаем
  });

  it("не ходит по внутреннему адресу ни напрямую, ни через DNS", async () => {
    await expect(safeFetch("https://127.0.0.1/base/odata/standard.odata/", {})).rejects.toThrow(
      /внутреннюю сеть/,
    );
    await expect(safeFetch("https://10.0.0.7/odata/standard.odata/", {})).rejects.toThrow(/внутреннюю сеть/);
    const err = await new Promise<NodeJS.ErrnoException | null>((r) =>
      guardedLookup("localhost", {}, (e) => r(e)),
    );
    expect(err?.code).toBe("EBLOCKED");
  });
});
