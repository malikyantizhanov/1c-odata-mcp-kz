import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { buildQuery, cmp, odataGuid, or } from "../odata/query.js";
import { CATALOGS, resolveEntity } from "../config/mapping.js";
import { InputError } from "../errors.js";
import type { ODataEntity } from "../types/odata.js";
import { isKazakhstan } from "./write-kz.js";
import { findDocumentByNumber, printTarget } from "./print.js";
import { currencyLabel, partyContacts, printedFileSchema, shortFio } from "./print-sale.js";
import { dateWords } from "../print/invoice-pdf.js";
import { renderTaxInvoicePdf, type TaxInvoiceData, type TaxInvoiceLine } from "../print/tax-invoice-pdf.js";
import { safeFileName, saveUnique, type SavedFile } from "../print/save.js";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const ref = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown): number => Number(v ?? 0) || 0;
const round2 = (x: number): number => Math.round(x * 100) / 100;

export const TAX_INVOICE_SET = "Document_СчетФактураВыданный";
/** Подкаталог каталога печати (ODATA_PRINT_DIR) для счетов-фактур, если outputDir не задан. */
export const TAX_INVOICE_SUBDIR = "счета-фактуры";

/** Представления документов-оснований, как их печатает 1С в строке «Товарно-транспортная накладная». */
const BASIS_TITLES: Record<string, string> = {
  Document_РеализацияТоваровУслуг: "Реализация ТМЗ и услуг",
  Document_АктОбОказанииПроизводственныхУслуг: "Акт об оказании производственных услуг",
  Document_РеализацияУслугПоПереработке: "Реализация услуг по переработке",
};
/** «ВозвратТоваровПоставщику» → «Возврат товаров поставщику» для оснований вне таблицы. */
const titleOf = (set: string): string => {
  const known = BASIS_TITLES[set];
  if (known) return known;
  const words = set.replace(/^Document_/, "").split(/(?=[А-ЯЁA-Z])/);
  return words.map((w, i) => (i ? w.toLowerCase() : w)).join(" ");
};

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

/** «KZ…, в банке АО "…", БИК …» — как 1С; пустой счёт даёт «, в банке , БИК». */
export const accountLine = (iik: string, bank: string, bik: string): string =>
  `${iik}, в банке ${bank}, БИК ${bik}`.trimEnd();

/** «Без НДС» — ставка с заглавной, как в форме 1С («без НДС» в справочнике). */
const rateTitle = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

export interface TaxInvoicePrintData {
  ref: string;
  number: string;
  date: string;
  total: number;
  form: TaxInvoiceData;
  notes: string[];
}

