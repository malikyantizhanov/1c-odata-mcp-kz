/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { similarNames } from "../src/tools/gateway.js";
import { baseStore, fake1C, id } from "./support/fake-1c.js";

/**
 * meta.list_tools / meta.call_tool: тот же реестр, что tools/list; вызов через шлюз = прямой вызов
 * (валидация, префлайт, READ_ONLY/writable, dry-run/confirm, operationId). Через MCP-клиент в памяти.
 */

const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { tools: Array<{ name: string }> };
const OP = "11111111-2222-4333-8444-555555555555";

async function connect(opts: { writable?: boolean; readOnly?: boolean } = {}) {
  const store = {
    ...baseStore(),
    Catalog_ЦенныеБумаги: [
      { Ref_Key: id(60), Code: "1", Description: "Облигации КЕГОК", DeletionMark: false },
    ],
  };
  const f = fake1C({ store, ...opts });
  const server = createServer({ db: () => f.conn } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  return { f, client };
}
const via = (client: Client, name: string, args?: Record<string, unknown>) =>
  client.callTool({ name: "meta.call_tool", arguments: { name, ...(args ? { arguments: args } : {}) } });
const text = (r: any): string => (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
const stripOp = (r: any) => {
  const sc = r.structuredContent ? { ...r.structuredContent } : undefined;
  if (sc) delete sc.operationId;
  return { isError: r.isError ?? false, structuredContent: sc };
};

describe("meta.list_tools", () => {
  it("тот же состав, что tools/list и manifest.json; версия из package.json", async () => {
    const { client } = await connect();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    const r = await client.callTool({ name: "meta.list_tools", arguments: {} });
    const d = r.structuredContent as any;
    expect(d.tools.map((t: any) => t.name).sort()).toEqual(listed);
    expect(d.total).toBe(listed.length);
    expect(listed).toEqual(manifest.tools.map((t) => t.name).sort());
    expect(listed).toContain("meta.list_tools");
    expect(listed).toContain("meta.call_tool");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(d.version).toBe(pkg.version);
    await client.close();
  });

  it("схемы и аннотации — как в tools/list; фильтры prefix / search / includeSchema", async () => {
    const { client } = await connect();
    const direct = (await client.listTools()).tools.find((t) => t.name === "read.currency.get_rates")!;
    const pre = (await client.callTool({ name: "meta.list_tools", arguments: { prefix: "read.currency." } }))
      .structuredContent as any;
    expect(pre.count).toBe(1);
    expect(pre.tools[0]).toMatchObject({
      name: "read.currency.get_rates",
      title: direct.title,
      description: direct.description,
      inputSchema: direct.inputSchema,
      annotations: direct.annotations,
    });
    const s = (await client.callTool({ name: "meta.list_tools", arguments: { search: "ЦЕННЫЕ БУМАГИ" } }))
      .structuredContent as any;
    expect(s.tools.map((t: any) => t.name)).toContain("write.catalog.create_security");
    const bare = (
      await client.callTool({
        name: "meta.list_tools",
        arguments: { prefix: "write.esf", includeSchema: false },
      })
    ).structuredContent as any;
    expect(bare.count).toBeGreaterThan(0);
    expect(bare.tools.every((t: any) => t.name.startsWith("write.esf") && !("inputSchema" in t))).toBe(true);
    await client.close();
  });

  it("аннотации шлюза: list — только чтение, call — может писать", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "meta.list_tools")!.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(tools.find((t) => t.name === "meta.call_tool")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    await client.close();
  });
});

describe("meta.call_tool", () => {
  it("read-инструмент: ответ шлюза = прямой вызов", async () => {
    const { client } = await connect();
    const args = { query: "Разработка" };
    const direct = await client.callTool({ name: "read.nomenclature.list_nomenclature", arguments: args });
    const gw = await via(client, "read.nomenclature.list_nomenclature", args);
    expect(direct.isError).toBeFalsy();
    expect(gw).toEqual(direct);
    await client.close();
  });

  it("ошибка валидации аргументов — та же, что напрямую", async () => {
    const { client } = await connect();
    const bad = { name: "x".repeat(500) };
    const direct = await client.callTool({ name: "write.catalog.create_security", arguments: bad });
    const gw = await via(client, "write.catalog.create_security", bad);
    expect(direct.isError).toBe(true);
    expect(gw).toEqual(direct);
    await client.close();
  });

  it("write без confirm — dry-run, в 1С ничего не пишется; confirm без operationId — тот же отказ", async () => {
    const { client, f } = await connect();
    const args = { name: "Акции Казатомпром" };
    const gw = await via(client, "write.catalog.create_security", args);
    const direct = await client.callTool({ name: "write.catalog.create_security", arguments: args });
    expect((gw.structuredContent as any).dryRun).toBe(true);
    expect((gw.structuredContent as any).operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stripOp(gw)).toEqual(stripOp(direct));
    expect(f.posts).toHaveLength(0);
    const c1 = await via(client, "write.catalog.create_security", { ...args, confirm: true });
    const c2 = await client.callTool({
      name: "write.catalog.create_security",
      arguments: { ...args, confirm: true },
    });
    expect(c1.isError).toBe(true);
    expect(c1).toEqual(c2);
    await client.close();
  });

  it("write с confirm при writable:false и при READ_ONLY=true — тот же отказ, что напрямую", async () => {
    for (const opts of [{ writable: false }, { readOnly: true }]) {
      const { client, f } = await connect(opts);
      const args = { name: "Акции Казатомпром", confirm: true, operationId: OP };
      const gw = await via(client, "write.catalog.create_security", args);
      const direct = await client.callTool({ name: "write.catalog.create_security", arguments: args });
      expect(gw.isError, JSON.stringify(opts)).toBe(true);
      expect(gw).toEqual(direct);
      // Понятный текст: что выключено, кто и как включает запись.
      expect(text(gw)).toMatch(opts.readOnly ? /READ_ONLY=true/ : /writable|WRITABLE/);
      expect(text(gw)).toMatch(/обратитесь к администратору команды\.$/);
      expect(f.posts).toHaveLength(0);
      await client.close();
    }
  });

  it("write с confirm и operationId на writable-базе — создаёт так же, как прямой вызов", async () => {
    const { client, f } = await connect();
    const preview = await via(client, "write.catalog.create_security", { name: "Акции Казатомпром" });
    const operationId = (preview.structuredContent as any).operationId;
    const r = await via(client, "write.catalog.create_security", {
      name: "Акции Казатомпром",
      confirm: true,
      operationId,
    });
    expect(r.isError, text(r)).toBeFalsy();
    expect((r.structuredContent as any).operationId).toBe(operationId);
    expect(f.posts).toHaveLength(1);
    // повтор с тем же operationId — из журнала, без второй записи
    const again = await via(client, "write.catalog.create_security", {
      name: "Акции Казатомпром",
      confirm: true,
      operationId,
    });
    expect((again.structuredContent as any).replayed).toBe(true);
    expect(f.posts).toHaveLength(1);
    await client.close();
  });

  it("рекурсия запрещена; неизвестное имя — ошибка с похожими именами", async () => {
    const { client } = await connect();
    for (const n of ["meta.call_tool", "meta.list_tools"]) {
      const r = await via(client, n, {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/шлюз не вызывает meta\.\*/);
    }
    const u = await via(client, "read.currency.get_rate");
    expect(u.isError).toBe(true);
    expect(text(u)).toMatch(
      /Инструмента «read\.currency\.get_rate» нет на сервере\. Похожие: read\.currency\.get_rates/,
    );
    const v = await via(client, "zzz");
    expect(text(v)).toMatch(/нет на сервере\. Полный список — meta\.list_tools/);
    await client.close();
  });

  it("similarNames: опечатки и хвост имени", () => {
    const names = ["read.currency.get_rates", "read.system.health_check", "write.esf.create_draft"];
    expect(similarNames("health_check", names)).toEqual(["read.system.health_check"]);
    expect(similarNames("write.esf.create_drfat", names)).toEqual(["write.esf.create_draft"]);
    expect(similarNames("qqqq", names)).toEqual([]);
  });
});
