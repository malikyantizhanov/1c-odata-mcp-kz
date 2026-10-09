import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { buildQuery, cmp, odataGuid, or } from "../odata/query.js";
import { InputError } from "../errors.js";
import type { ODataEntity } from "../types/odata.js";
import { isKazakhstan } from "./write-kz.js";
import { findDocumentByNumber, printTarget } from "./print.js";
import { printedFileSchema } from "./print-sale.js";
import { amountInWords } from "../print/amount-words.js";
import { documentTitle, trimNumber } from "../print/doc-titles.js";
import {
  reconciliationTotals,
  renderReconciliationPdf,
  type ReconciliationData,
  type ReconciliationRow,
} from "../print/reconciliation-pdf.js";
import { safeFileName, saveUnique, type SavedFile } from "../print/save.js";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ref = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown): number => Number(v ?? 0) || 0;
const date10 = (v: unknown): string | undefined => {
  const s = str(v).slice(0, 10);
  return s && !s.startsWith("0001") ? s : undefined;
};

export const RECONCILIATION_SET = "Document_АктСверкиВзаиморасчетов";
/** Подкаталог каталога печати (ODATA_PRINT_DIR) для актов сверки, если outputDir не задан. */
export const RECONCILIATION_SUBDIR = "акты сверки";

async function entity(
  conn: Connection,
  set: string,
  key: string | undefined,
  select: string[],
): Promise<ODataEntity> {
  if (!key) return {};
  try {
    return await conn.client.getEntity(`${set}(guid'${key}')${buildQuery({ select })}`);
  } catch {
    return {};
  }
}

/**
 * Документы строк акта — «Реализация ТМЗ и услуг 19 от 09.10.2026», как в колонке «Документ» формы 1С. Номер и дату
 * читаем пачкой по каждому виду документа; строка без ссылки (у контрагента — текст или пусто) печатается как есть.
 */
async function documentNames(conn: Connection, rows: ODataEntity[]): Promise<Map<string, string>> {
  const available = await conn.available();
  const byType = new Map<string, Set<string>>();
  for (const r of rows) {
    const type = str(r["Документ_Type"]).replace(/^StandardODATA\./, "");
    const key = str(r["Документ"]);
    if (type.startsWith("Document_") && GUID.test(key) && available.has(type)) {
      (byType.get(type) ?? byType.set(type, new Set()).get(type)!).add(key);
    }
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...byType].map(async ([type, keys]) => {
      const { rows: docs } = await fetchAll(
        conn.client,
        type,
        {
          filter: or(...[...keys].map((k) => cmp("Ref_Key", "eq", odataGuid(k)))),
          select: ["Ref_Key", "Number", "Date"],
        },
        50,
        keys.size,
      );
      for (const x of docs) {
        const dt = date10(x["Date"]);
        out.set(
          String(x["Ref_Key"]),
          `${documentTitle(type)} ${trimNumber(str(x["Number"]))}${dt ? ` от ${dt.split("-").reverse().join(".")}` : ""}`,
        );
      }
    }),
  );
  return out;
}

export interface ReconciliationPrintData {
  ref: string;
  number: string;
  date: string;
  /** Сальдо на конец по данным организации: «+» — долг контрагента. */
  closing: number;
  form: ReconciliationData;
  notes: string[];
}

