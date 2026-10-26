/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Behavior, ConnectionConfig } from "../src/config/env.js";
import { parseConfig } from "../src/config/env.js";
import { ODataClient } from "../src/odata/client.js";
import { ODataError, fromHttpStatus, isUnavailablePage, looksLikeHtml } from "../src/odata/errors.js";
import {
  ADMIN_HINT,
  notWritableMessage,
  readOnlyMessage,
  sharedToolMessage,
  writeStatusBlock,
} from "../src/write-status.js";
import {
  compareSemver,
  latestFromTags,
  latestVersion,
  serverVersion,
  setUpdateFetcher,
  versionInfo,
} from "../src/version.js";
import { capabilities } from "../src/tools/capabilities.js";
import { fake1C } from "./support/fake-1c.js";

/**
 * PR ①: понятные ошибки 1cfresh (страница «сервис частично недоступен», 502/503/504) — повтор для чтения, без повтора
 * для записи; «почему нет записи» по каждому источнику; версия сервера и подсказка о перезапуске подключения.
 */

const URL_BASE = "https://1cfresh.kz/a/ea20/1/odata/standard.odata/";
const behavior = (over: Partial<Behavior> = {}): Behavior => ({
  timeoutMs: 2_000,
  retries: 1,
  pageSize: 100,
  maxRows: 1_000,
  analyticsMaxRows: 1_000,
  readOnly: false,
  writeOperationMarker: false,
  writeJournalDir: mkdtempSync(join(tmpdir(), "1c-pr1-journal-")),
  printDir: tmpdir(),
  metadataCache: undefined,
  ...over,
});
const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  name: "buh",
  baseUrl: URL_BASE,
  username: "u",
  password: "p",
  writable: true,
  ...over,
});

/** Страница 1cfresh «сервис частично недоступен» — с кодом 200, как в проде. */
const UNAVAILABLE_PAGE =
  "<!DOCTYPE html><html><head><title>1cfresh.kz</title></head><body><h1>Сервис частично недоступен</h1>" +
  "<p>Ведутся технические работы. Попробуйте позже.</p></body></html>";
const DENIED_PAGE =
  "<!DOCTYPE html><html><head><title>1cfresh.kz</title></head><body><p>Доступ запрещен</p></body></html>";

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(...responses: Array<() => Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const make = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return make();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUpdateFetcher(undefined);
});

async function errOf(p: Promise<unknown>): Promise<ODataError> {
  try {
    await p;
  } catch (e) {
    return e as ODataError;
  }
  throw new Error("ожидалась ошибка");
}

