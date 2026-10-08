import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, odataGuid, or } from "../odata/query.js";
import { CATALOGS, DOCUMENTS, resolveEntity } from "../config/mapping.js";
import { InputError } from "../errors.js";
import type { ODataEntity } from "../types/odata.js";
import { isKazakhstan } from "./write-kz.js";
import { findDocumentByNumber, printTarget } from "./print.js";
import {
  renderActR1Pdf,
  renderWaybillZ2Pdf,
  shortDate,
  type ActLine,
  type ActR1Data,
  type ActVariant,
  type Signer,
  type WaybillLine,
  type WaybillZ2Data,
} from "../print/sale-forms-pdf.js";
import { amountInWords, quantityInWords } from "../print/amount-words.js";
import { safeFileName, saveUnique, type SavedFile } from "../print/save.js";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const ref = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown): number => Number(v ?? 0) || 0;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Подкаталоги каталога печати (ODATA_PRINT_DIR) для форм реализации, если outputDir не задан. */
export const ACT_SUBDIR = "акты";
export const WAYBILL_SUBDIR = "накладные";

/** Кеш чтений справочников в пределах одной операции: путь запроса → сущность. */
export type ReadMemo = Map<string, Promise<ODataEntity>>;

function cached(conn: Connection, memo: ReadMemo, set: string, key: string | undefined, select: string[]) {
  if (!key) return Promise.resolve({} as ODataEntity);
  const path = `${set}(guid'${key}')${buildQuery({ select })}`;
  let p = memo.get(path);
  if (!p) {
    p = conn.client.getEntity(path).catch(() => ({}) as ODataEntity);
    memo.set(path, p);
  }
  return p;
}

/** «Жумабекова Алина Ерлановна» → «Жумабекова А. Е.» (как ФИО кратко в подписях форм 1С). */
export function shortFio(full: string): string {
  const [last, ...rest] = full.trim().split(/\s+/);
  if (!last || !rest.length) return full.trim();
  return `${last} ${rest.map((p) => `${p.charAt(0).toUpperCase()}.`).join(" ")}`;
}

export interface SalePrintData {
  ref: string;
  number: string;
  date: string;
  total: number;
  act?: ActR1Data | undefined;
  waybill?: WaybillZ2Data | undefined;
  notes: string[];
}

/**
 * Данные для Р-1 (строки «Услуги») и З-2 (строки «Товары») по документу «Реализация товаров и услуг».
 * Правила — как в ПечатьР1/ПолучитьДанныеДляПечатиР1 и ПечатьЗ2 модуля менеджера документа в 1С:
 *  - стороны — полное наименование, ИИН/БИН — идентификационный номер без префикса;
 *  - договор — представление договора контрагента; номер — без лидирующих нулей; дата — дд.мм.гггг;
 *  - Р-1: строки услуг сгруппированы по номенклатуре, цене и содержанию; наименование — содержание, иначе полное
 *    наименование номенклатуры; единица — базовая единица номенклатуры; колонки НДС — у плательщика НДС
 *    (команда 1С «Акт выполненных работ (Р-1) с НДС»), у неплательщика — без них;
 *  - З-2: товары сгруппированы по номенклатуре, единице и цене; сумма с НДС = сумма (+ НДС сверху) (+ акциз сверху);
 *    количество и сумма прописью;
 *  - подпись исполнителя / «Отпуск разрешил» — физлицо ответственного документа (ФИО кратко) и его текущая
 *    должность в организации; без физлица расшифровка пустая, у ИП должность — «Индивидуальный предприниматель»;
 *  - Р-1: стороны — «наименование, юридический адрес, тел.: …» (если контактная информация опубликована), договор —
 *    «Договор №… от … г.», колонка 3 — отчётный период документа, валюта в заголовке НДС — «в теңге».
 * Сведений, которых нет в опубликованных объектах OData (контактная информация, ответственные лица
 * организации — главный бухгалтер, МОЛ склада), в форме нет — это сказано в notes.
 */
