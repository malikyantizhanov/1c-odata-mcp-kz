import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { CATALOGS, DOCUMENTS } from "../config/mapping.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, contains, odataGuid, odataString } from "../odata/query.js";
import { fingerprintWriteInput, withWriteOperation } from "../odata/write-operation-context.js";
import { ODataError } from "../odata/errors.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok, organizationField } from "./_shared.js";
import {
  isKazakhstan,
  isWithoutVat,
  KZ_VAT_RATES,
  tengeRef,
  unitRef,
  vatPercent,
  vatRateRefs,
} from "./write-kz.js";
import { resolveOrgBankAccount } from "./write.js";
import { printInvoice, printTarget } from "./print.js";

/**
 * Счёт на оплату покупателю «в один вызов» (Казахстан). confirm=false — один вызов: параллельные чтения, один
 * компактный план, ничего не пишет (в журнал — только отпечатки шагов). Неоднозначность — варианты, а не догадка.
 * confirm=true с тем же operationId — недостающие договор/номенклатура, счёт БЕЗ проведения, перечитывание из базы
 * и PDF. Каждый шаг — отдельная операция журнала (id выводится из operationId), поэтому повтор после сбоя
 * не создаёт дубликатов: уже созданное возвращается из журнала, недостающее досоздаётся.
 */
export const QUICK_INVOICE_TOOL = "write.sales.quick_invoice";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const isGuid = (s: string | undefined): boolean => !!s && GUID_RE.test(s.trim());
const guid = (s: string): string => s.trim().replace(/[{}]/g, "");
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const refOf = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const roundMoney = (n: number): number => Math.round(n * 100) / 100;
const OPTIONS_LIMIT = 10;

/** Сравнение наименований: регистр, «ё», кавычки-ёлочки и лишние пробелы не важны. */
export const normName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»“”„"']/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Сегодня и сейчас по Алматы (Asia/Almaty) — дата счёта по умолчанию, независимо от часового пояса хоста. */
export function almatyNow(now = new Date()): { date: string; dateTime: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Almaty",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  return { date, dateTime: `${date}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}` };
}

