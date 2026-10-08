import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import {
  hasClassPrefix,
  normalizeDocumentEntity,
  normalizeEntityName,
  resolveEntityName,
} from "../src/odata/entity-name.js";

/**
 * Имя типа без префикса OData: агент 1С передал «СчетНаОплатуПокупателю» в get_document и получил «не опубликован
 * в OData». Теперь имя приводится к Document_… (для параметров-документов) или подбирается по опубликованным.
 */
type Tool = {
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const REF = "13a546d0-c2d4-11f1-9395-af4747f1cb08";

function connection(sets: string[]) {
  const getEntity = vi.fn(async (path: string) => ({ Ref_Key: REF, path }));
  const getCollection = vi.fn(async () => ({ value: [] }));
  const entities = new Map(
    sets.map((s) => [
      s,
      {
        entitySet: s,
        class: s.split("_")[0]!.toLowerCase(),
        keys: ["Ref_Key"],
        properties: [{ name: "Recorder", type: "Edm.Guid", nullable: false }],
        navigations: [],
      },
    ]),
  );
  const conn = {
    cfg: { name: "default" },
    behavior: { pageSize: 100, maxRows: 1000 },
    getMetadata: async () => ({ entities }),
    available: async () => new Set(sets),
    client: { getEntity, getCollection },
  };
  const tools = (
    createServer({ db: () => conn } as never) as unknown as { _registeredTools: Record<string, Tool> }
  )._registeredTools;
  return { conn, tools, getEntity, getCollection };
}

describe("нормализация имени объекта", () => {
  it("документ: без префикса и в синтаксисе 1С → Document_…; с префиксом — как есть", () => {
    expect(normalizeDocumentEntity("СчетНаОплатуПокупателю")).toBe("Document_СчетНаОплатуПокупателю");
    expect(normalizeDocumentEntity(" Документ.РеализацияТоваровУслуг ")).toBe(
      "Document_РеализацияТоваровУслуг",
    );
    expect(normalizeDocumentEntity("Document.РеализацияТоваровУслуг")).toBe(
      "Document_РеализацияТоваровУслуг",
    );
    expect(normalizeDocumentEntity("Document_СчетНаОплатуПокупателю")).toBe(
      "Document_СчетНаОплатуПокупателю",
    );
    // Подчёркивание внутри имени — не префикс класса.
    expect(normalizeDocumentEntity("КУФИБ_Акт")).toBe("Document_КУФИБ_Акт");
  });

  it("документ: префикс другого класса — ошибка, а не Document_Catalog_…", () => {
    expect(() => normalizeDocumentEntity("Catalog_Контрагенты")).toThrow(/Ожидается документ/);
    expect(() => normalizeDocumentEntity("Справочник.Контрагенты")).toThrow(/Ожидается документ/);
  });

  it("любой класс: синтаксис 1С переводится, префиксы распознаются", () => {
    expect(normalizeEntityName("Справочник.Контрагенты")).toBe("Catalog_Контрагенты");
    expect(normalizeEntityName("РегистрНакопления.НДСКВозмещению")).toBe(
      "AccumulationRegister_НДСКВозмещению",
    );
    expect(hasClassPrefix("InformationRegister_КурсыВалют")).toBe(true);
    expect(hasClassPrefix("СчетНаОплатуПокупателю")).toBe(false);
  });

  it("любой класс без префикса: подбирается по опубликованным; оба варианта — ошибка с вариантами", async () => {
    const { conn } = connection(["Catalog_Контрагенты", "Document_Акт", "Catalog_Акт"]);
    expect(await resolveEntityName(conn as never, "Контрагенты")).toBe("Catalog_Контрагенты");
    expect(await resolveEntityName(conn as never, "Нет")).toBe("Нет");
    await expect(resolveEntityName(conn as never, "Акт")).rejects.toThrow(/Document_Акт или Catalog_Акт/);
  });
});

describe("инструменты принимают тип без префикса", () => {
  it("get_document: «СчетНаОплатуПокупателю» → запрос к Document_СчетНаОплатуПокупателю", async () => {
    const { tools, getEntity } = connection(["Document_СчетНаОплатуПокупателю"]);
    const res = await tools["read.document.get_document"]!.handler(
      { entitySet: "СчетНаОплатуПокупателю", ref: REF },
      {},
    );
    expect(res.isError).toBeFalsy();
    expect(getEntity.mock.calls[0]![0]).toMatch(/^Document_СчетНаОплатуПокупателю\(guid'/);
  });

  it("search_documents и get_document_movements: тоже; Catalog_ в параметре-документе — понятная ошибка", async () => {
    const { tools, getCollection } = connection([
      "Document_РеализацияТоваровУслуг",
      "AccumulationRegister_Продажи_RecordType",
    ]);
    const s = await tools["read.document.search_documents"]!.handler(
      { entitySet: "Документ.РеализацияТоваровУслуг", limit: 5, postedOnly: false },
      {},
    );
    expect(s.isError).toBeFalsy();
    expect(String(getCollection.mock.calls[0]![0])).toMatch(/^Document_РеализацияТоваровУслуг\?/);

    const movTool = tools["read.document.get_document_movements"]!;
    expect(
      movTool.inputSchema.safeParse({ documentEntity: "РеализацияТоваровУслуг", documentRef: REF }).success,
    ).toBe(true);
    const m = await movTool.handler(
      { documentEntity: "РеализацияТоваровУслуг", documentRef: REF, limit: 5 },
      {},
    );
    expect(m.isError).toBeFalsy();
    expect(decodeURIComponent(String(getCollection.mock.calls.at(-1)![0]))).toContain(
      "Document_РеализацияТоваровУслуг",
    );

    const bad = await tools["read.document.get_document"]!.handler(
      { entitySet: "Catalog_Контрагенты", ref: REF },
      {},
    );
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/Ожидается документ/);
  });

  it("describe_entity: «Контрагенты» → Catalog_Контрагенты", async () => {
    const { tools } = connection(["Catalog_Контрагенты"]);
    const res = await tools["read.schema.describe_entity"]!.handler({ entitySet: "Контрагенты" }, {});
    expect(res.structuredContent).toMatchObject({ entitySet: "Catalog_Контрагенты" });
  });
});
