import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { DOCUMENTS } from "../config/mapping.js";
import { InputError } from "../errors.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, odataGuid, odataString, or } from "../odata/query.js";
import { fingerprintWriteInput, withWriteOperation } from "../odata/write-operation-context.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok } from "./_shared.js";
import {
  currencyByRef,
  orgBankAccountsWithCurrency,
  pickBankForCurrency,
  rateForDocument,
  rateText,
  resolveCurrency,
  type CurrencyInfo,
  type DocRate,
} from "./currency-kz.js";
import { EXCHANGE_FIELDS, fitToMetadata } from "./esf-create.js";
import { findSaleByNumber } from "./print-sale.js";
import { almatyNow, docNumber, subOperationId, subRequestHash, writeBlocked } from "./quick-invoice.js";
import { isKazakhstan, vatRateRefs } from "./write-kz.js";

/**
 * Счёт-фактура выданный на основании проведённой реализации (Казахстан) — как «Ввести на основании» в 1С.
 * Из реализации: организация, покупатель, договор, строки (номенклатура, количество, цена, сумма, ставка и сумма НДС),
 * флаги НДС и акциза, банковский счёт организации, валюта и курс; оборот по реализации — по строкам; дата совершения
 * оборота — параметр (по умолчанию дата реализации). Валютная реализация: СФ в валюте реализации с её курсом или в
 * тенге по курсу на дату оборота (так выписывают в 1С, когда ЭСФ идёт в тенге) — по прошлым СФ организации или по
 * выбору пользователя. confirm=false — план (ничего не пишет), confirm=true с тем же operationId — СФ без проведения.
 * Поля обмена с ИС ЭСФ (статус, регистрационный номер, ЭЦП…) не заполняются никогда; ЭСФ — отдельным документом.
 */
export const TAX_INVOICE_FROM_SALE_TOOL = "write.sales.tax_invoice_from_sale";

const INVOICE_OUT = "Document_СчетФактураВыданный";
const SALE_TYPE = "StandardODATA.Document_РеализацияТоваровУслуг";
const ORG_TYPE = "StandardODATA.Catalog_Организации";
const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const refOf = (v: unknown): string | undefined => {
  const s = str(v);
  return s && s !== EMPTY ? s : undefined;
};
const guid = (s: string) => s.trim().replace(/[{}]/g, "");
const money = (n: number) => Math.round(n * 100) / 100;
const ru = (d: string) => d.slice(0, 10).split("-").reverse().join(".");
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const SERVICE_FIELDS = [
  "Номенклатура_Key",
  "Содержание",
  "Количество",
  "Цена",
  "Сумма",
  "СтавкаНДС_Key",
  "СуммаНДС",
];
const GOODS_FIELDS = [
  "Номенклатура_Key",
  "ЕдиницаИзмерения_Key",
  "Коэффициент",
  "Количество",
  "Цена",
  "Сумма",
  "СтавкаНДС_Key",
  "СуммаНДС",
  "СтавкаАкциза_Key",
  "СуммаАкциза",
];
/** Денежные поля строки — пересчитываются в тенге в режиме «tenge». */
const MONEY_FIELDS = ["Цена", "Сумма", "СуммаНДС", "СуммаАкциза"];

