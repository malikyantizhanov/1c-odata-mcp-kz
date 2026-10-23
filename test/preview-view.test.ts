/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в тестах */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { humanize } from "../src/tools/preview-view.js";
import { withWriteOperation } from "../src/odata/write-operation-context.js";
import { createOrPreview, patchOrPreview } from "../src/tools/write.js";
import { BUYER, CONTRACT, ORG, SERVICE, VAT_NONE, baseStore, fake1C, id } from "./support/fake-1c.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Прямой вызов createOrPreview вне MCP-сервера: предпросмотру нужен контекст операции. */
const previewCreate = (
  conn: Parameters<typeof createOrPreview>[0],
  entitySet: string,
  payload: Record<string, unknown>,
  confirm: boolean,
) => withWriteOperation(randomUUID(), "test-hash", () => createOrPreview(conn, entitySet, payload, confirm));

/**
 * Читаемый предпросмотр (view) в ответах записи: подписи по-человечески, названия вместо GUID,
 * итоги и changes «было → станет». Карточка созданного документа: дата, сумма, проведение.
 */

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>;
const INVOICE_SET = "Document_СчетНаОплатуПокупателю";

/** Метаданные счёта: реквизиты, табличные части и навигации — как в настоящей базе. */
const invoiceEntities = {
  [INVOICE_SET]: {
    properties: [
      { name: "Ref_Key", type: "Edm.Guid" },
      { name: "Date", type: "Edm.DateTime" },
      { name: "Posted", type: "Edm.Boolean" },
      { name: "Организация_Key", type: "Edm.Guid" },
      { name: "Контрагент_Key", type: "Edm.Guid" },
      { name: "ДоговорКонтрагента_Key", type: "Edm.Guid" },
      { name: "СуммаДокумента", type: "Edm.Double" },
      { name: "Комментарий", type: "Edm.String" },
      { name: "Товары", type: `Collection(StandardODATA.${INVOICE_SET}_Товары_RowType)` },
      { name: "Услуги", type: `Collection(StandardODATA.${INVOICE_SET}_Услуги_RowType)` },
    ],
    navigations: [
      { name: "Организация", toType: "Catalog_Организации", collection: false },
      { name: "Контрагент", toType: "Catalog_Контрагенты", collection: false },
      { name: "ДоговорКонтрагента", toType: "Catalog_ДоговорыКонтрагентов", collection: false },
    ],
  },
  [`${INVOICE_SET}_Услуги`]: {
    properties: [
      { name: "Номенклатура_Key", type: "Edm.Guid" },
      { name: "Содержание", type: "Edm.String" },
      { name: "Количество", type: "Edm.Double" },
      { name: "Цена", type: "Edm.Double" },
      { name: "Сумма", type: "Edm.Double" },
      { name: "СуммаНДС", type: "Edm.Double" },
    ],
    navigations: [{ name: "Номенклатура", toType: "Catalog_Номенклатура", collection: false }],
  },
  [`${INVOICE_SET}_Товары`]: {
    properties: [
      { name: "Номенклатура_Key", type: "Edm.Guid" },
      { name: "Количество", type: "Edm.Double" },
      { name: "Сумма", type: "Edm.Double" },
      { name: "СуммаНДС", type: "Edm.Double" },
    ],
    navigations: [{ name: "Номенклатура", toType: "Catalog_Номенклатура", collection: false }],
  },
};

const payload = () => ({
  Date: "2026-10-08T00:00:00",
  Posted: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: CONTRACT,
  СуммаДокумента: 100,
  Комментарий: "тест",
  Услуги: [
    {
      LineNumber: 1,
      Номенклатура_Key: SERVICE,
      Содержание: "Разработка",
      Количество: 1,
      Цена: 100,
      Сумма: 100,
      СуммаНДС: 0,
      СтавкаНДС_Key: VAT_NONE,
    },
  ],
});

describe("подписи", () => {
  it("технические имена — по-человечески", () => {
    expect(humanize("ДоговорКонтрагента_Key")).toBe("Договор контрагента");
    expect(humanize("Организация_Key")).toBe("Организация");
    expect(humanize("СуммаДокумента")).toBe("Сумма документа");
    expect(humanize("УчитыватьНДС")).toBe("Учитывать НДС");
    expect(humanize("Количество")).toBe("Количество");
  });
});

