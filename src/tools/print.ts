import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { buildQuery, cmp, odataGuid, or } from "../odata/query.js";
import { resolveNames } from "../odata/accounting.js";
import { CATALOGS, DOCUMENTS, resolveEntity } from "../config/mapping.js";
import { InputError } from "../errors.js";
import type { ODataEntity } from "../types/odata.js";
import { isKazakhstan } from "./write-kz.js";
import { renderInvoicePdf, type InvoicePrintData, type InvoicePrintLine } from "../print/invoice-pdf.js";
import {
  DEFAULT_PRINT_DIR,
  resolvePrintDir,
  safeFileName,
  saveUnique,
  type SavedFile,
} from "../print/save.js";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const ref = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function entity(
  conn: Connection,
  set: string,
  key: string | undefined,
  select: string[],
): Promise<ODataEntity> {
  if (!key) return {};
  return conn.client.getEntity(`${set}(guid'${key}')${buildQuery({ select })}`);
}

/**
 * Город банка без своего префикса «г.»/«гор.»/«город»: в справочнике «Банки» он часто уже записан как «г. Алматы»,
 * а макет добавляет « г. » сам. Форма 1С в этом случае печатает «г. г. Алматы» — мы такое удвоение не повторяем.
 */
export const bankCity = (city: string): string =>
  city
    .trim()
    .replace(/^(?:г|гор|город)(?:\.\s*|\s+)/iu, "")
    .trim();

/** Банк в реквизитах — как в форме 1С: наименование и « г. » с городом из справочника («… г. Алматы»). */
export const bankTitle = (name: string, city: string): string => {
  const c = bankCity(city);
  return c ? `${name} г. ${c}` : name;
};

/** Данные счёта на оплату для печати: документ, организация, банк, покупатель, договор, позиции. */
export async function invoicePrintData(conn: Connection, docRef: string): Promise<InvoicePrintData> {
  const available = await conn.available();
  const set = await requireEntity(conn, DOCUMENTS.customerInvoice, "Документ «Счёт на оплату покупателю»");
  const doc = await conn.client.getEntity(`${set}(guid'${docRef}')?$format=json`);
  const org = await entity(conn, "Catalog_Организации", ref(doc["Организация_Key"]), [
    "Description",
    "НаименованиеПолное",
    "ИдентификационныйНомер",
    "КБЕ",
    "ОсновнойБанковскийСчет_Key",
  ]);
  // Счёт организации — из документа (СтруктурнаяЕдиница), иначе основной счёт организации.
  const bankAccountRef =
    (str(doc["СтруктурнаяЕдиница_Type"]).endsWith("Catalog_БанковскиеСчета")
      ? ref(doc["СтруктурнаяЕдиница"])
      : undefined) ?? ref(org["ОсновнойБанковскийСчет_Key"]);
  const account = await entity(conn, "Catalog_БанковскиеСчета", bankAccountRef, ["НомерСчета", "Банк_Key"]);
  const bank = await entity(conn, "Catalog_Банки", ref(account["Банк_Key"]), [
    "Description",
    "БИК",
    "Code",
    "Город",
  ]);
  const buyer = await entity(conn, "Catalog_Контрагенты", ref(doc["Контрагент_Key"]), [
    "Description",
    "НаименованиеПолное",
    "ИдентификационныйКодЛичности",
  ]);
  const contract = await entity(conn, "Catalog_ДоговорыКонтрагентов", ref(doc["ДоговорКонтрагента_Key"]), [
    "Description",
  ]);
  const currency = await entity(conn, "Catalog_Валюты", ref(doc["ВалютаДокумента_Key"]), ["Description"]);

  const goods = (doc["Товары"] as ODataEntity[] | undefined) ?? [];
  const services = (doc["Услуги"] as ODataEntity[] | undefined) ?? [];
  const nomRefs = [
    ...new Set([...goods, ...services].map((r) => str(r["Номенклатура_Key"])).filter((r) => ref(r))),
  ];
  const nomSet = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
  const { rows: noms } = nomRefs.length
    ? await fetchAll(
        conn.client,
        nomSet,
        {
          filter: or(...nomRefs.map((r) => cmp("Ref_Key", "eq", odataGuid(r)))),
          select: ["Ref_Key", "Code", "Description", "НаименованиеПолное", "БазоваяЕдиницаИзмерения_Key"],
        },
        50,
        nomRefs.length,
      )
    : { rows: [] };
  const nom = new Map(noms.map((n) => [String(n["Ref_Key"]), n]));
  // Единица: у товара — из строки, у услуги — базовая единица номенклатуры (как в форме 1С: «ч», «шт»).
  const unitOf = (r: ODataEntity) =>
    ref(r["ЕдиницаИзмерения_Key"]) ??
    ref(nom.get(str(r["Номенклатура_Key"]))?.["БазоваяЕдиницаИзмерения_Key"]);
  const unitSet = resolveEntity(
    ["Catalog_КлассификаторЕдиницИзмерения", "Catalog_ЕдиницыИзмерения"],
    available,
  );
  const unitRefs = [...goods, ...services].map(unitOf).filter((u): u is string => !!u);
  const units =
    unitSet && unitRefs.length ? await resolveNames(conn, unitSet, unitRefs) : new Map<string, string>();
  const nomName = (r: ODataEntity) => {
    const n = nom.get(str(r["Номенклатура_Key"]));
    return str(n?.["НаименованиеПолное"]) || str(n?.["Description"]);
  };
  const line = (r: ODataEntity, name: string): InvoicePrintLine => {
    const unit = unitOf(r);
    return {
      code: str(nom.get(str(r["Номенклатура_Key"]))?.["Code"]) || undefined,
      name,
      quantity: Number(r["Количество"] ?? 0),
      unit: unit ? units.get(unit) || undefined : undefined,
      price: Number(r["Цена"] ?? 0),
      sum: Number(r["Сумма"] ?? 0),
    };
  };
  const lines = [
    ...goods.map((r) => line(r, nomName(r))),
    ...services.map((r) => line(r, str(r["Содержание"]) || nomName(r))),
  ];
  return {
    number: str(doc["Number"]).replace(/^0+(?=\d)/, ""),
    date: str(doc["Date"]).slice(0, 10),
    supplier: {
      name: str(org["НаименованиеПолное"]) || str(org["Description"]),
      bin: str(org["ИдентификационныйНомер"]) || undefined,
      kbe: str(org["КБЕ"]) || undefined,
    },
    bank: str(account["НомерСчета"])
      ? {
          iik: str(account["НомерСчета"]),
          bankName: bankTitle(str(bank["Description"]), str(bank["Город"])),
          bik: str(bank["БИК"]) || str(bank["Code"]) || undefined,
        }
      : undefined,
    paymentCode: str(doc["КодНазначенияПлатежа"]) || undefined,
    buyer: {
      name: str(buyer["НаименованиеПолное"]) || str(buyer["Description"]),
      bin: str(buyer["ИдентификационныйКодЛичности"]) || undefined,
    },
    contract: str(contract["Description"]) || undefined,
    lines,
    withVat: doc["УчитыватьНДС"] === true,
    vatIncluded: doc["СуммаВключаетНДС"] === true,
    vatSum: [...goods, ...services].reduce((s, r) => s + Number(r["СуммаНДС"] ?? 0), 0),
    total: Number(doc["СуммаДокумента"] ?? 0),
    currency: str(currency["Description"]) || "KZT",
  };
}