/** Данные акта сверки для печати: стороны, договор, период, строки обеих сторон, сальдо. */
export async function reconciliationPrintData(
  conn: Connection,
  docRef: string,
): Promise<ReconciliationPrintData> {
  const set = await requireEntity(conn, [RECONCILIATION_SET], "Документ «Акт сверки взаиморасчетов»");
  const doc = await conn.client.getEntity(`${set}(guid'${docRef}')?$format=json`);
  const [org, cp, contract, currency] = await Promise.all([
    entity(conn, "Catalog_Организации", ref(doc["Организация_Key"]), [
      "Description",
      "НаименованиеПолное",
      "ИдентификационныйНомер",
      "ЮрФизЛицо",
    ]),
    entity(conn, "Catalog_Контрагенты", ref(doc["Контрагент_Key"]), [
      "Description",
      "НаименованиеПолное",
      "ИдентификационныйКодЛичности",
      "ЮрФизЛицо",
    ]),
    entity(conn, "Catalog_ДоговорыКонтрагентов", ref(doc["ДоговорКонтрагента_Key"]), ["Description"]),
    entity(conn, "Catalog_Валюты", ref(doc["ВалютаДокумента_Key"]), [
      "Description",
      "ПараметрыПрописиНаРусском",
    ]),
  ]);
  const orgRows = (doc["ПоДаннымОрганизации"] as ODataEntity[] | undefined) ?? [];
  const cpRows = (doc["ПоДаннымКонтрагента"] as ODataEntity[] | undefined) ?? [];
  const names = await documentNames(conn, [...orgRows, ...cpRows]);
  const toRow = (r: ODataEntity): ReconciliationRow => {
    const key = str(r["Документ"]);
    return {
      date: date10(r["Дата"]),
      document: names.get(key) ?? (key && !GUID.test(key) ? key : undefined),
      debit: n(r["Дебет"]),
      credit: n(r["Кредит"]),
    };
  };
  const idOf = (p: ODataEntity, field: string) =>
    `${p["ЮрФизЛицо"] === "ФизЛицо" ? "ИИН" : "БИН"}: ${str(p[field])}`;
  const nameOf = (p: ODataEntity) => str(p["НаименованиеПолное"]) || str(p["Description"]);
  const number = trimNumber(str(doc["Number"]));
  const date = str(doc["Date"]).slice(0, 10);
  const cur = str(currency["Description"]) || "KZT";
  const partial = {
    opening: n(doc["ОстатокНаНачало"]),
    organizationRows: orgRows.map(toRow),
  };
  const { closing } = reconciliationTotals(partial);
  const form: ReconciliationData = {
    number,
    date,
    periodStart: date10(doc["ДатаНачала"]),
    periodEnd: date10(doc["ДатаОкончания"]) ?? date,
    organization: { name: nameOf(org), id: idOf(org, "ИдентификационныйНомер") },
    counterparty: { name: nameOf(cp), id: idOf(cp, "ИдентификационныйКодЛичности") },
    contract: str(contract["Description"]) || undefined,
    currency: cur,
    ...partial,
    counterpartyRows: cpRows.map(toRow),
    agreed: doc["СверкаСогласована"] === true,
    amountWords: amountInWords(
      Math.abs(closing),
      cur,
      str(currency["ПараметрыПрописиНаРусском"]) || undefined,
    ),
  };
  const notes: string[] = [];
  if (!orgRows.length)
    notes.push(
      "В акте нет строк «По данным организации» — заполните акт в 1С (кнопка «Заполнить») и напечатайте снова.",
    );
  if (!form.agreed)
    notes.push("Сверка не согласована — обороты и сальдо по данным контрагента не печатаются (как в 1С).");
  return { ref: docRef, number, date, closing, form, notes };
}

const RECONCILIATION_NUMBER_WORDS = {
  what: "Акт сверки",
  several: "актов сверки",
  empty: "Укажите номер акта сверки.",
};

