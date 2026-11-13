import { readableDocument } from "./readable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { ok, guard, withTruncationNote, databaseField, organizationField } from "./_shared.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, contains, odataGuid, buildQuery } from "../odata/query.js";
import { sameDocNumber } from "./print.js";
import { CATALOGS, DOC_FIELDS, resolveEntity } from "../config/mapping.js";
import { resolveNames } from "../odata/accounting.js";
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
        maxAmount: z.number().optional().describe("Максимальная сумма документа"),
        purposeContains: z
          .string()
          .max(200)
          .optional()
          .describe("Подстрока назначения платежа (НазначениеПлатежа) — у платёжных документов"),
        commentContains: z.string().max(200).optional().describe("Подстрока комментария документа"),
        operationKind: z
          .string()
          .max(100)
          .optional()
          .describe(
            "Вид операции (ВидОперации) точно, напр. «ОплатаПокупателя», «ПрочиеРасчетыСКонтрагентами»",
          ),
        fields: z
          .array(z.string().max(100))
          .max(20)
          .optional()
          .describe(
            'Доп. поля шапки в каждой строке (rows[].fields), напр. ["Контрагент_Key","НазначениеПлатежа",' +
              '"ВидОперации","Комментарий","ДоговорКонтрагента_Key"]; у Контрагент_Key — ещё counterparty (название)',
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .max(100000)
          .default(0)
          .describe("Сколько строк пропустить (постранично: nextOffset)"),
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
      maxAmount,
      purposeContains,
      commentContains,
      operationKind,
      fields,
      offset = 0,
      limit = 50,
    }) =>
      guard("read.document.search_documents", async () => {
        const conn = ctx.db(database);
        ensurePublished(await conn.available(), entitySet);
        const orgKey = organization ? (await resolveOrganization(conn, organization)).ref : undefined;
        // поля шапки этого вида: отборы и доп. поля — только по существующим (иначе 1С ответит 400/500)
        const wantsFields = !!(purposeContains || commentContains || operationKind || fields?.length);
        const props = wantsFields
          ? new Set(((await conn.getMetadata()).entities.get(entitySet)?.properties ?? []).map((p) => p.name))
          : new Set<string>();
        const notes: string[] = [];
        const fieldFilter = (field: string, value: string | undefined, how: "contains" | "eq") => {
          if (!value?.trim()) return undefined;
          if (!props.has(field)) {
            notes.push(`В этом виде документа нет поля ${field} — отбор по нему не применён.`);
            return undefined;
          }
          return how === "contains"
            ? contains(field, value.trim())
            : cmp(field, "eq", `'${value.trim().replace(/'/g, "''")}'`);
        };
        const extraFields = (fields ?? []).filter((f) => {
          if (props.has(f)) return true;
          notes.push(`Поля ${f} нет в ${entitySet} — пропущено.`);
          return false;
        });

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
          typeof maxAmount === "number" ? cmp(DOC_FIELDS.amount, "le", String(maxAmount)) : undefined,
          fieldFilter("НазначениеПлатежа", purposeContains, "contains"),
          fieldFilter("Комментарий", commentContains, "contains"),
        );
        // Вид операции — на коннекторе, как в get_payments_breakdown: серверный eq по перечислению в 1С ненадёжен
        let opWanted: string | undefined;
        if (operationKind?.trim()) {
          if (props.has("ВидОперации")) opWanted = operationKind.trim();
          else notes.push("В этом виде документа нет поля ВидОперации — отбор по нему не применён.");
        }

        // При клиентской фильтрации тянем больше строк (до maxRows), затем режем до limit.
        const clientFiltered = cpClientRef || numberWanted || opWanted;
        const fetchMax = clientFiltered ? conn.behavior.maxRows : limit + 1; // +1 — узнать, есть ли следующая страница
        const { rows, truncated } = await fetchAll(
          conn.client,
          entitySet,
          {
            filter: filter || undefined,
            orderby: `${DOC_FIELDS.date} desc`,
            ...(clientFiltered ? {} : { skip: offset }),
          },
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
        const byNumber =
          numberWanted != null && numberWanted !== ""
            ? byCp.filter((r) => sameDocNumber(String(r[DOC_FIELDS.number] ?? ""), numberWanted))
            : byCp;
        const matched = opWanted
          ? byNumber.filter((r) => String(r["ВидОперации"] ?? "") === opWanted)
          : byNumber;
        const start = clientFiltered ? offset : 0; // без клиентского отбора offset уже применён в $skip
        const page = matched.slice(start, start + limit);
        const items: Array<DocumentSummary & { fields?: Record<string, unknown>; counterparty?: string }> =
          page.map((r) => {
            const base = toSummary(r, entitySet);
            return extraFields.length
              ? { ...base, fields: Object.fromEntries(extraFields.map((f) => [f, r[f] ?? null])) }
              : base;
          });
        if (extraFields.includes(DOC_FIELDS.counterparty)) {
          // название контрагента рядом со ссылкой — сценариям и модели не нужно открывать каждый документ
          const cpSet = resolveEntity(CATALOGS.counterparties, await conn.available());
          const names = cpSet
            ? await resolveNames(
                conn,
                cpSet,
                items.map((i) => String(i.fields?.[DOC_FIELDS.counterparty] ?? "")),
              )
            : new Map<string, string>();
          for (const i of items) {
            const key = String(i.fields?.[DOC_FIELDS.counterparty] ?? "");
            const name = names.get(key) ?? names.get(key.toLowerCase());
            if (name) i.counterparty = name;
          }
        }
        const hasMore = truncated || matched.length > start + limit;
        const result = withTruncationNote(items, hasMore, limit);
        return ok({
          ...result,
          ...(hasMore ? { nextOffset: offset + items.length } : {}),
          ...(cpNote ? { counterpartyFilter: cpNote } : {}),
          ...(notes.length ? { filterNotes: notes } : {}),
        });
      }),
  );

  server.registerTool(
    "read.document.get_document",
    {
      title: "Документ целиком",
      description:
        "Возвращает документ по типу и Ref_Key со всеми полями, включая табличные части. " +
        "Ref_Key берётся из search_documents или истории взаиморасчётов. Текст ответа — читаемый вид в TOON: понятные " +
        "имена полей (counterparty, contract, services[].nomenclature …), у ссылок — {guid, name}, без служебных полей; " +
        "structuredContent — документ 1С как есть. raw=true — и текст как есть (реквизиты 1С).",
      inputSchema: {
        database: databaseField,
        entitySet: z
          .string()
          .describe(
            "Имя документа, напр. Document_РеализацияТоваровУслуг (префикс Document_ можно опустить)",
          ),
        ref: z.string().describe("Ref_Key документа (GUID)"),
        raw: z
          .boolean()
          .optional()
          .describe("true — текст как в 1С (реквизиты, guid без названий), без читаемого вида"),
      },
      outputSchema: odataEntitySchema,
    },
    ({ database, entitySet, ref, raw }) =>
      guard("read.document.get_document", async () => {
        const conn = ctx.db(database);
        ensurePublished(await conn.available(), entitySet);
        const path = `${entitySet}(guid'${ref.replace(/[{}']/g, "")}')${buildQuery({})}`;
        const entity = omitLargeBinary(await conn.client.getEntity(path), entitySet);
        if (raw) return ok(entity);
        // читаемый вид для модели и интеграций; structuredContent — как в 1С (его читают сценарии и формы)
        const readable = await readableDocument(conn, entitySet, entity);
        return { content: [{ type: "text", text: readable.text }], structuredContent: entity };
      }),
  );
}