export async function salePrintData(
  conn: Connection,
  docRef: string,
  opts: { doc?: ODataEntity | undefined; memo?: ReadMemo | undefined } = {},
): Promise<SalePrintData> {
  const memo = opts.memo ?? new Map();
  const set = await requireEntity(conn, DOCUMENTS.sales, "Документ «Реализация товаров и услуг»");
  const doc = opts.doc ?? (await conn.client.getEntity(`${set}(guid'${docRef}')?$format=json`));
  const available = await conn.available();
  const goods = (doc["Товары"] as ODataEntity[] | undefined) ?? [];
  const services = (doc["Услуги"] as ODataEntity[] | undefined) ?? [];
  const nomRefs = [
    ...new Set([...goods, ...services].map((r) => str(r["Номенклатура_Key"])).filter((r) => ref(r))),
  ];
  const nomSet = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
  const unitSet = resolveEntity(
    ["Catalog_КлассификаторЕдиницИзмерения", "Catalog_ЕдиницыИзмерения"],
    available,
  );

  // Волна 1: организация, покупатель, договор, валюта, ответственный, номенклатура — параллельно.
  const [org, buyer, contract, currency, user, noms] = await Promise.all([
    cached(conn, memo, "Catalog_Организации", ref(doc["Организация_Key"]), [
      "Description",
      "НаименованиеПолное",
      "ИдентификационныйНомер",
      "ЮрФизЛицо",
      "ИндивидуальныйПредприниматель_Key",
    ]),
    cached(conn, memo, "Catalog_Контрагенты", ref(doc["Контрагент_Key"]), [
      "Description",
      "НаименованиеПолное",
      "ИдентификационныйКодЛичности",
    ]),
    cached(conn, memo, "Catalog_ДоговорыКонтрагентов", ref(doc["ДоговорКонтрагента_Key"]), [
      "Description",
      "НомерДоговора",
      "ДатаДоговора",
    ]),
    cached(conn, memo, "Catalog_Валюты", ref(doc["ВалютаДокумента_Key"]), [
      "Code",
      "Description",
      "ПараметрыПрописиНаРусском",
    ]),
    available.has("Catalog_Пользователи")
      ? cached(conn, memo, "Catalog_Пользователи", ref(doc["Ответственный_Key"]), [
          "Description",
          "ФизЛицо_Key",
          "ФизическоеЛицо_Key",
        ])
      : Promise.resolve({} as ODataEntity),
    nomRefs.length
      ? fetchAll(
          conn.client,
          nomSet,
          {
            filter: or(...nomRefs.map((r) => cmp("Ref_Key", "eq", odataGuid(r)))),
            select: ["Ref_Key", "Code", "Description", "НаименованиеПолное", "БазоваяЕдиницаИзмерения_Key"],
          },
          50,
          nomRefs.length,
        ).then((r) => r.rows)
      : Promise.resolve([] as ODataEntity[]),
  ]);
  const nom = new Map(noms.map((x) => [String(x["Ref_Key"]), x]));
  const orgRef = ref(doc["Организация_Key"]);
  const individual = org["ЮрФизЛицо"] === "ФизЛицо";
  const userPerson = ref(user["ФизЛицо_Key"]) ?? ref(user["ФизическоеЛицо_Key"]);
  const ipPerson = individual ? ref(org["ИндивидуальныйПредприниматель_Key"]) : undefined;

  // Волна 2: единицы, ФИО и должность подписанта — параллельно.
  const unitKeys = [
    ...new Set(
      [
        ...goods.map((r) => ref(r["ЕдиницаИзмерения_Key"])),
        ...services.map((r) => ref(nom.get(str(r["Номенклатура_Key"]))?.["БазоваяЕдиницаИзмерения_Key"])),
      ].filter((u): u is string => !!u),
    ),
  ];
  const [unitRows, person, position, orgContacts, buyerContacts] = await Promise.all([
    unitSet && unitKeys.length
      ? fetchAll(
          conn.client,
          unitSet,
          {
            filter: or(...unitKeys.map((k) => cmp("Ref_Key", "eq", odataGuid(k)))),
            select: ["Ref_Key", "Description"],
          },
          50,
          unitKeys.length,
        ).then((r) => r.rows)
      : Promise.resolve([] as ODataEntity[]),
    available.has("Catalog_ФизическиеЛица")
      ? cached(conn, memo, "Catalog_ФизическиеЛица", userPerson, ["Description"])
      : Promise.resolve({} as ODataEntity),
    userPerson && orgRef ? currentPosition(conn, memo, orgRef, userPerson) : Promise.resolve(undefined),
    partyContacts(conn, [
      ["Catalog_Организации", orgRef],
      ["Catalog_ФизическиеЛица", ipPerson],
    ]),
    partyContacts(conn, [["Catalog_Контрагенты", ref(doc["Контрагент_Key"])]]),
  ]);
  const units = new Map(unitRows.map((u) => [String(u["Ref_Key"]), str(u["Description"])]));
  const notes: string[] = [];
  // Подпись исполнителя (Подвал Р-1): расшифровка — ФИО физлица ответственного документа; без физлица — пустая (как
  // в 1С). Должность — текущая должность этого физлица; у ИП без неё — «Индивидуальный предприниматель».
  const signerName = str(person["Description"]) ? shortFio(str(person["Description"])) : undefined;
  const signerPosition = position ?? (individual ? "Индивидуальный предприниматель" : undefined);
  const signer: Signer | undefined =
    signerName || signerPosition ? { name: signerName, position: signerPosition } : undefined;
  if (!signerName)
    notes.push("У ответственного документа нет физлица — расшифровка подписи исполнителя пустая (как в 1С).");

  const number = str(doc["Number"]).replace(/^0+(?=\d)/, "");
  const date = str(doc["Date"]).slice(0, 10);
  const withVat = doc["УчитыватьНДС"] === true;
  const vatIncluded = doc["СуммаВключаетНДС"] === true;
  const executor = {
    name: str(org["НаименованиеПолное"]) || str(org["Description"]),
    idNumber: str(org["ИдентификационныйНомер"]) || undefined,
    ...orgContacts.found,
  };
  const customer = {
    name: str(buyer["НаименованиеПолное"]) || str(buyer["Description"]),
    idNumber: str(buyer["ИдентификационныйКодЛичности"]) || undefined,
    ...buyerContacts.found,
  };
  const cur = str(currency["Description"]) || "KZT";
  const curLabel = currencyLabel(currency);
  const nomName = (r: ODataEntity) => {
    const x = nom.get(str(r["Номенклатура_Key"]));
    return str(x?.["НаименованиеПолное"]) || str(x?.["Description"]);
  };

  let act: ActR1Data | undefined;
  if (services.length) {
    const variant: ActVariant = withVat ? (vatIncluded ? "vatIncluded" : "vatOnTop") : "plain";
    const groups = new Map<string, ActLine>();
    for (const r of services) {
      const name = str(r["Содержание"]) || nomName(r);
      const key = `${str(r["Номенклатура_Key"])}|${n(r["Цена"])}|${name}`;
      const unitKey = ref(nom.get(str(r["Номенклатура_Key"]))?.["БазоваяЕдиницаИзмерения_Key"]);
      const g = groups.get(key) ?? {
        name,
        unit: unitKey ? units.get(unitKey) : undefined,
        quantity: 0,
        price: n(r["Цена"]),
        sum: 0,
        vat: 0,
        sumWithVat: 0,
      };
      g.quantity += n(r["Количество"]);
      g.sum = round2(g.sum + n(r["Сумма"]));
      g.vat = round2(g.vat + n(r["СуммаНДС"]));
      groups.set(key, g);
    }
    const lines = [...groups.values()].map((l) => ({
      ...l,
      sumWithVat: variant === "vatOnTop" ? round2(l.sum + l.vat) : l.sum,
    }));
    act = {
      number,
      date,
      customer,
      executor,
      contract: contractPresentation(contract),
      period: reportPeriod(doc),
      variant,
      currency: curLabel,
      lines,
      totals: {
        quantity: lines.reduce((a, l) => a + l.quantity, 0),
        sum: round2(lines.reduce((a, l) => a + l.sum, 0)),
        vat: round2(lines.reduce((a, l) => a + l.vat, 0)),
        sumWithVat: round2(lines.reduce((a, l) => a + l.sumWithVat, 0)),
      },
      executorSigner: signer,
      acceptedDate: str(doc["ДатаПодписанияГЗ"]).slice(0, 10) || undefined,
      documentation: str(doc["ПереченьДокументации"]) || undefined,
    };
  }

  let waybill: WaybillZ2Data | undefined;
  if (goods.length) {
    const addVat = withVat && !vatIncluded;
    const addExcise = doc["УчитыватьАкциз"] === true && doc["СуммаВключаетАкциз"] !== true;
    const groups = new Map<string, WaybillLine>();
    for (const r of goods) {
      const unitKey = ref(r["ЕдиницаИзмерения_Key"]);
      const key = `${str(r["Номенклатура_Key"])}|${unitKey ?? ""}|${n(r["Цена"])}`;
      const x = nom.get(str(r["Номенклатура_Key"]));
      const g = groups.get(key) ?? {
        name: nomName(r),
        code: str(x?.["Code"]) || undefined,
        unit: unitKey ? units.get(unitKey) : undefined,
        quantity: 0,
        price: n(r["Цена"]),
        sumWithVat: 0,
        vat: 0,
      };
      g.quantity += n(r["Количество"]);
      g.sumWithVat = round2(
        g.sumWithVat +
          n(r["Сумма"]) +
          (addVat ? n(r["СуммаНДС"]) : 0) +
          (addExcise ? n(r["СуммаАкциза"]) : 0),
      );
      g.vat = round2(g.vat + n(r["СуммаНДС"]));
      groups.set(key, g);
    }
    const lines = [...groups.values()];
    const totalQty = lines.reduce((a, l) => a + l.quantity, 0);
    const totalSum = round2(lines.reduce((a, l) => a + l.sumWithVat, 0));
    const poaNumber = str(doc["ДоверенностьНомер"]);
    const poaDate = shortDate(str(doc["ДоверенностьДата"]));
    waybill = {
      number,
      date,
      organization: executor,
      receiver: customer.name,
      responsible: signer?.name,
      currency: curLabel,
      lines,
      totals: { quantity: totalQty, sumWithVat: totalSum, vat: round2(lines.reduce((a, l) => a + l.vat, 0)) },
      quantityWords: quantityInWords(totalQty),
      amountWords: amountInWords(totalSum, cur),
      permittedBy: signer,
      powerOfAttorney: poaNumber ? `№ ${poaNumber}${poaDate ? ` от ${poaDate}` : ""}` : undefined,
      powerOfAttorneyPerson: str(doc["ДоверенностьЛицо"]) || undefined,
      powerOfAttorneyIssuedBy: str(doc["ДоверенностьВыдана"]) || undefined,
    };
    notes.push(
      "З-2: главный бухгалтер и материально ответственное лицо склада в OData не опубликованы (регистр «Ответственные лица " +
        "организаций») — эти расшифровки пустые, заполните от руки.",
    );
  }
  if (orgContacts.unpublished || buyerContacts.unpublished)
    notes.push(
      "Контактная информация (юридический адрес, телефоны) в OData не опубликована — в строках «Заказчик» / " +
        "«Исполнитель» только полное наименование.",
    );
  return { ref: docRef, number, date, total: n(doc["СуммаДокумента"]), act, waybill, notes };
}