describe("view у создания (CP)", () => {
  it("предпросмотр: поля с названиями, строки с номенклатурой, итоги", async () => {
    const f = fake1C({ store: baseStore(), entities: invoiceEntities });
    const res = await previewCreate(f.conn, INVOICE_SET, payload(), false);
    expect(res.isError).toBeFalsy();
    const view = sc(res)["view"] as Record<string, any>;
    expect(view["title"]).toBe("Счет на оплату покупателю");
    const byName = new Map((view["fields"] as Array<Record<string, any>>).map((fl) => [fl["name"], fl]));
    expect(byName.get("Организация_Key")).toMatchObject({ label: "Организация", text: "ИП Aru Market" });
    expect(byName.get("Контрагент_Key")).toMatchObject({ label: "Контрагент", text: 'ТОО "TRADESPACE"' });
    expect(byName.get("ДоговорКонтрагента_Key")).toMatchObject({
      label: "Договор контрагента",
      text: "Договор б/н",
    });
    expect(byName.get("Комментарий")).toMatchObject({ label: "Комментарий", value: "тест" });
    expect(byName.get("Комментарий")).not.toHaveProperty("text");
    const services = (view["tables"] as Array<Record<string, any>>).find((t) => t["name"] === "Услуги")!;
    expect(services["label"]).toBe("Услуги");
    expect(services["columns"].map((c: { name: string }) => c["name"])).toContain("Номенклатура_Key");
    const nomCol = services["columns"].findIndex((c: { name: string }) => c["name"] === "Номенклатура_Key");
    expect(services["rows"][0][nomCol]).toBe("Разработка программного обеспечения");
    expect(view["totals"]).toMatchObject({ sum: 100, vat: 0, total: 100 });
    expect(view).not.toHaveProperty("changes");
  });

  it("пустая ссылка — без строки", async () => {
    const f = fake1C({ store: baseStore(), entities: invoiceEntities });
    const res = await previewCreate(
      f.conn,
      INVOICE_SET,
      { ...payload(), ДоговорКонтрагента_Key: "00000000-0000-0000-0000-000000000000" },
      false,
    );
    const names = ((sc(res)["view"] as Record<string, any>)["fields"] as Array<Record<string, any>>).map(
      (fl) => fl["name"],
    );
    expect(names).not.toContain("ДоговорКонтрагента_Key");
  });

  it("запись документа: дата, сумма и проведение в ответе", async () => {
    const f = fake1C({ store: baseStore(), entities: invoiceEntities });
    // Подтверждение тем же operationId, что предпросмотр: журнал находит prepare-запись и пишет.
    const opId = randomUUID();
    const pre = await withWriteOperation(opId, "test-hash", () =>
      createOrPreview(f.conn, INVOICE_SET, payload(), false),
    );
    expect(pre.isError).toBeFalsy();
    const res = await withWriteOperation(opId, "test-hash", () =>
      createOrPreview(f.conn, INVOICE_SET, payload(), true),
    );
    expect(res.isError).toBeFalsy();
    expect(sc(res)).toMatchObject({ created: true, date: "2026-10-08", total: 100, posted: false });
  });
});

describe("view у правки (PP)", () => {
  it("изменяемые поля и changes «было → станет» с названиями", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"] = [
      {
        Ref_Key: CONTRACT,
        Description: "Договор б/н",
        Owner_Key: BUYER,
        Организация_Key: ORG,
        IsFolder: false,
        DeletionMark: false,
      },
    ];
    const f = fake1C({
      store,
      entities: {
        Catalog_ДоговорыКонтрагентов: {
          properties: [{ name: "Ref_Key" }, { name: "Description" }, { name: "Owner_Key" }],
          navigations: [{ name: "Owner", toType: "Catalog_Контрагенты", collection: false }],
        },
      },
    });
    const res = await patchOrPreview(
      f.conn,
      "Catalog_ДоговорыКонтрагентов",
      CONTRACT,
      { Owner_Key: ORG },
      false,
    );
    expect(res.isError).toBeFalsy();
    const view = sc(res)["view"] as Record<string, any>;
    expect(view["fields"]).toEqual([
      { name: "Owner_Key", label: "Owner", value: ORG, text: "ИП Aru Market" },
    ]);
    expect(view["changes"]).toEqual([
      {
        name: "Owner_Key",
        label: "Owner",
        from: { value: BUYER, text: 'ТОО "TRADESPACE"' },
        to: { value: ORG, text: "ИП Aru Market" },
      },
    ]);
  });
});

