/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { KZ_WRITE_TOOLS } from "../src/tools/write-kz.js";
import { baseStore, fake1C, id, ORG, type Row } from "./support/fake-1c.js";

/**
 * Доверенность и комплектация номенклатуры: понятные аргументы → реквизиты и табличные части по $metadata
 * (форма полей — из $metadata Aru Market). По умолчанию предпросмотр, без записи.
 */

const POA = "Document_Доверенность";
const KIT = "Document_КомплектацияНоменклатуры";
const PERSON = id(301);
const SUPPLIER = id(302);
const NOM = id(303);
const UNIT = id(304);
const WAREHOUSE = id(311);
const KIT_NOM = id(312);
const PART1 = id(313);
const PART2 = id(314);
const ACC_1330 = id(321);
const OP = "11111111-2222-4333-8444-555555555555";

const props = (names: string[], type = "Edm.String") => names.map((name) => ({ name, type }));
const nav = (name: string, toType = "ChartOfAccounts_Типовой") => ({ name, toType, collection: false });
const entities = {
  [POA]: {
    properties: [
      ...props(["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "ФизЛицо_Key"]),
      ...props(["ДатаДействия", "Контрагент_Key", "ДоговорКонтрагента_Key", "НаПолучениеОт", "ПоДокументу"]),
      ...props(["ДокументОснование_Key", "Комментарий"]),
      { name: "Товары", type: `Collection(StandardODATA.${POA}_Товары_RowType)` },
    ],
  },
  [`${POA}_Товары`]: {
    properties: props([
      "LineNumber",
      "НаименованиеТовара",
      "НаименованиеТовара_Type",
      "ЕдиницаПоКлассификатору_Key",
      "Количество",
    ]),
  },
  [KIT]: {
    properties: [
      ...props(["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "ВидОперации"]),
      ...props(["Склад_Key", "Номенклатура_Key", "Количество", "ЕдиницаИзмерения_Key", "Коэффициент"]),
      ...props(["СчетУчетаБУ_Key", "СчетУчетаНУ_Key", "Комментарий"]),
      { name: "Комплектующие", type: `Collection(StandardODATA.${KIT}_Комплектующие_RowType)` },
    ],
    navigations: [nav("СчетУчетаБУ")],
  },
  [`${KIT}_Комплектующие`]: {
    properties: props([
      "LineNumber",
      "Номенклатура_Key",
      "Количество",
      "Коэффициент",
      "ЕдиницаИзмерения_Key",
      "ДоляСтоимости",
      "СчетУчетаБУ_Key",
      "СчетУчетаНУ_Key",
    ]),
    navigations: [nav("СчетУчетаБУ")],
  },
  ChartOfAccounts_Типовой: { properties: props(["Ref_Key", "Code"]) },
};

function setup(opts: { readOnly?: boolean; writable?: boolean } = {}) {
  const store = baseStore();
  store[POA] = [
    { Ref_Key: id(401), Number: "1", Date: "2026-10-01T00:00:00", Posted: false, DeletionMark: false },
    { Ref_Key: id(402), Number: "2", Date: "2026-10-01T00:00:00", Posted: false, DeletionMark: true },
  ];
  store[KIT] = [
    { Ref_Key: id(411), Number: "1", Date: "2026-10-01T00:00:00", Posted: false, DeletionMark: false },
    { Ref_Key: id(412), Number: "2", Date: "2026-10-01T00:00:00", Posted: true, DeletionMark: false },
  ];
  store["ChartOfAccounts_Типовой"] = [{ Ref_Key: ACC_1330, Code: "1330", ExtDimensionTypes: [] }];
  return fake1C({ store, entities, ...opts });
}

type Res = { structuredContent?: any; isError?: boolean; content: Array<{ text?: string }> };
const text = (r: Res) => r.content.map((c) => c.text ?? "").join("\n");
const notes = (r: Res) => ((r.structuredContent?.notes ?? []) as string[]).join("\n");

const poa = {
  date: "2026-10-20",
  personRef: PERSON,
  validUntil: "2026-10-31",
  counterpartyRef: SUPPLIER,
  receiveFrom: "ТОО «Поставщик»",
  byDocument: "Счёт на оплату № 15 от 01.10.2026",
  lines: [
    { name: "Бумага А4", quantity: 10 },
    { nomenclatureRef: NOM, unitRef: UNIT, quantity: 2 },
  ],
};
const kit = {
  date: "2026-10-20",
  operation: "Комплектация",
  warehouseRef: WAREHOUSE,
  nomenclatureRef: KIT_NOM,
  quantity: 5,
  account: "1330",
  components: [
    { nomenclatureRef: PART1, quantity: 10, account: "1330" },
    { nomenclatureRef: PART2, quantity: 5, account: "1330" },
  ],
};

describe("write.document.create_power_of_attorney", () => {
  it("предпросмотр: шапка, ТМЦ строкой и из справочника с _Type, ничего не пишет", async () => {
    const { call, posts } = setup();
    const r = (await call("write.document.create_power_of_attorney", poa)) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(0);
    const p = r.structuredContent.payload as Row & { Товары: Row[] };
    expect(r.structuredContent.dryRun).toBe(true);
    expect(p).toMatchObject({
      Организация_Key: ORG,
      ФизЛицо_Key: PERSON,
      ДатаДействия: "2026-10-31T00:00:00",
      Контрагент_Key: SUPPLIER,
      НаПолучениеОт: "ТОО «Поставщик»",
      ПоДокументу: "Счёт на оплату № 15 от 01.10.2026",
      Posted: false,
    });
    expect(p.Товары[0]).toMatchObject({
      НаименованиеТовара: "Бумага А4",
      НаименованиеТовара_Type: "Edm.String",
    });
    expect(p.Товары[1]).toMatchObject({
      НаименованиеТовара: NOM,
      НаименованиеТовара_Type: "StandardODATA.Catalog_Номенклатура",
      ЕдиницаПоКлассификатору_Key: UNIT,
      Количество: 2,
    });
    expect(notes(r)).toContain("не проводится");
  });

  it("срок действия раньше даты — отказ", async () => {
    const { call, posts } = setup();
    const r = (await call("write.document.create_power_of_attorney", {
      ...poa,
      validUntil: "2026-10-01",
    })) as Res;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("раньше даты доверенности");
    expect(posts).toHaveLength(0);
  });

  it("READ_ONLY: confirm=true не пишет", async () => {
    const { call, posts } = setup({ readOnly: true });
    const r = (await call("write.document.create_power_of_attorney", {
      ...poa,
      confirm: true,
      operationId: OP,
    })) as Res;
    expect(r.isError).toBe(true);
    expect(posts).toHaveLength(0);
  });
});

describe("write.document.update_power_of_attorney", () => {
  it("предпросмотр изменения срока и строк, без PATCH", async () => {
    const { call, patches } = setup();
    const r = (await call("write.document.update_power_of_attorney", {
      ref: id(401),
      validUntil: "2026-11-15",
      lines: [{ name: "Тонер", quantity: 1 }],
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(patches).toHaveLength(0);
    expect(JSON.stringify(r.structuredContent)).toContain("2026-11-15T00:00:00");
    expect(JSON.stringify(r.structuredContent)).toContain("Тонер");
  });

  it("помеченная на удаление — отказ; срок раньше даты — отказ; пустое изменение — отказ", async () => {
    const { call, patches } = setup();
    const del = (await call("write.document.update_power_of_attorney", {
      ref: id(402),
      comment: "x",
    })) as Res;
    expect(del.isError).toBe(true);
    expect(text(del)).toContain("помечен на удаление");
    const early = (await call("write.document.update_power_of_attorney", {
      ref: id(401),
      validUntil: "2026-09-01",
    })) as Res;
    expect(early.isError).toBe(true);
    const empty = (await call("write.document.update_power_of_attorney", { ref: id(401) })) as Res;
    expect(empty.isError).toBe(true);
    expect(patches).toHaveLength(0);
  });
});

describe("write.warehouse.create_kitting", () => {
  it("предпросмотр комплектации: счета по коду → ссылки, коэффициент 1, ничего не пишет", async () => {
    const { call, posts } = setup();
    const r = (await call("write.warehouse.create_kitting", kit)) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(0);
    const p = r.structuredContent.payload as Row & { Комплектующие: Row[] };
    expect(p).toMatchObject({
      ВидОперации: "Комплектация",
      Склад_Key: WAREHOUSE,
      Номенклатура_Key: KIT_NOM,
      Количество: 5,
      Коэффициент: 1,
      СчетУчетаБУ_Key: ACC_1330,
      Организация_Key: ORG,
    });
    expect(p.Комплектующие).toHaveLength(2);
    expect(p.Комплектующие[0]).toMatchObject({
      Номенклатура_Key: PART1,
      Количество: 10,
      СчетУчетаБУ_Key: ACC_1330,
    });
  });

  it("разукомплектация без долей стоимости — предупреждение; комплект в своих строках — отказ", async () => {
    const { call } = setup();
    const r = (await call("write.warehouse.create_kitting", {
      ...kit,
      operation: "Разукомплектация",
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(notes(r)).toContain("без долей стоимости");
    const self = (await call("write.warehouse.create_kitting", {
      ...kit,
      components: [{ nomenclatureRef: KIT_NOM, quantity: 1 }],
    })) as Res;
    expect(self.isError).toBe(true);
  });

  it("журнал: confirm без dry-run отклоняется; dry-run → operationId → confirm создаёт (фейковая 1С)", async () => {
    const { call, posts } = setup();
    const blind = (await call("write.warehouse.create_kitting", {
      ...kit,
      confirm: true,
      operationId: OP,
    })) as Res;
    expect(blind.isError).toBe(true);
    expect(text(blind)).toContain("dry-run");
    const plan = (await call("write.warehouse.create_kitting", kit)) as Res;
    const operationId = plan.structuredContent.operationId as string;
    expect(operationId).toBeTruthy();
    const r = (await call("write.warehouse.create_kitting", { ...kit, confirm: true, operationId })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.set).toBe(KIT);
  });
});

describe("write.warehouse.update_kitting", () => {
  it("проведённую не меняет; непроведённую — предпросмотр", async () => {
    const { call, patches } = setup();
    const posted = (await call("write.warehouse.update_kitting", { ref: id(412), quantity: 3 })) as Res;
    expect(posted.isError).toBe(true);
    expect(text(posted)).toContain("проведён");
    const ok = (await call("write.warehouse.update_kitting", {
      ref: id(411),
      quantity: 3,
      components: [{ nomenclatureRef: PART1, quantity: 6, costShare: 1 }],
    })) as Res;
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(JSON.stringify(ok.structuredContent)).toContain("ДоляСтоимости");
    expect(patches).toHaveLength(0);
  });
});

describe("регистрация", () => {
  const NEW = [
    "write.document.create_power_of_attorney",
    "write.document.update_power_of_attorney",
    "write.warehouse.create_kitting",
    "write.warehouse.update_kitting",
  ];
  it("в KZ_WRITE_TOOLS и видны через meta.list_tools; схема отклоняет строку с name и nomenclatureRef", async () => {
    for (const n of NEW) expect(KZ_WRITE_TOOLS as readonly string[]).toContain(n);
    const f = fake1C({ store: baseStore(), entities });
    const server = createServer({ db: () => f.conn } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    const r = await client.callTool({ name: "meta.list_tools", arguments: { prefix: "write." } });
    const names = ((r.structuredContent as any).tools as Array<{ name: string }>).map((t) => t.name);
    for (const n of NEW) expect(names).toContain(n);
    const bad = (await client.callTool({
      name: "write.document.create_power_of_attorney",
      arguments: { ...poa, lines: [{ name: "x", nomenclatureRef: NOM, quantity: 1 }] },
    })) as Res;
    expect(bad.isError).toBe(true);
    expect(f.posts).toHaveLength(0);
    await client.close();
  });
});