/**
 * Договор в Р-1: «Договор №<номер> от <дата> г.» по реквизитам НомерДоговора / ДатаДоговора; номер «б/н» —
 * «Договор б/н от … г.». Без номера и даты — наименование договора (его представление в 1С).
 */
export function contractPresentation(c: ODataEntity): string | undefined {
  const number = str(c["НомерДоговора"]);
  const date = shortDate(str(c["ДатаДоговора"]));
  if (number || date) {
    const no = !number ? "" : /^б\/н$/i.test(number) ? " б/н" : ` №${number}`;
    return `Договор${no}${date ? ` от ${date} г.` : ""}`;
  }
  return str(c["Description"]) || undefined;
}

/** Колонка 3 Р-1: отчётный период документа «начало - конец»; одна дата — она; нет — пусто. */
export function reportPeriod(doc: ODataEntity): string | undefined {
  const start = shortDate(str(doc["ДатаНачалаОтчетногоПериода"]));
  const end = shortDate(str(doc["ДатаОкончанияОтчетногоПериода"]));
  if (start && end) return start === end ? start : `${start} - ${end}`;
  return start || end || undefined;
}

/**
 * Валюта в заголовках колонок форм («в теңге»): у тенге (код 398) — как в печатной форме 1С, «теңге» (первая форма
 * «Параметров прописи на русском»), у другой валюты — её наименование (USD, RUB, …), как представление валюты
 * документа в параметре [Валюта] макета.
 */
