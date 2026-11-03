import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { CATALOGS } from "../config/mapping.js";
import { InputError } from "../errors.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { and, or, cmp, odataString } from "../odata/query.js";
import { createResultSchema } from "../schemas/output.js";
import { databaseField, guard } from "./_shared.js";
import { confirmField, createOrPreview } from "./write.js";

/** Банк — отдельный справочник, без владельца и без автоматического создания банковского счёта. */
export function registerBankTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.catalog.create_bank",
    {
      title: "Создать банк в справочнике",
      description:
        "Создаёт банк в справочнике «Банки» по проверенным наименованию и БИК. " +
        "Используйте, если create_bank_account не нашёл банк. Реквизиты передаёт пользователь или " +
        "проверенный источник — инструмент не угадывает их и не проверяет банк во внешнем реестре. " +
        "В базе с реквизитом БИК заполняет его, не подменяя порядковый Code; иначе БИК записывается в Code. " +
        "Существующий БИК, включая помеченный на удаление банк, блокирует создание дубля. " +
        "Предпросмотр по умолчанию; после согласия повторите те же аргументы с confirm=true и operationId. " +
        "После создания используйте write.counterparty.create_bank_account для счёта владельца.",
      inputSchema: {
        database: databaseField,
        name: z.string().trim().min(1).max(150).describe("Проверенное наименование банка"),
        bik: z
          .string()
          .trim()
          .toUpperCase()
          .regex(
            /^(?:[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?|[0-9]{9})$/,
            "БИК: 8 или 11 латинских символов SWIFT либо 9 цифр",
          )
          .describe("Проверенный БИК банка (например IRTYKZKA); пробелы по краям и регистр нормализуются"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, name, bik, confirm }) =>
      guard("write.catalog.create_bank", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, CATALOGS.banks, "Справочник «Банки»");
        const metadata = (await conn.getMetadata()).entities.get(set);
        const fields = new Set(metadata?.properties.map((p) => p.name));
        const bikField = fields.has("БИК") ? "БИК" : fields.has("Code") ? "Code" : undefined;
        if (!bikField || !fields.has("Description"))
          throw new InputError(
            "В метаданных справочника «Банки» нет наименования или поля БИК/Code — создание недоступно.",
          );
        // Проверяем обе схемы хранения, в том числе удалённые записи; не снимаем пометку автоматически.
        const keys = [bikField, ...(bikField !== "Code" && fields.has("Code") ? ["Code"] : [])];
        const matches = await fetchAll(
          conn.client,
          set,
          {
            filter: and(
              or(...keys.map((key) => cmp(key, "eq", odataString(bik)))),
              ...(fields.has("IsFolder") ? [cmp("IsFolder", "eq", "false")] : []),
            ),
            select: ["Ref_Key", "Description", ...(fields.has("DeletionMark") ? ["DeletionMark"] : [])],
          },
          3,
          3,
        );
        if (matches.rows.length) {
          const existing = matches.rows
            .map(
              (r) =>
                `${r["Description"]} (${r["Ref_Key"]})` +
                (r["DeletionMark"] === true ? " — помечен на удаление" : ""),
            )
            .join("; ");
          throw new InputError(
            `Банк с БИК ${bik} уже существует: ${existing}. Новый банк не создан. Проверьте существующие записи в 1С.`,
          );
        }
        return createOrPreview(
          conn,
          set,
          {
            Description: name,
            [bikField]: bik,
            ...(fields.has("IsFolder") ? { IsFolder: false } : {}),
          },
          confirm,
        );
      }),
  );
}
