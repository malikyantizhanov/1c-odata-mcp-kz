import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, contains, odataGuid, or } from "../odata/query.js";
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
    "ЮрФизЛицо",
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
      // ИП в 1С — «ФизЛицо»: форма 1С подписывает его номер в образце платёжки «ИИН:», юрлицо — «БИН:».
      individual: org["ЮрФизЛицо"] === "ФизЛицо",
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

const INVOICE_NUMBER_MAX_ROWS = 500;

/** Номер документа совпадает с запрошенным: точно или (для чисто цифрового запроса) по числу в конце номера. */
export function sameDocNumber(docNumber: string, wanted: string): boolean {
  const a = docNumber.trim().toUpperCase();
  const b = wanted.trim().toUpperCase();
  if (a === b) return true;
  if (!/^\d+$/.test(b)) return false;
  const tail = /(\d+)$/.exec(a)?.[1];
  return tail !== undefined && Number(tail) === Number(b);
}

export interface InvoiceMatch {
  ref: string;
  number: string;
  date: string;
  total: number;
  posted: boolean;
  deletionMark: boolean;
}

/**
 * Счёт на оплату по номеру: «3», «00000000003» или номер с префиксом. Дата (YYYY-MM-DD) или год сужают поиск —
 * номера 1С повторяются каждый год. Помеченные на удаление не выбираются, если есть другие. Несколько
 * подходящих — InputError со списком (номер, дата, сумма, Ref): угадывать нельзя.
 */
export async function findInvoiceByNumber(
  conn: Connection,
  number: string,
  opts: { date?: string | undefined; year?: number | undefined } = {},
): Promise<InvoiceMatch> {
  const set = await requireEntity(conn, DOCUMENTS.customerInvoice, "Документ «Счёт на оплату покупателю»");
  const wanted = number.trim();
  if (!wanted) throw new InputError("Укажите номер счёта.");
  const needle = /^\d+$/.test(wanted) ? String(Number(wanted)) : wanted;
  const range = opts.date
    ? [`${opts.date}T00:00:00`, `${opts.date}T23:59:59`]
    : opts.year
      ? [`${opts.year}-01-01T00:00:00`, `${opts.year}-12-31T23:59:59`]
      : undefined;
  const { rows, truncated } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        contains("Number", needle),
        range ? cmp("Date", "ge", `datetime'${range[0]}'`) : undefined,
        range ? cmp("Date", "le", `datetime'${range[1]}'`) : undefined,
      ),
      select: ["Ref_Key", "Number", "Date", "СуммаДокумента", "Posted", "DeletionMark"],
      orderby: "Date desc",
    },
    100,
    INVOICE_NUMBER_MAX_ROWS,
  );
  const all: InvoiceMatch[] = rows
    .filter((r) => sameDocNumber(str(r["Number"]), wanted))
    .map((r) => ({
      ref: str(r["Ref_Key"]),
      number: str(r["Number"]),
      date: str(r["Date"]).slice(0, 10),
      total: Number(r["СуммаДокумента"] ?? 0),
      posted: r["Posted"] === true,
      deletionMark: r["DeletionMark"] === true,
    }));
  const live = all.filter((m) => !m.deletionMark);
  const pick = live.length ? live : all;
  const where = opts.date ? ` от ${opts.date}` : opts.year ? ` за ${opts.year} год` : "";
  if (pick.length === 0)
    throw new InputError(
      `Счёт на оплату № ${wanted}${where} не найден.` +
        (truncated ? " Поиск ограничен — укажите date или year." : "") +
        " Номер — как в 1С (например «3» или «00000000003»).",
    );
  if (pick.length > 1) {
    const list = pick
      .map(
        (m) =>
          `№ ${m.number} от ${m.date}, ${m.total} — ref ${m.ref}${m.deletionMark ? " (помечен на удаление)" : ""}`,
      )
      .join("; ");
    throw new InputError(
      `Под номер ${wanted}${where} подходит несколько счетов: ${list}. Уточните date/year или передайте ref.`,
    );
  }
  return pick[0]!;
}

export interface PrintedInvoice {
  name: string;
  pdf: Buffer;
  data: InvoicePrintData;
  saved?: SavedFile | undefined;
  saveError?: string | undefined;
  notes: string[];
}

/**
 * Каталог для PDF: путь за пределами каталога печати — InputError (до обращения к 1С), сбой файловой системы —
 * не ошибка печати: PDF вернётся ресурсом, причина — в saveError.
 */
export async function printTarget(
  conn: Connection,
  outputDir: string | undefined,
): Promise<{ dir?: string | undefined; saveError?: string | undefined }> {
  const root = conn.behavior.printDir ?? DEFAULT_PRINT_DIR;
  try {
    return { dir: await resolvePrintDir(root, outputDir) };
  } catch (e) {
    if (e instanceof InputError) throw e;
    return { saveError: `Каталог для PDF недоступен (${root}): ${(e as Error).message}` };
  }
}

