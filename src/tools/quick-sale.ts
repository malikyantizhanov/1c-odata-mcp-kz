import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { CATALOGS, DOCUMENTS } from "../config/mapping.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, contains, odataGuid, or } from "../odata/query.js";
import { fingerprintWriteInput, withWriteOperation } from "../odata/write-operation-context.js";
import { ODataError } from "../odata/errors.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok, organizationField } from "./_shared.js";
import { isKazakhstan } from "./write-kz.js";
import { fillFromSample } from "./kz-flow.js";
import { findInvoiceByNumber, printTarget } from "./print.js";
import { printSale, printedFilesOutput, type SaleForm } from "./print-sale.js";
import {
  almatyNow,
  contractPayload,
  docNumber,
  lineSchema,
  nomenclaturePayload,
  planQuickInvoice,
  subOperationId,
  subRequestHash,
  writeBlocked,
  type Choice,
  type QuickInput,
  type QuickPlan,
} from "./quick-invoice.js";

/**
 * Реализация товаров и услуг «в один вызов» (Казахстан): на основании счёта на оплату покупателю или напрямую
 * (покупатель + строки, как quick_invoice). confirm=false — план (параллельные чтения, варианты при
 * неоднозначности, проверка дублей, operationId); confirm=true с тем же operationId — реализация БЕЗ проведения
 * + PDF акта Р-1 / накладной З-2. Шаги — операции журнала записи: повтор не создаёт дубликатов.
 *
 * Заполнение «на основании» — как в 1С (Документы.РеализацияТоваровУслуг.ЗаполнитьДокументПоСчетуНаОплатуПокупателю
 * + ЗаполнениеДокументов.ЗаполнитьШапкуДокументаПоОснованию): организация, структурное подразделение, склад,
 * ответственный, контрагент, договор (если он той же организации), валюта = валюта взаиморасчётов договора, тип цен,
 * флаги НДС и акциза, адрес доставки, банковский счёт = «Структурная единица» счёта, ДокументОснование = счёт,
 * способ выписки АВР = из договора (пусто — «на портале госзакупа» для госучреждения, иначе «в бумажном виде»),
 * вид операции = товары / услуги / «продажа, комиссия» по составу строк, строки товаров и услуг — копия строк счёта.
 * Счета учёта 1С подставляет при вводе в форме (СчетаУчетаВДокументах), через OData — нет: они, вид учёта НУ,
 * вид операции НДС и субконто берутся из последней реализации той же организации с такими же строками
 * (проведённая — в приоритете); субконто «Номенклатура» / «Номенклатурные группы» — по позиции строки.
 */
export const QUICK_SALE_TOOL = "write.sales.quick_sale";
const BASIS_TYPE = "StandardODATA.Document_СчетНаОплатуПокупателю";
const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const isGuid = (s: string | undefined): boolean => !!s && GUID_RE.test(s.trim());
const guid = (s: string): string => s.trim().replace(/[{}]/g, "");
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const refOf = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const SAMPLE_CANDIDATES = 30;

export const quickSaleInput = {
  database: databaseField,
  basis: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Счёт на оплату покупателю — основание: Ref_Key или номер («3», «00000000003»). С основанием покупатель, " +
        "договор и строки берутся из счёта (buyer/lines не нужны).",
    ),
  basisDate: dateField("Дата счёта-основания — сужает поиск по номеру").optional(),
  basisYear: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .optional()
    .describe("Год счёта-основания — сужает поиск по номеру"),
  date: dateField("Дата реализации; по умолчанию — сейчас (Алматы)").optional(),
  organization: organizationField,
  buyer: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Без основания: покупатель — БИН/ИИН, Ref_Key или наименование (как в quick_invoice)"),
  buyerName: z
    .string()
    .max(500)
    .optional()
    .describe("Наименование покупателя — для сверки с найденным по БИН"),
  lines: z
    .array(lineSchema)
    .min(1)
    .max(100)
    .optional()
    .describe("Без основания: позиции (как в quick_invoice)"),
  contract: z
    .string()
    .max(200)
    .optional()
    .describe("Без основания: договор — Ref_Key, номер или наименование"),
  bankAccount: z.string().max(200).optional().describe("Без основания: банковский счёт организации"),
  sumIncludesVat: z
    .boolean()
    .default(true)
    .describe("Без основания: цена включает НДС (для плательщика НДС)"),
  warehouse: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Склад для товаров: Ref_Key или наименование. По умолчанию — из основания, единственный склад или склад образца.",
    ),
  print: z
    .enum(["auto", "act", "waybill", "none"])
    .default("auto")
    .describe("PDF после создания: auto — Р-1 для услуг и/или З-2 для товаров; none — без PDF."),
  outputDir: z
    .string()
    .max(500)
    .optional()
    .describe("Подкаталог для PDF внутри ODATA_PRINT_DIR (как у print_sale)"),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "false (по умолчанию) — только план, ничего не создаётся. true — создать реализацию (без проведения) и PDF: " +
        "передайте operationId из плана и те же аргументы. После таймаута/сбоя повторяйте с тем же operationId.",
    ),
  operationId: z.string().uuid().optional().describe("operationId из плана (обязателен при confirm=true)"),
};

export type QuickSaleInput = {
  database?: string | undefined;
  basis?: string | undefined;
  basisDate?: string | undefined;
  basisYear?: number | undefined;
  date?: string | undefined;
  organization?: string | undefined;
  buyer?: string | undefined;
  buyerName?: string | undefined;
  lines?: QuickInput["lines"] | undefined;
  contract?: string | undefined;
  bankAccount?: string | undefined;
  sumIncludesVat: boolean;
  warehouse?: string | undefined;
  print: "auto" | "act" | "waybill" | "none";
  outputDir?: string | undefined;
  confirm: boolean;
  operationId?: string | undefined;
};

export interface DuplicateSale {
  number: string;
  date: string;
  ref: string;
  total: number;
  posted: boolean;
  /** «same_basis» — на основании того же счёта; «same_day_sum» — тот же покупатель, день и сумма. */
  reason: "same_basis" | "same_day_sum";
}

