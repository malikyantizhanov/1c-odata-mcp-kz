import { describe, expect, it } from "vitest";
import { baseStore, fake1C } from "./support/fake-1c.js";

/**
 * Фейковая 1С на метаданных из файла (формат дискового кеша $metadata): сущности, свойства и навигации
 * берутся из файла. Путь — из ONEC_METADATA_FILE (shared/metadata/kz-base-metadata.json), без переменной
 * тест пропускается; файл в репозиторий не копируется.
 */

const FILE = process.env["ONEC_METADATA_FILE"];
const run = FILE ? it : it.skip;

describe("fake1C({ metadataFile })", () => {
  run("сущности, свойства и навигации — из файла кеша", async () => {
    const f = fake1C({ store: baseStore(), metadataFile: FILE! });
    const meta = await f.conn.getMetadata();
    expect(meta.entities.size).toBeGreaterThan(500);
    const invoice = meta.entities.get("Document_СчетНаОплатуПокупателю")!;
    expect(invoice).toBeDefined();
    expect(invoice.properties.map((p) => p.name)).toContain("ДоговорКонтрагента_Key");
    expect(invoice.properties.map((p) => p.name)).toContain("Товары");
    const nav = invoice.navigations.find((n) => n.name === "ДоговорКонтрагента")!;
    expect(nav).toMatchObject({ toType: "Catalog_ДоговорыКонтрагентов", collection: false });
    const rowSet = meta.entities.get("Document_СчетНаОплатуПокупателю_Товары")!;
    expect(rowSet.navigations.map((n) => n.name)).toContain("Номенклатура");
  });

  run("данные — из store: предпросмотр разрешает ссылки по навигациям файла", async () => {
    const f = fake1C({ store: baseStore(), metadataFile: FILE! });
    const res = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_ДоговорыКонтрагентов",
      owner: (await import("./support/fake-1c.js")).BUYER,
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as { rows: Array<{ ref: string }> };
    expect(body.rows).toHaveLength(1);
  });

  run("describe_entity отдаёт цели ссылок из файла", async () => {
    const f = fake1C({ store: baseStore(), metadataFile: FILE! });
    const res = await f.call("read.schema.describe_entity", {
      entitySet: "Document_СчетНаОплатуПокупателю",
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      relations: string[];
      navigations: Array<{ name: string; toType: string; collection: boolean }>;
    };
    expect(body.relations).toContain("ДоговорКонтрагента");
    expect(body.navigations).toContainEqual({
      name: "ДоговорКонтрагента",
      toType: "Catalog_ДоговорыКонтрагентов",
      collection: false,
    });
  });
});

describe("describe_entity: navigations на фейковой 1С", () => {
  it("цели ссылок — из явных метаданных, relations — как раньше", async () => {
    const f = fake1C({
      store: baseStore(),
      entities: {
        Catalog_Контрагенты: {
          properties: [{ name: "Ref_Key" }, { name: "Description" }],
          navigations: [
            { name: "ОсновнойДоговорКонтрагента", toType: "Catalog_ДоговорыКонтрагентов", collection: false },
            { name: "КонтактныеЛица", toType: "Catalog_КонтактныеЛица", collection: true },
          ],
        },
      },
    });
    const res = await f.call("read.schema.describe_entity", { entitySet: "Catalog_Контрагенты" });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      relations: string[];
      navigations: Array<{ name: string; toType: string; collection: boolean }>;
    };
    expect(body.relations).toEqual(["ОсновнойДоговорКонтрагента", "КонтактныеЛица"]);
    expect(body.navigations).toEqual([
      { name: "ОсновнойДоговорКонтрагента", toType: "Catalog_ДоговорыКонтрагентов", collection: false },
      { name: "КонтактныеЛица", toType: "Catalog_КонтактныеЛица", collection: true },
    ]);
  });
});