export function currencyLabel(c: ODataEntity): string {
  const code = str(c["Code"]);
  const name = str(c["Description"]);
  if (code === "398" || name === "KZT")
    return str(c["ПараметрыПрописиНаРусском"]).split(",")[0]?.trim() || "теңге";
  return name || "KZT";
}

const CI_REGISTER = "InformationRegister_КонтактнаяИнформация";
const CI_KINDS = "Catalog_ВидыКонтактнойИнформации";

/**
 * Юридический адрес и телефоны стороны (как СведенияОЮрФизЛице: КонтактнаяИнформацияБК.ПолучитьАдресИзКонтактной-
 * Информации(…, "Юридический") и ПолучитьТелефонИзКонтактнойИнформации). Источник — табличная часть
 * «КонтактнаяИнформация» справочника или регистр сведений «КонтактнаяИнформация», если они опубликованы. Объекты
 * проверяются по порядку (организация, затем физлицо ИП) — берётся первый, у которого что-то нашлось.
 */
async function partyContacts(
  conn: Connection,
  objects: Array<[string, string | undefined]>,
): Promise<{ found: { address?: string; phones?: string }; unpublished: boolean }> {
  const available = await conn.available();
  const meta = await conn.getMetadata().catch(() => undefined);
  const hasTable = (set: string) =>
    !!meta?.entities.get(set)?.properties.some((p) => p.name === "КонтактнаяИнформация");
  const register = available.has(CI_REGISTER);
  if (!register && !objects.some(([set]) => hasTable(set))) return { found: {}, unpublished: true };
  let kinds: Map<string, ODataEntity> | undefined;
  for (const [set, key] of objects) {
    if (!key) continue;
    try {
      let rows: ODataEntity[] = [];
      if (hasTable(set)) {
        const e = await conn.client.getEntity(
          `${set}(guid'${key}')${buildQuery({ select: ["КонтактнаяИнформация"] })}`,
        );
        rows = (e["КонтактнаяИнформация"] as ODataEntity[] | undefined) ?? [];
      }
      if (!rows.length && register) {
        rows = (
          await fetchAll(
            conn.client,
            CI_REGISTER,
            { filter: cmp("Объект", "eq", `cast(${odataGuid(key)}, '${set}')`) },
            50,
            200,
          )
        ).rows;
      }
      if (!rows.length) continue;
      kinds ??= available.has(CI_KINDS)
        ? new Map(
            (
              await fetchAll(
                conn.client,
                CI_KINDS,
                { select: ["Ref_Key", "Description", "PredefinedDataName"] },
                500,
                500,
              )
            ).rows.map((k) => [str(k["Ref_Key"]), k]),
          )
        : new Map();
      const kindOf = (r: ODataEntity) => kinds!.get(str(r["Вид_Key"]) || str(r["Вид"]));
      const text = (r: ODataEntity) => str(r["Представление"]);
      const legal = rows.find((r) => {
        const k = kindOf(r);
        return (
          str(r["Тип"]) === "Адрес" &&
          text(r) &&
          (/^ЮрАдрес/.test(str(k?.["PredefinedDataName"])) || /юрид/i.test(str(k?.["Description"])))
        );
      });
      const phones = [...new Set(rows.filter((r) => str(r["Тип"]) === "Телефон" && text(r)).map(text))];
      const found = {
        ...(legal ? { address: text(legal) } : {}),
        ...(phones.length ? { phones: phones.join(", ") } : {}),
      };
      if (found.address || found.phones) return { found, unpublished: false };
    } catch {
      // Нет доступа / не опубликовано у этого объекта — пробуем следующий; в форме останется наименование.
    }
  }
  return { found: {}, unpublished: false };
}

