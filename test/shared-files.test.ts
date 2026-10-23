import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBehavior } from "../src/config/env.js";
import { printTarget } from "../src/tools/print.js";
import { sharedToolFilter } from "../src/http.js";
import { baseStore, fake1C, id } from "./support/fake-1c.js";

/**
 * Общий HTTP-режим: печатные формы и вложения отдаются ресурсом MCP без записи на диск (printToDisk=false),
 * вложения — не больше 10 МБ. Обычный режим пишет на диск, как раньше.
 */

const INVOICE = id(100);
const FILE = id(101);
const PDF = Buffer.from("%PDF-1.4\n%тест\n");

/** Счёт на оплату в памяти: шапка + строки, чтобы печать собрала PDF без живой 1С. */
function invoiceStore() {
  const store = baseStore();
  store["Document_СчетНаОплатуПокупателю"] = [
    {
      Ref_Key: INVOICE,
      Number: "00000000007",
      Date: "2026-10-07T10:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: store["Catalog_Организации"]![0]!["Ref_Key"],
      Контрагент_Key: store["Catalog_Контрагенты"]![0]!["Ref_Key"],
      ДоговорКонтрагента_Key: store["Catalog_ДоговорыКонтрагентов"]![0]!["Ref_Key"],
      ВалютаДокумента_Key: store["Catalog_Валюты"]![0]!["Ref_Key"],
      УчитыватьНДС: false,
      СуммаВключаетНДС: false,
      СуммаДокумента: 100,
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: store["Catalog_Номенклатура"]![0]!["Ref_Key"],
          Содержание: "Разработка",
          Количество: 1,
          Цена: 100,
          Сумма: 100,
          СуммаНДС: 0,
        },
      ],
      Товары: [],
    },
  ];
  return store;
}

describe("поведение общего режима", () => {
  it("parseBehavior: печать при создании включена, записи на диск нет", () => {
    const { behavior } = parseBehavior({ ODATA_BASE_URL: "https://x/", READ_ONLY: "true" });
    expect(behavior.printOnCreate).toBe(true);
    expect(behavior.printToDisk).toBe(false);
  });

  it("printTarget без диска: каталогов не создаёт, printing идёт только ресурсом", async () => {
    const f = fake1C({ printToDisk: false });
    const target = await printTarget(f.conn, undefined);
    expect(target).toEqual({});
    expect(existsSync(join(f.conn.behavior.printDir!, "счета"))).toBe(false);
  });

  it("в общем режиме разрешены печать и вложения — запрещён только шлюз", () => {
    expect(sharedToolFilter("read.document.print_invoice")).toBe(true);
    expect(sharedToolFilter("read.document.print_sale")).toBe(true);
    expect(sharedToolFilter("read.document.print_reconciliation")).toBe(true);
    expect(sharedToolFilter("read.files.list_attachments")).toBe(true);
    expect(sharedToolFilter("read.files.get_attachment")).toBe(true);
    expect(sharedToolFilter("meta.call_tool")).toBe(false);
    expect(sharedToolFilter("meta.list_tools")).toBe(false);
  });
});

describe("печать без диска и с диском", () => {
  it("print_invoice без диска: PDF ресурсом, поля path нет, каталог пуст", async () => {
    const f = fake1C({ store: invoiceStore(), printToDisk: false });
    const res = await f.call("read.document.print_invoice", { ref: INVOICE });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ name: expect.stringContaining(".pdf"), mimeType: "application/pdf" });
    expect(sc).not.toHaveProperty("path");
    expect(sc).not.toHaveProperty("saveError");
    const resource = res.content.find((c) => c.type === "resource") as unknown as {
      resource: { blob: string; mimeType: string };
    };
    expect(resource.resource.mimeType).toBe("application/pdf");
    expect(Buffer.from(resource.resource.blob, "base64").subarray(0, 4).toString()).toBe("%PDF");
    expect(readdirSync(f.conn.behavior.printDir!)).toEqual([]);
  });

  it("print_invoice с диском: путь в ответе, файл на месте", async () => {
    const f = fake1C({ store: invoiceStore() });
    const res = await f.call("read.document.print_invoice", { ref: INVOICE });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc["path"]).toBe(join(f.conn.behavior.printDir!, sc["fileName"] as string));
    expect(existsSync(sc["path"] as string)).toBe(true);
  });

  it("get_attachment в общем режиме: maxBytes больше 10 МБ — отказ сразу", async () => {
    const store = invoiceStore();
    store["Catalog_СчетПрисоединенныеФайлы"] = [
      {
        Ref_Key: FILE,
        Description: "Счёт 1",
        Расширение: "pdf",
        ТипХраненияФайла: "ВИнформационнойБазе",
        ФайлХранилище_Base64Data: PDF.toString("base64"),
      },
    ];
    const shared = fake1C({ store, printToDisk: false });
    const bad = await shared.call("read.files.get_attachment", {
      filesCatalog: "Catalog_СчетПрисоединенныеФайлы",
      ref: FILE,
      maxBytes: 20_000_000,
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("10 000 000");

    const okRes = await shared.call("read.files.get_attachment", {
      filesCatalog: "Catalog_СчетПрисоединенныеФайлы",
      ref: FILE,
      maxBytes: 10_000_000,
    });
    expect(okRes.isError).toBeFalsy();

    const usual = fake1C({ store });
    const usualRes = await usual.call("read.files.get_attachment", {
      filesCatalog: "Catalog_СчетПрисоединенныеФайлы",
      ref: FILE,
      maxBytes: 20_000_000,
    });
    expect(usualRes.isError).toBeFalsy();
  });
});

describe("PDF при создании в общем режиме", () => {
  it("quick_invoice: PDF ресурсом без пути и без файлов на диске", async () => {
    const f = fake1C({ printToDisk: false });
    const plan = (await f.quick({
      buyer: "240440007327",
      date: "2026-10-08",
      lines: [{ name: "Разработка программного обеспечения", quantity: 1, price: 100, kind: "service" }],
    })) as unknown as { structuredContent: Record<string, unknown> };
    const opId = plan.structuredContent["operationId"] as string;
    const done = await f.quick({
      buyer: "240440007327",
      date: "2026-10-08",
      lines: [{ name: "Разработка программного обеспечения", quantity: 1, price: 100, kind: "service" }],
      confirm: true,
      operationId: opId,
    });
    expect(done.isError).toBeFalsy();
    const sc = done.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ created: true });
    const pdf = sc["pdf"] as Record<string, unknown>;
    expect(pdf["size"]).toBeGreaterThan(0);
    expect(pdf).not.toHaveProperty("path");
    const resource = done.content.find((c) => c.type === "resource") as unknown as {
      resource: { blob: string; mimeType: string };
    };
    expect(resource.resource.mimeType).toBe("application/pdf");
    expect(Buffer.from(resource.resource.blob, "base64").subarray(0, 4).toString()).toBe("%PDF");
    expect(readdirSync(f.conn.behavior.printDir!)).toEqual([]);
  });
});