/** Данные счёта-фактуры выданного для печати: реквизиты сторон, основание, строки, подписи. */
export async function taxInvoicePrintData(conn: Connection, docRef: string): Promise<TaxInvoicePrintData> {
  const available = await conn.available();
  const set = await requireEntity(conn, [TAX_INVOICE_SET], "Документ «Счёт-фактура выданный»");
  const doc = await conn.client.getEntity(`${set}(guid'${docRef}')?$format=json`);
  const orgRef = ref(doc["Поставщик_Key"]) ?? ref(doc["Организация_Key"]);
  const buyerRef = ref(doc["Покупатель_Key"]) ?? ref(doc["Контрагент_Key"]);
  const consigneeRef = ref(doc["Грузополучатель_Key"]);
  const basisSet = str(doc["ДокументОснование_Type"]).replace(/^StandardODATA\./, "");
  const partySelect = [
    "Description",
    "НаименованиеПолное",
    "ИдентификационныйКодЛичности",
    "НомерНалоговойРегистрацииВСтранеРезидентства",
    "ЮрФизЛицо",
    "ОсновнойБанковскийСчет_Key",
  ];
  const [org, buyer, consignee, contract, currency, basis, orgContacts, buyerContacts, consigneeContacts] =
    await Promise.all([
      entity(conn, "Catalog_Организации", orgRef, [
        "Description",
        "НаименованиеПолное",
        "ИдентификационныйНомер",
        "ЮрФизЛицо",
        "ИндивидуальныйПредприниматель_Key",
        "ОсновнойБанковскийСчет_Key",
      ]),
      entity(conn, "Catalog_Контрагенты", buyerRef, partySelect),
      entity(conn, "Catalog_Контрагенты", consigneeRef, partySelect),
      entity(conn, "Catalog_ДоговорыКонтрагентов", ref(doc["ДоговорКонтрагента_Key"]), ["Description"]),
      entity(conn, "Catalog_Валюты", ref(doc["ВалютаДокумента_Key"]), [
        "Code",
        "Description",
        "ПараметрыПрописиНаРусском",
      ]),
      basisSet.startsWith("Document_") && available.has(basisSet)
        ? entity(conn, basisSet, ref(doc["ДокументОснование"]), ["Number", "Date"])
        : Promise.resolve({} as ODataEntity),
      partyContacts(conn, [["Catalog_Организации", orgRef]]),
      partyContacts(conn, [["Catalog_Контрагенты", buyerRef]]),
      partyContacts(conn, [["Catalog_Контрагенты", consigneeRef]]),
    ]);
  const individual = org["ЮрФизЛицо"] === "ФизЛицо";
  const orgAccountRef = ref(doc["СчетОрганизации_Key"]) ?? ref(org["ОсновнойБанковскийСчет_Key"]);
  const [orgAccount, buyerAccount, ipPerson] = await Promise.all([
    entity(conn, "Catalog_БанковскиеСчета", orgAccountRef, ["НомерСчета", "Банк_Key"]),
    entity(conn, "Catalog_БанковскиеСчета", ref(buyer["ОсновнойБанковскийСчет_Key"]), [
      "НомерСчета",
      "Банк_Key",
    ]),
    individual
      ? entity(conn, "Catalog_ФизическиеЛица", ref(org["ИндивидуальныйПредприниматель_Key"]), ["Description"])
      : Promise.resolve({} as ODataEntity),
  ]);
  const [orgBank, buyerBank] = await Promise.all([
    entity(conn, "Catalog_Банки", ref(orgAccount["Банк_Key"]), ["Description", "БИК", "Code"]),
    entity(conn, "Catalog_Банки", ref(buyerAccount["Банк_Key"]), ["Description", "БИК", "Code"]),
  ]);

  // Строки: номенклатура (наименование, код ТНВЭД), единицы, ставки НДС и акциза.
  const rows = (doc["Товары"] as ODataEntity[] | undefined) ?? [];
  const nomRefs = [...new Set(rows.map((r) => ref(r["Номенклатура_Key"])).filter((r): r is string => !!r))];
  const nomSet = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
  const unitSet = resolveEntity(
    ["Catalog_КлассификаторЕдиницИзмерения", "Catalog_ЕдиницыИзмерения"],
    available,
  );
  const byKeys = async (set: string | undefined, keys: Array<string | undefined>, select: string[]) => {
    const list = [...new Set(keys.filter((k): k is string => !!k))];
    if (!set || !list.length || !available.has(set)) return new Map<string, ODataEntity>();
    const { rows: found } = await fetchAll(
      conn.client,
      set,
      { filter: or(...list.map((k) => cmp("Ref_Key", "eq", odataGuid(k)))), select: ["Ref_Key", ...select] },
      50,
      list.length,
    );
    return new Map(found.map((x) => [String(x["Ref_Key"]), x]));
  };
  const [noms, units, vatRates, exciseRates] = await Promise.all([
    byKeys(nomSet, nomRefs, ["Description", "НаименованиеПолное", "КодТНВЭД"]),
    byKeys(
      unitSet,
      rows.map((r) => ref(r["ЕдиницаИзмерения_Key"])),
      ["Description"],
    ),
    byKeys(
      "Catalog_СтавкиНДС",
      rows.map((r) => ref(r["СтавкаНДС_Key"])),
      ["Description"],
    ),
    byKeys(
      "Catalog_СтавкиАкциза",
      rows.map((r) => ref(r["СтавкаАкциза_Key"])),
      ["Description"],
    ),
  ]);
  const vatIncluded = doc["СуммаВключаетНДС"] === true;
  const exciseIncluded = doc["СуммаВключаетАкциз"] === true;
  const lines: TaxInvoiceLine[] = rows.map((r) => {
    const nom = noms.get(str(r["Номенклатура_Key"]));
    const sum = n(r["Сумма"]);
    const vat = n(r["СуммаНДС"]);
    const excise = n(r["СуммаАкциза"]);
    const cost = round2(sum - (vatIncluded ? vat : 0) - (exciseIncluded ? excise : 0));
    return {
      name: str(nom?.["НаименованиеПолное"]) || str(nom?.["Description"]),
      unit: str(units.get(str(r["ЕдиницаИзмерения_Key"]))?.["Description"]) || undefined,
      tnved: str(nom?.["КодТНВЭД"]) || undefined,
      quantity: n(r["Количество"]),
      price: n(r["Цена"]),
      costWithoutVat: cost,
      vatRate: rateTitle(str(vatRates.get(str(r["СтавкаНДС_Key"]))?.["Description"])),
      vat,
      total: round2(cost + vat + excise),
      exciseRate: str(exciseRates.get(str(r["СтавкаАкциза_Key"]))?.["Description"]) || undefined,
      excise,
    };
  });
  const sumOf = (k: keyof TaxInvoiceLine) => round2(lines.reduce((a, l) => a + (l[k] as number), 0));

  // Реквизиты сторон — как строки формы 1С (пустые части оставляют запятые: «ИИН: 123123123123, ,»).
  const idOf = (p: ODataEntity, own = false) =>
    `${p["ЮрФизЛицо"] === "ФизЛицо" ? "ИИН" : "БИН"}: ${str(p[own ? "ИдентификационныйНомер" : "ИдентификационныйКодЛичности"])}`;
  const regOf = (p: ODataEntity) =>
    str(p["НомерНалоговойРегистрацииВСтранеРезидентства"])
      ? [`ИНН/КПП: ${str(p["НомерНалоговойРегистрацииВСтранеРезидентства"])}`]
      : [];
  const nameOf = (p: ODataEntity) => str(p["НаименованиеПолное"]) || str(p["Description"]);
  const supplierIds = [idOf(org, true), orgContacts.found.address ?? "", ""].join(", ").trimEnd();
  const buyerIds = [
    idOf(buyer),
    ...regOf(buyer),
    ...(buyerContacts.found.address ? [buyerContacts.found.address] : []),
  ].join(", ");
  const consigneeText = consigneeRef
    ? [idOf(consignee), ...regOf(consignee), nameOf(consignee), consigneeContacts.found.address ?? ""]
        .join(", ")
        .trimEnd()
    : undefined;
  const poaNumber = str(doc["ДоверенностьНомер"]);
  const poaDate = str(doc["ДоверенностьДата"]).slice(0, 10);
  const poaDateText =
    poaDate && !poaDate.startsWith("0001") ? ` от ${poaDate.split("-").reverse().join(".")}` : "";
  const basisNumber = str(basis["Number"]).replace(/^0+(?=\d)/, "");
  const basisDate = str(basis["Date"]).slice(0, 10);

  const notes: string[] = [];
  if (!individual)
    notes.push(
      "Руководитель и главный бухгалтер в OData не опубликованы (регистр «Ответственные лица организаций») — " +
        "в счёте-фактуре эти строки пустые, заполните от руки.",
    );
  if (orgContacts.unpublished)
    notes.push(
      "Контактная информация в OData не опубликована — адреса поставщика и покупателя в счёте-фактуре пустые.",
    );

  const number = str(doc["Number"]);
  const date = str(doc["Date"]).slice(0, 10);
  const form: TaxInvoiceData = {
    number,
    date,
    turnoverDate: str(doc["ДатаСовершенияОборотаПоРеализации"]).slice(0, 10) || date,
    supplierName: nameOf(org),
    supplierIds,
    supplierAccount: accountLine(
      str(orgAccount["НомерСчета"]),
      str(orgBank["Description"]),
      str(orgBank["БИК"]) || str(orgBank["Code"]),
    ),
    contract: str(contract["Description"]) || "Без договора",
    paymentTerms: str(doc["УсловияОплаты"]) || undefined,
    destination: str(doc["ПунктНазначения"]) || undefined,
    powerOfAttorney: poaNumber ? `№ ${poaNumber}${poaDateText}` : "Без доверенности",
    shipmentMethod: str(doc["СпособОтправления"]) || undefined,
    waybill:
      basisNumber && basisSet
        ? `${titleOf(basisSet)} № ${basisNumber}${basisDate ? ` от ${dateWords(basisDate)}` : ""}`
        : undefined,
    consignor: undefined,
    consignee: consigneeText,
    buyerName: nameOf(buyer),
    buyerIds,
    buyerAccount: accountLine(
      str(buyerAccount["НомерСчета"]),
      str(buyerBank["Description"]),
      str(buyerBank["БИК"]) || str(buyerBank["Code"]),
    ),
    currency: currencyLabel(currency),
    lines,
    totals: {
      costWithoutVat: sumOf("costWithoutVat"),
      vat: sumOf("vat"),
      total: sumOf("total"),
      excise: sumOf("excise"),
    },
    head: str(ipPerson["Description"]) ? shortFio(str(ipPerson["Description"])) : undefined,
    chiefAccountant: individual ? "Не предусмотрен" : undefined,
  };
  return { ref: docRef, number, date, total: n(doc["СуммаДокумента"]), form, notes };
}