/** Текущая должность физлица в организации: сотрудник организации → ТекущаяДолжностьОрганизации. */
async function currentPosition(
  conn: Connection,
  memo: ReadMemo,
  orgRef: string,
  personRef: string,
): Promise<string | undefined> {
  const available = await conn.available();
  if (!available.has("Catalog_СотрудникиОрганизаций") || !available.has("Catalog_ДолжностиОрганизаций"))
    return undefined;
  try {
    const { rows } = await fetchAll(
      conn.client,
      "Catalog_СотрудникиОрганизаций",
      {
        filter: and(
          cmp("Физлицо_Key", "eq", odataGuid(personRef)),
          cmp("Организация_Key", "eq", odataGuid(orgRef)),
          cmp("DeletionMark", "eq", "false"),
        ),
        select: ["Ref_Key", "ТекущаяДолжностьОрганизации_Key", "Актуальность"],
      },
      10,
      10,
    );
    const emp = rows.find((r) => r["Актуальность"] === true) ?? rows[0];
    const pos = await cached(
      conn,
      memo,
      "Catalog_ДолжностиОрганизаций",
      ref(emp?.["ТекущаяДолжностьОрганизации_Key"]),
      ["Description"],
    );
    return str(pos["Description"]) || undefined;
  } catch {
    return undefined;
  }
}

