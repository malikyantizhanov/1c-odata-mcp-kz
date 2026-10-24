import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, fail, guard, withTruncationNote, databaseField, organizationField } from "./_shared.js";
import { catalogFields } from "../odata/catalog-fields.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { fuzzyCandidates, taxIdFilter } from "../odata/fuzzy.js";
import { and, cmp, contains, odataGuid, odataString, or, buildQuery } from "../odata/query.js";
import {
  CATALOGS,
  COUNTERPARTY_FIELDS as CF,
  DOC_FIELDS,
  DOCUMENTS,
  resolveEntity,
} from "../config/mapping.js";
import { resolveOrganization } from "../odata/orgs.js";
import { requireEntity } from "../odata/publication.js";
import type { Counterparty, DocumentSummary } from "../types/domain.js";
import type { ODataEntity } from "../types/odata.js";
import { truncatedList, counterpartySchema, counterpartyHistoryResultSchema } from "../schemas/output.js";

function toCounterparty(r: ODataEntity, fields: Record<keyof typeof CF, string> = CF): Counterparty {
  return {
    ref: String(r[fields.ref] ?? ""),
    name: String(r[fields.name] ?? ""),
    code: r[fields.code] ? String(r[fields.code]) : undefined,
    inn: r[fields.inn] ? String(r[fields.inn]) : undefined,
    kpp: r[fields.kpp] ? String(r[fields.kpp]) : undefined,
    fullName: r[fields.fullName] ? String(r[fields.fullName]) : undefined,
    isFolder: typeof r[fields.isFolder] === "boolean" ? (r[fields.isFolder] as boolean) : undefined,
  };
}

const counterpartySet = (conn: Connection): Promise<string> =>
  requireEntity(conn, CATALOGS.counterparties, "Справочник «Контрагенты»");