export const taxInvoiceFromSaleInput = {
  database: databaseField,
  sale: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Реализация-основание: Ref_Key или номер («13», «00000000013»); с номером — saleDate или saleYear",
    ),
  saleDate: dateField("Дата реализации — сужает поиск по номеру").optional(),
  saleYear: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .optional()
    .describe("Год реализации — сужает поиск по номеру"),
  date: dateField("Дата счёта-фактуры; по умолчанию сегодня (Алматы)").optional(),
  turnoverDate: dateField(
    "Дата совершения оборота по реализации; по умолчанию — дата реализации. Для ЭАВР на портале — дата его подтверждения.",
  ).optional(),
  currencyMode: z
    .enum(["auto", "basis", "tenge"])
    .default("tenge")
    .describe(
      "Валютная реализация: tenge (по умолчанию) — СФ в тенге, суммы по курсу регистра «Курсы валют» на дату оборота; " +
        "basis — СФ в валюте реализации, курс и суммы как в ней; auto — как в последнем проведённом СФ этой организации " +
        "по валютной реализации, его нет — вопрос в choices. Для реализации в тенге не влияет.",
    ),
  comment: z
    .string()
    .max(500)
    .optional()
    .describe("Комментарий СФ — ставится перед автоматическим «Создан по реализации № …»"),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "false (по умолчанию) — только план. true — создать счёт-фактуру без проведения: передайте operationId из плана и " +
        "те же аргументы. После таймаута/сбоя повторяйте с тем же operationId.",
    ),
  operationId: z.string().uuid().optional().describe("operationId из плана (обязателен при confirm=true)"),
};
export type TaxInvoiceFromSaleInput = {
  database?: string | undefined;
  sale: string;
  saleDate?: string | undefined;
  saleYear?: number | undefined;
  date?: string | undefined;
  turnoverDate?: string | undefined;
  currencyMode: "auto" | "basis" | "tenge";
  comment?: string | undefined;
  confirm: boolean;
  operationId?: string | undefined;
};

interface Choice {
  field: string;
  reason: string;
  options: Array<Record<string, unknown>>;
  howTo: string;
}

export interface TaxInvoicePlan {
  ready: boolean;
  choices: Choice[];
  notes: string[];
  warnings: string[];
  sale: {
    ref: string;
    number: string;
    date: string;
    posted: boolean;
    total: number;
    currency?: string | undefined;
    rate: number;
    multiplier: number;
  };
  date: string;
  turnoverDate: string;
  currency?: (CurrencyInfo & { mode: "basis" | "tenge"; source: string }) | undefined;
  rate: DocRate;
  payload: Record<string, unknown>;
  total: number;
  vat: number;
  duplicates: Array<{ ref: string; number: string; date: string; posted: boolean; total: number }>;
  view: Record<string, unknown>;
}

async function readOpt(conn: Connection, set: string, key: string | undefined, select: string[]) {
  if (!key) return {} as ODataEntity;
  return conn.client
    .getEntity(`${set}(guid'${key}')${buildQuery({ select })}`)
    .catch(() => ({}) as ODataEntity);
}

function copyRows(rows: unknown, fields: string[]): Array<Record<string, unknown>> {
  return [...((rows as ODataEntity[] | undefined) ?? [])]
    .sort((a, b) => Number(a["LineNumber"] ?? 0) - Number(b["LineNumber"] ?? 0))
    .map((r, i) => {
      const out: Record<string, unknown> = { LineNumber: i + 1 };
      for (const f of fields) if (r[f] !== undefined && r[f] !== null && r[f] !== "") out[f] = r[f];
      return out;
    });
}

/**
 * Как выписаны прошлые СФ организации по валютным реализациям: последний проведённый СФ, чья реализация не в тенге —
 * в тенге или в валюте. Ошибка чтения или таких СФ нет — undefined.
 */