export type SaleForm = "auto" | "act" | "waybill";

export interface PrintedForm {
  form: "Р-1" | "З-2";
  name: string;
  pdf: Buffer;
  saved?: SavedFile | undefined;
  saveError?: string | undefined;
}

export interface PrintedSale {
  data: SalePrintData;
  files: PrintedForm[];
  notes: string[];
}

/**
 * PDF форм реализации и сохранение без перезаписи. outputDir задан — обе формы туда; не задан — Р-1 в «акты»,
 * З-2 в «накладные» внутри каталога печати. «auto» — по составу документа: услуги → Р-1, товары → З-2, оба вида
 * строк → обе формы.
 */
export async function printSale(
  conn: Connection,
  docRef: string,
  opts: {
    form?: SaleForm | undefined;
    outputDir?: string | undefined;
    doc?: ODataEntity | undefined;
    memo?: ReadMemo | undefined;
  } = {},
): Promise<PrintedSale> {
  const form = opts.form ?? "auto";
  // outputDir проверяется до чтения 1С: выход за корень — ошибка ввода сразу. Подкаталоги «акты»/«накладные»
  // создаются только для печатаемых форм.
  const explicit = opts.outputDir !== undefined ? await printTarget(conn, opts.outputDir) : undefined;
  const dirFor = (sub: string) => (explicit ? Promise.resolve(explicit) : printTarget(conn, sub));
  const data = await salePrintData(conn, docRef.replace(/[{}]/g, ""), { doc: opts.doc, memo: opts.memo });
  const notes = [...data.notes];
  const wantAct = form === "act" || (form === "auto" && !!data.act);
  const wantWaybill = form === "waybill" || (form === "auto" && !!data.waybill);
  if (form === "act" && !data.act)
    throw new InputError(`В реализации № ${data.number} нет строк «Услуги» — акт Р-1 печатать не из чего.`);
  if (form === "waybill" && !data.waybill)
    throw new InputError(
      `В реализации № ${data.number} нет строк «Товары» — накладную З-2 печатать не из чего.`,
    );
  if (!data.act && !data.waybill)
    throw new InputError(`В реализации № ${data.number} нет строк товаров и услуг.`);
  const dd = shortDate(data.date);
  const [actTarget, waybillTarget] = await Promise.all([
    wantAct && data.act ? dirFor(ACT_SUBDIR) : Promise.resolve({}),
    wantWaybill && data.waybill ? dirFor(WAYBILL_SUBDIR) : Promise.resolve({}),
  ]);
  const jobs: Array<Promise<PrintedForm>> = [];
  const save = async (
    f: PrintedForm["form"],
    name: string,
    pdf: Promise<Buffer>,
    target: { dir?: string | undefined; saveError?: string | undefined },
  ): Promise<PrintedForm> => {
    const buf = await pdf;
    let saved: SavedFile | undefined;
    let saveError = target.saveError;
    if (target.dir) {
      try {
        saved = await saveUnique(target.dir, safeFileName(name), buf);
      } catch (e) {
        saveError = `PDF не сохранён в ${target.dir}: ${(e as Error).message}`;
      }
    }
    if (saved?.renamed)
      notes.push(
        `Файл «${safeFileName(name)}» уже был — новый сохранён как «${saved.fileName}», прежний не перезаписан.`,
      );
    return { form: f, name, pdf: buf, saved, saveError };
  };
  if (wantAct && data.act)
    jobs.push(
      save(
        "Р-1",
        `Акт выполненных работ Р-1 № ${data.number} от ${dd}.pdf`,
        renderActR1Pdf(data.act),
        actTarget,
      ),
    );
  if (wantWaybill && data.waybill)
    jobs.push(
      save(
        "З-2",
        `Накладная на отпуск запасов З-2 № ${data.number} от ${dd}.pdf`,
        renderWaybillZ2Pdf(data.waybill),
        waybillTarget,
      ),
    );
  const files = await Promise.all(jobs);
  return { data, files, notes };
}

