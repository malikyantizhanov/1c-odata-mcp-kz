import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { ok, guard, withTruncationNote, databaseField, organizationField } from "./_shared.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, contains, odataGuid, buildQuery } from "../odata/query.js";
import { sameDocNumber } from "./print.js";
import { DOC_FIELDS } from "../config/mapping.js";
import { resolveOrganization } from "../odata/orgs.js";
import { ensurePublished } from "../odata/publication.js";
import type { DocumentSummary } from "../types/domain.js";
import type { ODataEntity } from "../types/odata.js";
import { searchDocumentsResultSchema, odataEntitySchema } from "../schemas/output.js";

function toSummary(r: ODataEntity, set: string): DocumentSummary {
  return {
    ref: String(r[DOC_FIELDS.ref] ?? ""),
    type: set,
    entitySet: set,
    number: r[DOC_FIELDS.number] ? String(r[DOC_FIELDS.number]) : undefined,
    date: r[DOC_FIELDS.date] ? String(r[DOC_FIELDS.date]) : undefined,
    posted: typeof r[DOC_FIELDS.posted] === "boolean" ? (r[DOC_FIELDS.posted] as boolean) : undefined,
    deletionMark:
      typeof r[DOC_FIELDS.deletionMark] === "boolean" ? (r[DOC_FIELDS.deletionMark] as boolean) : undefined,
    amount: typeof r[DOC_FIELDS.amount] === "number" ? (r[DOC_FIELDS.amount] as number) : undefined,
  };
}