async function precedentMode(
  conn: Connection,
  orgRef: string,
  saleSet: string,
): Promise<{ mode: "basis" | "tenge"; number: string; date: string } | undefined> {
  try {
    const { rows } = await fetchAll(
      conn.client,
      INVOICE_OUT,
      {
        filter: and(
          cmp("Организация_Key", "eq", odataGuid(orgRef)),
          cmp("Posted", "eq", "true"),
          cmp("ДокументОснование_Type", "eq", odataString(SALE_TYPE)),
        ),
        select: ["Ref_Key", "Number", "Date", "ВалютаДокумента_Key", "ДокументОснование"],
        orderby: "Date desc",
      },
      20,
      20,
    );
    const basisRefs = [
      ...new Set(rows.map((r) => refOf(r["ДокументОснование"])).filter((r): r is string => !!r)),
    ];
    if (!basisRefs.length) return undefined;
    const { rows: sales } = await fetchAll(
      conn.client,
      saleSet,
      {
        filter: or(...basisRefs.map((r) => cmp("Ref_Key", "eq", odataGuid(r)))),
        select: ["Ref_Key", "ВалютаДокумента_Key"],
      },
      50,
      basisRefs.length,
    );
    const saleCurrency = new Map(
      sales.map((s) => [str(s["Ref_Key"]).toLowerCase(), refOf(s["ВалютаДокумента_Key"])]),
    );
    for (const r of rows) {
      const cur = saleCurrency.get(str(r["ДокументОснование"]).toLowerCase());
      const info = await currencyByRef(conn, cur);
      if (!info || info.isTenge) continue;
      const own = await currencyByRef(conn, refOf(r["ВалютаДокумента_Key"]));
      return {
        mode: own?.isTenge ? "tenge" : "basis",
        number: docNumber(str(r["Number"])),
        date: str(r["Date"]).slice(0, 10),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function planTaxInvoiceFromSale(
  conn: Connection,
  input: TaxInvoiceFromSaleInput,
): Promise<TaxInvoicePlan> {
  const saleSet = await requireEntity(conn, DOCUMENTS.sales, "Документ «Реализация товаров и услуг»");
  await requireEntity(conn, DOCUMENTS.issuedInvoice, "Документ «Счёт-фактура выданный»");
  const saleRef = GUID_RE.test(input.sale.trim())
    ? guid(input.sale)
    : (await findSaleByNumber(conn, input.sale, { date: input.saleDate, year: input.saleYear })).ref;
  const sale = await conn.client.getEntity(`${saleSet}(guid'${saleRef}')?$format=json`);
  const number = docNumber(str(sale["Number"]));
  const saleDate = str(sale["Date"]).slice(0, 10);
  const label = `Реализация № ${number} от ${ru(saleDate)}`;
  if (sale["DeletionMark"] === true)
    throw new InputError(`${label} помечена на удаление — счёт-фактуру по ней не выписывают.`);
  if (sale["Posted"] !== true)
    throw new InputError(
      `${label} не проведена — счёт-фактуру выписывают только по проведённой реализации. Проведите её ` +
        "(write.document.post_document) и повторите. Ничего не создано.",
    );
  const services = copyRows(sale["Услуги"], SERVICE_FIELDS);
  const goods = copyRows(sale["Товары"], GOODS_FIELDS);
  if (!services.length && !goods.length)
    throw new InputError(
      `В реализации № ${number} нет строк товаров и услуг — счёт-фактуру заполнить нечем.`,
    );

  const notes: string[] = [];
  const warnings: string[] = [];
  const choices: Choice[] = [];
  const today = almatyNow();
  const date = input.date ?? today.date;
  const turnoverDate = input.turnoverDate ?? saleDate;
  const orgRef = str(sale["Организация_Key"]);
  const buyerRef = str(sale["Контрагент_Key"]);
  const contractRef = refOf(sale["ДоговорКонтрагента_Key"]);
  const withVat = sale["УчитыватьНДС"] === true;
  const vatIncluded = sale["СуммаВключаетНДС"] === true;
  const saleRate: DocRate = {
    rate: Number(sale["КурсВзаиморасчетов"] ?? 1) || 1,
    multiplier: Number(sale["КратностьВзаиморасчетов"] ?? 1) || 1,
  };

  const [orgCard, buyerCard, contractCard, saleCurrency, accounts, existing] = await Promise.all([
    readOpt(conn, "Catalog_Организации", orgRef, ["Description", "ОсновнойБанковскийСчет_Key"]),
    readOpt(conn, "Catalog_Контрагенты", buyerRef, [
      "Description",
      "ИдентификационныйКодЛичности",
      "ОсновнойБанковскийСчет_Key",
    ]),
    readOpt(conn, "Catalog_ДоговорыКонтрагентов", contractRef, ["Description", "ВалютаВзаиморасчетов_Key"]),
    currencyByRef(conn, refOf(sale["ВалютаДокумента_Key"])),
    orgBankAccountsWithCurrency(conn, orgRef),
    fetchAll(
      conn.client,
      INVOICE_OUT,
      {
        filter: cmp("ДокументОснование", "eq", odataGuid(saleRef)),
        select: ["Ref_Key", "Number", "Date", "Posted", "СуммаДокумента", "DeletionMark"],
      },
      20,
      20,
    )
      .then((r) => r.rows)
      .catch(() => [] as ODataEntity[]),
  ]);

  // Валюта и курс.
  let currency: TaxInvoicePlan["currency"];
  let rate: DocRate = saleRate;
  if (!saleCurrency || saleCurrency.isTenge) {
    rate = { rate: 1, multiplier: 1 };
    if (saleCurrency) currency = { ...saleCurrency, mode: "basis", source: "валюта реализации — тенге" };
  } else {
    let mode: "basis" | "tenge" | undefined = input.currencyMode === "auto" ? undefined : input.currencyMode;
    let source = mode ? "указано (currencyMode)" : "";
    if (!mode) {
      const prev = await precedentMode(conn, orgRef, saleSet);
      if (prev) {
        mode = prev.mode;
        source = `как в СФ № ${prev.number} от ${ru(prev.date)} по валютной реализации`;
      }
    }
    if (!mode)
      choices.push({
        field: "currencyMode",
        reason:
          `Реализация в ${saleCurrency.name}, а проведённых СФ этой организации по валютным реализациям нет — ` +
          "не из чего понять, как их выписывают.",
        options: [
          {
            value: "tenge",
            description: `СФ в тенге: суммы × курс ${saleCurrency.name} из регистра «Курсы валют» на дату оборота ${ru(turnoverDate)}`,
          },
          {
            value: "basis",
            description: `СФ в ${saleCurrency.name}: курс ${saleRate.rate} и суммы как в реализации`,
          },
        ],
        howTo: "Спросите бухгалтера и передайте currencyMode: tenge или basis.",
      });
    else if (mode === "basis") {
      currency = { ...saleCurrency, mode, source };
      rate = saleRate;
    } else {
      const [r, tenge] = await Promise.all([
        rateForDocument(conn, saleCurrency, turnoverDate),
        resolveCurrency(conn, "398").catch(() => undefined),
      ]);
      if (!tenge)
        throw new InputError("В справочнике «Валюты» нет тенге (код 398) — СФ в тенге не выписать.");
      if (!r)
        choices.push({
          field: "turnoverDate",
          reason: `В регистре «Курсы валют» нет курса ${saleCurrency.name} на ${ru(turnoverDate)} (или только курс 1 — курсы не загружены) — пересчитать в тенге не по чему.`,
          options: [],
          howTo: "Загрузите курсы в 1С или передайте currencyMode: basis.",
        });
      else {
        rate = r;
        currency = {
          ...tenge,
          mode,
          source: `${source}; курс ${rateText(saleCurrency, r)} — на дату оборота`,
        };
      }
    }
  }

  // Строки: «без НДС» у неплательщика, оборот по реализации, пересчёт в тенге.
  const toTenge = currency?.mode === "tenge" && !!saleCurrency && !saleCurrency.isTenge;
  const factor = toTenge ? rate.rate / (rate.multiplier || 1) : 1;
  const noVatRef =
    !withVat && [...services, ...goods].some((r) => !refOf(r["СтавкаНДС_Key"]))
      ? await vatRateRefs(conn, ["без НДС"])
          .then((m) => m.get("без НДС"))
          .catch(() => undefined)
      : undefined;
  let total = 0;
  let vat = 0;
  const fix = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => {
      const out = { ...r };
      if (toTenge)
        for (const f of MONEY_FIELDS) if (typeof out[f] === "number") out[f] = money(Number(out[f]) * factor);
      if (!refOf(out["СтавкаНДС_Key"])) {
        if (noVatRef) out["СтавкаНДС_Key"] = noVatRef;
        else delete out["СтавкаНДС_Key"];
      }
      const sum = Number(out["Сумма"] ?? 0);
      const lineVat = Number(out["СуммаНДС"] ?? 0);
      out["ОборотПоРеализации"] = money(vatIncluded ? sum - lineVat : sum);
      total += vatIncluded ? sum : sum + lineVat;
      vat += lineVat;
      return out;
    });
  const svc = fix(services);
  const gds = fix(goods);
  total = money(total);
  vat = money(vat);
  if (!withVat && !noVatRef && [...svc, ...gds].some((r) => !refOf(r["СтавкаНДС_Key"])))
    notes.push(
      "Ставка «без НДС» не найдена в справочнике «Ставки НДС» — в строках СФ ставка пустая; заполните в 1С.",
    );
  const saleTotal = Number(sale["СуммаДокумента"] ?? 0);
  if (!toTenge && Math.abs(saleTotal - total) >= 0.01)
    notes.push(
      `Сумма по строкам (${total}) отличается от суммы реализации (${saleTotal}) — проверьте строки.`,
    );
  if (toTenge && saleCurrency)
    notes.push(
      `Суммы пересчитаны в тенге: ${saleTotal} ${saleCurrency.name} × ${rate.rate}${rate.multiplier !== 1 ? `/${rate.multiplier}` : ""} = ${total} (по строкам, с округлением до тиына).`,
    );

  // Банковский счёт организации — из реализации; пусто — основной / в валюте реализации.
  const saleBank = refOf(sale["БанковскийСчетОрганизации_Key"]);
  const pick = pickBankForCurrency(accounts, saleCurrency, {
    explicitRef: saleBank,
    preferredRef: refOf(orgCard["ОсновнойБанковскийСчет_Key"]),
  });
  if (pick.note) notes.push(pick.note);
  if (!saleBank)
    notes.push("В реализации не указан банковский счёт организации — подобран по валюте реализации.");
  const bankAcc = accounts.find((a) => a.ref.toLowerCase() === (pick.ref ?? "").toLowerCase());

  // Даты.
  if (turnoverDate < saleDate)
    warnings.push(`Дата оборота ${ru(turnoverDate)} раньше даты реализации ${ru(saleDate)} — проверьте.`);
  if (date < turnoverDate)
    warnings.push(
      `Дата счёта-фактуры ${ru(date)} раньше даты оборота ${ru(turnoverDate)} — так выписывать нельзя.`,
    );
  else if (date > addDays(turnoverDate, 15))
    warnings.push(
      `Счёт-фактура выписывается позже 15 календарных дней после оборота (${ru(turnoverDate)} → ${ru(date)}) — ` +
        "проверьте срок по НК РК (read.system.kz_document_guide, Document_СчетФактураВыданный).",
    );
  const signed = str(sale["ДатаПодписанияГЗ"]).slice(0, 10);
  if (!input.turnoverDate && signed && !signed.startsWith("0001") && signed !== saleDate)
    notes.push(
      `В реализации дата подписания акта ${ru(signed)}, а дата оборота взята по дате реализации ${ru(saleDate)}. ` +
        "Если оборот — по дате подтверждения акта (ЭАВР), передайте turnoverDate.",
    );

  // Дубли: СФ на основании этой реализации.
  const live = existing.filter((r) => r["DeletionMark"] !== true);
  const duplicates = live.map((r) => ({
    ref: str(r["Ref_Key"]),
    number: docNumber(str(r["Number"])),
    date: str(r["Date"]).slice(0, 10),
    posted: r["Posted"] === true,
    total: Number(r["СуммаДокумента"] ?? 0),
  }));
  if (duplicates.length)
    warnings.push(
      `По этой реализации уже есть счёт-фактура: ${duplicates.map((d) => `№ ${d.number} от ${ru(d.date)}${d.posted ? " (проведён)" : ""}`).join("; ")}. ` +
        "Покажите possibleDuplicates пользователю до confirm=true.",
    );
  if (existing.length > live.length)
    notes.push(
      `Ещё ${existing.length - live.length} СФ по этой реализации помечены на удаление — не учитывались.`,
    );

  const contractCurrency = refOf(contractCard["ВалютаВзаиморасчетов_Key"]);
  if (saleCurrency && contractCurrency && contractCurrency.toLowerCase() !== saleCurrency.ref.toLowerCase())
    warnings.push("Валюта реализации не совпадает с валютой договора — проверьте реализацию до выписки СФ.");

  const comment =
    (input.comment?.trim() ? `${input.comment.trim()}. ` : "") +
    `Создан по реализации № ${number} от ${ru(saleDate)}` +
    (toTenge && saleCurrency ? `; курс ${saleCurrency.name} ${rate.rate} на ${ru(turnoverDate)}` : "");
  const payload: Record<string, unknown> = {
    Date: input.date ? `${input.date}T00:00:00` : today.dateTime,
    Организация_Key: orgRef,
    Поставщик_Key: orgRef,
    Грузоотправитель: orgRef,
    Грузоотправитель_Type: ORG_TYPE,
    Контрагент_Key: buyerRef,
    Покупатель_Key: buyerRef,
    Грузополучатель_Key: refOf(sale["Грузополучатель_Key"]) ?? buyerRef,
    ...(contractRef ? { ДоговорКонтрагента_Key: contractRef } : {}),
    ...(pick.ref ? { СчетОрганизации_Key: pick.ref } : {}),
    ...(refOf(buyerCard["ОсновнойБанковскийСчет_Key"])
      ? { СчетКонтрагента_Key: buyerCard["ОсновнойБанковскийСчет_Key"] }
      : {}),
    ...(currency?.ref ? { ВалютаДокумента_Key: currency.ref } : {}),
    КурсВзаиморасчетов: rate.rate,
    КратностьВзаиморасчетов: rate.multiplier,
    ...(refOf(sale["ТипЦен_Key"]) ? { ТипЦен_Key: sale["ТипЦен_Key"] } : {}),
    УчитыватьНДС: withVat,
    СуммаВключаетНДС: vatIncluded,
    УчитыватьАкциз: sale["УчитыватьАкциз"] === true,
    СуммаВключаетАкциз: sale["СуммаВключаетАкциз"] === true,
    СуммаДокумента: total,
    ДатаСовершенияОборотаПоРеализации: `${turnoverDate}T00:00:00`,
    ДатаОборотаВТабличнойЧасти: false,
    ВидСчетаФактуры: "Обычный",
    СпособВыставления: "Электронно",
    ...(str(sale["АдресДоставки"])
      ? { АдресДоставки: sale["АдресДоставки"], ПунктНазначения: sale["АдресДоставки"] }
      : {}),
    ...(refOf(sale["Ответственный_Key"]) ? { Ответственный_Key: sale["Ответственный_Key"] } : {}),
    ...(refOf(sale["СтруктурноеПодразделение_Key"])
      ? { СтруктурноеПодразделение_Key: sale["СтруктурноеПодразделение_Key"] }
      : {}),
    ДокументОснование: saleRef,
    ДокументОснование_Type: SALE_TYPE,
    ДокументыОснования: [{ LineNumber: 1, ДокументОснование: saleRef, ДокументОснование_Type: SALE_TYPE }],
    Комментарий: comment,
    ...(svc.length ? { Услуги: svc } : {}),
    ...(gds.length ? { Товары: gds } : {}),
  };
  for (const k of Object.keys(payload))
    if (EXCHANGE_FIELDS.has(k)) throw new Error(`Внутренняя ошибка: поле обмена ${k} в СФ.`);

  const saleInfo: TaxInvoicePlan["sale"] = {
    ref: saleRef,
    number,
    date: saleDate,
    posted: true,
    total: saleTotal,
    currency: saleCurrency?.name,
    rate: saleRate.rate,
    multiplier: saleRate.multiplier,
  };
  const view = {
    sale: saleInfo,
    date,
    turnoverDate,
    organization: { ref: orgRef, name: str(orgCard["Description"]) },
    buyer: {
      ref: buyerRef,
      name: str(buyerCard["Description"]),
      bin: str(buyerCard["ИдентификационныйКодЛичности"]) || undefined,
    },
    ...(contractRef ? { contract: { ref: contractRef, name: str(contractCard["Description"]) } } : {}),
    ...(pick.ref
      ? {
          bankAccount: {
            ref: pick.ref,
            name: bankAcc?.name || undefined,
            number: bankAcc?.number || undefined,
          },
        }
      : {}),
    ...(currency
      ? {
          currency: {
            code: currency.code,
            name: currency.name,
            rate: rate.rate,
            multiplier: rate.multiplier,
            mode: currency.mode === "tenge" ? "в тенге" : "в валюте реализации",
            source: currency.source,
          },
        }
      : {}),
    lines: [...svc.map((r) => ({ kind: "услуга", r })), ...gds.map((r) => ({ kind: "товар", r }))].map(
      ({ kind, r }) => ({
        kind,
        nomenclatureRef: r["Номенклатура_Key"],
        ...(r["Содержание"] ? { content: r["Содержание"] } : {}),
        quantity: r["Количество"],
        price: r["Цена"],
        sum: r["Сумма"],
        vat: r["СуммаНДС"] ?? 0,
        turnover: r["ОборотПоРеализации"],
      }),
    ),
    totals: { total, vat, withVat, vatIncluded },
    possibleDuplicates: duplicates,
  };
  return {
    ready: choices.length === 0,
    choices,
    notes,
    warnings,
    sale: saleInfo,
    date,
    turnoverDate,
    currency,
    rate,
    payload,
    total,
    vat,
    duplicates,
    view,
  };
}

export async function taxInvoiceFromSale(
  conn: Connection,
  input: TaxInvoiceFromSaleInput,
): Promise<CallToolResult> {
  if (!(await isKazakhstan(conn)))
    throw new InputError(
      `${TAX_INVOICE_FROM_SALE_TOOL} работает с казахстанской базой (БИН/ИИН, тенге, НДС РК).`,
    );
  const requestHash = fingerprintWriteInput(
    TAX_INVOICE_FROM_SALE_TOOL,
    input as unknown as Record<string, unknown>,
  );
  const blocked = writeBlocked(conn);
  const extra = (plan: TaxInvoicePlan) => ({
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    ...(plan.notes.length ? { notes: plan.notes } : {}),
  });

  if (input.confirm) {
    if (!input.operationId)
      throw new InputError("Сначала план (confirm=false). При confirm=true передайте operationId из плана.");
    if (blocked) throw new InputError(blocked);
    const id = subOperationId(input.operationId, "taxInvoice");
    const hash = subRequestHash(requestHash, "taxInvoice");
    const settled = await conn.client.operationSettled(id, hash);
    let ref = settled?.result["Ref_Key"] ? str(settled.result["Ref_Key"]) : "";
    let replayed = !!ref;
    let plan: TaxInvoicePlan | undefined;
    if (!ref) {
      plan = await planTaxInvoiceFromSale(conn, input);
      if (!plan.ready)
        throw new InputError(
          `Нужен выбор: ${plan.choices.map((c) => `${c.field} — ${c.reason} ${c.howTo}`).join(" ")} Затем новый план.`,
        );
      if (!(await conn.client.operationEntry(id)))
        throw new InputError(
          `Счёт-фактура не подготовлен планом с operationId ${input.operationId} (план менялся или делался в режиме ` +
            "только-чтение). Ничего не создано — выполните новый план.",
        );
      const fitted = await fitToMetadata(conn, INVOICE_OUT, plan.payload, plan.notes);
      try {
        const created = await withWriteOperation(id, hash, () =>
          conn.client.create<ODataEntity>(INVOICE_OUT, fitted),
        );
        ref = str(created["Ref_Key"]);
      } catch (e) {
        const unknown = e instanceof ODataError && e.kind === "unknown";
        throw new InputError(
          `Счёт-фактура не создан: ${(e as Error).message} ` +
            (unknown
              ? `Исход неизвестен: сверьте write.operation.status с operationId ${id} — повтор с тем же operationId ` +
                "дубликата не создаст."
              : "Исправьте причину и сделайте новый план."),
        );
      }
      replayed = false;
    }
    const doc = await conn.client
      .getEntity(
        `${INVOICE_OUT}(guid'${ref}')${buildQuery({ select: ["Ref_Key", "Number", "Date", "Posted", "СуммаДокумента", "DeletionMark"] })}`,
      )
      .catch(() => ({}) as ODataEntity);
    return ok({
      created: true,
      ...(replayed ? { replayed: true } : {}),
      database: conn.cfg.name,
      operationId: input.operationId,
      taxInvoice: {
        ref,
        number: docNumber(str(doc["Number"])),
        number1C: str(doc["Number"]),
        date: str(doc["Date"]).slice(0, 10),
        total: Number(doc["СуммаДокумента"] ?? 0),
        posted: doc["Posted"] === true,
      },
      ...(plan ? extra(plan) : {}),
      note:
        (replayed ? "Счёт-фактура уже был создан этой операцией — повторно не создавался. " : "") +
        "Счёт-фактура создан без проведения: проверьте и проведите его (write.document.post_document). ЭСФ — " +
        "отдельно (write.esf.create_draft или модуль ЭСФ в 1С), отправка в ИС ЭСФ — только из 1С с ЭЦП.",
    });
  }

  const plan = await planTaxInvoiceFromSale(conn, input);
  if (!plan.ready)
    return ok({
      dryRun: true,
      ready: false,
      database: conn.cfg.name,
      choices: plan.choices,
      ...plan.view,
      ...extra(plan),
      note: "Нужно уточнение — выберите вариант и повторите план. Ничего не создано.",
    });
  const opId = input.operationId ?? randomUUID();
  const fitted = await fitToMetadata(conn, INVOICE_OUT, plan.payload, plan.notes);
  if (!blocked)
    await withWriteOperation(
      subOperationId(opId, "taxInvoice"),
      subRequestHash(requestHash, "taxInvoice"),
      () => conn.client.prepareCreate(INVOICE_OUT, fitted),
    );
  return ok({
    dryRun: true,
    ready: true,
    database: conn.cfg.name,
    operationId: opId,
    ...plan.view,
    willCreate: ["Счёт-фактура выданный (без проведения)"],
    ...extra(plan),
    note:
      (blocked ? `${blocked} План показан, но создать нельзя. ` : "") +
      (plan.warnings.length ? "Покажите warnings пользователю. " : "") +
      "Ничего не создано. Покажите план пользователю; после его согласия — confirm=true с этим operationId и теми же аргументами.",
  });
}

export function registerTaxInvoiceFromSaleTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    TAX_INVOICE_FROM_SALE_TOOL,
    {
      title: "Счёт-фактура выданный на основании реализации (Казахстан)",
      description:
        "Счёт-фактура выданный по ПРОВЕДЁННОЙ реализации — как «Ввести на основании» в 1С. sale — ref или номер " +
        "реализации (+ saleDate/saleYear). Из реализации: организация (поставщик и грузоотправитель), покупатель " +
        "(и грузополучатель), договор, строки товаров и услуг (количество, цена, сумма, ставка и сумма НДС), флаги НДС, " +
        "банковский счёт организации, валюта и курс; оборот по реализации — по строкам; ДокументОснование и " +
        "ДокументыОснования — реализация. turnoverDate — дата совершения оборота (по умолчанию дата реализации). " +
        "Валютная реализация: currencyMode tenge (по умолчанию) — СФ в тенге по курсу на дату оборота; basis — в валюте " +
        "и по курсу реализации; auto — как в прошлых проведённых СФ организации, их нет — вопрос в choices. " +
        "Непроведённая или помеченная на удаление реализация — отказ. confirm=false (по умолчанию) — план (warnings, " +
        "possibleDuplicates — уже выписанные СФ по этой реализации; показать пользователю), ничего не пишет. " +
        "confirm=true с тем же operationId и аргументами — СФ БЕЗ проведения. Поля обмена с ИС ЭСФ не заполняются; " +
        "ЭСФ — отдельно (write.esf.create_draft). Подтверждайте только с согласия пользователя.",
      inputSchema: taxInvoiceFromSaleInput,
      outputSchema: z
        .object({
          database: z.string(),
          dryRun: z.boolean().optional(),
          ready: z.boolean().optional(),
          created: z.boolean().optional(),
          operationId: z.string().optional(),
        })
        .passthrough(),
    },
    (args) =>
      guard(TAX_INVOICE_FROM_SALE_TOOL, async () => {
        const input = z.object(taxInvoiceFromSaleInput).parse(args) as TaxInvoiceFromSaleInput;
        return taxInvoiceFromSale(ctx.db(input.database), input);
      }),
  );
}