export interface SalePlan {
  ready: boolean;
  choices: Choice[];
  notes: string[];
  mode: "basis" | "direct";
  basis?: { ref: string; number: string; date: string; total: number; posted: boolean } | undefined;
  org: { ref: string; name: string };
  buyer?: { ref: string; name: string; bin?: string | undefined } | undefined;
  contract?: { ref?: string | undefined; name: string; action: "use" | "create" } | undefined;
  date: string;
  dateTime: string;
  operationKind: string;
  header: Record<string, unknown>;
  services: Array<Record<string, unknown>>;
  goods: Array<Record<string, unknown>>;
  /** Строки, чья номенклатура создаётся (прямой режим): индекс строки → шаг nomenclature:i. */
  createdNom: Map<Record<string, unknown>, string>;
  total: number;
  saleSet: string;
  sample?: { ref: string; number: string; date: string; posted: boolean; tables: string[] } | undefined;
  filled: string[];
  duplicates: DuplicateSale[];
  invoicePlan?: QuickPlan | undefined;
}

/** Вид операции по составу строк — как ОпределитьВидОперацииПоДокументуОснованию. */
export function operationKind(goods: number, services: number): string {
  if (goods > 0 && services === 0) return "Товары";
  if (goods === 0 && services > 0) return "Услуги";
  return "ПродажаКомиссия";
}

const SERVICE_FIELDS = [
  "Содержание",
  "Количество",
  "Цена",
  "Сумма",
  "СтавкаНДС_Key",
  "СуммаНДС",
  "Номенклатура_Key",
];
const GOODS_FIELDS = [
  "Номенклатура_Key",
  "ЕдиницаИзмерения_Key",
  "Цена",
  "Сумма",
  "СтавкаНДС_Key",
  "СуммаНДС",
  "СтавкаАкциза_Key",
  "СуммаАкциза",
  "Коэффициент",
  "Количество",
];

/** Строки счёта → строки реализации (СкопироватьТовары / СкопироватьУслуги): только эти колонки, по порядку. */
export function copyRows(rows: ODataEntity[] | undefined, fields: string[]): Array<Record<string, unknown>> {
  return [...(rows ?? [])]
    .sort((a, b) => Number(a["LineNumber"] ?? 0) - Number(b["LineNumber"] ?? 0))
    .map((r, i) => {
      const out: Record<string, unknown> = { LineNumber: i + 1 };
      for (const f of fields) if (r[f] !== undefined && r[f] !== null) out[f] = r[f];
      return out;
    });
}

/**
 * Субконто строк после образца: «Номенклатура» — позиция строки, «Номенклатурные группы» — группа позиции
 * (когда она известна), остальное (статья доходов и т. п.) — как в образце.
 */
export function fixSubconto(
  rows: Array<Record<string, unknown>>,
  groups: Map<string, string>,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const next = { ...r };
    const nom = refOf(r["Номенклатура_Key"]);
    for (const [k, v] of Object.entries(r)) {
      if (!k.endsWith("_Type") || !k.startsWith("Субконто")) continue;
      const field = k.slice(0, -"_Type".length);
      if (v === "StandardODATA.Catalog_Номенклатура" && nom) next[field] = nom;
      if (v === "StandardODATA.Catalog_НоменклатурныеГруппы" && nom && groups.get(nom))
        next[field] = groups.get(nom);
    }
    return next;
  });
}

const hasAccounts = (rows: unknown, field: string): boolean =>
  Array.isArray(rows) && rows.some((r) => !!refOf((r as ODataEntity)[field]));

/** Образец счетов: последняя реализация той же организации с такими строками; проведённая — в приоритете. */
export function pickSample(
  candidates: ODataEntity[],
  orgRef: string,
  table: "Услуги" | "Товары",
): ODataEntity | undefined {
  const field = table === "Услуги" ? "СчетДоходовБУ_Key" : "СчетУчетаБУ_Key";
  const ok = candidates.filter(
    (c) => c["DeletionMark"] !== true && c["Организация_Key"] === orgRef && hasAccounts(c[table], field),
  );
  return ok.find((c) => c["Posted"] === true) ?? ok[0];
}

/**
 * Возможные дубли среди реализаций покупателя: на основании того же счёта (любая дата) или тот же день и та же
 * сумма. Помеченные на удаление не считаются (упоминаются в notes). Ошибка поиска не мешает плану.
 */