export function registerDocumentTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.search_documents",
    {
      title: "Поиск документов",
      description:
        "Ищет документы заданного типа по периоду, номеру, контрагенту, организации, статусу проведения и сумме. " +
        "Тип документа — техническое имя из list_entities, напр. 'Document_РеализацияТоваровУслуг'. " +
        "Сначала уточните имя через list_entities (class=document), а поля — через describe_entity. " +
        "number — точное совпадение номера с учётом префиксов и ведущих нулей («3», «00000000003» или номер с префиксом — " +
        "как в 1С); query — подстрока номера (естественный для OData 1С substringof по полю Number).",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        entitySet: z
          .string()
          .describe(
            "Имя документа, напр. Document_РеализацияТоваровУслуг (префикс Document_ можно опустить)",
          ),
        from: z.string().optional().describe("Дата начала (YYYY-MM-DD)"),
        to: z.string().optional().describe("Дата конца (YYYY-MM-DD)"),
        number: z
          .string()
          .max(50)
          .optional()
          .describe("Точный номер документа как в 1С: «3», «00000000003» или с префиксом"),
        query: z.string().max(50).optional().describe("Подстрока номера документа"),
        counterpartyRef: z.string().optional().describe("Ref_Key контрагента для фильтра"),
        postedOnly: z.boolean().default(false).describe("Только проведённые документы"),
        minAmount: z.number().optional().describe("Минимальная сумма документа"),
        limit: z.number().int().positive().max(500).default(50).describe("Сколько документов вернуть"),
      },
      outputSchema: searchDocumentsResultSchema,
    },
    ({
      database,
      organization,
      entitySet,
      from,
      to,
      number,
      query,
      counterpartyRef,
      postedOnly,
      minAmount,
      limit = 50,
    }) =>
      guard("read.document.search_documents", async () => {
        const conn = ctx.db(database);
        ensurePublished(await conn.available(), entitySet);
        const orgKey = organization ? (await resolveOrganization(conn, organization)).ref : undefined;

        // Контрагент бывает типизированным (Контрагент_Key — фильтруем на сервере)
        // или полиморфным (Контрагент: Edm.String — в 1С серверный eq/substringof по
        // нему не работает, поэтому фильтруем на стороне коннектора).
        let cpServer: string | undefined;
        let cpClientRef: string | undefined;
        let cpNote: string | undefined;
        if (counterpartyRef) {
          const meta = await conn.getMetadata();
          const props = new Set((meta.entities.get(entitySet)?.properties ?? []).map((p) => p.name));
          if (props.has(DOC_FIELDS.counterparty)) {
            cpServer = cmp(DOC_FIELDS.counterparty, "eq", odataGuid(counterpartyRef));
          } else if (props.has("Контрагент")) {
            cpClientRef = counterpartyRef.replace(/[{}]/g, "").trim().toLowerCase();
            cpNote =
              "Контрагент в этом документе хранится полиморфно — фильтр применён на стороне коннектора.";
          } else {
            cpNote = "В этом типе документа нет поля контрагента — фильтр по контрагенту проигнорирован.";
          }
        }

        // Номер: query — подстрока (естественный для OData substringof по Number); number — точное совпадение
        // с учётом префиксов и ведущих нулей (как sameDocNumber): сервер даёт кандидатов, точный отбор — на коннекторе.
        const numberWanted = number?.trim();
        const queryText = query?.trim();
        // Точный номер: цифры без ведущих нулей («00000000003» → «3») — сервер даёт кандидатов по подстроке;
        // подстрока query — как ввели.
        const needle =
          numberWanted != null && numberWanted !== ""
            ? /^\d+$/.test(numberWanted)
              ? String(Number(numberWanted))
              : numberWanted
            : queryText;
        const numberServer = needle ? contains(DOC_FIELDS.number, needle) : undefined;
        const filter = and(
          from ? cmp(DOC_FIELDS.date, "ge", `datetime'${from}T00:00:00'`) : undefined,
          to ? cmp(DOC_FIELDS.date, "le", `datetime'${to}T23:59:59'`) : undefined,
          orgKey ? cmp(DOC_FIELDS.organization, "eq", odataGuid(orgKey)) : undefined,
          cpServer,
          numberServer,
          postedOnly ? cmp(DOC_FIELDS.posted, "eq", "true") : undefined,
          typeof minAmount === "number" ? cmp(DOC_FIELDS.amount, "ge", String(minAmount)) : undefined,
        );

        // При клиентской фильтрации тянем больше строк (до maxRows), затем режем до limit.
        const clientFiltered = cpClientRef || numberWanted;
        const fetchMax = clientFiltered ? conn.behavior.maxRows : limit;
        const { rows, truncated } = await fetchAll(
          conn.client,
          entitySet,
          { filter: filter || undefined, orderby: `${DOC_FIELDS.date} desc` },
          conn.behavior.pageSize,
          fetchMax,
        );
        const byCp = cpClientRef
          ? rows.filter(
              (r) =>
                String(r["Контрагент"] ?? "")
                  .replace(/[{}]/g, "")
                  .trim()
                  .toLowerCase() === cpClientRef,
            )
          : rows;
        const matched =
          numberWanted != null && numberWanted !== ""
            ? byCp.filter((r) => sameDocNumber(String(r[DOC_FIELDS.number] ?? ""), numberWanted))
            : byCp;
        const items = matched.slice(0, limit).map((r) => toSummary(r, entitySet));
        const wasTruncated = truncated || matched.length > limit;
        const result = withTruncationNote(items, wasTruncated, limit);
        return ok(cpNote ? { ...result, counterpartyFilter: cpNote } : result);
      }),
  );

  server.registerTool(
    "read.document.get_document",
    {
      title: "Документ целиком",
      description:
        "Возвращает документ по типу и Ref_Key со всеми полями, включая табличные части. " +
        "Ref_Key берётся из search_documents или истории взаиморасчётов.",
      inputSchema: {
        database: databaseField,
        entitySet: z
          .string()
          .describe(
            "Имя документа, напр. Document_РеализацияТоваровУслуг (префикс Document_ можно опустить)",
          ),
        ref: z.string().describe("Ref_Key документа (GUID)"),
      },
      outputSchema: odataEntitySchema,
    },
    ({ database, entitySet, ref }) =>
      guard("read.document.get_document", async () => {
        const conn = ctx.db(database);
        ensurePublished(await conn.available(), entitySet);
        const path = `${entitySet}(guid'${ref.replace(/[{}']/g, "")}')${buildQuery({})}`;
        const entity = await conn.client.getEntity(path);
        return ok(entity);
      }),
  );
}