describe("view у ЭСФ/ЭАВР (EP)", () => {
  it("предпросмотр связи: changes с названиями документов", async () => {
    const CTR = id(310);
    const ESF = id(301);
    const INV = id(302);
    const store = baseStore();
    store["Document_ЭСФ"] = [
      {
        Ref_Key: ESF,
        Number: "00000005029",
        Date: "2026-10-13T00:00:00",
        DeletionMark: false,
        Posted: false,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        Направление: "Входящий",
        Статус: "Доставленный",
        Состояние: "ПринятОтПоставщика",
        РегистрационныйНомер: "",
        СчетФактура: "",
        СчетФактура_Type: "StandardODATA.Undefined",
        ДоговорПоставки_Key: "00000000-0000-0000-0000-000000000000",
      },
    ];
    store["Document_СчетФактураПолученный"] = [
      {
        Ref_Key: INV,
        Number: "00000000259",
        Date: "2026-10-13T00:00:00",
        DeletionMark: false,
        Posted: true,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        ДоговорКонтрагента_Key: CTR,
        СуммаДокумента: 100,
      },
    ];
    store["Catalog_ДоговорыКонтрагентов"] = [
      {
        Ref_Key: CTR,
        Description: "Договор № 186/2026 от 29.09.2026",
        Owner_Key: BUYER,
        Организация_Key: ORG,
        DeletionMark: false,
        НомерДоговора: "186/2026",
        ДатаДоговора: "2026-09-29T00:00:00",
      },
    ];
    store["InformationRegister_АктуальныеЭСФ"] = [];
    store["InformationRegister_ИсторияЭСФ"] = [];
    store["InformationRegister_ОчередьОтправкиЭСФ"] = [];
    store["InformationRegister_АктуальныеЭСФПоПервичнымДокументам"] = [];
    const f = fake1C({ store });
    const res = await f.call("write.esf.link_invoice", { esfRef: ESF, invoiceRef: INV });
    expect(res.isError).toBeFalsy();
    const body = sc(res);
    expect(body).toMatchObject({ dryRun: true });
    const view = body["view"] as Record<string, any>;
    expect(view["title"]).toBe("ЭСФ");
    const change = (view["changes"] as Array<Record<string, any>>).find((c) => c["name"] === "СчетФактура")!;
    expect(change["label"]).toBe("Счет фактура");
    expect(String(change["to"]["text"])).toContain("№ 259");
  });
});

describe("повтор создания документа из журнала", () => {
  it("второй confirm с тем же operationId: та же карточка без нового POST", async () => {
    const f = fake1C({ store: baseStore() });
    const args = {
      counterpartyRef: BUYER,
      date: "2026-10-08",
      lines: [{ nomenclatureRef: SERVICE, quantity: 1, price: 100, vatRate: "без НДС" as const }],
    };
    const plan = sc(await f.call("write.sales.create_invoice", args));
    const opId = plan["operationId"] as string;
    const first = sc(
      await f.call("write.sales.create_invoice", { ...args, confirm: true, operationId: opId }),
    );
    expect(first).toMatchObject({ created: true, date: "2026-10-08", total: 100, posted: false });
    expect(f.posts).toHaveLength(1);
    const again = sc(
      await f.call("write.sales.create_invoice", { ...args, confirm: true, operationId: opId }),
    );
    expect(again).toMatchObject({
      created: true,
      replayed: true,
      date: "2026-10-08",
      total: 100,
      posted: false,
    });
    expect(f.posts).toHaveLength(1);
  });
});