export async function findDuplicateSales(
  conn: Connection,
  saleSet: string,
  q: { buyerRef: string; orgRef: string; date: string; total: number; basisRef?: string | undefined },
): Promise<{ duplicates: DuplicateSale[]; notes: string[] }> {
  try {
    const { rows } = await fetchAll(
      conn.client,
      saleSet,
      {
        filter: and(
          cmp("Контрагент_Key", "eq", odataGuid(q.buyerRef)),
          cmp("Организация_Key", "eq", odataGuid(q.orgRef)),
        ),
        select: [
          "Ref_Key",
          "Number",
          "Date",
          "Posted",
          "DeletionMark",
          "СуммаДокумента",
          "ДокументОснование",
          "ДокументОснование_Type",
        ],
        orderby: "Date desc",
      },
      100,
      500,
    );
    const sameBasis = (r: ODataEntity) =>
      !!q.basisRef && r["ДокументОснование"] === q.basisRef && r["ДокументОснование_Type"] === BASIS_TYPE;
    const sameDay = (r: ODataEntity) => str(r["Date"]).slice(0, 10) === q.date;
    const sameSum = (r: ODataEntity) => Math.abs(Number(r["СуммаДокумента"] ?? 0) - q.total) < 0.005;
    const hits = rows.filter((r) => sameBasis(r) || (sameDay(r) && sameSum(r)));
    const live = hits.filter((r) => r["DeletionMark"] !== true);
    const marked = hits.length - live.length;
    const duplicates: DuplicateSale[] = live.map((r) => ({
      number: docNumber(str(r["Number"])),
      date: str(r["Date"]).slice(0, 10),
      ref: str(r["Ref_Key"]),
      total: Number(r["СуммаДокумента"] ?? 0),
      posted: r["Posted"] === true,
      reason: sameBasis(r) ? "same_basis" : "same_day_sum",
    }));
    const notes: string[] = [];
    if (duplicates.length)
      notes.push(
        "ВНИМАНИЕ, возможный дубль: " +
          duplicates
            .map(
              (d) =>
                `реализация № ${d.number} от ${d.date} на ${d.total} (ref ${d.ref}, ${d.posted ? "проведена" : "не проведена"}) — ` +
                (d.reason === "same_basis"
                  ? "на основании этого же счёта"
                  : "тот же покупатель, день и сумма"),
            )
            .join("; ") +
          ". Покажите possibleDuplicates пользователю до confirm=true: «использовать существующую» или «создать ещё».",
      );
    if (marked) notes.push(`Ещё ${marked} похожая(их) реализация(й) помечены на удаление — не учитывались.`);
    const others = rows.filter((r) => r["DeletionMark"] !== true && sameDay(r) && !hits.includes(r));
    if (others.length)
      notes.push(
        `У покупателя за ${q.date} есть ещё реализация(и) на другие суммы/основания: ` +
          others
            .map((r) => {
              const basis =
                r["ДокументОснование_Type"] === BASIS_TYPE && refOf(r["ДокументОснование"])
                  ? `, основание — счёт ref ${String(r["ДокументОснование"])}`
                  : "";
              return `№ ${docNumber(str(r["Number"]))} на ${Number(r["СуммаДокумента"] ?? 0)}${basis}`;
            })
            .join("; ") +
          " — не дубль по правилам проверки, но покажите пользователю.",
      );
    return { duplicates, notes };
  } catch (e) {
    return { duplicates: [], notes: [`Проверка на дубли не выполнена: ${(e as Error).message}`] };
  }
}

async function readOpt(conn: Connection, set: string, key: string | undefined, select: string[]) {
  if (!key) return {} as ODataEntity;
  return conn.client
    .getEntity(`${set}(guid'${key}')${buildQuery({ select })}`)
    .catch(() => ({}) as ODataEntity);
}

/** Склад для товаров: явный (ref/наименование) → из основания → единственный → склад образца → выбор. */
async function resolveWarehouse(
  conn: Connection,
  input: string | undefined,
  fromBasis: string | undefined,
  fromSample: string | undefined,
): Promise<{ ref?: string | undefined; choice?: Choice | undefined; note?: string | undefined }> {
  const available = await conn.available();
  const set = CATALOGS.warehouses?.find((s) => available.has(s)) ?? "Catalog_Склады";
  if (input && isGuid(input)) return { ref: guid(input) };
  if (!input && fromBasis) return { ref: fromBasis };
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(cmp("DeletionMark", "eq", "false"), input ? contains("Description", input) : undefined),
      select: ["Ref_Key", "Description"],
    },
    50,
    50,
  );
  const exact = input
    ? rows.filter((r) => str(r["Description"]).toLowerCase() === input.toLowerCase())
    : rows;
  const pick = exact.length ? exact : rows;
  if (pick.length === 1) return { ref: str(pick[0]!["Ref_Key"]) };
  if (!input && fromSample && rows.some((r) => r["Ref_Key"] === fromSample))
    return {
      ref: fromSample,
      note: `Склад не указан и в основании пуст — взят склад последней реализации с товарами (${String(rows.find((r) => r["Ref_Key"] === fromSample)?.["Description"] ?? fromSample)}).`,
    };
  return {
    choice: {
      field: "warehouse",
      reason: pick.length ? "Складов несколько — нужен выбор." : `Склад «${input ?? ""}» не найден.`,
      options: rows.slice(0, 10).map((r) => ({ ref: r["Ref_Key"], name: r["Description"] })),
      howTo: "Передайте warehouse (Ref_Key или точное наименование).",
    },
  };
}

