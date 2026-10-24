import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { catalogFields } from "../odata/catalog-fields.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { ensurePublished } from "../odata/publication.js";
import { fuzzyCandidates } from "../odata/fuzzy.js";
import { OWNER_CATALOGS, ownerFieldOf, ownerFilter, sameOwner, type OwnerFilter } from "../odata/owner.js";
import { and, buildQuery, cmp, contains, or, odataString } from "../odata/query.js";
import { databaseField, guard, ok } from "./_shared.js";

/**
 * Классы объектов, которые читает read.catalog.list_catalog: справочники, планы видов характеристик (субконто),
 * планы видов расчёта (виды начислений и удержаний зарплаты — ВидРасчета_Key в документах зарплаты) и планы
 * счетов (счета учёта — СчетЗатратНДСНУ_Key заявления о ввозе ведёт на налоговый план, который get_chart_of_accounts
 * не читает; у плана может не быть IsFolder — catalogFields его тогда пропускает).
 */
export const CATALOG_CLASSES = [
  "Catalog_",
  "ChartOfCharacteristicTypes_",
  "ChartOfCalculationTypes_",
  "ChartOfAccounts_",
] as const;

/** Сообщение о 401/403 при чтении справочника: чинится правами пользователя OData, а не запросом. */
export const noAccessMessage = (set: string, status?: number): string =>
  `Нет прав OData на справочник ${set}${status ? ` (HTTP ${status})` : ""}: пользователь, под которым подключён ` +
  `MCP, не может его читать. Дайте этому пользователю право на чтение объекта и включите его в «Состав OData» ` +
  `(Настройка стандартного интерфейса OData); перебор запросов не поможет.`;

/**
 * Варианты записи кода для точного поиска: как ввели, без ведущих нулей и дополненный нулями до длины кодов
 * справочника (в 1С коды часто хранятся с нулями: «104» → «000000104»). length — длина кода по образцу из базы.
 */
export function codeFilterValues(raw: string, length?: number): string[] {
  const t = raw.trim();
  const out = new Set<string>([t]);
  if (/^\d+$/.test(t)) {
    const bare = t.replace(/^0+/, "") || "0";
    out.add(bare);
    if (length && bare.length <= length) out.add(bare.padStart(length, "0"));
  }
  return [...out];
}

