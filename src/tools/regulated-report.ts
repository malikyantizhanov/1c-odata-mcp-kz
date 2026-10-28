import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { ok, guard, databaseField } from "./_shared.js";
import { ensurePublished } from "../odata/publication.js";
import { buildQuery, contains, odataGuid } from "../odata/query.js";
import { looksLikeHtml } from "../odata/errors.js";
import { InputError } from "../errors.js";
import { sameDocNumber } from "./print.js";
import { monthlyBreakdown, parseRegulatedReportXml, reportXml } from "../odata/regulated-report.js";

/**
 * Регламентированные отчёты (ФНО 200.00, 100.00, 300.00, фин. отчётность…) — документ РегламентированныйОтчет.
 * Только чтение: данные отчёта (ХранилищеЗначения) скачиваются потоком `ДанныеОтчета/$value` целиком
 * и разбираются на сервере MCP; клиенту уходят показатели по кодам строк, а не 5–8 МБ base64.
 */
export const REPORT_SET = "Document_РегламентированныйОтчет";
const HEAD_FIELDS = [
  "Ref_Key",
  "Number",
  "Date",
  "Posted",
  "DeletionMark",
  "ВыбраннаяФорма",
  "НаименованиеОтчета",
  "ИсточникОтчета",
  "ДатаНачала",
  "ДатаОкончания",
  "Периодичность",
  "ЕдиницаИзмерения",
  "Организация_Key",
  "ДанныеОтчета_Type",
];
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const day = (v: unknown) => String(v ?? "").slice(0, 10);

function summary(r: Record<string, unknown>) {
  return {
    ref: String(r["Ref_Key"] ?? ""),
    number: String(r["Number"] ?? ""),
    date: day(r["Date"]),
    posted: r["Posted"] === true,
    deletionMark: r["DeletionMark"] === true,
    name: String(r["НаименованиеОтчета"] ?? ""),
    form: String(r["ВыбраннаяФорма"] ?? ""),
    source: String(r["ИсточникОтчета"] ?? ""),
    periodStart: day(r["ДатаНачала"]),
    periodEnd: day(r["ДатаОкончания"]),
    periodicity: String(r["Периодичность"] ?? ""),
    organizationRef: String(r["Организация_Key"] ?? ""),
  };
}