export function registerCounterpartyTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.counterparty.find_counterparty",
    {
      title: "Поиск контрагента",
      description:
        "Ищет контрагентов по части названия (наименование и полное наименование) или по БИН/ИИН/ИНН (целиком или " +
        "от 4 цифр). Нет точного вхождения — возвращает похожих с оценкой score (ё/е, кавычки, ТОО/ИП/АО/LLP, " +
        "латиница↔кириллица, опечатки: «Schneider»/«Шнайдер» найдут «Шнейдер Электрик ТОО») — подтвердите выбор у пользователя. " +
        "Ref_Key используйте в get_counterparty, истории взаиморасчётов и write-инструментах. " +
        "Пример: «найди контрагента Ромашка» или «контрагент с ИНН 7701234567».",
      inputSchema: {
        database: databaseField,
        query: z
          .string()
          .default("")
          .describe("Часть названия или ИНН/БИН/ИИН; пустая строка — список контрагентов"),
        limit: z.number().int().positive().max(100).default(20).describe("Сколько вернуть"),
      },
      outputSchema: truncatedList(counterpartySchema),
    },
    ({ database, query, limit = 20 }) =>
      guard("read.counterparty.find_counterparty", async () => {
        const conn = ctx.db(database);
        const set = await counterpartySet(conn);
        const fields = await catalogFields(conn, set);
        const q = query.trim();
        const digits = q.replace(/\s+/g, "");
        const isInn = /^\d{10,12}$/.test(digits);
        if (isInn && !fields.inn) throw new InputError("В справочнике не опубликовано поле ИНН/БИН/ИИН.");
        // Часть БИН/ИИН (от 4 цифр) — подстрокой по налоговому номеру; 10–12 цифр — точно.
        const byTaxId = fields.inn
          ? isInn
            ? cmp(fields.inn, "eq", odataString(digits))
            : taxIdFilter(fields.inn, digits)
          : undefined;
        const filter = !q
          ? undefined
          : byTaxId
            ? byTaxId
            : or(contains(fields.name, q), fields.fullName ? contains(fields.fullName, q) : undefined);
        const select = [fields.ref, fields.name, fields.code, fields.inn, fields.kpp, fields.isFolder].filter(
          Boolean,
        );

        const { rows, truncated } = await fetchAll(
          conn.client,
          set,
          { filter, select, orderby: fields.name },
          conn.behavior.pageSize,
          Math.min(limit, conn.behavior.maxRows),
        );

        const items = rows.map((row) => toCounterparty(row, fields)).filter((c) => !c.isFolder);
        if (items.length || !q || byTaxId) {
          const res = withTruncationNote(items, truncated, limit);
          return ok(
            !items.length && byTaxId
              ? {
                  ...res,
                  note: `Контрагента с БИН/ИИН ${isInn ? "" : "содержащим "}«${digits}» нет. Проверьте номер или ищите по названию; нет в базе — write.counterparty.create_counterparty.`,
                }
              : res,
          );
        }
        // Точного вхождения нет — похожие по написанию: ё/е, кавычки, ТОО/LLP, латиница ↔ кириллица, опечатки.
        const hits = await fuzzyCandidates(conn, set, q, {
          nameFields: [fields.name, fields.fullName].filter(Boolean),
          select: [...select, fields.fullName].filter(Boolean),
          limit,
        });
        return ok({
          rows: hits.map((h) => ({ ...toCounterparty(h.row, fields), matchedBy: "fuzzy", score: h.score })),
          count: hits.length,
          truncated: false,
          note: hits.length
            ? `Точного вхождения «${q}» нет — показаны похожие (score 0..1: 1 — то же название без учёта регистра, кавычек и ОПФ). ` +
              "Подтвердите контрагента у пользователя (лучше по БИН/ИИН), а не берите первого."
            : `Контрагент «${q}» не найден ни по вхождению, ни по похожему написанию. Попробуйте БИН/ИИН или часть названия; ` +
              "нет в базе — write.counterparty.create_counterparty.",
        });
      }),
  );

  server.registerTool(
    "read.counterparty.get_counterparty",
    {
      title: "Карточка контрагента",
      description:
        "Возвращает полную карточку контрагента по его Ref_Key: реквизиты (ИНН/КПП), " +
        "наименования, код. Ref_Key берётся из find_counterparty.",
      inputSchema: {
        database: databaseField,
        ref: z.string().describe("Ref_Key контрагента (GUID)"),
      },
      outputSchema: counterpartySchema,
    },
    ({ database, ref }) =>
      guard("read.counterparty.get_counterparty", async () => {
        const conn = ctx.db(database);
        const set = await counterpartySet(conn);
        const path = `${set}(guid'${ref.replace(/[{}']/g, "")}')${buildQuery({})}`;
        const entity = await conn.client.getEntity(path);
        return ok(toCounterparty(entity, await catalogFields(conn, set)));
      }),
  );

  const historyInput = {
    database: databaseField,
    organization: organizationField,
    ref: z.string().describe("Ref_Key контрагента"),
    from: z.string().optional().describe("Дата начала периода (YYYY-MM-DD)"),
    to: z.string().optional().describe("Дата конца периода (YYYY-MM-DD)"),
    limit: z.number().int().positive().max(500).default(100).describe("Сколько документов вернуть"),
  };

  async function history(
    conn: Connection,
    docKeys: readonly string[],
    ref: string,
    orgKey: string | undefined,
    from: string | undefined,
    to: string | undefined,
    limit: number,
  ): Promise<{ docs: DocumentSummary[]; truncated: boolean; usedSets: string[] }> {
    const available = await conn.available();
    const guid = odataGuid(ref);
    const docs: DocumentSummary[] = [];
    const usedSets: string[] = [];
    let truncated = false;

    for (const key of docKeys) {
      const set = resolveEntity([key], available);
      if (!set) continue;
      usedSets.push(set);
      const filter = and(
        cmp(DOC_FIELDS.counterparty, "eq", guid),
        orgKey ? cmp(DOC_FIELDS.organization, "eq", odataGuid(orgKey)) : undefined,
        from ? cmp(DOC_FIELDS.date, "ge", `datetime'${from}T00:00:00'`) : undefined,
        to ? cmp(DOC_FIELDS.date, "le", `datetime'${to}T23:59:59'`) : undefined,
      );
      const { rows, truncated: t } = await fetchAll(
        conn.client,
        set,
        { filter, orderby: `${DOC_FIELDS.date} desc` },
        conn.behavior.pageSize,
        limit,
      );
      truncated ||= t;
      for (const r of rows) {
        docs.push({
          ref: String(r[DOC_FIELDS.ref] ?? ""),
          type: set,
          entitySet: set,
          number: r[DOC_FIELDS.number] ? String(r[DOC_FIELDS.number]) : undefined,
          date: r[DOC_FIELDS.date] ? String(r[DOC_FIELDS.date]) : undefined,
          posted: typeof r[DOC_FIELDS.posted] === "boolean" ? (r[DOC_FIELDS.posted] as boolean) : undefined,
          amount: typeof r[DOC_FIELDS.amount] === "number" ? (r[DOC_FIELDS.amount] as number) : undefined,
        });
      }
    }
    docs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return { docs: docs.slice(0, limit), truncated, usedSets };
  }

  async function orgKeyOf(conn: Connection, organization?: string): Promise<string | undefined> {
    return organization ? (await resolveOrganization(conn, organization)).ref : undefined;
  }

  server.registerTool(
    "read.counterparty.get_customer_history",
    {
      title: "История по покупателю",
      description:
        "Документы реализации и счета по контрагенту-покупателю за период. " +
        "Показывает, что и на какие суммы продавали клиенту. Ref_Key — из find_counterparty.",
      inputSchema: historyInput,
      outputSchema: counterpartyHistoryResultSchema,
    },
    ({ database, organization, ref, from, to, limit = 100 }) =>
      guard("read.counterparty.get_customer_history", async () => {
        const conn = ctx.db(database);
        const orgKey = await orgKeyOf(conn, organization);
        const r = await history(
          conn,
          [...DOCUMENTS.sales, ...DOCUMENTS.customerInvoice],
          ref,
          orgKey,
          from,
          to,
          limit,
        );
        if (r.usedSets.length === 0) {
          return fail("Документы продаж не опубликованы в OData. Добавьте их в «Состав OData».");
        }
        return ok({
          counterparty: ref,
          period: { from, to },
          ...withTruncationNote(r.docs, r.truncated, limit),
        });
      }),
  );

  server.registerTool(
    "read.counterparty.get_supplier_history",
    {
      title: "История по поставщику",
      description:
        "Документы поступления по контрагенту-поставщику за период. " +
        "Показывает закупки у поставщика. Ref_Key — из find_counterparty.",
      inputSchema: historyInput,
      outputSchema: counterpartyHistoryResultSchema,
    },
    ({ database, organization, ref, from, to, limit = 100 }) =>
      guard("read.counterparty.get_supplier_history", async () => {
        const conn = ctx.db(database);
        const orgKey = await orgKeyOf(conn, organization);
        const r = await history(conn, [...DOCUMENTS.purchases], ref, orgKey, from, to, limit);
        if (r.usedSets.length === 0) {
          return fail("Документы поступлений не опубликованы в OData. Добавьте их в «Состав OData».");
        }
        return ok({
          counterparty: ref,
          period: { from, to },
          ...withTruncationNote(r.docs, r.truncated, limit),
        });
      }),
  );
}