export function registerCatalogRead(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.catalog.list_catalog",
    {
      title: "Элементы любого справочника, плана видов характеристик, плана видов расчёта или плана счетов",
      description:
        "Читает строки любого справочника (Catalog_*) или плана видов характеристик (ChartOfCharacteristicTypes_*, " +
        "виды субконто), плана видов расчёта (ChartOfCalculationTypes_*: виды начислений и удержаний зарплаты — " +
        "ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций, ChartOfCalculationTypes_УдержанияОрганизаций; " +
        "Ref_Key идёт в ВидРасчета_Key документов зарплаты) или плана счетов (ChartOfAccounts_*, напр. налоговый — " +
        "счета учёта; у плана может не быть признака группы IsFolder): Ref_Key, наименование, код, признак группы " +
        "и пометки удаления. entitySet — техническое имя " +
        "('Catalog_СтатьиЗатрат'), без префикса или в синтаксисе 1С ('Справочник.СтатьиЗатрат'). query — поиск по " +
        "части наименования (без учёта регистра); точного вхождения нет — похожие по написанию с оценкой score " +
        "(ё/е, кавычки, ТОО/LLP, латиница↔кириллица: «Schneider» найдёт «Шнейдер Электрик ТОО»); если query состоит из цифр — ещё и по коду (точно, а также без " +
        "ведущих нулей и с нулями до длины кодов справочника: «104» найдёт «000000104»); code — только по коду; " +
        "owner — Ref_Key владельца (договоры — контрагент, банковские счета — организация или контрагент, контактные лица — " +
        "объект-владелец; составной тип владельца Owner/Владелец + _Type MCP отбирает сам — не передавайте Владелец_Key в select); " +
        "пустой query — список. По умолчанию группы и помеченные на " +
        "удаление скрыты (includeFolders / includeDeleted). Для следующих страниц передавайте nextOffset. " +
        "select — дополнительные поля (имена из read.schema.describe_entity), напр. ВидРасходовНУ_Key. " +
        "Ref_Key статьи затрат, подразделения и т.п. нужен для create_services_receipt и create_document. " +
        "Если у пользователя OData нет прав на справочник, инструмент так и скажет.",
      inputSchema: {
        database: databaseField,
        entitySet: z
          .string()
          .describe(
            "Справочник, план видов характеристик или план видов расчёта: Catalog_СтатьиЗатрат, " +
              "ChartOfCharacteristicTypes_ВидыСубконтоТиповые, ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций " +
              "(префикс можно опустить, если имя однозначно)",
          ),
        query: z
          .string()
          .max(200)
          .default("")
          .describe("Часть наименования; только цифры — ещё и поиск по коду; пусто — без отбора"),
        code: z
          .string()
          .max(50)
          .optional()
          .describe("Код элемента: точное совпадение (с учётом нулей в начале); отбор только по коду"),
        owner: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key владельца — GUID")
          .optional()
          .describe(
            "Ref_Key владельца: договоры контрагента — контрагент (Owner_Key), банковские счета — организация, " +
              "контактные лица — объект-владелец. Без владельца — по всему справочнику.",
          ),
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
                matchedBy: z.enum(["code", "fuzzy"]).optional(),
                score: z.number().optional(),
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
      code,
      owner,
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
            `«${entitySet}» — не справочник, не план видов характеристик, не план видов расчёта и не план счетов. Здесь читаются ` +
              "Catalog_*, ChartOfCharacteristicTypes_*, ChartOfCalculationTypes_* и ChartOfAccounts_*; документы — read.document.search_documents. Список имён — read.schema.list_entities.",
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
        const ownerLike = bad.filter((n) => /^(Owner|Владелец|ОбъектВладелец)(_Key|_Type)?$/.test(n));
        if (ownerLike.length && ownerFieldOf(props))
          throw new InputError(
            `${ownerLike.join(", ")}: отбор по владельцу задаётся параметром owner=<Ref_Key владельца>, а не через select ` +
              "(у справочника владелец может быть составного типа — MCP сам отберёт по Owner и типу владельца). " +
              "Банковские счета организации — owner = Ref_Key организации (read.system.list_organizations), " +
              "договоры и счета контрагента — owner = Ref_Key контрагента (read.counterparty.find_counterparty).",
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
        const codeParam = code?.trim() ?? "";
        const qText = query.trim();
        const digitsQuery = !codeParam && /^\d+$/.test(qText);
        let candidates: string[] = [];
        if (codeParam || digitsQuery) {
          if (!fields.code) {
            if (codeParam) throw new InputError(`У ${entitySet} нет поля Code — поиск по коду невозможен.`);
          } else {
            // Длина кодов справочника — по образцу: «104» → «000000104», если коды девятизначные.
            let length: number | undefined;
            try {
              const sample = await conn.client.getCollection(
                entitySet + buildQuery({ select: [fields.code], top: 1 }),
              );
              const first = sample.value?.[0]?.[fields.code];
              length = typeof first === "string" && first ? first.length : undefined;
            } catch (e) {
              if (e instanceof ODataError && e.kind === "auth")
                throw new InputError(noAccessMessage(entitySet, e.status));
            }
            candidates = codeFilterValues(codeParam || qText, length);
          }
        }
        const byCode = candidates.length
          ? or(...candidates.map((c) => cmp(fields.code, "eq", odataString(c))))
          : undefined;
        const codeFilter = codeParam ? byCode : undefined;
        const nameOrCode = (text: string) => or(contains(fields.name, text), byCode);
        // Владелец: Owner_Key — eq на сервере; составной Owner/Владелец (банковские счета, договоры части баз РК) —
        // cast(guid'…', 'Catalog_…') по справочнику, где найден Ref_Key владельца (src/odata/owner.ts).
        const ownerGuid = owner?.trim().replace(/[{}]/g, "");
        let ownerSel: OwnerFilter | undefined;
        if (ownerGuid) {
          ownerSel = await ownerFilter(conn, entitySet, ownerGuid);
          if (!ownerSel)
            throw new InputError(
              `У ${entitySet} нет владельца — отбор owner невозможен (есть владельцы у договоров, банковских счетов и контактных лиц).`,
            );
        }
        const ownerServer = ownerSel?.filter;
        const ownerClientField = ownerSel?.clientField;
        const filter = and(
          codeFilter,
          !codeParam && qText ? nameOrCode(qText) : undefined,
          ownerServer,
          !includeFolders && fields.isFolder ? cmp(fields.isFolder, "eq", "false") : undefined,
          !includeDeleted && deletion ? cmp(deletion, "eq", "false") : undefined,
        );
        // При клиентском фильтре тянем больше строк (до maxRows), затем режем до limit.
        const fetchMax = ownerClientField ? conn.behavior.maxRows : Math.min(limit, conn.behavior.maxRows);
        let page;
        try {
          page = await fetchAll(
            conn.client,
            entitySet,
            {
              select: [
                fields.ref,
                fields.name,
                fields.code,
                fields.isFolder,
                deletion,
                ...extra,
                // Без поля в $select 1С его не вернёт — сравнивать владельца было бы не с чем.
                ownerClientField ?? "",
              ].filter(Boolean),
              filter: filter || undefined,
              orderby: `${fields.name},${fields.ref}`,
              skip: offset,
            },
            conn.behavior.pageSize,
            fetchMax,
          );
        } catch (e) {
          if (e instanceof ODataError && e.kind === "auth")
            throw new InputError(noAccessMessage(entitySet, e.status));
          throw e;
        }
        const filtered = ownerClientField
          ? page.rows.filter((r) => sameOwner(r[ownerClientField], ownerGuid!))
          : page.rows;
        const sliced = filtered.slice(0, limit);
        const truncated = page.truncated || filtered.length > limit;
        const rowOf = (r: Record<string, unknown>, score?: number) => ({
          ref: String(r[fields.ref]),
          name: String(r[fields.name] ?? ""),
          ...(fields.code && r[fields.code] ? { code: String(r[fields.code]) } : {}),
          ...(fields.isFolder && typeof r[fields.isFolder] === "boolean"
            ? { isFolder: r[fields.isFolder] as boolean }
            : {}),
          ...(deletion && typeof r[deletion] === "boolean" ? { deletionMark: r[deletion] as boolean } : {}),
          ...(candidates.length && fields.code && candidates.includes(String(r[fields.code]))
            ? { matchedBy: "code" as const }
            : score !== undefined
              ? { matchedBy: "fuzzy" as const, score }
              : {}),
          ...(extra.length ? { fields: Object.fromEntries(extra.map((n) => [n, r[n]])) } : {}),
        });
        let rows = sliced.map((r) => rowOf(r));
        // Точного вхождения нет — похожие по написанию (ё/е, кавычки, ТОО/LLP, латиница ↔ кириллица, опечатки).
        let fuzzy = false;
        if (!rows.length && qText && !codeParam && !digitsQuery && !offset && !ownerClientField) {
          const hits = await fuzzyCandidates(conn, entitySet, qText, {
            nameFields: [fields.name, fields.fullName].filter(Boolean),
            select: [
              fields.ref,
              fields.name,
              fields.fullName,
              fields.code,
              fields.isFolder,
              deletion,
              ...extra,
            ].filter(Boolean),
            filter: and(
              ownerServer,
              !includeFolders && fields.isFolder ? cmp(fields.isFolder, "eq", "false") : undefined,
              !includeDeleted && deletion ? cmp(deletion, "eq", "false") : undefined,
            ),
            limit,
          }).catch(() => []);
          rows = hits.map((h) => rowOf(h.row, h.score));
          fuzzy = rows.length > 0;
        }
        const ownerText = ownerGuid
          ? `владелец ${ownerGuid}${ownerSel?.ownerType ? ` (${ownerSel.ownerType})` : ""}`
          : "";
        const emptyNote = (): string => {
          if (codeParam)
            return `Элемента с кодом «${codeParam}» нет в ${entitySet} (проверены варианты ${candidates.join(", ") || codeParam}). Попробуйте поиск по названию (query).`;
          if (qText)
            return `По запросу «${qText}» ничего не найдено в ${entitySet}${candidates.length ? ` (по названию и коду: ${candidates.join(", ")})` : ""}${ownerText ? ` (${ownerText})` : ""}, похожих по написанию тоже нет. Попробуйте часть слова, БИН/код или пустой query.`;
          // Только владелец: пустой список — это «у владельца нет элементов», а не «ничего не найдено по запросу».
          if (ownerSel?.field.kind === "composite" && !ownerSel.ownerType)
            return `Ref_Key ${ownerGuid} не найден ни в одном справочнике-владельце (${OWNER_CATALOGS.join(", ")}) — проверьте, что передан Ref_Key владельца (организации или контрагента), а не самого элемента ${entitySet}.`;
          return `У владельца ${ownerGuid}${ownerSel?.ownerType ? ` (${ownerSel.ownerType})` : ""} нет элементов в ${entitySet}${includeDeleted ? "" : " (помеченные на удаление скрыты — includeDeleted=true)"}. Проверьте, что передан Ref_Key нужного владельца: банковские счета организации — Ref_Key организации, договоры — Ref_Key контрагента.`;
        };
        return ok({
          database: conn.cfg.name,
          entitySet,
          rows,
          count: rows.length,
          truncated: fuzzy ? false : truncated,
          ...(!fuzzy && truncated ? { nextOffset: offset + rows.length } : {}),
          ...(fuzzy
            ? {
                note:
                  `Точного вхождения «${qText}» в названия ${entitySet} нет — показаны похожие (score 0..1: 1 — то же название без ` +
                  "учёта регистра, кавычек и ОПФ; ниже — близкое написание). Не берите кандидата молча: уточните у пользователя или выберите явно совпадающий по смыслу.",
              }
            : !rows.length && (qText || codeParam || ownerGuid)
              ? { note: emptyNote() }
              : {}),
        });
      }),
  );
}