const TAX_INVOICE_NUMBER_WORDS = {
  what: "Счёт-фактура",
  several: "счетов-фактур",
  empty: "Укажите номер счёта-фактуры.",
};

export function registerTaxInvoicePrintTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.print_tax_invoice",
    {
      title: "Печать счёта-фактуры (PDF)",
      description:
        "PDF счёта-фактуры выданного (Казахстан) по печатной форме 1С «Счет-фактура»: дата оборота, поставщик и его ИИК, " +
        "договор, доверенность, товарно-транспортная накладная (документ-основание), грузополучатель, получатель, " +
        "таблица (наименование, ед., код ТНВЭД, количество, цена, стоимость без НДС, НДС, всего, акциз), подписи и «МП». " +
        "Счёт-фактура — по ref или номеру (number; date или year при повторе). PDF сохраняется в каталог печати " +
        "(ODATA_PRINT_DIR), подкаталог «счета-фактуры» (или outputDir); существующий файл не перезаписывается. " +
        "Возвращает путь (path) и файл ресурсом MCP. Печать 1С через OData не вызвать — форма повторяет её по данным документа.",
      inputSchema: {
        database: databaseField,
        ref: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID")
          .optional()
          .describe("Ref_Key счёта-фактуры. Либо ref, либо number."),
        number: z.string().max(50).optional().describe("Номер как в 1С: «2» или «00000000002»."),
        date: dateField("Дата счёта-фактуры — сужает поиск по номеру").optional(),
        year: z.number().int().min(2000).max(2100).optional().describe("Год — сужает поиск по номеру"),
        outputDir: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Подкаталог внутри каталога печати. Не задан — «счета-фактуры». Выход за каталог печати отклоняется.",
          ),
      },
      outputSchema: z
        .object({
          database: z.string(),
          ref: z.string(),
          number: z.string(),
          date: z.string(),
          total: z.number(),
          files: z.array(printedFileSchema),
          path: z.string().optional(),
          note: z.string().optional(),
        })
        .passthrough(),
    },
    (args) =>
      guard("read.document.print_tax_invoice", async (): Promise<CallToolResult> => {
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
        if (!docRef && !number) throw new InputError("Укажите ref счёта-фактуры или его номер (number).");
        if (docRef && number) throw new InputError("Укажите что-то одно: ref или number.");
        if (!(await isKazakhstan(conn)))
          throw new InputError("Печать счёта-фактуры поддержана для казахстанской базы.");
        // Каталог проверяется до чтения 1С: выход за корень — ошибка ввода сразу.
        const target = await printTarget(conn, outputDir ?? TAX_INVOICE_SUBDIR);
        const set = await requireEntity(conn, [TAX_INVOICE_SET], "Документ «Счёт-фактура выданный»");
        const r = (
          docRef ??
          (await findDocumentByNumber(conn, set, number!, { date, year }, TAX_INVOICE_NUMBER_WORDS)).ref
        ).replace(/[{}]/g, "");
        const data = await taxInvoicePrintData(conn, r);
        const pdf = await renderTaxInvoicePdf(data.form);
        const name = `Счет-фактура № ${data.number.replace(/^0+(?=\d)/, "")} от ${data.date.split("-").reverse().join(".")}.pdf`;
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
          form: "Счет-фактура",
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
          total: data.total,
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