/** PDF счёта на оплату по данным документа + сохранение в каталог печати (без перезаписи). */
export async function printInvoice(
  conn: Connection,
  docRef: string,
  target: { dir?: string | undefined; saveError?: string | undefined },
): Promise<PrintedInvoice> {
  const data = await invoicePrintData(conn, docRef.replace(/[{}]/g, ""));
  const pdf = await renderInvoicePdf(data);
  const name = `Счет на оплату покупателю № ${data.number} от ${data.date.split("-").reverse().join(".")}.pdf`;
  // Хост MCP передаёт агентам только structuredContent, поэтому PDF сохраняется на диск и путь
  // отдаётся в нём; ресурс с base64 остаётся для клиентов, которые его показывают.
  let saved: SavedFile | undefined;
  let saveError = target.saveError;
  if (target.dir) {
    try {
      saved = await saveUnique(target.dir, safeFileName(name), pdf);
    } catch (e) {
      saveError = `PDF не сохранён в ${target.dir}: ${(e as Error).message}`;
    }
  }
  const notes = [
    ...(data.bank ? [] : ["У счёта и организации нет банковского счёта — ИИК, банк и БИК в PDF пустые."]),
    ...(saved?.renamed
      ? [
          `Файл «${safeFileName(name)}» уже был — новый сохранён как «${saved.fileName}», прежний не перезаписан.`,
        ]
      : []),
  ];
  return { name, pdf, data, saved, saveError, notes };
}

export function registerPrintTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.print_invoice",
    {
      title: "Печать счёта на оплату (PDF)",
      description:
        "PDF счёта на оплату покупателю (Казахстан) по макету печатной формы 1С «Счет на оплату»: условия, образец " +
        "платёжного поручения (бенефициар, ИИК, Кбе, банк, БИК), поставщик, покупатель, договор, позиции, итоги с НДС, " +
        "сумма прописью, подпись. Счёт — по ref или по номеру (number; при повторе номера в разные годы — date или year). " +
        "Сохраняет PDF на диск и возвращает абсолютный путь (path) — существующий файл " +
        "не перезаписывается, новый получает суффикс « (2)»; тот же PDF приходит и ресурсом MCP. Форма собирается по данным " +
        "документа: печать 1С через OData не вызвать, поэтому собственные настройки печати базы (свой текст условий, " +
        "факсимиле, логотип) в PDF не попадают.",
      inputSchema: {
        database: databaseField,
        ref: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID")
          .optional()
          .describe("Ref_Key счёта на оплату. Либо ref, либо number."),
        number: z
          .string()
          .max(50)
          .optional()
          .describe("Номер счёта как в 1С: «3» или «00000000003». Вместо ref."),
        date: dateField("Дата счёта — сужает поиск по номеру").optional(),
        year: z.number().int().min(2000).max(2100).optional().describe("Год счёта — сужает поиск по номеру"),
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
          ref: z.string().optional(),
          path: z.string().optional(),
          fileName: z.string().optional(),
          directory: z.string().optional(),
          saveError: z.string().optional(),
        })
        .passthrough(),
    },
    ({ database, ref: docRef, number, date, year, outputDir }) =>
      guard("read.document.print_invoice", async (): Promise<CallToolResult> => {
        const conn = ctx.db(database);
        if (!docRef && !number) throw new InputError("Укажите ref счёта или его номер (number).");
        if (docRef && number) throw new InputError("Укажите что-то одно: ref или number.");
        if (!(await isKazakhstan(conn)))
          throw new InputError("Печать счёта сейчас поддержана для казахстанской базы.");
        const target = await printTarget(conn, outputDir);
        const ref = docRef ?? (await findInvoiceByNumber(conn, number!, { date, year })).ref;
        const printed = await printInvoice(conn, ref, target);
        const result = ok({
          database: conn.cfg.name,
          ref: ref.replace(/[{}]/g, ""),
          name: printed.name,
          mimeType: "application/pdf",
          size: printed.pdf.length,
          number: printed.data.number,
          date: printed.data.date,
          total: printed.data.total,
          ...(printed.saved
            ? {
                path: printed.saved.path,
                fileName: printed.saved.fileName,
                directory: printed.saved.directory,
              }
            : {}),
          ...(printed.saveError ? { saveError: printed.saveError } : {}),
          ...(printed.notes.length ? { note: printed.notes.join(" ") } : {}),
        });
        result.content.push({
          type: "resource",
          resource: {
            uri: `onec-print:///${encodeURIComponent(printed.name)}`,
            mimeType: "application/pdf",
            blob: printed.pdf.toString("base64"),
          },
        });
        return result;
      }),
  );
}
