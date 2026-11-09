/* eslint-disable @typescript-eslint/no-explicit-any -- разбор decode() в тестах */
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BUYER, baseStore, fake1C, id } from "./support/fake-1c.js";
import { readableResult } from "../src/tools/readable-result.js";
import { unwrapRefs } from "../src/tools/readable-input.js";
import { createServer } from "../src/mcp/server.js";

function docStore() {
  const store = baseStore();
  store["Document_СчетНаОплатуПокупателю"] = [
    {
      Ref_Key: id(100),
      Number: "00000000007",
      Date: "2026-10-07T10:00:00",
      Posted: false,
      DeletionMark: false,
      СуммаДокумента: 100,
      Контрагент_Key: BUYER,
    },
  ];
  return store;
}
const SEARCH = { entitySet: "Document_СчетНаОплатуПокупателю" };

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const body = (t: string) => decode(t.slice(t.indexOf("\n") + 1)) as any;

describe("читаемый ответ любого инструмента (TOON, понятные поля, ссылки с названиями)", () => {
  it("поиск документов: заголовок, snake_case, вид по-русски, дата без T00; structuredContent — как был", async () => {
    const f = fake1C({ store: docStore() });
    const r = await f.call("read.document.search_documents", SEARCH);
    const t = text(r);
    expect(t.startsWith("# Поиск документов\n")).toBe(true);
    const v = body(t);
    expect(v.rows[0]).toMatchObject({
      type: "Счет на оплату покупателю",
      entity_set: "Document_СчетНаОплатуПокупателю",
    });
    expect(v.rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/);
    expect((r.structuredContent as any).rows[0].entitySet).toBe("Document_СчетНаОплатуПокупателю");
  });

  it("голая ссылка получает название из 1С сама", async () => {
    const f = fake1C({ store: docStore() });
    const v = body(text(await f.call("read.counterparty.get_customer_history", { ref: BUYER })));
    expect(v.counterparty).toEqual({ guid: BUYER, name: 'ТОО "TRADESPACE"' });
  });

  it("пара counterparty + counterpartyRef — одна ссылка {guid, name}; пустое — прочь", async () => {
    const { text: t } = await readableResult(undefined, "Т", {
      counterparty: "ИП Алексеев",
      counterpartyRef: BUYER,
      contractRef: "00000000-0000-0000-0000-000000000000",
      comment: "",
      period: {},
      isFolder: false,
      odata: { x: 1 },
      "odata.metadata": "http://x",
    });
    const v = body(t);
    expect(v).toEqual({
      counterparty: { guid: BUYER, name: "ИП Алексеев" },
      is_folder: false,
      odata: { x: 1 },
    });
  });

  it("реквизиты 1С: по словарю, счёт учёта — «код название», КНП — с названием", async () => {
    const store = baseStore();
    store["ChartOfAccounts_Типовой"] = [
      { Ref_Key: id(900), Code: "1210", Description: "Дебиторка покупателей" },
    ];
    const f = fake1C({ store });
    const { view } = await readableResult(f.conn, "Т", {
      willCreate: "Document_ПоступлениеНаРасчетныйСчет",
      payload: {
        СчетУчетаРасчетовСКонтрагентом_Key: id(900),
        КодНазначенияПлатежа: "859",
        Контрагент_Key: BUYER,
      },
    });
    expect((view as any).payload).toMatchObject({
      settlement_account: { guid: id(900), name: "1210 Дебиторка покупателей" },
      knp: { code: "859" },
      counterparty: { guid: BUYER, name: 'ТОО "TRADESPACE"' },
    });
    expect((view as any).payload.knp.name).toBeTruthy();
  });

  it("предпросмотр записи: карточка view для экрана в тексте не дублируется, operationId — как есть", async () => {
    const f = fake1C({ writable: true });
    const r = await f.call("write.catalog.create_nomenclature", { name: "Услуга", isService: true });
    const v = body(text(r));
    expect(v.operationId).toBe((r.structuredContent as any).operationId);
    expect(v.view).toBeUndefined();
  });

  it("raw=true — текст как structuredContent", async () => {
    const f = fake1C({ store: docStore() });
    const r = await f.call("read.document.search_documents", { ...SEARCH, raw: true });
    expect(JSON.parse(text(r))).toEqual(r.structuredContent);
  });
});

describe("ссылка из ответа — во вход инструмента как есть", () => {
  it("{guid, name} → guid, КНП {code, name} → код; объекты-данные не трогаем", () => {
    expect(
      unwrapRefs("write.sales.quick_invoice", {
        buyer: { guid: BUYER, name: "ТОО" },
        knp: { code: "859", name: "Услуги" },
        lines: [{ nomenclature: { guid: id(4), name: "Услуга", type: "Catalog_Номенклатура" }, price: 1 }],
        period: { from: "2026-01-01", to: "2026-01-31" },
        contract: { name: "Договор №2" },
      }),
    ).toEqual({
      buyer: BUYER,
      knp: "859",
      lines: [{ nomenclature: id(4), price: 1 }],
      period: { from: "2026-01-01", to: "2026-01-31" },
      contract: { name: "Договор №2" },
    });
    const own = { fields: { counterparty: { guid: BUYER, name: "ТОО" } } };
    expect(unwrapRefs("write.document.create_document", own)).toBe(own);
  });

  it("сервер разворачивает ссылки до проверки по схеме", async () => {
    const f = fake1C();
    const server = createServer({
      db: () => f.conn,
      defaultName: "default",
      databases: () => [{ name: "default", isDefault: true }],
    } as never) as any;
    const tool = server._registeredTools["read.counterparty.get_counterparty"];
    const args = await server.validateToolInput(
      tool,
      { ref: { guid: BUYER, name: "ТОО" } },
      "read.counterparty.get_counterparty",
    );
    expect(args.ref).toBe(BUYER);
  });
});