export function registerPrintTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.print_invoice",
    {
      title: "Печать счёта на оплату (PDF)",
      description:
        "PDF счёта на оплату покупателю (Казахстан) по макету печатной формы 1С «Счет на оплату»: условия, образец " +
        "платёжного поручения (бенефициар, ИИК, Кбе, банк, БИК), поставщик, покупатель, договор, позиции, итоги с НДС, " +
        "сумма прописью, подпись. Сохраняет PDF на диск и возвращает абсолютный путь (path) — существующий файл " +
        "не перезаписывается, новый получает суффикс « (2)»; тот же PDF приходит и ресурсом MCP. Форма собирается по данным " +
        "документа: печать 1С через OData не вызвать, поэтому собственные настройки печати базы (свой текст условий, " +
        "факсимиле, логотип) в PDF не попадают.",
      inputSchema: {
        database: databaseField,
        ref: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID")
          .describe("Ref_Key счёта на оплату"),
        outputDir: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Подкаталог для PDF внутри каталога печати (ODATA_PRINT_DIR, по умолчанию /workspace/library/счета): " +
              "относительный путь от него или абсолютный внутри него; создаётся, если его нет. Выход за каталог " +
              "печати («..», чужой абсолютный путь, символическая ссылка наружу) отклоняется. Не задан — сам каталог печати.",
          ),
      },
      outputSchema: z
        .object({
          database: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.number(),
          path: z.string().optional(),
          fileName: z.string().optional(),
          directory: z.string().optional(),
          saveError: z.string().optional(),
        })
        .passthrough(),
    },
    ({ database, ref: docRef, outputDir }) =>
      guard("read.document.print_invoice", async (): Promise<CallToolResult> => {
        const conn = ctx.db(database);
        if (!(await isKazakhstan(conn)))
          throw new InputError("Печать счёта сейчас поддержана для казахстанской базы.");
        // Каталог проверяется до обращения к 1С: путь за пределами каталога печати — ошибка ввода (PDF не строится).
        // Сбой файловой системы (нет прав и т. п.) не мешает печати: PDF вернётся ресурсом, причина — в saveError.
        const root = conn.behavior.printDir ?? DEFAULT_PRINT_DIR;
        let dir: string | undefined;
        let saveError: string | undefined;
        try {
          dir = await resolvePrintDir(root, outputDir);
        } catch (e) {
          if (e instanceof InputError) throw e;
          saveError = `Каталог для PDF недоступен (${root}): ${(e as Error).message}`;
        }
        const data = await invoicePrintData(conn, docRef.replace(/[{}]/g, ""));
        const pdf = await renderInvoicePdf(data);
        const name = `Счет на оплату покупателю № ${data.number} от ${data.date.split("-").reverse().join(".")}.pdf`;
        // Хост MCP передаёт агентам только structuredContent, поэтому PDF сохраняется на диск и путь
        // отдаётся в нём; ресурс с base64 остаётся для клиентов, которые его показывают.
        let saved: SavedFile | undefined;
        if (dir) {
          try {
            saved = await saveUnique(dir, safeFileName(name), pdf);
          } catch (e) {
            saveError = `PDF не сохранён в ${dir}: ${(e as Error).message}`;
          }
        }
        const notes = [
          ...(data.bank
            ? []
            : ["У счёта и организации нет банковского счёта — ИИК, банк и БИК в PDF пустые."]),
          ...(saved?.renamed
            ? [
                `Файл «${safeFileName(name)}» уже был — новый сохранён как «${saved.fileName}», прежний не перезаписан.`,
              ]
            : []),
        ];
        const result = ok({
          database: conn.cfg.name,
          name,
          mimeType: "application/pdf",
          size: pdf.length,
          number: data.number,
          total: data.total,
          ...(saved ? { path: saved.path, fileName: saved.fileName, directory: saved.directory } : {}),
          ...(saveError ? { saveError } : {}),
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
