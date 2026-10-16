import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { catalogFields } from "../odata/catalog-fields.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { ensurePublished } from "../odata/publication.js";
import { and, cmp, contains } from "../odata/query.js";
import { databaseField, guard, ok } from "./_shared.js";

/** Классы объектов, которые читает read.catalog.list_catalog: справочники и планы видов характеристик (субконто). */
export const CATALOG_CLASSES = ["Catalog_", "ChartOfCharacteristicTypes_"] as const;

/** Сообщение о 401/403 при чтении справочника: чинится правами пользователя OData, а не запросом. */
export const noAccessMessage = (set: string, status?: number): string =>
  `Нет прав OData на справочник ${set}${status ? ` (HTTP ${status})` : ""}: пользователь, под которым подключён ` +
  `MCP, не может его читать. Дайте этому пользователю право на чтение объекта и включите его в «Состав OData» ` +
  `(Настройка стандартного интерфейса OData); перебор запросов не поможет.`;

export function registerCatalogRead(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.catalog.list_catalog",
    {
      title: "Элементы любого справочника или плана видов характеристик",
      description:
        "Читает строки любого справочника (Catalog_*) или плана видов характеристик (ChartOfCharacteristicTypes_*, " +
        "виды субконто): Ref_Key, наименование, код, признак группы и пометки удаления. entitySet — техническое имя " +
        "('Catalog_СтатьиЗатрат'), без префикса или в синтаксисе 1С ('Справочник.СтатьиЗатрат'). query — поиск по " +
        "части наименования (без учёта регистра); пустой query — список. По умолчанию группы и помеченные на " +
        "удаление скрыты (includeFolders / includeDeleted). Для следующих страниц передавайте nextOffset. " +
        "select — дополнительные поля (имена из read.schema.describe_entity), напр. ВидРасходовНУ_Key. " +
        "Ref_Key статьи затрат, подразделения и т.п. нужен для create_services_receipt и create_document. " +
        "Если у пользователя OData нет прав на справочник, инструмент так и скажет.",
      inputSchema: {
        database: databaseField,
        entitySet: z
          .string()
          .describe(
            "Справочник или план видов характеристик: Catalog_СтатьиЗатрат, ChartOfCharacteristicTypes_ВидыСубконтоТиповые " +
              "(префикс можно опустить, если имя однозначно)",
          ),
        query: z.string().max(200).default("").describe("Часть наименования; пусто — без отбора"),
        select: z
          .array(z.string().min(1).max(100))
          .max(20)
          .optional()
          .describe("Дополнительные поля (кроме Ref_Key, Description, Code, IsFolder, DeletionMark)"),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).max(1000000).default(0),
        includeFolders: z.boolean().default(false).describe("Показывать группы (IsFolder=true)"),
        includeDeleted: z.boolean().default(false).describe("Показывать помеченные на удаление"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          entitySet: z.string(),
          rows: z.array(
            z
              .object({
                ref: z.string(),
                name: z.string(),
                code: z.string().optional(),
                isFolder: z.boolean().optional(),
                deletionMark: z.boolean().optional(),
                fields: z.record(z.string(), z.unknown()).optional(),
              })
              .passthrough(),
          ),
          count: z.number(),
          truncated: z.boolean(),
          nextOffset: z.number().optional(),
          note: z.string().optional(),
        })
        .passthrough(),
    },
    ({
      database,
      entitySet,
      query = "",
      select,
      limit = 50,
      offset = 0,
      includeFolders = false,
      includeDeleted = false,
    }) =>
      guard("read.catalog.list_catalog", async () => {
        const conn = ctx.db(database);
        if (!CATALOG_CLASSES.some((p) => entitySet.startsWith(p)))
          throw new InputError(
            `«${entitySet}» — не справочник и не план видов характеристик. Здесь читаются Catalog_* и ` +
              "ChartOfCharacteristicTypes_*; документы — read.document.search_documents. Список имён — read.schema.list_entities.",
          );
        ensurePublished(await conn.available(), entitySet);
        const fields = await catalogFields(conn, entitySet);
        const props = (await conn.getMetadata()).entities.get(entitySet)?.properties ?? [];
        const has = (n: string) => props.some((p) => p.name === n);
        const extra = [...new Set(select ?? [])].filter(
          (n) => ![fields.ref, fields.name, fields.code, fields.isFolder, "DeletionMark"].includes(n),
        );
        const bad = extra.filter(
          (n) => !has(n) || (props.find((p) => p.name === n)?.type ?? "").startsWith("Collection("),
        );
        if (bad.length)
          throw new InputError(
            `В ${entitySet} нет простых полей: ${bad.join(", ")}. Есть: ` +
              props
                .filter((p) => !(p.type ?? "").startsWith("Collection("))
                .map((p) => p.name)
                .join(", ") +
              ".",
          );
        const deletion = has("DeletionMark") ? "DeletionMark" : "";
        const filter = and(
          query.trim() ? contains(fields.name, query.trim()) : undefined,
          !includeFolders && fields.isFolder ? cmp(fields.isFolder, "eq", "false") : undefined,
          !includeDeleted && deletion ? cmp(deletion, "eq", "false") : undefined,
        );
        let page;
        try {
          page = await fetchAll(
            conn.client,
            entitySet,
            {
              select: [fields.ref, fields.name, fields.code, fields.isFolder, deletion, ...extra].filter(
                Boolean,
              ),
              filter: filter || undefined,
              orderby: `${fields.name},${fields.ref}`,
              skip: offset,
            },
            conn.behavior.pageSize,
            Math.min(limit, conn.behavior.maxRows),
          );
        } catch (e) {
          if (e instanceof ODataError && e.kind === "auth")
            throw new InputError(noAccessMessage(entitySet, e.status));
          throw e;
        }
        const rows = page.rows.map((r) => ({
          ref: String(r[fields.ref]),
          name: String(r[fields.name] ?? ""),
          ...(fields.code && r[fields.code] ? { code: String(r[fields.code]) } : {}),
          ...(fields.isFolder && typeof r[fields.isFolder] === "boolean"
            ? { isFolder: r[fields.isFolder] as boolean }
            : {}),
          ...(deletion && typeof r[deletion] === "boolean" ? { deletionMark: r[deletion] as boolean } : {}),
          ...(extra.length ? { fields: Object.fromEntries(extra.map((n) => [n, r[n]])) } : {}),
        }));
        return ok({
          database: conn.cfg.name,
          entitySet,
          rows,
          count: rows.length,
          truncated: page.truncated,
          ...(page.truncated ? { nextOffset: offset + rows.length } : {}),
          ...(!rows.length && query.trim()
            ? {
                note: `По запросу «${query.trim()}» ничего не найдено в ${entitySet}. Попробуйте часть слова или пустой query.`,
              }
            : {}),
        });
      }),
  );
}