/** Id шага составной операции: детерминированный UUID (вариант RFC 4122, версия 8) из operationId и имени шага. */
export function subOperationId(operationId: string, step: string): string {
  const h = createHash("sha256").update(`${operationId}\n${step}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const subRequestHash = (requestHash: string, step: string): string =>
  createHash("sha256").update(`${requestHash}\n${step}`).digest("hex");

const lineSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Наименование услуги/товара (как в справочнике или новое)"),
  ref: z.string().optional().describe("Ref_Key номенклатуры — вместо name"),
  quantity: z.number().positive().default(1).describe("Количество (по умолчанию 1)"),
  price: z.number().nonnegative().describe("Цена за единицу, тенге"),
  kind: z
    .enum(["service", "goods"])
    .default("service")
    .describe("service — услуга (по умолчанию), goods — товар"),
  content: z
    .string()
    .max(1000)
    .optional()
    .describe("Содержание строки услуги (печатается в счёте). По умолчанию — name."),
  vatRate: z
    .enum(KZ_VAT_RATES)
    .optional()
    .describe("Ставка НДС строки. По умолчанию — по статусу организации."),
  createNew: z
    .boolean()
    .default(false)
    .describe("true — завести новую номенклатуру, даже если есть похожие (после показа вариантов)."),
});
type LineInput = z.infer<typeof lineSchema>;

export const quickInvoiceInput = {
  database: databaseField,
  organization: organizationField,
  buyer: z.string().min(1).max(500).describe("Покупатель: БИН/ИИН (12 цифр), Ref_Key или наименование"),
  buyerName: z
    .string()
    .max(500)
    .optional()
    .describe("Наименование покупателя — для сверки с найденным по БИН"),
  date: dateField("Дата счёта; по умолчанию сегодня (Алматы)").optional(),
  lines: z.array(lineSchema).min(1).max(100).describe("Позиции счёта"),
  paymentCode: z
    .string()
    .regex(/^\d{3}$/, "КНП — три цифры")
    .optional()
    .describe("КНП — код назначения платежа (напр. 851 — оплата за услуги, 710 — за товары)"),
  contract: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Договор: Ref_Key, номер или наименование. Без него — действующий договор «С покупателем»; нет ни одного — будет создан «б/н».",
    ),
  bankAccount: z
    .string()
    .max(200)
    .optional()
    .describe("Банковский счёт организации: Ref_Key, номер (IBAN) или название. По умолчанию — основной."),
  sumIncludesVat: z.boolean().default(true).describe("Цена включает НДС (для плательщика НДС)"),
  outputDir: z
    .string()
    .max(500)
    .optional()
    .describe("Подкаталог для PDF внутри ODATA_PRINT_DIR (как у print_invoice)"),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "false (по умолчанию) — только план, ничего не создаётся. true — создать недостающее и счёт (без проведения) " +
        "и сразу PDF: передайте operationId из плана и те же аргументы. После таймаута/сбоя повторяйте с тем же operationId.",
    ),
  operationId: z.string().uuid().optional().describe("operationId из плана (обязателен при confirm=true)"),
};
type QuickInput = {
  database?: string | undefined;
  organization?: string | undefined;
  buyer: string;
  buyerName?: string | undefined;
  date?: string | undefined;
  lines: LineInput[];
  paymentCode?: string | undefined;
  contract?: string | undefined;
  bankAccount?: string | undefined;
  sumIncludesVat: boolean;
  outputDir?: string | undefined;
  confirm: boolean;
  operationId?: string | undefined;
};

export interface Choice {
  field: string;
  reason: string;
  options: Array<Record<string, unknown>>;
  howTo: string;
}

interface CreateStep {
  step: string;
  entitySet: string;
  payload: Record<string, unknown>;
  label: string;
}

interface PlannedLine {
  index: number;
  action: "use" | "create";
  ref?: string | undefined;
  name: string;
  kind: "service" | "goods";
  unitRef?: string | undefined;
  quantity: number;
  price: number;
  sum: number;
  vatRate: string;
  vat: number;
  content?: string | undefined;
}

export interface QuickPlan {
  ready: boolean;
  choices: Choice[];
  notes: string[];
  org: { ref: string; name: string; vatPayer: boolean; vatBasis: string; mainBank?: string | undefined };
  buyer?: { ref: string; name: string; bin?: string | undefined } | undefined;
  contract?:
    | { action: "use" | "create"; ref?: string | undefined; name: string; number?: string; date?: string }
    | undefined;
  bank?: { ref: string; number?: string | undefined; name?: string | undefined } | undefined;
  date: string;
  dateTime: string;
  lines: PlannedLine[];
  withVat: boolean;
  totals: { sum: number; vat: number; total: number };
  invoiceSet: string;
  contractSet?: string | undefined;
  nomSet: string;
  currencyRef?: string | undefined;
  vatRefs: Map<string, string>;
  /** Похожие счета: тот же покупатель и организация, тот же день, та же сумма (без помеченных на удаление). */
  duplicates: DuplicateInvoice[];
}

export interface DuplicateInvoice {
  number: string;
  date: string;
  ref: string;
  total: number;
  posted: boolean;
  /** Строки совпадают: та же номенклатура, количество, цена и сумма (порядок не важен). */
  linesMatch: boolean;
}

/** Подпись строки для сравнения с существующим счётом; новая номенклатура не совпадёт ни с чем. */
const lineKey = (ref: string | undefined, quantity: unknown, price: unknown, sum: unknown): string =>
  [ref ?? "new", Number(quantity ?? 0), roundMoney(Number(price ?? 0)), roundMoney(Number(sum ?? 0))].join(
    "|",
  );

/**
 * Возможные дубли: счета на оплату того же покупателя от той же организации за тот же календарный день с той же
 * суммой документа — проведённые и нет. Помеченные на удаление не считаются (их уже «отменили»), но упоминаются
 * в notes. Счета того дня на другие суммы — только счётчиком в notes. Ошибка поиска не мешает плану.
 */
export async function findDuplicateInvoices(
  conn: Connection,
  invoiceSet: string,
  q: { buyerRef: string; orgRef: string; date: string; total: number; lineKeys: string[] },
): Promise<{ duplicates: DuplicateInvoice[]; notes: string[] }> {
  try {
    const { rows } = await fetchAll(
      conn.client,
      invoiceSet,
      {
        filter: and(
          cmp("Контрагент_Key", "eq", odataGuid(q.buyerRef)),
          cmp("Организация_Key", "eq", odataGuid(q.orgRef)),
          cmp("Date", "ge", `datetime'${q.date}T00:00:00'`),
          cmp("Date", "le", `datetime'${q.date}T23:59:59'`),
        ),
        // Табличные части нужны для сравнения строк; $select их не берём — 1С отдаёт их в составе документа.
        orderby: "Date",
      },
      50,
      50,
    );
    const sameTotal = rows.filter((r) => Math.abs(Number(r["СуммаДокумента"] ?? 0) - q.total) < 0.005);
    const live = sameTotal.filter((r) => r["DeletionMark"] !== true);
    const marked = sameTotal.length - live.length;
    const other = rows.filter((r) => r["DeletionMark"] !== true).length - live.length;
    const wanted = [...q.lineKeys].sort().join("\n");
    const duplicates = live.map((r) => {
      const docLines = [
        ...((r["Товары"] as ODataEntity[] | undefined) ?? []),
        ...((r["Услуги"] as ODataEntity[] | undefined) ?? []),
      ].map((l) => lineKey(refOf(l["Номенклатура_Key"]), l["Количество"], l["Цена"], l["Сумма"]));
      return {
        number: docNumber(str(r["Number"])),
        date: str(r["Date"]).slice(0, 10),
        ref: str(r["Ref_Key"]),
        total: Number(r["СуммаДокумента"] ?? 0),
        posted: r["Posted"] === true,
        linesMatch: docLines.sort().join("\n") === wanted,
      };
    });
    const notes: string[] = [];
    if (duplicates.length)
      notes.push(
        `ВНИМАНИЕ, возможный дубль: у покупателя уже есть счёт на ту же сумму от ${q.date} — ` +
          duplicates
            .map(
              (d) => `№ ${d.number} (ref ${d.ref}${d.linesMatch ? ", те же строки" : ", строки отличаются"})`,
            )
            .join("; ") +
          ". Покажите пользователю possibleDuplicates до confirm=true: «использовать существующий» или «создать ещё».",
      );
    if (marked)
      notes.push(`Ещё ${marked} счёт(а) с той же суммой за этот день помечены на удаление — не учитывались.`);
    if (other) notes.push(`У покупателя за ${q.date} есть ещё ${other} счёт(а) на другие суммы.`);
    return { duplicates, notes };
  } catch (e) {
    return { duplicates: [], notes: [`Проверка на дубли не выполнена: ${(e as Error).message}`] };
  }
}

const docNumber = (n: string): string => n.replace(/^0+(?=\d)/, "");

/** Покупатель: Ref, БИН/ИИН или наименование. Несколько — варианты. */
async function resolveBuyer(
  conn: Connection,
  set: string,
  buyer: string,
  buyerName: string | undefined,
): Promise<{
  buyer?: QuickPlan["buyer"];
  mainContract?: string | undefined;
  choice?: Choice;
  notes: string[];
}> {
  const select = [
    "Ref_Key",
    "Description",
    "НаименованиеПолное",
    "ИдентификационныйКодЛичности",
    "ОсновнойДоговорКонтрагента_Key",
  ];
  const q = buyer.trim();
  const toBuyer = (r: ODataEntity) => ({
    ref: str(r["Ref_Key"]),
    name: str(r["Description"]) || str(r["НаименованиеПолное"]),
    bin: str(r["ИдентификационныйКодЛичности"]) || undefined,
  });
  const option = (r: ODataEntity) => ({ ...toBuyer(r), fullName: str(r["НаименованиеПолное"]) || undefined });
  let rows: ODataEntity[];
  let how: string;
  if (isGuid(q)) {
    const r = await conn.client.getEntity(
      `${set}(guid'${guid(q)}')${buildQuery({ select: [...select, "DeletionMark"] })}`,
    );
    if (r["DeletionMark"] === true)
      throw new InputError(`Покупатель ${q} помечен на удаление — выберите другого.`);
    rows = [r];
    how = "по Ref_Key";
  } else if (/^\d{12}$/.test(q)) {
    ({ rows } = await fetchAll(
      conn.client,
      set,
      {
        filter: and(
          cmp("ИдентификационныйКодЛичности", "eq", odataString(q)),
          cmp("DeletionMark", "eq", "false"),
        ),
        select,
      },
      OPTIONS_LIMIT,
      OPTIONS_LIMIT,
    ));
    how = `по БИН/ИИН ${q}`;
    if (!rows.length)
      throw new InputError(
        `Покупатель с БИН/ИИН ${q} не найден в справочнике «Контрагенты». Заведите его (write.counterparty.create_counterparty) и повторите.`,
      );
  } else {
    const found = await fetchAll(
      conn.client,
      set,
      { filter: and(contains("Description", q), cmp("DeletionMark", "eq", "false")), select },
      20,
      20,
    );
    const exact = found.rows.filter(
      (r) =>
        normName(str(r["Description"])) === normName(q) ||
        normName(str(r["НаименованиеПолное"])) === normName(q),
    );
    rows = exact.length ? exact : found.rows;
    how = `по наименованию «${q}»`;
    if (!rows.length) throw new InputError(`Покупатель «${q}» не найден. Укажите БИН/ИИН или Ref_Key.`);
    if (!exact.length)
      return {
        notes: [],
        choice: {
          field: "buyer",
          reason: `Точного совпадения ${how} нет, есть похожие.`,
          options: rows.slice(0, OPTIONS_LIMIT).map(option),
          howTo: "Передайте buyer — БИН/ИИН или ref нужного контрагента.",
        },
      };
  }
  if (rows.length > 1)
    return {
      notes: [],
      choice: {
        field: "buyer",
        reason: `${how} найдено несколько контрагентов.`,
        options: rows.map(option),
        howTo: "Передайте buyer — ref нужного контрагента.",
      },
    };
  const r = rows[0]!;
  const b = toBuyer(r);
  const notes: string[] = [];
  if (
    buyerName &&
    !normName(`${str(r["Description"])} ${str(r["НаименованиеПолное"])}`).includes(normName(buyerName))
  )
    notes.push(`Найденный ${how} покупатель «${b.name}» не похож на «${buyerName}» — проверьте.`);
  return { buyer: b, mainContract: refOf(r["ОсновнойДоговорКонтрагента_Key"]), notes };
}

/** Действует ли договор на дату счёта (пустые даты начала/окончания — без ограничения). */
const activeOn = (r: ODataEntity, date: string): boolean => {
  const from = str(r["ДатаНачалаДействияДоговора"]).slice(0, 10);
  const to = str(r["ДатаОкончанияДействияДоговора"]).slice(0, 10);
  const set = (d: string) => d && !d.startsWith("0001");
  return (!set(from) || from <= date) && (!set(to) || to >= date);
};

async function resolveContract(
  conn: Connection,
  set: string | undefined,
  input: string | undefined,
  buyerRef: string,
  orgRef: string,
  mainContract: string | undefined,
  date: string,
): Promise<{ contract?: QuickPlan["contract"]; choice?: Choice; notes: string[] }> {
  if (!set) throw new InputError("Справочник «Договоры контрагентов» не опубликован в OData.");
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        cmp("Owner_Key", "eq", odataGuid(buyerRef)),
        cmp("Организация_Key", "eq", odataGuid(orgRef)),
        cmp("DeletionMark", "eq", "false"),
      ),
      select: [
        "Ref_Key",
        "Description",
        "НомерДоговора",
        "ДатаДоговора",
        "ВидДоговора",
        "ДатаНачалаДействияДоговора",
        "ДатаОкончанияДействияДоговора",
        "IsFolder",
      ],
    },
    50,
    50,
  );
  const items = rows.filter((r) => r["IsFolder"] !== true);
  const view = (r: ODataEntity) => ({
    action: "use" as const,
    ref: str(r["Ref_Key"]),
    name: str(r["Description"]),
    number: str(r["НомерДоговора"]) || undefined,
    date: str(r["ДатаДоговора"]).slice(0, 10) || undefined,
  });
  const option = (r: ODataEntity) => ({ ...view(r), kind: str(r["ВидДоговора"]), active: activeOn(r, date) });
  if (input?.trim()) {
    const q = input.trim();
    const hits = isGuid(q)
      ? items.filter((r) => str(r["Ref_Key"]) === guid(q))
      : items.filter(
          (r) =>
            normName(str(r["Description"])) === normName(q) ||
            normName(str(r["НомерДоговора"])) === normName(q.replace(/^№\s*/, "")) ||
            normName(str(r["Description"])).includes(normName(q)),
        );
    if (hits.length === 1) {
      const r = hits[0]!;
      const notes = [
        ...(str(r["ВидДоговора"]) !== "СПокупателем"
          ? [`Договор «${str(r["Description"])}» — вид «${str(r["ВидДоговора"])}», не «С покупателем».`]
          : []),
        ...(activeOn(r, date) ? [] : [`Договор «${str(r["Description"])}» не действует на ${date}.`]),
      ];
      return { contract: view(r), notes };
    }
    if (hits.length > 1)
      return {
        notes: [],
        choice: {
          field: "contract",
          reason: `Под «${q}» подходит несколько договоров покупателя.`,
          options: hits.slice(0, OPTIONS_LIMIT).map(option),
          howTo: "Передайте contract — ref нужного договора.",
        },
      };
    throw new InputError(
      `Договор «${q}» у покупателя не найден.` +
        (items.length
          ? ` Есть: ${items.map((r) => `«${str(r["Description"])}» (ref ${str(r["Ref_Key"])})`).join("; ")}.`
          : " Договоров нет — не указывайте contract, и договор «б/н» будет создан."),
    );
  }
  const active = items.filter((r) => str(r["ВидДоговора"]) === "СПокупателем" && activeOn(r, date));
  if (active.length === 1) return { contract: view(active[0]!), notes: [] };
  if (active.length > 1) {
    const main = active.find((r) => str(r["Ref_Key"]) === mainContract);
    if (main)
      return {
        contract: view(main),
        notes: [
          `Договоров «С покупателем» несколько — взят основной договор контрагента «${str(main["Description"])}».`,
        ],
      };
    return {
      notes: [],
      choice: {
        field: "contract",
        reason: `У покупателя ${active.length} действующих договора «С покупателем».`,
        options: active.slice(0, OPTIONS_LIMIT).map(option),
        howTo: "Передайте contract — ref нужного договора.",
      },
    };
  }
  const inactive = items.filter((r) => str(r["ВидДоговора"]) === "СПокупателем");
  return {
    contract: { action: "create", name: "Договор б/н", number: "б/н", date },
    notes: inactive.length
      ? [
          `Действующего договора «С покупателем» нет (есть недействующие: ${inactive.map((r) => str(r["Description"])).join(", ")}) — будет создан новый «Договор б/н».`,
        ]
      : ["Договора «С покупателем» нет — будет создан «Договор б/н»."],
  };
}

/** Номенклатура строки: ref, точное совпадение наименования того же вида или «создать». Похожие — варианты. */
async function resolveLine(
  conn: Connection,
  nomSet: string,
  l: LineInput,
  index: number,
): Promise<{
  ref?: string;
  name: string;
  unitRef?: string | undefined;
  choice?: Choice;
  notes: string[];
  create?: boolean;
}> {
  const select = [
    "Ref_Key",
    "Code",
    "Description",
    "НаименованиеПолное",
    "Услуга",
    "БазоваяЕдиницаИзмерения_Key",
    "IsFolder",
  ];
  const wantService = l.kind === "service";
  const kindText = (r: ODataEntity) => (r["Услуга"] === true ? "service" : "goods");
  const option = (r: ODataEntity) => ({
    ref: str(r["Ref_Key"]),
    code: str(r["Code"]) || undefined,
    name: str(r["Description"]),
    kind: kindText(r),
  });
  const field = `lines[${index}]`;
  if (l.ref) {
    if (!isGuid(l.ref)) throw new InputError(`${field}.ref — не GUID.`);
    const r = await conn.client.getEntity(
      `${nomSet}(guid'${guid(l.ref)}')${buildQuery({ select: [...select, "DeletionMark"] })}`,
    );
    if (r["DeletionMark"] === true)
      throw new InputError(`${field}: номенклатура ${l.ref} помечена на удаление.`);
    const notes =
      (r["Услуга"] === true) !== wantService
        ? [
            `${field}: «${str(r["Description"])}» в справочнике — ${r["Услуга"] === true ? "услуга" : "товар"}, строка пойдёт в ${r["Услуга"] === true ? "«Услуги»" : "«Товары»"}.`,
          ]
        : [];
    return {
      ref: str(r["Ref_Key"]),
      name: str(r["Description"]),
      unitRef: refOf(r["БазоваяЕдиницаИзмерения_Key"]),
      notes,
    };
  }
  const name = l.name!.trim();
  const { rows } = await fetchAll(
    conn.client,
    nomSet,
    { filter: and(contains("Description", name), cmp("DeletionMark", "eq", "false")), select },
    20,
    20,
  );
  const items = rows.filter((r) => r["IsFolder"] !== true);
  const exact = items.filter(
    (r) =>
      normName(str(r["Description"])) === normName(name) ||
      normName(str(r["НаименованиеПолное"])) === normName(name),
  );
  const exactKind = exact.filter((r) => (r["Услуга"] === true) === wantService);
  if (exactKind.length === 1) {
    const r = exactKind[0]!;
    return {
      ref: str(r["Ref_Key"]),
      name: str(r["Description"]),
      unitRef: refOf(r["БазоваяЕдиницаИзмерения_Key"]),
      notes: [],
    };
  }
  if (exactKind.length > 1)
    return {
      name,
      notes: [],
      choice: {
        field,
        reason: `«${name}»: в справочнике несколько позиций с таким наименованием.`,
        options: exactKind.slice(0, OPTIONS_LIMIT).map(option),
        howTo: `Передайте ${field}.ref нужной позиции.`,
      },
    };
  if (!l.createNew && items.length)
    return {
      name,
      notes: [],
      choice: {
        field,
        reason: exact.length
          ? `«${name}» есть в справочнике, но как ${wantService ? "товар" : "услуга"}.`
          : `Точного совпадения «${name}» нет, есть похожие позиции.`,
        options: items.slice(0, OPTIONS_LIMIT).map(option),
        howTo: `Передайте ${field}.ref подходящей позиции или ${field}.createNew=true, чтобы завести новую.`,
      },
    };
  return { name, notes: [], create: true };
}

/** Строит план: всё нужное читается параллельно; ничего не пишет. */
export async function planQuickInvoice(conn: Connection, input: QuickInput): Promise<QuickPlan> {
  input.lines.forEach((l, i) => {
    if (!l.name?.trim() && !l.ref) throw new InputError(`lines[${i}]: укажите name или ref.`);
  });
  const today = almatyNow();
  const date = input.date ?? today.date;
  const dateTime = input.date ? `${input.date}T00:00:00` : today.dateTime;
  const available = await conn.available();
  const [invoiceSet, cpSet, nomSet, orgSet] = await Promise.all([
    requireEntity(conn, DOCUMENTS.customerInvoice, "Документ «Счёт на оплату покупателю»"),
    requireEntity(conn, CATALOGS.counterparties, "Справочник «Контрагенты»"),
    requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»"),
    requireEntity(conn, CATALOGS.organizations, "Справочник «Организации»"),
  ]);
  const contractSet = CATALOGS.contracts.find((c) => available.has(c));

  // Волна 1: организация, покупатель, позиции, валюта — независимы.
  const [orgCard, buyerRes, lineRes, currencyRef] = await Promise.all([
    resolveOrgOrDefault(conn, input.organization).then((o) =>
      conn.client.getEntity(
        `${orgSet}(guid'${o.ref}')${buildQuery({
          select: [
            "Ref_Key",
            "Description",
            "ОсновнойБанковскийСчет_Key",
            "НомерСвидетельстваПоНДС",
            "СерияСвидетельстваПоНДС",
            "ДатаПостановкиНаУчетПоНДС",
          ],
        })}`,
      ),
    ),
    resolveBuyer(conn, cpSet, input.buyer, input.buyerName),
    Promise.all(input.lines.map((l, i) => resolveLine(conn, nomSet, l, i))),
    tengeRef(conn),
  ]);

  const orgRef = str(orgCard["Ref_Key"]);
  const vatDate = str(orgCard["ДатаПостановкиНаУчетПоНДС"]).slice(0, 10);
  const certificate = str(orgCard["НомерСвидетельстваПоНДС"]) || str(orgCard["СерияСвидетельстваПоНДС"]);
  const registered = !!vatDate && !vatDate.startsWith("0001") && vatDate <= date;
  const vatPayer = !!certificate || registered;
  const org: QuickPlan["org"] = {
    ref: orgRef,
    name: str(orgCard["Description"]),
    vatPayer,
    vatBasis: vatPayer
      ? `В карточке организации регистрация по НДС${registered ? ` с ${vatDate}` : ""}${certificate ? `, свидетельство ${certificate}` : ""} — плательщик НДС.`
      : "В карточке организации нет свидетельства и даты постановки на учёт по НДС — неплательщик НДС: ставка «без НДС» (ст. 208 НК РК).",
    mainBank: refOf(orgCard["ОсновнойБанковскийСчет_Key"]),
  };
  const notes: string[] = [...buyerRes.notes, ...lineRes.flatMap((l) => l.notes)];
  const choices: Choice[] = [
    ...(buyerRes.choice ? [buyerRes.choice] : []),
    ...lineRes.flatMap((l) => (l.choice ? [l.choice] : [])),
  ];

  // Ставки строк.
  const rates = input.lines.map((l) => l.vatRate ?? (vatPayer ? "16%" : "без НДС"));
  const withVat = rates.some((r) => !isWithoutVat(r));
  if (!vatPayer && withVat)
    notes.push(
      "Организация по карточке не плательщик НДС, а в строках задана ставка НДС — проверьте статус в 1С.",
    );
  if (vatPayer && input.lines.some((l) => !l.vatRate))
    notes.push("Ставка НДС не задана — взята базовая 16%. Для иной ставки передайте vatRate в строке.");
  const needCreateUnit = lineRes.some((l) => l.create);

  // Строки и итоги — из входа и волны 1 (нужны поиску дублей уже во второй волне).
  let sum = 0;
  let vat = 0;
  const lines: PlannedLine[] = input.lines.map((l, i) => {
    const res = lineRes[i]!;
    const lineSum = roundMoney(l.quantity * l.price);
    const rate = rates[i]!;
    const p = withVat ? vatPercent(rate) : 0;
    const lineVat = roundMoney(input.sumIncludesVat ? (lineSum * p) / (100 + p) : (lineSum * p) / 100);
    sum += lineSum;
    vat += lineVat;
    return {
      index: i,
      action: res.create ? "create" : "use",
      ref: res.ref,
      name: res.name,
      kind: l.kind,
      unitRef: res.create ? undefined : res.unitRef,
      quantity: l.quantity,
      price: l.price,
      sum: lineSum,
      vatRate: withVat ? rate : "без НДС",
      vat: lineVat,
      content: l.kind === "service" ? (l.content ?? l.name?.trim() ?? res.name) : undefined,
    };
  });
  sum = roundMoney(sum);
  vat = roundMoney(vat);
  const total = roundMoney(sum + (withVat && !input.sumIncludesVat ? vat : 0));

  // Волна 2: договор, банковский счёт, ставки, единица, возможные дубли — после организации и покупателя.
  const [contractRes, bank, vatRefs, newUnit, dupRes] = await Promise.all([
    buyerRes.buyer
      ? resolveContract(
          conn,
          contractSet,
          input.contract,
          buyerRes.buyer.ref,
          orgRef,
          buyerRes.mainContract,
          date,
        )
      : Promise.resolve(undefined),
    (input.bankAccount
      ? resolveOrgBankAccount(conn, orgRef, input.bankAccount)
      : Promise.resolve(org.mainBank)
    ).then(async (bankRef): Promise<QuickPlan["bank"]> => {
      if (!bankRef) return undefined;
      const acc = await conn.client
        .getEntity(
          `Catalog_БанковскиеСчета(guid'${guid(bankRef)}')${buildQuery({ select: ["Ref_Key", "Description", "НомерСчета"] })}`,
        )
        .catch(() => ({}) as ODataEntity);
      return {
        ref: guid(bankRef),
        number: str(acc["НомерСчета"]) || undefined,
        name: str(acc["Description"]) || undefined,
      };
    }),
    withVat ? vatRateRefs(conn, [...new Set(rates)]) : Promise.resolve(new Map<string, string>()),
    needCreateUnit ? unitRef(conn) : Promise.resolve(undefined),
    buyerRes.buyer
      ? findDuplicateInvoices(conn, invoiceSet, {
          buyerRef: buyerRes.buyer.ref,
          orgRef,
          date,
          total,
          lineKeys: lines.map((l) =>
            lineKey(l.action === "use" ? l.ref : undefined, l.quantity, l.price, l.sum),
          ),
        })
      : Promise.resolve({ duplicates: [], notes: [] }),
  ]);
  if (contractRes?.choice) choices.push(contractRes.choice);
  notes.unshift(...dupRes.notes);
  notes.push(...(contractRes?.notes ?? []));
  if (!bank) notes.push("У организации нет банковского счёта — в счёте не будет реквизитов для оплаты.");
  if (!input.paymentCode) notes.push("КНП не указан — поле «Код назначения платежа» в счёте будет пустым.");
  for (const l of lines) if (l.action === "create") l.unitRef = newUnit;
  return {
    ready: choices.length === 0,
    choices,
    notes,
    org,
    buyer: buyerRes.buyer,
    contract: contractRes?.contract,
    bank,
    date,
    dateTime,
    lines,
    withVat,
    totals: { sum, vat, total },
    invoiceSet,
    contractSet,
    nomSet,
    currencyRef,
    vatRefs,
    duplicates: dupRes.duplicates,
  };
}

/** Payload договора «С покупателем» — как write.catalog.create_contract в казахстанской базе. */
export function contractPayload(plan: QuickPlan): Record<string, unknown> {
  return clean({
    Description: plan.contract?.name ?? "Договор б/н",
    НомерДоговора: plan.contract?.number ?? "б/н",
    ДатаДоговора: `${plan.date}T00:00:00`,
    Owner_Key: plan.buyer!.ref,
    ВидДоговора: "СПокупателем",
    Организация_Key: plan.org.ref,
    ВалютаВзаиморасчетов_Key: plan.currencyRef,
    ВедениеВзаиморасчетов: "ПоДоговоруВЦелом",
  });
}

/** Payload номенклатуры — как write.catalog.create_nomenclature в казахстанской базе. */
export function nomenclaturePayload(l: PlannedLine): Record<string, unknown> {
  return clean({
    Description: l.name,
    НаименованиеПолное: l.name,
    ...(l.kind === "service" ? { Услуга: true } : {}),
    БазоваяЕдиницаИзмерения_Key: l.unitRef,
  });
}

/** Payload счёта — как write.sales.create_invoice в казахстанской базе; ссылки — найденные или назначенные шагам. */
export function invoicePayload(
  plan: QuickPlan,
  refs: { contract: string | undefined; lines: Array<string | undefined> },
  input: { paymentCode?: string | undefined; sumIncludesVat: boolean },
): Record<string, unknown> {
  const goods: Array<Record<string, unknown>> = [];
  const services: Array<Record<string, unknown>> = [];
  plan.lines.forEach((l, i) => {
    const common = {
      Номенклатура_Key: refs.lines[i],
      Количество: l.quantity,
      Цена: l.price,
      Сумма: l.sum,
      ...(plan.withVat ? { СтавкаНДС_Key: plan.vatRefs.get(l.vatRate) } : {}),
      СуммаНДС: l.vat,
    };
    if (l.kind === "service")
      services.push({ LineNumber: services.length + 1, ...common, Содержание: l.content });
    else
      goods.push({
        LineNumber: goods.length + 1,
        ...common,
        ЕдиницаИзмерения_Key: l.unitRef,
        Коэффициент: 1,
      });
  });
  return clean({
    Date: plan.dateTime,
    Posted: false,
    Организация_Key: plan.org.ref,
    Контрагент_Key: plan.buyer!.ref,
    ДоговорКонтрагента_Key: refs.contract,
    ВалютаДокумента_Key: plan.currencyRef,
    КурсВзаиморасчетов: 1,
    КратностьВзаиморасчетов: 1,
    УчитыватьНДС: plan.withVat,
    СуммаВключаетНДС: plan.withVat && input.sumIncludesVat,
    СуммаДокумента: plan.totals.total,
    КодНазначенияПлатежа: input.paymentCode,
    ...(plan.bank
      ? {
          СтруктурнаяЕдиница: plan.bank.ref,
          СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
        }
      : {}),
    ...(goods.length ? { Товары: goods } : {}),
    ...(services.length ? { Услуги: services } : {}),
  });
}

function clean(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""));
}

/** Шаги создания в порядке выполнения; ссылки на создаваемое — назначенные журналом (refs). */
function createSteps(
  plan: QuickPlan,
  assigned: Map<string, string | undefined>,
  input: QuickInput,
): CreateStep[] {
  const steps: CreateStep[] = [];
  if (plan.contract?.action === "create")
    steps.push({
      step: "contract",
      entitySet: plan.contractSet!,
      payload: contractPayload(plan),
      label: `Договор «${plan.contract.name}»`,
    });
  plan.lines.forEach((l) => {
    if (l.action === "create")
      steps.push({
        step: `nomenclature:${l.index}`,
        entitySet: plan.nomSet,
        payload: nomenclaturePayload(l),
        label: `${l.kind === "service" ? "Услуга" : "Товар"} «${l.name}»`,
      });
  });
  const refs = {
    contract: plan.contract?.action === "create" ? assigned.get("contract") : plan.contract?.ref,
    lines: plan.lines.map((l) => (l.action === "create" ? assigned.get(`nomenclature:${l.index}`) : l.ref)),
  };
  steps.push({
    step: "invoice",
    entitySet: plan.invoiceSet,
    payload: invoicePayload(plan, refs, input),
    label: "Счёт на оплату покупателю",
  });
  return steps;
}

/** Компактный план для ответа. */
function planView(plan: QuickPlan) {
  return {
    date: plan.date,
    organization: { ref: plan.org.ref, name: plan.org.name, vatPayer: plan.org.vatPayer },
    ...(plan.buyer ? { buyer: plan.buyer } : {}),
    ...(plan.contract
      ? {
          contract:
            plan.contract.action === "create"
              ? { action: "создать", name: plan.contract.name, date: plan.contract.date }
              : {
                  action: "найден",
                  ref: plan.contract.ref,
                  name: plan.contract.name,
                  number: plan.contract.number,
                  date: plan.contract.date,
                },
        }
      : {}),
    ...(plan.bank ? { bankAccount: plan.bank } : {}),
    lines: plan.lines.map((l) => ({
      ...(l.action === "create" ? { action: "создать" } : { action: "найдена", ref: l.ref }),
      name: l.name,
      kind: l.kind === "service" ? "услуга" : "товар",
      quantity: l.quantity,
      price: l.price,
      sum: l.sum,
      vatRate: l.vatRate,
      ...(plan.withVat ? { vat: l.vat } : {}),
    })),
    totals: { ...plan.totals, withVat: plan.withVat },
    // Всегда, когда покупатель найден: пустой массив — проверено, похожих счетов нет.
    ...(plan.buyer ? { possibleDuplicates: plan.duplicates } : {}),
  };
}

const duplicateList = (d: DuplicateInvoice[]): string =>
  d.map((x) => `№ ${x.number} от ${x.date} на ${x.total} (ref ${x.ref})`).join("; ");

const writeBlocked = (conn: Connection): string | undefined =>
  conn.behavior.readOnly
    ? "Запись запрещена: сервер в режиме только-чтение (READ_ONLY=true)."
    : !conn.cfg.writable
      ? `Запись в базу "${conn.cfg.name}" запрещена: задайте ODATA_DB_${conn.cfg.name.toUpperCase()}_WRITABLE=true.`
      : undefined;

/** Перечитывает созданный счёт из базы и печатает PDF. */
async function finish(
  conn: Connection,
  plan: { invoiceSet: string },
  invoiceRef: string,
  target: Awaited<ReturnType<typeof printTarget>>,
  base: Record<string, unknown>,
  notes: string[],
): Promise<CallToolResult> {
  const doc = await conn.client.getEntity(
    `${plan.invoiceSet}(guid'${invoiceRef}')${buildQuery({ select: ["Ref_Key", "Number", "Date", "Posted", "СуммаДокумента", "DeletionMark"] })}`,
  );
  let pdf: Record<string, unknown>;
  try {
    const printed = await printInvoice(conn, invoiceRef, target);
    notes.push(...printed.notes);
    pdf = {
      ...(printed.saved ? { path: printed.saved.path, fileName: printed.saved.fileName } : {}),
      size: printed.pdf.length,
      ...(printed.saveError ? { saveError: printed.saveError } : {}),
    };
  } catch (e) {
    pdf = {
      error: `PDF не построен: ${(e as Error).message}. Счёт создан — повторите read.document.print_invoice.`,
    };
  }
  return ok({
    ...base,
    invoice: {
      ref: str(doc["Ref_Key"]) || invoiceRef,
      number: docNumber(str(doc["Number"])),
      number1C: str(doc["Number"]),
      date: str(doc["Date"]).slice(0, 10),
      total: Number(doc["СуммаДокумента"] ?? 0),
      posted: doc["Posted"] === true,
    },
    pdf,
    ...(notes.length ? { notes } : {}),
  });
}

export async function quickInvoice(conn: Connection, input: QuickInput): Promise<CallToolResult> {
  const started = Date.now();
  if (!(await isKazakhstan(conn)))
    throw new InputError(
      "write.sales.quick_invoice работает с казахстанской базой (БИН/ИИН, тенге, НДС РК).",
    );
  const target = await printTarget(conn, input.outputDir); // outputDir проверяется до записи
  const requestHash = fingerprintWriteInput(QUICK_INVOICE_TOOL, input as unknown as Record<string, unknown>);
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
    // Счёт уже создан этой операцией — не трогаем 1С, только перечитываем и печатаем.
    const inv = sub("invoice");
    const settled = await conn.client.operationSettled(inv.id, inv.hash);
    if (settled?.result["Ref_Key"]) {
      const invoiceSet = await requireEntity(
        conn,
        DOCUMENTS.customerInvoice,
        "Документ «Счёт на оплату покупателю»",
      );
      return finish(
        conn,
        { invoiceSet },
        settled.result["Ref_Key"],
        target,
        {
          created: true,
          replayed: true,
          database: conn.cfg.name,
          operationId: opId,
          note: "Счёт уже был создан этой операцией — повторно не создавался.",
        },
        [],
      );
    }
    const plan = await planQuickInvoice(conn, input);
    if (!plan.ready)
      throw new InputError(
        `Нужен выбор: ${plan.choices.map((c) => `${c.field} — ${c.reason} ${c.howTo}`).join(" ")} Затем новый план.`,
      );
    const assigned = new Map<string, string | undefined>();
    const pre = createSteps(plan, assigned, input);
    // Все шаги должны быть подготовлены планом с этим operationId — иначе ни одного POST.
    for (const s of pre) {
      const entry = await conn.client.operationEntry(sub(s.step).id);
      if (!entry)
        throw new InputError(
          `Шаг «${s.label}» не подготовлен планом с operationId ${opId} (план менялся или делался в режиме только-чтение). Ничего не создано — выполните новый план.`,
        );
      assigned.set(s.step, entry.refKey);
    }
    const steps = createSteps(plan, assigned, input); // счёт — с назначенными ссылками
    const created: Array<Record<string, unknown>> = [];
    let invoiceRef = "";
    for (const s of steps) {
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
              : `Исправьте причину и сделайте новый план (confirm=false): уже созданное он найдёт в базе и не создаст повторно.`),
        );
      }
      const ref = str(entity["Ref_Key"]);
      if (s.step === "invoice") invoiceRef = ref;
      else
        created.push({
          type: s.label,
          ref,
          ...(entity["_operation_replayed"] === true ? { replayed: true } : {}),
        });
    }
    // Дубли перепроверены этим же вызовом (план пересобран до записи) — не блокируют, но видны в ответе.
    return finish(
      conn,
      plan,
      invoiceRef,
      target,
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
              `ВНИМАНИЕ: создан ещё один счёт, хотя у покупателя на эту дату и сумму уже есть ${duplicateList(plan.duplicates)}. ` +
                "Если он не нужен — пометьте созданный на удаление (write.entity.mark_for_deletion).",
            ]
          : []),
        "Счёт создан без проведения (счёт на оплату проводок не делает).",
      ],
    );
  }

  // План.
  const plan = await planQuickInvoice(conn, input);
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
  const assigned = new Map<string, string | undefined>();
  const sub = (step: string) => ({ id: subOperationId(opId, step), hash: subRequestHash(requestHash, step) });
  const prepare = async (s: CreateStep) => {
    const { id, hash } = sub(s.step);
    await withWriteOperation(id, hash, () => conn.client.prepareCreate(s.entitySet, s.payload));
    return (await conn.client.operationEntry(id))?.refKey;
  };
  if (!blocked) {
    // Отпечатки шагов в журнал. Ref_Key создаваемым договору/номенклатуре назначаются сейчас — счёт ссылается на них.
    for (const s of createSteps(plan, assigned, input))
      if (s.step !== "invoice") assigned.set(s.step, await prepare(s));
  }
  const steps = createSteps(plan, assigned, input);
  if (!blocked) await prepare(steps[steps.length - 1]!);
  const willCreate = steps.map((s) =>
    s.step === "invoice" ? "Счёт на оплату покупателю (без проведения) + PDF" : s.label,
  );
  return ok({
    dryRun: true,
    ready: true,
    database: conn.cfg.name,
    operationId: opId,
    ...view,
    willCreate,
    ...(plan.notes.length ? { notes: plan.notes } : {}),
    note:
      (plan.duplicates.length
        ? `ВОЗМОЖНЫЙ ДУБЛЬ: ${duplicateList(plan.duplicates)}. Покажите possibleDuplicates пользователю и спросите: ` +
          "использовать существующий (PDF — read.document.print_invoice с его ref) или создать ещё. confirm=true — " +
          "только после ответа «создай ещё». "
        : "") +
      (blocked
        ? `План. ВНИМАНИЕ: ${blocked} confirm=true не пройдёт.`
        : "План. Ничего не создано. Чтобы создать, повторите вызов с теми же аргументами, confirm=true и этим operationId."),
    elapsedMs: Date.now() - started,
  });
}

export function registerQuickInvoiceTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    QUICK_INVOICE_TOOL,
    {
      title: "Счёт на оплату в один вызов (Казахстан)",
      description:
        "Счёт на оплату покупателю за один-два вызова вместо 6–8. confirm=false (по умолчанию) — один вызов: сам находит " +
        "организацию (статус НДС — по карточке; неплательщик — «без НДС»), покупателя по БИН/ИИН, действующий договор " +
        "«С покупателем», номенклатуру по наименованию, основной банковский счёт — и возвращает компактный план: " +
        "что найдено, что будет создано («создать» — договор/услуга), итоги, notes и operationId. Ничего не пишет. " +
        "Неоднозначность (два договора, похожие услуги) — варианты в choices, без догадок. План проверяет дубли: " +
        "счета того же покупателя за тот же день на ту же сумму (проведённые и нет; помеченные на удаление не считаются) " +
        "— в possibleDuplicates (номер, дата, ref, сумма, posted, linesMatch). Не пуст — ОБЯЗАТЕЛЬНО покажите его " +
        "пользователю до подтверждения: «используй №N» (PDF — read.document.print_invoice) или «создай ещё». confirm=true с тем же operationId " +
        "и теми же аргументами — создаёт недостающее и счёт БЕЗ проведения, перечитывает его из базы и сразу сохраняет PDF " +
        "(путь — pdf.path); дубли перепроверяются и возвращаются в possibleDuplicates, но не блокируют. Повтор после сбоя с тем же operationId не создаёт дубликатов. Показывайте план пользователю " +
        "и подтверждайте только с его согласия.",
      inputSchema: quickInvoiceInput,
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
      guard(QUICK_INVOICE_TOOL, async () => {
        // Значения по умолчанию (quantity, kind, sumIncludesVat…) — и при вызове в обход валидации SDK.
        const input = z.object(quickInvoiceInput).parse(args) as QuickInput;
        return quickInvoice(ctx.db(input.database), input);
      }),
  );
}