export async function planQuickSale(conn: Connection, input: QuickSaleInput): Promise<SalePlan> {
  if (!input.basis && !(input.buyer && input.lines?.length))
    throw new InputError(
      "Укажите basis (счёт на оплату — ref или номер) или buyer и lines для реализации без основания.",
    );
  if (input.basis && (input.buyer || input.lines?.length))
    throw new InputError(
      "С основанием (basis) покупатель и строки берутся из счёта — не передавайте buyer/lines.",
    );
  const today = almatyNow();
  const date = input.date ?? today.date;
  const dateTime = input.date ? `${input.date}T00:00:00` : today.dateTime;
  const [saleSet, meta] = await Promise.all([
    requireEntity(conn, DOCUMENTS.sales, "Документ «Реализация товаров и услуг»"),
    conn.getMetadata(),
  ]);
  const em = meta.entities.get(saleSet);
  if (!em) throw new InputError(`${saleSet} нет в метаданных.`);
  // Кандидаты в образец счетов учёта — параллельно с основным чтением.
  const candidatesP = fetchAll(
    conn.client,
    saleSet,
    { filter: cmp("DeletionMark", "eq", "false"), orderby: "Date desc" },
    SAMPLE_CANDIDATES,
    SAMPLE_CANDIDATES,
  )
    .then((r) => r.rows)
    .catch(() => [] as ODataEntity[]);

  const nomSet = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
  const dupsFor = (q: { buyerRef: string; orgRef: string; total: number; basisRef?: string }) =>
    findDuplicateSales(conn, saleSet, { ...q, date });
  const groupsFor = (rows: Array<Record<string, unknown>>): Promise<ODataEntity[]> => {
    const refs = [...new Set(rows.map((r) => refOf(r["Номенклатура_Key"])).filter((r): r is string => !!r))];
    if (!refs.length) return Promise.resolve([]);
    return fetchAll(
      conn.client,
      nomSet,
      {
        filter: or(...refs.map((r) => cmp("Ref_Key", "eq", odataGuid(r)))),
        select: ["Ref_Key", "НоменклатурнаяГруппа_Key"],
      },
      50,
      refs.length,
    )
      .then((r) => r.rows)
      .catch(() => [] as ODataEntity[]);
  };
  // В режиме «на основании» дубли и группы номенклатуры известны сразу после чтения счёта —
  // их запросы идут параллельно с карточками организации/покупателя/договора (на одну волну меньше).
  let dupP: ReturnType<typeof dupsFor> | undefined;
  let groupsP: Promise<ODataEntity[]> | undefined;

  const notes: string[] = [];
  const choices: Choice[] = [];
  const filled: string[] = [];
  let header: Record<string, unknown>;
  let services: Array<Record<string, unknown>>;
  let goods: Array<Record<string, unknown>>;
  let basisInfo: SalePlan["basis"];
  let org: SalePlan["org"];
  let buyer: SalePlan["buyer"];
  let contract: SalePlan["contract"];
  let total: number;
  let invoicePlan: QuickPlan | undefined;
  const createdNom = new Map<Record<string, unknown>, string>();
  let basisWarehouse: string | undefined;

  if (input.basis) {
    const invoiceSet = await requireEntity(
      conn,
      DOCUMENTS.customerInvoice,
      "Документ «Счёт на оплату покупателю»",
    );
    const basisRef = isGuid(input.basis)
      ? guid(input.basis)
      : (await findInvoiceByNumber(conn, input.basis, { date: input.basisDate, year: input.basisYear })).ref;
    const basis = await conn.client.getEntity(`${invoiceSet}(guid'${basisRef}')?$format=json`);
    if (basis["DeletionMark"] === true)
      throw new InputError(
        `Счёт № ${docNumber(str(basis["Number"]))} помечен на удаление — на его основании реализацию не вводят.`,
      );
    const orgRef = str(basis["Организация_Key"]);
    const buyerRef = str(basis["Контрагент_Key"]);
    const contractRef = refOf(basis["ДоговорКонтрагента_Key"]);
    services = copyRows(basis["Услуги"] as ODataEntity[] | undefined, SERVICE_FIELDS);
    goods = copyRows(basis["Товары"] as ODataEntity[] | undefined, GOODS_FIELDS);
    total = Number(basis["СуммаДокумента"] ?? 0);
    if (services.length || goods.length) {
      dupP = dupsFor({ buyerRef, orgRef, total, basisRef });
      groupsP = groupsFor([...services, ...goods]);
      // Не даём «висящим» отказам стать unhandled rejection, если ниже будет InputError.
      dupP.catch(() => undefined);
    }
    const [orgCard, buyerCard, contractCard] = await Promise.all([
      readOpt(conn, "Catalog_Организации", orgRef, ["Description"]),
      readOpt(conn, "Catalog_Контрагенты", buyerRef, [
        "Description",
        "ИдентификационныйКодЛичности",
        "ГосударственноеУчреждение",
      ]),
      readOpt(conn, "Catalog_ДоговорыКонтрагентов", contractRef, [
        "Description",
        "Организация_Key",
        "ВалютаВзаиморасчетов_Key",
        "СпособВыпискиАктовВыполненныхРабот",
        "DeletionMark",
      ]),
    ]);
    basisInfo = {
      ref: basisRef,
      number: docNumber(str(basis["Number"])),
      date: str(basis["Date"]).slice(0, 10),
      total: Number(basis["СуммаДокумента"] ?? 0),
      posted: basis["Posted"] === true,
    };
    org = { ref: orgRef, name: str(orgCard["Description"]) };
    buyer = {
      ref: buyerRef,
      name: str(buyerCard["Description"]),
      bin: str(buyerCard["ИдентификационныйКодЛичности"]) || undefined,
    };
    // Договор — только если он той же организации (как ЗаполнитьШапкуДокументаПоОснованию).
    const contractOk = contractRef && contractCard["Организация_Key"] === orgRef;
    if (contractRef && !contractOk)
      choices.push({
        field: "contract",
        reason:
          "Договор счёта принадлежит другой организации — 1С при вводе на основании оставит договор пустым.",
        options: [],
        howTo: "Исправьте договор в счёте или создайте реализацию без основания (buyer + lines + contract).",
      });
    contract = contractOk
      ? { ref: contractRef, name: str(contractCard["Description"]), action: "use" }
      : undefined;
    const currency = refOf(contractCard["ВалютаВзаиморасчетов_Key"]) ?? refOf(basis["ВалютаДокумента_Key"]);
    const actsWay =
      str(contractCard["СпособВыпискиАктовВыполненныхРабот"]) ||
      (buyerCard["ГосударственноеУчреждение"] === true ? "НаПорталеГосЗакупа" : "ВБумажномВиде");
    const bankRef =
      str(basis["СтруктурнаяЕдиница_Type"]) === "StandardODATA.Catalog_БанковскиеСчета"
        ? refOf(basis["СтруктурнаяЕдиница"])
        : undefined;
    if (!services.length && !goods.length)
      throw new InputError(
        `В счёте № ${basisInfo.number} нет строк товаров и услуг — реализацию заполнить нечем.`,
      );
    if (((basis["ОС"] as unknown[] | undefined) ?? []).length)
      notes.push(
        "Строки «ОС» счёта в реализацию не переносятся (так же делает 1С) — основные средства продают отдельным документом.",
      );
    basisWarehouse = refOf(basis["Склад_Key"]);
    header = {
      Date: dateTime,
      Posted: false,
      Организация_Key: orgRef,
      ...(refOf(basis["СтруктурноеПодразделение_Key"])
        ? { СтруктурноеПодразделение_Key: basis["СтруктурноеПодразделение_Key"] }
        : {}),
      ...(refOf(basis["Ответственный_Key"]) ? { Ответственный_Key: basis["Ответственный_Key"] } : {}),
      Контрагент_Key: buyerRef,
      ...(contractOk ? { ДоговорКонтрагента_Key: contractRef } : {}),
      ...(currency ? { ВалютаДокумента_Key: currency } : {}),
      КурсВзаиморасчетов: basis["КурсВзаиморасчетов"] ?? 1,
      КратностьВзаиморасчетов: basis["КратностьВзаиморасчетов"] ?? 1,
      ...(refOf(basis["ТипЦен_Key"]) ? { ТипЦен_Key: basis["ТипЦен_Key"] } : {}),
      УчитыватьНДС: basis["УчитыватьНДС"] === true,
      СуммаВключаетНДС: basis["СуммаВключаетНДС"] === true,
      УчитыватьАкциз: basis["УчитыватьАкциз"] === true,
      СуммаВключаетАкциз: basis["СуммаВключаетАкциз"] === true,
      ...(str(basis["АдресДоставки"]) ? { АдресДоставки: basis["АдресДоставки"] } : {}),
      ...(bankRef ? { БанковскийСчетОрганизации_Key: bankRef } : {}),
      ДокументОснование: basisRef,
      ДокументОснование_Type: BASIS_TYPE,
      СпособВыпискиАктовВыполненныхРабот: actsWay,
      СуммаДокумента: total,
    };
    filled.push(
      "из счёта: организация, контрагент, договор, ответственный, тип цен, флаги НДС/акциза, адрес доставки, " +
        "банковский счёт, строки товаров и услуг; валюта — из договора; ДокументОснование — счёт",
    );
    if (!basisInfo.posted)
      notes.push(
        `Счёт-основание № ${basisInfo.number} не проведён — 1С позволяет вводить на его основании, просто к сведению.`,
      );
    if (currency && Number(header["КурсВзаиморасчетов"]) !== 1)
      notes.push(
        "Курс взаиморасчётов скопирован из счёта — 1С пересчитала бы его на дату реализации; проверьте в 1С.",
      );
  } else {
    invoicePlan = await planQuickInvoice(
      conn,
      {
        database: input.database,
        organization: input.organization,
        buyer: input.buyer!,
        buyerName: input.buyerName,
        date: input.date,
        lines: input.lines!,
        contract: input.contract,
        bankAccount: input.bankAccount,
        sumIncludesVat: input.sumIncludesVat,
        confirm: false,
      },
      { forSale: true },
    );
    choices.push(...invoicePlan.choices);
    notes.push(...invoicePlan.notes);
    org = { ref: invoicePlan.org.ref, name: invoicePlan.org.name };
    buyer = invoicePlan.buyer;
    contract = invoicePlan.contract
      ? {
          ref: invoicePlan.contract.ref,
          name: invoicePlan.contract.name,
          action: invoicePlan.contract.action,
        }
      : undefined;
    const p = invoicePlan;
    services = [];
    goods = [];
    p.lines.forEach((l) => {
      const common: Record<string, unknown> = {
        ...(l.ref ? { Номенклатура_Key: l.ref } : {}),
        Количество: l.quantity,
        Цена: l.price,
        Сумма: l.sum,
        ...(p.withVat ? { СтавкаНДС_Key: p.vatRefs.get(l.vatRate) } : {}),
        СуммаНДС: l.vat,
      };
      const row =
        l.kind === "service"
          ? { LineNumber: services.length + 1, Содержание: l.content, ...common }
          : { LineNumber: goods.length + 1, ...common, ЕдиницаИзмерения_Key: l.unitRef, Коэффициент: 1 };
      if (l.action === "create") createdNom.set(row, `nomenclature:${l.index}`);
      (l.kind === "service" ? services : goods).push(row);
    });
    total = p.totals.total;
    let actsWay = "ВБумажномВиде";
    if (contract?.ref || buyer?.ref) {
      const [c, b] = await Promise.all([
        readOpt(conn, "Catalog_ДоговорыКонтрагентов", contract?.ref, ["СпособВыпискиАктовВыполненныхРабот"]),
        readOpt(conn, "Catalog_Контрагенты", buyer?.ref, ["ГосударственноеУчреждение"]),
      ]);
      actsWay =
        str(c["СпособВыпискиАктовВыполненныхРабот"]) ||
        (b["ГосударственноеУчреждение"] === true ? "НаПорталеГосЗакупа" : "ВБумажномВиде");
    }
    header = {
      Date: dateTime,
      Posted: false,
      Организация_Key: org.ref,
      ...(buyer ? { Контрагент_Key: buyer.ref } : {}),
      ...(contract?.ref ? { ДоговорКонтрагента_Key: contract.ref } : {}),
      ...(p.currencyRef ? { ВалютаДокумента_Key: p.currencyRef } : {}),
      КурсВзаиморасчетов: 1,
      КратностьВзаиморасчетов: 1,
      УчитыватьНДС: p.withVat,
      СуммаВключаетНДС: p.withVat && input.sumIncludesVat,
      ...(p.bank ? { БанковскийСчетОрганизации_Key: p.bank.ref } : {}),
      СпособВыпискиАктовВыполненныхРабот: actsWay,
      СуммаДокумента: total,
    };
    filled.push(
      "как quick_invoice: организация, покупатель по БИН, договор, номенклатура, ставки НДС, банковский счёт",
    );
  }

  const kind = operationKind(goods.length, services.length);
  header["ВидОперации"] = kind;
  if (header["СпособВыпискиАктовВыполненныхРабот"] === "ВБумажномВиде") header["ДатаПодписанияГЗ"] = dateTime;

  // Образцы счетов учёта, дубли, группы номенклатуры — параллельно (в режиме «на основании» уже запущены).
  const [candidates, dupRes, groupRows] = await Promise.all([
    candidatesP,
    dupP ??
      (buyer
        ? dupsFor({ buyerRef: buyer.ref, orgRef: org.ref, total, basisRef: basisInfo?.ref })
        : Promise.resolve({ duplicates: [] as DuplicateSale[], notes: [] as string[] })),
    groupsP ?? groupsFor([...services, ...goods]),
  ]);
  notes.unshift(...dupRes.notes);
  const groups = new Map(
    groupRows
      .map((r) => [str(r["Ref_Key"]), refOf(r["НоменклатурнаяГруппа_Key"])] as const)
      .filter((e): e is readonly [string, string] => !!e[1]),
  );
  const sampleS = services.length ? pickSample(candidates, org.ref, "Услуги") : undefined;
  const sampleG = goods.length ? pickSample(candidates, org.ref, "Товары") : undefined;
  let payload: Record<string, unknown> = {
    ...header,
    ...(services.length ? { Услуги: services } : {}),
  };
  const samples: Array<{ s: ODataEntity; table: string }> = [];
  if (sampleS) {
    const r = fillFromSample(meta, em, payload, sampleS);
    payload = r.payload;
    samples.push({ s: sampleS, table: "Услуги" });
  }
  if (goods.length) {
    payload = { ...payload, Товары: goods };
    if (sampleG) {
      payload = fillFromSample(meta, em, payload, sampleG).payload;
      samples.push({ s: sampleG, table: "Товары" });
    }
  }
  if (services.length && !sampleS)
    notes.push(
      "Нет реализации этой организации со строками услуг и счетами учёта — счета доходов в строках не заполнены; " +
        "перед проведением заполните их в 1С (или сначала проведите одну реализацию услуг из 1С).",
    );
  if (goods.length && !sampleG)
    notes.push(
      "Нет реализации этой организации со строками товаров и счетами учёта — счета учёта/себестоимости в строках не " +
        "заполнены; перед проведением заполните их в 1С.",
    );
  const sample = samples[0]?.s;
  // УчитыватьКПН — признак организации; через OData 1С его не ставит — как в образце той же организации.
  if (sample && typeof sample["УчитыватьКПН"] === "boolean") payload["УчитыватьКПН"] = sample["УчитыватьКПН"];
  if (samples.length) {
    filled.push(
      "счета учёта, вид учёта НУ, вид операции НДС, субконто — из реализации " +
        samples
          .map(
            ({ s, table }) =>
              `№ ${docNumber(str(s["Number"]))} от ${str(s["Date"]).slice(0, 10)} (${table}${s["Posted"] === true ? ", проведена" : ", не проведена"})`,
          )
          .join(" и "),
    );
    if (samples.some(({ s }) => s["Posted"] !== true))
      notes.push(
        "Образец счетов учёта не проведён (проведённой реализации с такими строками нет) — счета взяты из неё; " +
          "1С проверит их при проведении.",
      );
  }
  // Субконто по позиции строки.
  if (Array.isArray(payload["Услуги"]))
    payload["Услуги"] = fixSubconto(payload["Услуги"] as Array<Record<string, unknown>>, groups);
  if (Array.isArray(payload["Товары"]))
    payload["Товары"] = fixSubconto(payload["Товары"] as Array<Record<string, unknown>>, groups);

  // Склад — только для товаров.
  if (goods.length) {
    const w = await resolveWarehouse(conn, input.warehouse, basisWarehouse, refOf(sampleG?.["Склад_Key"]));
    if (w.choice) choices.push(w.choice);
    if (w.note) notes.push(w.note);
    if (w.ref) payload["Склад_Key"] = w.ref;
  } else if (input.warehouse)
    notes.push("Склад указан, но строк товаров нет — склад не нужен и не заполнен.");

  // Строки с создаваемой номенклатурой: найти их в payload по порядку (fill/fix копируют объекты).
  const mapped = new Map<Record<string, unknown>, string>();
  for (const table of ["Услуги", "Товары"] as const) {
    const src = table === "Услуги" ? services : goods;
    const out = (payload[table] as Array<Record<string, unknown>> | undefined) ?? [];
    src.forEach((row, i) => {
      const step = createdNom.get(row);
      if (step && out[i]) mapped.set(out[i]!, step);
    });
  }

  return {
    ready: choices.length === 0,
    choices,
    notes,
    mode: input.basis ? "basis" : "direct",
    basis: basisInfo,
    org,
    buyer,
    contract,
    date,
    dateTime,
    operationKind: kind,
    header: payload,
    services: (payload["Услуги"] as Array<Record<string, unknown>> | undefined) ?? [],
    goods: (payload["Товары"] as Array<Record<string, unknown>> | undefined) ?? [],
    createdNom: mapped,
    total,
    saleSet,
    sample: sample
      ? {
          ref: str(sample["Ref_Key"]),
          number: docNumber(str(sample["Number"])),
          date: str(sample["Date"]).slice(0, 10),
          posted: sample["Posted"] === true,
          tables: samples.map((x) => x.table),
        }
      : undefined,
    filled,
    duplicates: dupRes.duplicates,
    invoicePlan,
  };
}