export function registerRegulatedReportTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.reports.regulated_report",
    {
      title: "Регламентированный отчёт (ФНО): показатели по кодам строк",
      description:
        "Читает документ «Регламентированный отчет» (ФНО 200.00, 100.00, 300.00, 910.00, фин. отчётность). " +
        "Без ref и number — список отчётов (новые сверху; nameContains — фильтр по названию, напр. «200.00»). " +
        "С ref или number — скачивает данные отчёта (ХранилищеЗначения) целиком, разбирает и возвращает показатели " +
        "по кодам строк (200.01.001 …) по разделам-приложениям; для квартальных форм — разбивка по месяцам " +
        "(колонки 1–3) и итог за квартал (колонка 4) с проверкой суммы. section — оставить один раздел, напр. «200.05». " +
        "Разделы, не заполненные в 1С, перечислены в emptySections. Только чтение. " +
        "Не используйте read.document.get_document для ФНО: данные там — 5–8 МБ base64, клиент их обрежет.",
      inputSchema: {
        database: databaseField,
        ref: GUID.optional().describe("Ref_Key отчёта"),
        number: z.string().optional().describe("Номер отчёта, напр. «15» или «00000000015»"),
        nameContains: z.string().optional().describe("Фильтр по названию отчёта, напр. «200.00»"),
        section: z
          .string()
          .regex(/^\d{3}\.\d{2}$/, "Раздел в виде 200.05")
          .optional()
          .describe("Вернуть только этот раздел (приложение), напр. «200.01»"),
        limit: z.number().int().min(1).max(200).default(30).describe("Сколько отчётов в списке"),
      },
      outputSchema: z.object({}).passthrough(),
    },
    ({ database, ref, number, nameContains, section, limit }) =>
      guard("read.reports.regulated_report", async (): Promise<CallToolResult> => {
        const conn = ctx.db(database);
        ensurePublished(await conn.available(), REPORT_SET, "Документ «Регламентированный отчет»");
        const nameFilter = nameContains ? contains("НаименованиеОтчета", nameContains) : undefined;

        let head: Record<string, unknown> | undefined;
        if (ref) {
          head = await conn.client.getEntity(
            `${REPORT_SET}(${odataGuid(ref)})${buildQuery({ select: HEAD_FIELDS })}`,
          );
        } else {
          const list = await conn.client.getCollection(
            `${REPORT_SET}${buildQuery({ select: HEAD_FIELDS, filter: nameFilter, orderby: "Date desc", top: number ? 500 : limit })}`,
          );
          const rows = list.value ?? [];
          if (!number) {
            return ok({ database: conn.cfg.name, count: rows.length, reports: rows.map(summary) });
          }
          const found = rows.filter((r) => sameDocNumber(String(r["Number"] ?? ""), number));
          if (found.length === 0) throw new InputError(`Регламентированный отчёт № ${number} не найден.`);
          if (found.length > 1) {
            return ok({
              database: conn.cfg.name,
              note: `Отчётов с номером ${number} несколько — укажите ref.`,
              reports: found.map(summary),
            });
          }
          head = found[0]!;
        }
        const info = summary(head);
        const dataType = String(head["ДанныеОтчета_Type"] ?? "");
        const key = odataGuid(info.ref);

        // Поток целиком: …/ДанныеОтчета/$value — те же байты, что в ДанныеОтчета_Base64Data, но без base64 в JSON.
        let bytes: Buffer;
        let via = "stream";
        try {
          const body = await conn.client.getText(`${REPORT_SET}(${key})/ДанныеОтчета/$value`);
          // Не XML (сжатое/двоичное хранилище) — текстом байты не передать: берём base64.
          if (looksLikeHtml(body) || !/^\s*</.test(body.replace(/^\uFEFF/, ""))) throw new Error("not xml");
          bytes = Buffer.from(body, "utf8");
        } catch {
          via = "base64";
          const e = await conn.client.getEntity(
            `${REPORT_SET}(${key})${buildQuery({ select: ["ДанныеОтчета_Base64Data"] })}`,
          );
          bytes = Buffer.from(String(e["ДанныеОтчета_Base64Data"] ?? ""), "base64");
        }
        if (bytes.length === 0) {
          return ok({ database: conn.cfg.name, ...info, dataType, note: "У отчёта нет сохранённых данных." });
        }
        const parsed = parseRegulatedReportXml(reportXml(bytes));
        const sections = parsed.sections
          .filter((s) => !section || s.section === section)
          .map((s) => ({
            ...s,
            lines: s.lines.map((l) => {
              const m = monthlyBreakdown(l, info.periodStart, info.periodicity);
              return m ? { ...l, ...m } : l;
            }),
          }));
        const notes: string[] = [];
        if (section && sections.length === 0) {
          notes.push(
            parsed.emptySections.includes(section)
              ? `Раздел ${section} в сохранённых данных отчёта пустой: в 1С он не заполнен (или не сформирован) — показателей нет.`
              : `Раздела ${section} в этом отчёте нет.`,
          );
        }
        if (parsed.emptySections.length)
          notes.push(
            `Пустые разделы (в 1С не заполнены): ${parsed.emptySections.join(", ")}. Цифр по ним в документе нет.`,
          );
        notes.push(
          "Значения — как сохранены в документе 1С (последнее «Записать» отчёта); пересчёт «Заполнить» в 1С может их изменить.",
        );
        return ok({
          database: conn.cfg.name,
          ...info,
          dataType,
          dataBytes: bytes.length,
          readVia: via,
          ...(parsed.comment ? { comment: parsed.comment } : {}),
          values: parsed.values,
          sections,
          emptySections: parsed.emptySections,
          tables: parsed.tables.filter((t) => !section || t.section === section),
          notes,
        });
      }),
  );
}
