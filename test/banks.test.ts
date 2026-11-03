import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { sharedToolFilter } from "../src/http.js";
import { baseStore, fake1C, id, ORG } from "./support/fake-1c.js";

const TOOL = "write.catalog.create_bank";
const SET = "Catalog_Банки";
const args = { name: "Банк Фикстура", bik: "TESTKZKX" };
function setup(options: { writable?: boolean; readOnly?: boolean } = {}) {
  const store = baseStore();
  store[SET] = [
    {
      Ref_Key: id(6),
      Description: "Существующий банк",
      Code: "000001",
      БИК: "KCJBKZKX",
      IsFolder: false,
      DeletionMark: false,
    },
  ];
  return fake1C({ store, honorSelect: true, ...options });
}

describe("создание банка", () => {
  it.each([false, true])("общий allowlist и MCP gateway, разрешён=%s", async (allowed) => {
    const f = setup();
    const server = createServer({ db: () => f.conn } as never, {
      toolFilter: (name) => sharedToolFilter(name, new Set(allowed ? [TOOL] : [])),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bank-test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.includes(TOOL)).toBe(allowed);
      const preview = await client.callTool({
        name: "meta.call_tool",
        arguments: { name: TOOL, arguments: args },
      });
      if (!allowed) {
        expect(preview.isError).toBe(true);
        expect(f.posts).toHaveLength(0);
        return;
      }
      expect(preview.isError).toBeFalsy();
      const confirmArgs = { ...args, confirm: true, operationId: preview.structuredContent!.operationId };
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({
          name: "meta.call_tool",
          arguments: { name: TOOL, arguments: confirmArgs },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ created: true, entitySet: SET });
      }
      expect(f.posts).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP шлюз нормализует БИК и проверяет вход до обращения к базе", async () => {
    const f = setup();
    const normalized = await f.call("meta.call_tool", {
      name: TOOL,
      arguments: { name: "  Банк Фикстура  ", bik: "  testkzkx  " },
    });
    expect(normalized.isError).toBeFalsy();
    expect(normalized.structuredContent!.payload).toMatchObject({ Description: args.name, БИК: args.bik });
    for (const invalid of [
      { name: " ", bik: args.bik },
      { ...args, bik: "БИК12345" },
      { ...args, bik: "TEST' or true" },
      { ...args, bik: "short" },
    ]) {
      const result = await f.call("meta.call_tool", { name: TOOL, arguments: invalid });
      expect(result.isError).toBe(true);
    }
    expect(f.posts).toHaveLength(0);
  });

  it("обнаруживает БИК в Code даже при наличии отдельного поля БИК", async () => {
    const f = setup();
    f.store[SET]![0]!.Code = args.bik;
    const result = await f.call(TOOL, args);
    expect(result.isError).toBe(true);
    expect(f.posts).toHaveLength(0);
  });

  it("KZ: preview без записи, подтверждение, повтор без дубля, затем счёт организации", async () => {
    const f = setup();
    const pre = await f.call(TOOL, args);
    expect(pre.isError).toBeFalsy();
    expect(f.posts).toHaveLength(0);
    expect(pre.structuredContent).toMatchObject({
      dryRun: true,
      willCreate: SET,
      payload: { Description: args.name, БИК: args.bik, IsFolder: false },
    });
    expect(pre.structuredContent!.payload).not.toHaveProperty("Code");
    const operationId = pre.structuredContent!.operationId;
    const confirmed = await f.call(TOOL, { ...args, confirm: true, operationId });
    expect(confirmed.isError).toBeFalsy();
    expect(confirmed.structuredContent).toMatchObject({ created: true, entitySet: SET });
    const readsBeforeReplay = f.gets.length;
    const repeat = await f.call(TOOL, { ...args, confirm: true, operationId });
    expect(repeat.isError).toBeFalsy();
    expect(f.gets.length).toBe(readsBeforeReplay);
    expect(f.posts).toHaveLength(1);
    const account = {
      ownerRef: ORG,
      ownerKind: "organization",
      accountNumber: "KZ000000000000000099",
      bik: args.bik,
    };
    const accountPre = await f.call("write.counterparty.create_bank_account", account);
    expect(accountPre.isError).toBeFalsy();
    expect(accountPre.structuredContent!.payload).toMatchObject({
      Банк_Key: confirmed.structuredContent!.ref,
    });
    const accountDone = await f.call("write.counterparty.create_bank_account", {
      ...account,
      confirm: true,
      operationId: accountPre.structuredContent!.operationId,
    });
    expect(accountDone.isError).toBeFalsy();
    expect(accountDone.structuredContent).toMatchObject({
      created: true,
      entitySet: "Catalog_БанковскиеСчета",
    });
  });

  it.each([false, true])("не дублирует банк, DeletionMark=%s", async (deleted) => {
    const f = setup();
    f.store[SET]![0]!.DeletionMark = deleted;
    const r = await f.call(TOOL, { ...args, bik: "KCJBKZKX" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("уже существует");
    expect(f.posts).toHaveLength(0);
  });

  it("банк появился после preview — подтверждение не создаёт дубль", async () => {
    const f = setup();
    const pre = await f.call(TOOL, args);
    f.store[SET]!.push({ Ref_Key: id(123), Description: args.name, БИК: args.bik, IsFolder: false });
    const r = await f.call(TOOL, { ...args, confirm: true, operationId: pre.structuredContent!.operationId });
    expect(r.isError).toBe(true);
    expect(f.posts).toHaveLength(0);
  });

  it("без operationId и при изменённых аргументах запись запрещена", async () => {
    const f = setup();
    expect((await f.call(TOOL, { ...args, confirm: true })).isError).toBe(true);
    const pre = await f.call(TOOL, args);
    const changed = await f.call(TOOL, {
      ...args,
      name: "Другой банк",
      confirm: true,
      operationId: pre.structuredContent!.operationId,
    });
    expect(changed.isError).toBe(true);
    expect(f.posts).toHaveLength(0);
  });

  it.each([{ writable: false }, { readOnly: true }])("соблюдает запрет записи %j", async (options) => {
    const f = setup(options);
    const pre = await f.call(TOOL, args);
    const r = await f.call(TOOL, { ...args, confirm: true, operationId: pre.structuredContent?.operationId });
    expect(r.isError).toBe(true);
    expect(f.posts).toHaveLength(0);
  });

  it("использует Code, когда отдельного поля БИК нет", async () => {
    const store = baseStore();
    store[SET] = [{ Ref_Key: id(6), Description: "Банк", Code: "044525225", IsFolder: false }];
    const f = fake1C({ store });
    const pre = await f.call(TOOL, { ...args, bik: "044525999" });
    expect(pre.isError).toBeFalsy();
    expect(pre.structuredContent!.payload).toMatchObject({ Code: "044525999" });
    expect(pre.structuredContent!.payload).not.toHaveProperty("БИК");
    expect((await f.call(TOOL, { ...args, bik: "044525225" })).isError).toBe(true);
  });

  it("без подходящих метаданных и без публикации — отказ", async () => {
    const store = baseStore();
    store[SET] = [{ Ref_Key: id(6), Description: "Банк" }];
    const f = fake1C({ store });
    expect((await f.call(TOOL, args)).isError).toBe(true);
    expect(f.posts).toHaveLength(0);
    delete store[SET];
    const unpublished = fake1C({ store });
    expect((await unpublished.call(TOOL, args)).isError).toBe(true);
    expect(unpublished.posts).toHaveLength(0);
  });
});