export function registerReconciliationPrintTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.print_reconciliation",
    {
      title: "Печать акта сверки (PDF)",
      description:
        "PDF «Акта сверки взаиморасчетов» (Казахстан) по печатной форме 1С: период, стороны и договор, таблицы «По данным» " +
        "организации и контрагента (сальдо на начало, документы, обороты, сальдо на конец), задолженность в пользу " +
        "стороны с суммой прописью, подписи с ИИН/БИН и «М.П.». Строки берутся из документа — заполните его в 1С кнопкой " +
        "«Заполнить» до печати. Акт — по ref или номеру (number; date или year при повторе). PDF сохраняется в каталог " +
        "печати (ODATA_PRINT_DIR), подкаталог «акты сверки» (или outputDir), без перезаписи. Возвращает путь (path) и " +
        "файл ресурсом MCP. Печать 1С через OData не вызвать — форма повторяет её по данным документа.",
      inputSchema: {
        database: databaseField,
        ref: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID")
          .optional()
          .describe("Ref_Key акта сверки. Либо ref, либо number."),
        number: z.string().max(50).optional().describe("Номер как в 1С: «2» или «00000000002»."),
        date: dateField("Дата акта — сужает поиск по номеру").optional(),
        year: z.number().int().min(2000).max(2100).optional().describe("Год — сужает поиск по номеру"),
        outputDir: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Подкаталог внутри каталога печати. Не задан — «акты сверки». Выход за каталог печати отклоняется.",
          ),
      },
      outputSchema: z
        .object({
          database: z.string(),
          ref: z.string(),
          number: z.string(),
          date: z.string(),
          closing: z.number(),
          files: z.array(printedFileSchema),
          path: z.string().optional(),
          note: z.string().optional(),
        })
        .passthrough(),
    },
    (args) =>
      guard("read.document.print_reconciliation", async (): Promise<CallToolResult> => {
        const {
          database,
          ref: docRef,
          number,
          date,
          year,
          outputDir,
        } = z
          .object({
            database: z.string().optional(),
            ref: z.string().optional(),
            number: z.string().optional(),
            date: z.string().optional(),
            year: z.number().optional(),
            outputDir: z.string().optional(),
          })
          .parse(args);
        const conn = ctx.db(database);
        if (!docRef && !number) throw new InputError("Укажите ref акта сверки или его номер (number).");
        if (docRef && number) throw new InputError("Укажите что-то одно: ref или number.");
        if (!(await isKazakhstan(conn)))
          throw new InputError("Печать акта сверки поддержана для казахстанской базы.");
        // Каталог проверяется до чтения 1С: выход за корень — ошибка ввода сразу.
        const target = await printTarget(conn, outputDir ?? RECONCILIATION_SUBDIR);
        const set = await requireEntity(conn, [RECONCILIATION_SET], "Документ «Акт сверки взаиморасчетов»");
        const r = (
          docRef ??
          (await findDocumentByNumber(conn, set, number!, { date, year }, RECONCILIATION_NUMBER_WORDS)).ref
        ).replace(/[{}]/g, "");
        const data = await reconciliationPrintData(conn, r);
        const pdf = await renderReconciliationPdf(data.form);
        const name = `Акт сверки № ${data.number} от ${data.date.split("-").reverse().join(".")}.pdf`;
        const notes = [...data.notes];
        let saved: SavedFile | undefined;
        let saveError = target.saveError;
        if (target.dir) {
          try {
            saved = await saveUnique(target.dir, safeFileName(name), pdf);
          } catch (e) {
            saveError = `PDF не сохранён в ${target.dir}: ${(e as Error).message}`;
          }
        }
        if (saved?.renamed)
          notes.push(
            `Файл «${safeFileName(name)}» уже был — новый сохранён как «${saved.fileName}», прежний не перезаписан.`,
          );
        const file = {
          form: "Акт сверки",
          name,
          size: pdf.length,
          ...(saved ? { path: saved.path, fileName: saved.fileName, directory: saved.directory } : {}),
          ...(saveError ? { saveError } : {}),
        };
        const result = ok({
          database: conn.cfg.name,
          ref: r,
          number: data.number,
          date: data.date,
          closing: data.closing,
          files: [file],
          ...(saved ? { path: saved.path } : {}),
          ...(notes.length ? { note: notes.join(" ") } : {}),
        });
        result.content.push({
          type: "resource",
          resource: {
            uri: `onec-print:///${encodeURIComponent(name)}`,
            mimeType: "application/pdf",
            blob: pdf.toString("base64"),
          },
        });
        return result;
      }),
  );
}