interface Step {
  step: string;
  entitySet: string;
  payload: Record<string, unknown>;
  label: string;
}

/** Payload реализации: ссылки на создаваемые договор/номенклатуру — назначенные журналом. */
export function salePayload(
  plan: SalePlan,
  assigned: Map<string, string | undefined>,
): Record<string, unknown> {
  const sub = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => {
      const step = plan.createdNom.get(r);
      if (!step) return r;
      const ref = assigned.get(step);
      const next: Record<string, unknown> = { ...r, ...(ref ? { Номенклатура_Key: ref } : {}) };
      for (const [k, v] of Object.entries(r))
        if (
          k.startsWith("Субконто") &&
          k.endsWith("_Type") &&
          v === "StandardODATA.Catalog_Номенклатура" &&
          ref
        )
          next[k.slice(0, -5)] = ref;
      return next;
    });
  const out: Record<string, unknown> = { ...plan.header };
  if (plan.services.length) out["Услуги"] = sub(plan.services);
  if (plan.goods.length) out["Товары"] = sub(plan.goods);
  if (plan.contract?.action === "create") {
    const ref = assigned.get("contract");
    if (ref) out["ДоговорКонтрагента_Key"] = ref;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function steps(plan: SalePlan, assigned: Map<string, string | undefined>): Step[] {
  const out: Step[] = [];
  const ip = plan.invoicePlan;
  if (ip && plan.contract?.action === "create")
    out.push({
      step: "contract",
      entitySet: ip.contractSet!,
      payload: contractPayload(ip),
      label: `Договор «${plan.contract.name}»`,
    });
  if (ip)
    ip.lines.forEach((l) => {
      if (l.action === "create")
        out.push({
          step: `nomenclature:${l.index}`,
          entitySet: ip.nomSet,
          payload: nomenclaturePayload(l),
          label: `${l.kind === "service" ? "Услуга" : "Товар"} «${l.name}»`,
        });
    });
  out.push({
    step: "sale",
    entitySet: plan.saleSet,
    payload: salePayload(plan, assigned),
    label: "Реализация товаров и услуг",
  });
  return out;
}

function planView(plan: SalePlan) {
  const rows = [
    ...plan.services.map((r) => ({ kind: "услуга", r })),
    ...plan.goods.map((r) => ({ kind: "товар", r })),
  ];
  return {
    mode: plan.mode === "basis" ? "на основании счёта" : "без основания",
    ...(plan.basis ? { basis: plan.basis } : {}),
    date: plan.date,
    organization: plan.org,
    ...(plan.buyer ? { buyer: plan.buyer } : {}),
    ...(plan.contract
      ? {
          contract:
            plan.contract.action === "create"
              ? { action: "создать", name: plan.contract.name }
              : { action: "найден", ref: plan.contract.ref, name: plan.contract.name },
        }
      : {}),
    operationKind: plan.operationKind,
    ...(plan.header["Склад_Key"] ? { warehouse: plan.header["Склад_Key"] } : {}),
    ...(plan.header["БанковскийСчетОрганизации_Key"]
      ? { bankAccount: plan.header["БанковскийСчетОрганизации_Key"] }
      : {}),
    lines: rows.map(({ kind, r }) => ({
      kind,
      ...(plan.createdNom.has(r) ? { nomenclature: "создать" } : { nomenclatureRef: r["Номенклатура_Key"] }),
      ...(r["Содержание"] ? { content: r["Содержание"] } : {}),
      quantity: r["Количество"],
      price: r["Цена"],
      sum: r["Сумма"],
      ...(Number(r["СуммаНДС"] ?? 0) ? { vat: r["СуммаНДС"] } : {}),
    })),
    totals: {
      total: plan.total,
      withVat: plan.header["УчитыватьНДС"] === true,
      vatIncluded: plan.header["СуммаВключаетНДС"] === true,
    },
    filledFrom: plan.filled,
    ...(plan.sample ? { accountsSample: plan.sample } : {}),
    ...(plan.buyer ? { possibleDuplicates: plan.duplicates } : {}),
  };
}

const dupList = (d: DuplicateSale[]): string =>
  d.map((x) => `№ ${x.number} от ${x.date} на ${x.total} (ref ${x.ref})`).join("; ");

/** Перечитывает созданную реализацию и печатает формы (если просили). */
async function finish(
  conn: Connection,
  saleSet: string,
  saleRef: string,
  input: QuickSaleInput,
  base: Record<string, unknown>,
  notes: string[],
): Promise<CallToolResult> {
  const doc = await conn.client.getEntity(`${saleSet}(guid'${saleRef}')?$format=json`);
  let pdf: Record<string, unknown> | undefined;
  if (input.print !== "none") {
    try {
      const printed = await printSale(conn, saleRef, {
        form: input.print as SaleForm,
        outputDir: input.outputDir,
        doc,
      });
      notes.push(...printed.notes);
      const files = printedFilesOutput(printed.files);
      pdf = { files, ...(files[0]?.path ? { path: files[0].path } : {}) };
    } catch (e) {
      pdf = {
        error: `PDF не построен: ${(e as Error).message}. Реализация создана — повторите read.document.print_sale.`,
      };
    }
  }
  return ok({
    ...base,
    sale: {
      ref: str(doc["Ref_Key"]) || saleRef,
      number: docNumber(str(doc["Number"])),
      number1C: str(doc["Number"]),
      date: str(doc["Date"]).slice(0, 10),
      total: Number(doc["СуммаДокумента"] ?? 0),
      posted: doc["Posted"] === true,
      operationKind: str(doc["ВидОперации"]),
    },
    ...(pdf ? { pdf } : {}),
    ...(notes.length ? { notes } : {}),
  });
}

export async function quickSale(conn: Connection, input: QuickSaleInput): Promise<CallToolResult> {
  const started = Date.now();
  if (!(await isKazakhstan(conn)))
    throw new InputError("write.sales.quick_sale работает с казахстанской базой (БИН/ИИН, тенге, НДС РК).");
  // outputDir проверяется до записи.
  if (input.print !== "none") await printTarget(conn, input.outputDir);
  const requestHash = fingerprintWriteInput(QUICK_SALE_TOOL, input as unknown as Record<string, unknown>);
  const blocked = writeBlocked(conn);

  if (input.confirm) {
    if (!input.operationId)
      throw new InputError("Сначала план (confirm=false). При confirm=true передайте operationId из плана.");
    if (blocked) throw new InputError(blocked);
    const opId = input.operationId;
    const sub = (step: string) => ({
      id: subOperationId(opId, step),
      hash: subRequestHash(requestHash, step),
    });
    const saleOp = sub("sale");
    const settled = await conn.client.operationSettled(saleOp.id, saleOp.hash);
    if (settled?.result["Ref_Key"]) {
      const saleSet = await requireEntity(conn, DOCUMENTS.sales, "Документ «Реализация товаров и услуг»");
      return finish(
        conn,
        saleSet,
        settled.result["Ref_Key"],
        input,
        {
          created: true,
          replayed: true,
          database: conn.cfg.name,
          operationId: opId,
          note: "Реализация уже была создана этой операцией — повторно не создавалась.",
        },
        [],
      );
    }
    const plan = await planQuickSale(conn, input);
    if (!plan.ready)
      throw new InputError(
        `Нужен выбор: ${plan.choices.map((c) => `${c.field} — ${c.reason} ${c.howTo}`).join(" ")} Затем новый план.`,
      );
    const assigned = new Map<string, string | undefined>();
    for (const s of steps(plan, assigned)) {
      const entry = await conn.client.operationEntry(sub(s.step).id);
      if (!entry)
        throw new InputError(
          `Шаг «${s.label}» не подготовлен планом с operationId ${opId} (план менялся или делался в режиме только-чтение). Ничего не создано — выполните новый план.`,
        );
      assigned.set(s.step, entry.refKey);
    }
    const created: Array<Record<string, unknown>> = [];
    let saleRef = "";
    for (const s of steps(plan, assigned)) {
      const { id, hash } = sub(s.step);
      let entity: ODataEntity;
      try {
        entity = await withWriteOperation(id, hash, () =>
          conn.client.create<ODataEntity>(s.entitySet, s.payload),
        );
      } catch (e) {
        const done = created.length
          ? `Уже создано: ${created.map((c) => `${String(c["type"])} (ref ${String(c["ref"])})`).join("; ")}.`
          : "Этим вызовом ничего не создано.";
        const unknown = e instanceof ODataError && e.kind === "unknown";
        throw new InputError(
          `Шаг «${s.label}» не выполнен: ${(e as Error).message} ${done} ` +
            (unknown
              ? `Исход шага неизвестен: сверьте его write.operation.status с operationId ${id} — если объект в 1С есть, ` +
                `повтор с operationId ${opId} продолжит с места сбоя без дубликатов.`
              : "Исправьте причину и сделайте новый план (confirm=false): уже созданное он найдёт в базе и не создаст повторно."),
        );
      }
      const ref = str(entity["Ref_Key"]);
      if (s.step === "sale") saleRef = ref;
      else
        created.push({
          type: s.label,
          ref,
          ...(entity["_operation_replayed"] === true ? { replayed: true } : {}),
        });
    }
    return finish(
      conn,
      plan.saleSet,
      saleRef,
      input,
      {
        created: true,
        database: conn.cfg.name,
        operationId: opId,
        ...(created.length ? { createdObjects: created } : {}),
        possibleDuplicates: plan.duplicates,
      },
      [
        ...(plan.duplicates.length
          ? [
              `ВНИМАНИЕ: создана ещё одна реализация, хотя уже есть ${dupList(plan.duplicates)}. Если она не нужна — ` +
                "пометьте созданную на удаление (write.entity.mark_for_deletion).",
            ]
          : []),
        "Реализация создана без проведения: проверьте и проведите её в 1С (write.document.post_document).",
      ],
    );
  }

  const plan = await planQuickSale(conn, input);
  const view = planView(plan);
  if (!plan.ready)
    return ok({
      dryRun: true,
      ready: false,
      database: conn.cfg.name,
      choices: plan.choices,
      ...view,
      ...(plan.notes.length ? { notes: plan.notes } : {}),
      note: "Нужно уточнение — выберите вариант и повторите план. Ничего не создано.",
      elapsedMs: Date.now() - started,
    });
  const opId = input.operationId ?? randomUUID();
  const sub = (step: string) => ({ id: subOperationId(opId, step), hash: subRequestHash(requestHash, step) });
  const assigned = new Map<string, string | undefined>();
  const prepare = async (s: Step) => {
    const { id, hash } = sub(s.step);
    await withWriteOperation(id, hash, () => conn.client.prepareCreate(s.entitySet, s.payload));
    return (await conn.client.operationEntry(id))?.refKey;
  };
  if (!blocked)
    for (const s of steps(plan, assigned)) if (s.step !== "sale") assigned.set(s.step, await prepare(s));
  const all = steps(plan, assigned);
  if (!blocked) await prepare(all[all.length - 1]!);
  const forms =
    input.print === "none"
      ? ""
      : ` + PDF (${[
          ...(plan.services.length && input.print !== "waybill" ? ["акт Р-1"] : []),
          ...(plan.goods.length && input.print !== "act" ? ["накладная З-2"] : []),
        ].join(", ")})`;
  return ok({
    dryRun: true,
    ready: true,
    database: conn.cfg.name,
    operationId: opId,
    ...view,
    willCreate: all.map((s) =>
      s.step === "sale" ? `Реализация товаров и услуг (без проведения)${forms}` : s.label,
    ),
    ...(plan.notes.length ? { notes: plan.notes } : {}),
    note:
      (plan.duplicates.length
        ? `ВОЗМОЖНЫЙ ДУБЛЬ: ${dupList(plan.duplicates)}. Покажите possibleDuplicates пользователю и спросите: ` +
          "использовать существующую (PDF — read.document.print_sale с её ref) или создать ещё. confirm=true — только " +
          "после ответа «создай ещё». "
        : "") +
      (blocked
        ? `План. ВНИМАНИЕ: ${blocked} confirm=true не пройдёт.`
        : "План. Ничего не создано. Чтобы создать, повторите вызов с теми же аргументами, confirm=true и этим operationId."),
    elapsedMs: Date.now() - started,
  });
}

export function registerQuickSaleTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    QUICK_SALE_TOOL,
    {
      title: "Реализация (акт / накладная) в один вызов (Казахстан)",
      description:
        "Реализация товаров и услуг за один-два вызова. С basis (счёт на оплату — ref или номер) — «на основании», как в " +
        "1С: организация, покупатель, договор, ответственный, валюта, флаги НДС, банковский счёт, строки товаров и услуг " +
        "копируются из счёта, ДокументОснование = счёт. Без basis — buyer + lines, как quick_invoice. Счета учёта, вид " +
        "учёта НУ и субконто — из последней реализации той же организации с такими строками (1С через OData их не " +
        "подставляет). confirm=false (по умолчанию) — план: что заполнено и откуда, итоги, notes, operationId; ничего " +
        "не пишет. План проверяет дубли: реализации на основании того же счёта и реализации того же покупателя за тот же " +
        "день на ту же сумму (помеченные на удаление не считаются) — possibleDuplicates (номер, дата, ref, сумма, posted, " +
        "reason). Не пуст — ОБЯЗАТЕЛЬНО покажите пользователю до подтверждения. confirm=true с тем же operationId и " +
        "аргументами — создаёт реализацию БЕЗ проведения, перечитывает её и сохраняет PDF: акт Р-1 (услуги) и/или " +
        "накладную З-2 (товары) — pdf.files[].path. Повтор после сбоя с тем же operationId не создаёт дубликатов. " +
        "Подтверждайте только с согласия пользователя.",
      inputSchema: quickSaleInput,
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
      guard(QUICK_SALE_TOOL, async () => {
        const input = z.object(quickSaleInput).parse(args) as QuickSaleInput;
        return quickSale(ctx.db(input.database), input);
      }),
  );
}