describe("(9) распознавание недоступности 1cfresh", () => {
  it("страница «частично недоступен» — недоступность; «Доступ запрещен» и JSON — нет", () => {
    expect(isUnavailablePage(UNAVAILABLE_PAGE)).toBe(true);
    expect(isUnavailablePage("<html><body>503 Service Temporarily Unavailable</body></html>")).toBe(true);
    expect(isUnavailablePage("<html><body><h1>502 Bad Gateway</h1>nginx</body></html>")).toBe(true);
    expect(isUnavailablePage(DENIED_PAGE)).toBe(false);
    expect(looksLikeHtml("{}", "text/html")).toBe(true);
    expect(looksLikeHtml('{"value":[]}', "application/json")).toBe(false);
  });

  it("502/503/504 — kind unavailable, понятный текст по каждому коду, повторяемо", () => {
    const t502 = fromHttpStatus(502, URL_BASE, "<html><body>Bad Gateway</body></html>");
    const t503 = fromHttpStatus(503, URL_BASE);
    const t504 = fromHttpStatus(504, URL_BASE);
    for (const e of [t502, t503, t504]) {
      expect(e.kind).toBe("unavailable");
      expect(e.retryable).toBe(true);
      expect(e.message).toMatch(/^1cfresh\.kz временно недоступен/);
      expect(e.message).not.toMatch(/нет прав|исключение 1С/);
    }
    expect(t502.message).toMatch(/502 Bad Gateway/);
    expect(t503.message).toMatch(/503 Service Unavailable/);
    expect(t504.message).toMatch(/504 Gateway Timeout/);
    expect(fromHttpStatus(500, URL_BASE).kind).toBe("server");
  });

  it("чтение: страница недоступности с кодом 200 — повтор, затем успех", async () => {
    const calls = stubFetch(
      () => html(UNAVAILABLE_PAGE),
      () => jsonRes({ value: [{ Ref_Key: "1" }] }),
    );
    const c = new ODataClient(conn(), behavior());
    const res = await c.getCollection("Catalog_Организации?$format=json");
    expect(res.value).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("чтение: недоступность не прошла — ошибка unavailable, а не «нет прав или исключение 1С»", async () => {
    const calls = stubFetch(() => html(UNAVAILABLE_PAGE));
    const c = new ODataClient(conn(), behavior());
    const e = await errOf(c.getCollection("Catalog_Организации?$format=json"));
    expect(e.kind).toBe("unavailable");
    expect(e.message).toMatch(/1cfresh\.kz временно недоступен/);
    expect(e.message).toMatch(/Сервис частично недоступен/);
    expect(e.message).not.toMatch(/нет прав пользователя OData/);
    expect(calls).toHaveLength(2); // retries=1 → 2 попытки
  });

  it("чтение: 503 → повтор → успех; getText ($metadata) тоже повторяется", async () => {
    const calls = stubFetch(
      () => new Response("busy", { status: 503 }),
      () => jsonRes({ value: [] }),
    );
    const c = new ODataClient(conn(), behavior());
    await c.getCollection("Catalog_X?$format=json");
    expect(calls).toHaveLength(2);

    const calls2 = stubFetch(
      () => html(UNAVAILABLE_PAGE),
      () => new Response("<?xml version='1.0'?><edmx:Edmx/>", { status: 200 }),
    );
    expect(await new ODataClient(conn(), behavior()).getText("$metadata")).toMatch(/edmx/);
    expect(calls2).toHaveLength(2);
  });

  it("«Доступ запрещен» (HTML 200) — без повтора, прежнее объяснение про права", async () => {
    const calls = stubFetch(() => html(DENIED_PAGE));
    const e = await errOf(new ODataClient(conn(), behavior()).getCollection("Catalog_X?$format=json"));
    expect(e.kind).toBe("parse");
    expect(e.message).toMatch(/нет прав пользователя OData/);
    expect(e.message).toMatch(/Доступ запрещен/);
    expect(calls).toHaveLength(1);
  });

  it("запись: 503 и страница недоступности — без повтора, «исход записи неизвестен»", async () => {
    for (const make of [() => new Response("", { status: 503 }), () => html(UNAVAILABLE_PAGE)]) {
      const calls = stubFetch(make);
      const c = new ODataClient(conn(), behavior({ retries: 3 }));
      const e = await errOf(c.create("Catalog_Контрагенты", { Description: "ZZ-TEST" }));
      expect(e.kind).toBe("unavailable");
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(
        /^1cfresh\.kz временно недоступен; исход записи неизвестен — проверьте write\.operation\.status \/ документ перед повтором/,
      );
      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("действия (Post) без тела тоже не повторяются; actionRaw — понятный текст", async () => {
    const calls = stubFetch(() => new Response("", { status: 504 }));
    const c = new ODataClient(conn(), behavior({ retries: 3 }));
    const e = await errOf(c.action("Document_X(guid'1')/Post"));
    expect(e.message).toMatch(/исход записи неизвестен/);
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
    stubFetch(() => html(UNAVAILABLE_PAGE));
    const raw = await errOf(c.actionRaw("Document_X(guid'1')/Post"));
    expect(raw.kind).toBe("unavailable");
    expect(raw.message).toMatch(/исход записи неизвестен/);
  });
});

describe("(10) почему нет записи", () => {
  const home = mkdtempSync(join(tmpdir(), "1c-pr1-home-"));
  mkdirSync(join(home, ".1c-odata"), { recursive: true });
  const file = join(home, ".1c-odata", "databases.json");
  writeFileSync(
    file,
    JSON.stringify({
      databases: [
        { name: "ro", base_url: URL_BASE, username: "u", password: "p", writable: false },
        { name: "nofield", base_url: URL_BASE, username: "u", password: "p" },
      ],
    }),
    { mode: 0o600 },
  );

  it("каждый текст заканчивается «обратитесь к администратору команды»", () => {
    expect(ADMIN_HINT).toMatch(/обратитесь к администратору команды\.$/);
    for (const m of [
      readOnlyMessage(),
      readOnlyMessage({ writeTools: [] }),
      notWritableMessage({ name: "x" }),
      notWritableMessage({ name: "x", writableSource: { kind: "header" } }),
      sharedToolMessage("write.sales.quick_invoice", { writeTools: ["write.sales.quick_sale"] }),
    ])
      expect(m).toMatch(/обратитесь к администратору команды\.$/);
  });

  it("READ_ONLY=true — говорит про переменную и перезапуск", async () => {
    const e = await errOf(
      new ODataClient(conn(), behavior({ readOnly: true })).create("Catalog_X", { Description: "a" }),
    );
    expect(e.message).toMatch(/только-чтение/);
    expect(e.message).toMatch(/READ_ONLY=true/);
    expect(e.message).toMatch(/READ_ONLY=false/);
    expect(e.message).toMatch(/обратитесь к администратору команды\.$/);
  });

  it("writable: false в файле — путь файла и поле; поле не задано — так и сказано", () => {
    const cfg = parseConfig({ ODATA_CONFIG: file }, { home });
    const ro = cfg.connections.find((c) => c.name === "ro")!;
    const nf = cfg.connections.find((c) => c.name === "nofield")!;
    expect(notWritableMessage(ro)).toContain(`в файле баз ${file} у базы "ro" поле "writable" равно false`);
    expect(notWritableMessage(ro)).toContain(`"writable": true`);
    expect(notWritableMessage(nf)).toMatch(/не задано \(по умолчанию false\)/);
    expect(writeStatusBlock({ readOnly: false }, ro)).toMatchObject({
      writeStatus: "disabled",
      reason: "writable_false_file",
      mode: "local",
    });
  });

  it("writable из env — имя переменной ODATA_DB_<ИМЯ>_WRITABLE", () => {
    const cfg = parseConfig({
      ODATA_DB_SHOP_BASE_URL: URL_BASE,
      ODATA_DB_SHOP_USERNAME: "u",
      ODATA_DB_SHOP_PASSWORD: "p",
      ODATA_DB_SHOP_WRITABLE: "no",
    });
    const shop = cfg.connections[0]!;
    expect(shop.writable).toBe(false);
    expect(notWritableMessage(shop)).toMatch(/переменная окружения ODATA_DB_SHOP_WRITABLE не равна true/);
    expect(notWritableMessage(shop)).toMatch(/ODATA_DB_SHOP_WRITABLE=true/);
    expect(writeStatusBlock({ readOnly: false }, shop).reason).toBe("writable_false_env");
  });

  it("командный режим: флаг из заголовка, пустой ODATA_HTTP_WRITE_TOOLS, разрешённые инструменты", () => {
    const header = conn({ writable: false, writableSource: { kind: "header" } });
    expect(
      writeStatusBlock({ readOnly: false }, header, { writeTools: ["write.sales.quick_invoice"] }),
    ).toMatchObject({ writeStatus: "disabled", reason: "writable_false_header", mode: "shared" });
    const open = conn({ writableSource: { kind: "header" } });
    expect(writeStatusBlock({ readOnly: false }, open, { writeTools: [] })).toMatchObject({
      writeStatus: "disabled",
      reason: "shared_no_write_tools",
    });
    expect(
      writeStatusBlock({ readOnly: false }, open, { writeTools: ["write.sales.quick_invoice"] }),
    ).toMatchObject({
      writeStatus: "enabled",
      mode: "shared",
      sharedWriteTools: ["write.sales.quick_invoice"],
    });
    expect(
      sharedToolMessage("write.document.post_document", { writeTools: ["write.sales.quick_invoice"] }),
    ).toMatch(/сейчас разрешены: write\.sales\.quick_invoice/);
  });

  it("read.system.capabilities и health_check: блок write и версия сервера", async () => {
    const f = fake1C({ writable: false });
    const cap = (await f.call("read.system.capabilities", {})).structuredContent as any;
    expect(cap.write).toMatchObject({ writeStatus: "disabled", reason: "writable_false", mode: "local" });
    expect(cap.write.message).toMatch(/обратитесь к администратору команды\.$/);
    expect(cap.server.running).toBe(serverVersion());
    const hc = (await f.call("read.system.health_check", {})).structuredContent as any;
    expect(hc.write.writeStatus).toBe("disabled");
    expect(hc.server.hint).toMatch(/перезапуска подключения 1С/);
    const ok = await capabilities({ db: () => fake1C().conn } as never);
    expect(ok.write.writeStatus).toBe("enabled");
  });
});

describe("(8) версия сервера и подсказка о новой версии", () => {
  it("сравнение и выбор последнего тега", () => {
    expect(compareSemver("0.7.13", "0.7.12")).toBeGreaterThan(0);
    expect(compareSemver("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(
      latestFromTags([{ name: "v0.7.9" }, { name: "v0.7.12" }, { name: "beta" }, { name: "v0.7.10" }]),
    ).toBe("0.7.12");
    expect(latestFromTags({ message: "API rate limit exceeded" })).toBeUndefined();
  });

  it("вышла новее — «запущена vX, доступна vY — перезапустите подключение 1С»; результат кешируется", async () => {
    let hits = 0;
    setUpdateFetcher(async () => {
      hits += 1;
      return jsonRes([{ name: "v99.0.0" }, { name: "v0.1.0" }]);
    });
    const env = { ODATA_UPDATE_CHECK: "true" };
    const info = await versionInfo(env);
    expect(info).toMatchObject({ running: serverVersion(), latest: "99.0.0", updateAvailable: true });
    expect(info.hint).toContain(
      `Запущена v${serverVersion()}, доступна v99.0.0 — перезапустите подключение 1С`,
    );
    await versionInfo(env);
    expect(hits).toBe(1);
  });

  it("ошибка сети, 403 лимита и выключенная проверка — молча без latest", async () => {
    setUpdateFetcher(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await latestVersion({ ODATA_UPDATE_CHECK: "true" })).toBeUndefined();
    setUpdateFetcher(async () => jsonRes({ message: "rate limit" }, 403));
    const info = await versionInfo({ ODATA_UPDATE_CHECK: "true" });
    expect(info.latest).toBeUndefined();
    expect(info.hint).toMatch(/^Запущена v/);
    let called = false;
    setUpdateFetcher(async () => {
      called = true;
      return jsonRes([]);
    });
    expect(await latestVersion({ ODATA_UPDATE_CHECK: "false" })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("таймаут ~2 с: зависший GitHub не держит health_check", async () => {
    vi.useFakeTimers();
    try {
      setUpdateFetcher(
        (_u, init) =>
          new Promise((_r, reject) =>
            init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      );
      const p = latestVersion({ ODATA_UPDATE_CHECK: "true" });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(await p).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