/** Порог, после которого двоичное поле (…_Base64Data) не отдаётся в get_document: клиент MCP всё равно обрежет ответ. */
export const BINARY_INLINE_LIMIT = 64 * 1024;

/**
 * Двоичные поля больше BINARY_INLINE_LIMIT заменяются пометкой с размером и подсказкой, чем их читать
 * (ФНО — read.reports.regulated_report, файлы — read.files.get_attachment). Остальные поля — как есть.
 */
export function omitLargeBinary<T extends Record<string, unknown>>(entity: T, entitySet: string): T {
  const out: Record<string, unknown> = { ...entity };
  for (const [k, v] of Object.entries(entity)) {
    if (!k.endsWith("_Base64Data") || typeof v !== "string" || v.length <= BINARY_INLINE_LIMIT) continue;
    const bytes = Math.floor((v.replace(/\s/g, "").length * 3) / 4);
    const hint = /РегламентированныйОтчет$/.test(entitySet)
      ? "показатели отчёта — read.reports.regulated_report"
      : /ПрисоединенныеФайлы$/.test(entitySet)
        ? "содержимое файла — read.files.get_attachment"
        : "поле слишком большое для ответа инструмента";
    out[k] = `<двоичные данные ~${bytes} байт не показаны: ${hint}>`;
  }
  return out as T;
}