const SALE_NUMBER_WORDS = {
  what: "Реализация (акт, накладная)",
  several: "реализаций",
  empty: "Укажите номер реализации.",
};

export async function findSaleByNumber(
  conn: Connection,
  number: string,
  opts: { date?: string | undefined; year?: number | undefined },
) {
  const set = await requireEntity(conn, DOCUMENTS.sales, "Документ «Реализация товаров и услуг»");
  return findDocumentByNumber(conn, set, number, opts, SALE_NUMBER_WORDS);
}

export const printedFileSchema = z
  .object({
    form: z.string(),
    name: z.string(),
    size: z.number(),
    path: z.string().optional(),
    fileName: z.string().optional(),
    directory: z.string().optional(),
    saveError: z.string().optional(),
  })
  .passthrough();

export function printedFilesOutput(files: PrintedForm[]) {
  return files.map((f) => ({
    form: f.form,
    name: f.name,
    size: f.pdf.length,
    ...(f.saved ? { path: f.saved.path, fileName: f.saved.fileName, directory: f.saved.directory } : {}),
    ...(f.saveError ? { saveError: f.saveError } : {}),
  }));
}

export function registerSalePrintTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.print_sale",
    {
      title: "Печать реализации: акт Р-1 и накладная З-2 (PDF)",
      description:
        "PDF первичных документов по «Реализации товаров и услуг» (Казахстан) по формам приказа МФ РК от 20.12.2012 " +
        "№ 562 (https://adilet.zan.kz/rus/docs/V1200008265): услуги — «Акт выполненных работ (оказанных услуг)», форма Р-1 " +
        "(приложение 50); товары — «Накладная на отпуск запасов на сторону», форма З-2 (приложение 26). Раскладка — как у " +
        "печатных форм 1С Р-1 и З-2. form: auto (по строкам документа; есть и услуги, и товары — оба PDF), act, waybill. " +
        "Реализация — по ref или по номеру (number; date или year при повторе номера). PDF сохраняются в каталог печати " +
        "(ODATA_PRINT_DIR): акт — в подкаталог «акты», накладная — в «накладные» (или в outputDir); существующий файл не " +
        "перезаписывается — новый получает « (2)». Возвращает пути (files[].path). Р-1 — как акт, напечатанный из 1С: " +
        "стороны с юридическим адресом и телефоном (если контактная информация опубликована в OData), договор «Договор " +
        "№… от … г.», колонка 3 — отчётный период документа, колонка 9 «в том числе НДС, в <валюта>» всегда. Главный " +
        "бухгалтер и МОЛ склада в OData не опубликованы — в З-2 их нет (см. note).",
      inputSchema: {
        database: databaseField,
        ref: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID")
          .optional()
          .describe("Ref_Key реализации. Либо ref, либо number."),
        number: z.string().max(50).optional().describe("Номер реализации как в 1С: «18» или «00000000018»."),
        date: dateField("Дата реализации — сужает поиск по номеру").optional(),
        year: z
          .number()
          .int()
          .min(2000)
          .max(2100)
          .optional()
          .describe("Год реализации — сужает поиск по номеру"),
        form: z
          .enum(["auto", "act", "waybill"])
          .default("auto")
          .describe("auto — по строкам документа; act — только Р-1 (услуги); waybill — только З-2 (товары)."),
        outputDir: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Подкаталог внутри каталога печати (ODATA_PRINT_DIR) для обоих PDF. Не задан — «акты» и «накладные». " +
              "Выход за каталог печати отклоняется.",
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
      guard("read.document.print_sale", async (): Promise<CallToolResult> => {
        const {
          database,
          ref: docRef,
          number,
          date,
          year,
          form,
          outputDir,
        } = z
          .object({
            database: z.string().optional(),
            ref: z.string().optional(),
            number: z.string().optional(),
            date: z.string().optional(),
            year: z.number().optional(),
            form: z.enum(["auto", "act", "waybill"]).default("auto"),
            outputDir: z.string().optional(),
          })
          .parse(args);
        const conn = ctx.db(database);
        if (!docRef && !number) throw new InputError("Укажите ref реализации или её номер (number).");
        if (docRef && number) throw new InputError("Укажите что-то одно: ref или number.");
        if (!(await isKazakhstan(conn)))
          throw new InputError("Печать Р-1 и З-2 поддержана для казахстанской базы.");
        const r = docRef ?? (await findSaleByNumber(conn, number!, { date, year })).ref;
        const printed = await printSale(conn, r, { form, outputDir });
        const files = printedFilesOutput(printed.files);
        const result = ok({
          database: conn.cfg.name,
          ref: r.replace(/[{}]/g, ""),
          number: printed.data.number,
          date: printed.data.date,
          total: printed.data.total,
          files,
          ...(files[0]?.path ? { path: files[0].path } : {}),
          ...(printed.notes.length ? { note: printed.notes.join(" ") } : {}),
        });
        for (const f of printed.files)
          result.content.push({
            type: "resource",
            resource: {
              uri: `onec-print:///${encodeURIComponent(f.name)}`,
              mimeType: "application/pdf",
              blob: f.pdf.toString("base64"),
            },
          });
        return result;
      }),
  );
}
