import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, contains, odataGuid, odataString, or } from "../odata/query.js";
import { fingerprintWriteInput, withWriteOperation } from "../odata/write-operation-context.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok, organizationField } from "./_shared.js";
import { isKazakhstan, tengeRef } from "./write-kz.js";
import { almatyNow, normName, subOperationId, subRequestHash, writeBlocked } from "./quick-invoice.js";
import { printTarget } from "./print.js";
import {
  documentNames,
  printReconciliation,
  RECONCILIATION_SET,
  RECONCILIATION_SUBDIR,
} from "./print-reconciliation.js";
import { amountInWords } from "../print/amount-words.js";
import { debtStatement, reconciliationTotals, type ReconciliationData } from "../print/reconciliation-pdf.js";
import { trimNumber } from "../print/doc-titles.js";

/**
 * Акт сверки с контрагентом «в один вызов» (Казахстан) — то же, что кнопка «Заполнить» акта в 1С, но расчёт в MCP:
 * через OData код документа не вызвать. Счета расчётов — счета плана с субконто «Контрагенты» и «Договоры» (так 1С
 * заполняет «Список счетов» акта); сальдо на начало — остаток по ним на начало периода; строки — движения регистра
 * «Типовой» по контрагенту (и договору) за период, по документам; внутренние обороты между счетами расчётов одного
 * контрагента не включаются. Сторона контрагента — зеркально, без документов. confirm=false — план с цифрами;
 * confirm=true с тем же operationId — акт без проведения и PDF.
 */
export const QUICK_RECONCILIATION_TOOL = "write.counterparty.quick_reconciliation";

const REGISTER = "AccountingRegister_Типовой";
const SUBCONTO_TYPES = "ChartOfCharacteristicTypes_ВидыСубконтоТиповые";
const CHART = "ChartOfAccounts_Типовой";
const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const isGuid = (s: string | undefined): boolean => !!s && GUID_RE.test(s.trim());
const guid = (s: string): string => s.trim().replace(/[{}]/g, "");
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const round2 = (n: number): number => Math.round(n * 100) / 100;
const MAX_RECORDS = 20000;

/** Счета расчётов: у счёта есть субконто «Контрагенты» и «Договоры» — как «Список счетов» акта в 1С. */
export async function settlementAccounts(conn: Connection): Promise<Map<string, string>> {
  const { rows: types } = await fetchAll(
    conn.client,
    SUBCONTO_TYPES,
    {
      filter: or(
        cmp("PredefinedDataName", "eq", odataString("Контрагенты")),
        cmp("PredefinedDataName", "eq", odataString("Договоры")),
      ),
      select: ["Ref_Key", "PredefinedDataName"],
    },
    10,
    10,
  );
  const typeOf = new Map(types.map((t) => [str(t["PredefinedDataName"]), str(t["Ref_Key"])]));
  const cpType = typeOf.get("Контрагенты");
  const contractType = typeOf.get("Договоры");
  if (!cpType || !contractType)
    throw new InputError(
      "В плане видов субконто нет предопределённых «Контрагенты» и «Договоры» — акт не посчитать.",
    );
  const { rows } = await fetchAll(
    conn.client,
    CHART,
    { select: ["Ref_Key", "Code", "ExtDimensionTypes"] },
    500,
    5000,
  );
  const out = new Map<string, string>();
  for (const a of rows) {
    const kinds = ((a["ExtDimensionTypes"] as ODataEntity[] | undefined) ?? []).map((t) =>
      str(t["ExtDimensionType_Key"]),
    );
    if (kinds.includes(cpType) && kinds.includes(contractType)) out.set(str(a["Ref_Key"]), str(a["Code"]));
  }
  return out;
}

export interface RegisterRow {
  date: string;
  documentRef: string;
  documentType: string;
  debit: number;
  credit: number;
}

/**
 * Данные акта по регистру: сальдо на начало и строки по документам с точки зрения организации («+» — долг
 * контрагента). from не задан — с начала учёта, сальдо на начало 0.
 */
export async function reconciliationFromRegister(
  conn: Connection,
  p: {
    org: string;
    counterparty: string;
    contract?: string | undefined;
    from?: string | undefined;
    to: string;
  },
): Promise<{ opening: number; rows: RegisterRow[]; truncated: boolean; accounts: Map<string, string> }> {
  const accounts = await settlementAccounts(conn);
  const cp = `cast(${odataGuid(p.counterparty)}, 'Catalog_Контрагенты')`;
  const anyCp = (fields: string[]) => or(...fields.map((f) => cmp(f, "eq", cp)));
  const sideFields = (side: "Dr" | "Cr") => [1, 2, 3].map((i) => `ExtDimension${side}${i}`);
  const has = (r: ODataEntity, fields: string[], value: string) => fields.some((f) => str(r[f]) === value);
  const matches = (r: ODataEntity, side: "Dr" | "Cr") =>
    accounts.has(str(r[`Account${side}_Key`])) &&
    has(r, sideFields(side), p.counterparty) &&
    (!p.contract || has(r, sideFields(side), p.contract));

  let opening = 0;
  if (p.from) {
    const { rows: balances } = await fetchAll(
      conn.client,
      `${REGISTER}/Balance(Period=datetime'${p.from}T00:00:00')`,
      {
        filter: and(
          cmp("Организация_Key", "eq", odataGuid(p.org)),
          anyCp(["ExtDimension1", "ExtDimension2", "ExtDimension3"]),
        ),
      },
      500,
      MAX_RECORDS,
    );
    const ext = ["ExtDimension1", "ExtDimension2", "ExtDimension3"];
    for (const b of balances)
      if (accounts.has(str(b["Account_Key"])) && (!p.contract || has(b, ext, p.contract)))
        opening += Number(b["СуммаBalance"] ?? 0);
  }

  const period = `${p.from ? `StartPeriod=datetime'${p.from}T00:00:00',` : ""}EndPeriod=datetime'${p.to}T23:59:59'`;
  const { rows: records, truncated } = await fetchAll(
    conn.client,
    `${REGISTER}/RecordsWithExtDimensions(${period})`,
    {
      filter: and(
        cmp("Организация_Key", "eq", odataGuid(p.org)),
        anyCp([...sideFields("Dr"), ...sideFields("Cr")]),
      ),
    },
    500,
    MAX_RECORDS,
  );
  const byDoc = new Map<string, RegisterRow & { period: string }>();
  for (const r of records) {
    if (r["Active"] === false) continue;
    const dr = matches(r, "Dr");
    const cr = matches(r, "Cr");
    // Внутренние обороты (обе стороны — расчёты с тем же контрагентом, напр. зачёт аванса) в акт не идут.
    if (dr === cr) continue;
    const amount = Number(r["Сумма"] ?? 0);
    const key = `${str(r["Recorder_Type"])}|${str(r["Recorder"])}`;
    const period0 = str(r["Period"]);
    const row = byDoc.get(key) ?? {
      date: period0.slice(0, 10),
      period: period0,
      documentRef: str(r["Recorder"]),
      documentType: str(r["Recorder_Type"]),
      debit: 0,
      credit: 0,
    };
    if (dr) row.debit = round2(row.debit + amount);
    else row.credit = round2(row.credit + amount);
    byDoc.set(key, row);
  }
  const rows = [...byDoc.values()]
    .filter((r) => r.debit || r.credit)
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(({ period: _p, ...r }) => r);
  return { opening: round2(opening), rows, truncated, accounts };
}

export const quickReconciliationInput = {
  database: databaseField,
  organization: organizationField,
  counterparty: z
    .string()
    .min(1)
    .max(300)
    .describe("Контрагент: Ref_Key, БИН/ИИН (12 цифр) или наименование."),
  contract: z
    .string()
    .max(300)
    .optional()
    .describe("Договор: Ref_Key, номер или наименование. Не задан — сверка по всем договорам контрагента."),
  from: dateField("Начало периода (без него — с начала учёта, сальдо на начало 0)").optional(),
  to: dateField("Конец периода (по умолчанию — сегодня, Алматы)").optional(),
  outputDir: z
    .string()
    .max(500)
    .optional()
    .describe("Подкаталог каталога печати; по умолчанию «акты сверки»."),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "false — план с цифрами, ничего не пишет. true — создать акт (без проведения) и сразу PDF: передайте operationId из " +
        "плана и те же аргументы.",
    ),
  operationId: z.string().uuid().optional().describe("operationId из плана (обязателен при confirm=true)"),
};
type QuickInput = {
  database?: string | undefined;
  organization?: string | undefined;
  counterparty: string;
  contract?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  outputDir?: string | undefined;
  confirm: boolean;
  operationId?: string | undefined;
};

interface Choice {
  field: "counterparty" | "contract";
  reason: string;
  options: Array<Record<string, unknown>>;
  howTo: string;
}

/** Контрагент по Ref_Key, БИН/ИИН или наименованию; несколько — варианты. */
async function resolveCounterparty(
  conn: Connection,
  q: string,
): Promise<{
  ref?: string;
  name?: string;
  fullName?: string;
  bin?: string;
  fuzzy?: boolean;
  choice?: Choice;
}> {
  const select = [
    "Ref_Key",
    "Description",
    "НаименованиеПолное",
    "ИдентификационныйКодЛичности",
    "DeletionMark",
  ];
  const view = (r: ODataEntity) => ({
    ref: str(r["Ref_Key"]),
    name: str(r["Description"]) || str(r["НаименованиеПолное"]),
    fullName: str(r["НаименованиеПолное"]) || str(r["Description"]),
    bin: str(r["ИдентификационныйКодЛичности"]) || undefined,
  });
  let rows: ODataEntity[];
  if (isGuid(q)) {
    rows = [await conn.client.getEntity(`Catalog_Контрагенты(guid'${guid(q)}')${buildQuery({ select })}`)];
  } else {
    const filter = /^\d{12}$/.test(q.trim())
      ? cmp("ИдентификационныйКодЛичности", "eq", odataString(q.trim()))
      : contains("Description", q.trim());
    ({ rows } = await fetchAll(
      conn.client,
      "Catalog_Контрагенты",
      { filter: and(filter, cmp("DeletionMark", "eq", "false")), select },
      20,
      20,
    ));
    if (!/^\d{12}$/.test(q.trim())) {
      const exact = rows.filter(
        (r) =>
          normName(str(r["Description"])) === normName(q) ||
          normName(str(r["НаименованиеПолное"])) === normName(q),
      );
      if (exact.length) rows = exact;
      else if (rows.length === 1) return { ...view(rows[0]!), fuzzy: true };
      else if (rows.length)
        return {
          choice: {
            field: "counterparty",
            reason: `Точного совпадения «${q}» нет, есть похожие.`,
            options: rows.slice(0, 10).map(view),
            howTo: "Передайте counterparty — БИН/ИИН или ref нужного контрагента.",
          },
        };
    }
  }
  if (!rows.length) throw new InputError(`Контрагент «${q}» не найден. Укажите БИН/ИИН или Ref_Key.`);
  if (rows.length > 1)
    return {
      choice: {
        field: "counterparty",
        reason: `Под «${q}» найдено несколько контрагентов.`,
        options: rows.slice(0, 10).map(view),
        howTo: "Передайте counterparty — ref нужного контрагента.",
      },
    };
  return view(rows[0]!);
}

/** Договор контрагента с организацией по Ref_Key, номеру или наименованию. */
async function resolveContract(
  conn: Connection,
  q: string,
  cp: string,
  org: string,
): Promise<{ ref?: string; name?: string; choice?: Choice }> {
  const { rows } = await fetchAll(
    conn.client,
    "Catalog_ДоговорыКонтрагентов",
    {
      filter: and(
        cmp("Owner_Key", "eq", odataGuid(cp)),
        cmp("Организация_Key", "eq", odataGuid(org)),
        cmp("DeletionMark", "eq", "false"),
      ),
      select: ["Ref_Key", "Description", "НомерДоговора", "IsFolder"],
    },
    50,
    50,
  );
  const items = rows.filter((r) => r["IsFolder"] !== true);
  const hits = isGuid(q)
    ? items.filter((r) => str(r["Ref_Key"]) === guid(q))
    : items.filter(
        (r) =>
          normName(str(r["Description"])) === normName(q) ||
          normName(str(r["НомерДоговора"])) === normName(q.replace(/^№\s*/, "")) ||
          normName(str(r["Description"])).includes(normName(q)),
      );
  if (hits.length === 1) return { ref: str(hits[0]!["Ref_Key"]), name: str(hits[0]!["Description"]) };
  if (hits.length > 1)
    return {
      choice: {
        field: "contract",
        reason: `Под «${q}» подходит несколько договоров.`,
        options: hits.slice(0, 10).map((r) => ({ ref: str(r["Ref_Key"]), name: str(r["Description"]) })),
        howTo: "Передайте contract — ref нужного договора.",
      },
    };
  throw new InputError(
    `Договор «${q}» не найден.` +
      (items.length
        ? ` Есть: ${items.map((r) => `«${str(r["Description"])}» (ref ${str(r["Ref_Key"])})`).join("; ")}.`
        : ""),
  );
}

interface Plan {
  ready: boolean;
  choices: Choice[];
  org: { ref: string; name: string };
  counterparty?: { ref: string; name: string; bin?: string | undefined };
  contract?: { ref: string; name: string };
  from?: string | undefined;
  to: string;
  opening: number;
  rows: Array<RegisterRow & { document: string }>;
  totals: { debit: number; credit: number; closing: number };
  debt: string;
  accounts: Map<string, string>;
  duplicates: Array<{ ref: string; number: string; date: string }>;
  notes: string[];
}

async function planReconciliation(conn: Connection, input: QuickInput): Promise<Plan> {
  const o = await resolveOrgOrDefault(conn, input.organization);
  const org = { ref: o.ref, name: o.name };
  const to = input.to ?? almatyNow().date;
  const from = input.from;
  if (from && from > to) throw new InputError(`Начало периода ${from} позже конца ${to}.`);
  const empty: Plan = {
    ready: false,
    choices: [],
    org,
    to,
    from,
    opening: 0,
    rows: [],
    totals: { debit: 0, credit: 0, closing: 0 },
    debt: "",
    accounts: new Map(),
    duplicates: [],
    notes: [],
  };
  const cp = await resolveCounterparty(conn, input.counterparty);
  if (cp.choice) return { ...empty, choices: [cp.choice] };
  const counterparty = { ref: cp.ref!, name: cp.name!, bin: cp.bin };
  const fuzzyNote = cp.fuzzy
    ? [
        `Контрагент найден по части наименования «${input.counterparty}»: «${cp.name}» (БИН/ИИН ${cp.bin ?? "—"}) — проверьте.`,
      ]
    : [];
  let contract: Plan["contract"];
  if (input.contract?.trim()) {
    const c = await resolveContract(conn, input.contract.trim(), counterparty.ref, org.ref);
    if (c.choice) return { ...empty, counterparty, choices: [c.choice] };
    contract = { ref: c.ref!, name: c.name! };
  }
  const reg = await reconciliationFromRegister(conn, {
    org: org.ref,
    counterparty: counterparty.ref,
    contract: contract?.ref,
    from,
    to,
  });
  const names = await documentNames(
    conn,
    reg.rows.map((r) => ({ Документ: r.documentRef, Документ_Type: r.documentType })),
  );
  const rows = reg.rows.map((r) => ({ ...r, document: names.get(r.documentRef) ?? r.documentType }));
  const totals = reconciliationTotals({
    opening: reg.opening,
    organizationRows: rows.map((r) => ({ debit: r.debit, credit: r.credit })),
  });
  // Сумма прописью — по «Параметрам прописи» тенге в базе, как в PDF.
  const { rows: kzt } = await fetchAll(
    conn.client,
    "Catalog_Валюты",
    { filter: cmp("Code", "eq", odataString("398")), select: ["ПараметрыПрописиНаРусском"] },
    1,
    1,
  );
  const spelling = str(kzt[0]?.["ПараметрыПрописиНаРусском"]) || undefined;
  const orgEntity = await conn.client.getEntity(
    `Catalog_Организации(guid'${org.ref}')${buildQuery({ select: ["НаименованиеПолное"] })}`,
  );
  const debt = debtStatement(
    {
      periodEnd: to,
      organization: { name: str(orgEntity["НаименованиеПолное"]) || org.name, id: "" },
      counterparty: { name: cp.fullName ?? counterparty.name, id: "" },
      currency: "KZT",
      amountWords: amountInWords(Math.abs(totals.closing), "KZT", spelling),
    } as ReconciliationData,
    totals.closing,
  );
  const notes: string[] = [...fuzzyNote];
  if (reg.truncated)
    notes.push(`Движений больше ${MAX_RECORDS} — укажите период (from), иначе акт будет неполным.`);
  if (!rows.length && !reg.opening)
    notes.push("За период нет движений по расчётам с контрагентом и нет сальдо на начало.");
  // Дубли: акт с тем же контрагентом, договором и концом периода (не помеченный на удаление).
  const { rows: existing } = await fetchAll(
    conn.client,
    RECONCILIATION_SET,
    {
      filter: and(
        cmp("Контрагент_Key", "eq", odataGuid(counterparty.ref)),
        cmp("ДатаОкончания", "eq", `datetime'${to}T00:00:00'`),
        cmp("DeletionMark", "eq", "false"),
      ),
      select: ["Ref_Key", "Number", "Date", "ДоговорКонтрагента_Key"],
    },
    20,
    20,
  );
  const duplicates = existing
    .filter((a) => (str(a["ДоговорКонтрагента_Key"]) || EMPTY) === (contract?.ref ?? EMPTY))
    .map((a) => ({
      ref: str(a["Ref_Key"]),
      number: trimNumber(str(a["Number"])),
      date: str(a["Date"]).slice(0, 10),
    }));
  return {
    ready: true,
    choices: [],
    org,
    counterparty,
    ...(contract ? { contract } : {}),
    from,
    to,
    opening: reg.opening,
    rows,
    totals,
    debt,
    accounts: reg.accounts,
    duplicates,
    notes,
  };
}

/** Документ «Акт сверки взаиморасчетов», заполненный как кнопкой «Заполнить» в 1С. */
export async function reconciliationPayload(
  conn: Connection,
  plan: Plan,
  dateTime: string,
): Promise<Record<string, unknown>> {
  const currency = await tengeRef(conn);
  const row = (r: RegisterRow, i: number, mirror: boolean) => ({
    LineNumber: i + 1,
    Дата: `${r.date}T00:00:00`,
    ...(mirror ? {} : { Документ: r.documentRef, Документ_Type: r.documentType }),
    Дебет: mirror ? r.credit : r.debit,
    Кредит: mirror ? r.debit : r.credit,
  });
  return {
    Date: dateTime,
    Posted: false,
    Организация_Key: plan.org.ref,
    Контрагент_Key: plan.counterparty!.ref,
    ...(plan.contract ? { ДоговорКонтрагента_Key: plan.contract.ref } : {}),
    ...(currency ? { ВалютаДокумента_Key: currency } : {}),
    ДатаНачала: plan.from ? `${plan.from}T00:00:00` : "0001-01-01T00:00:00",
    ДатаОкончания: `${plan.to}T00:00:00`,
    ОстатокНаНачало: plan.opening,
    Расхождение: 0,
    СверкаСогласована: false,
    ВключатьДочерние: false,
    ВключатьВнутренниеОбороты: false,
    РазбитьПоДоговорам: false,
    ПоДаннымОрганизации: plan.rows.map((r, i) => row(r, i, false)),
    ПоДаннымКонтрагента: plan.rows.map((r, i) => row(r, i, true)),
    СписокСчетов: [...plan.accounts.keys()].map((k, i) => ({
      LineNumber: i + 1,
      Счет_Key: k,
      УчаствуетВРасчетах: true,
    })),
    СписокОрганизаций: [{ LineNumber: 1, Организация_Key: plan.org.ref }],
  };
}

function planView(plan: Plan) {
  return {
    organization: plan.org,
    ...(plan.counterparty ? { counterparty: plan.counterparty } : {}),
    contract: plan.contract ?? "все договоры контрагента",
    period: { from: plan.from ?? "с начала учёта", to: plan.to },
    opening: plan.opening,
    rows: plan.rows.map((r) => ({ date: r.date, document: r.document, debit: r.debit, credit: r.credit })),
    turnovers: { debit: plan.totals.debit, credit: plan.totals.credit },
    closing: plan.totals.closing,
    debt: plan.debt,
    possibleDuplicates: plan.duplicates,
  };
}

export async function quickReconciliation(conn: Connection, input: QuickInput): Promise<CallToolResult> {
  if (!(await isKazakhstan(conn)))
    throw new InputError(
      `${QUICK_RECONCILIATION_TOOL} работает с казахстанской базой (план счетов «Типовой»).`,
    );
  const target = await printTarget(conn, input.outputDir ?? RECONCILIATION_SUBDIR); // outputDir — до записи
  const set = await requireEntity(conn, [RECONCILIATION_SET], "Документ «Акт сверки взаиморасчетов»");
  const requestHash = fingerprintWriteInput(
    QUICK_RECONCILIATION_TOOL,
    input as unknown as Record<string, unknown>,
  );
  const blocked = writeBlocked(conn);

  if (input.confirm) {
    if (!input.operationId)
      throw new InputError("Сначала план (confirm=false). При confirm=true передайте operationId из плана.");
    if (blocked) throw new InputError(blocked);
    const id = subOperationId(input.operationId, "act");
    const hash = subRequestHash(requestHash, "act");
    const settled = await conn.client.operationSettled(id, hash);
    let actRef = settled?.result["Ref_Key"] ? String(settled.result["Ref_Key"]) : "";
    let plan: Plan | undefined;
    if (!actRef) {
      if (!(await conn.client.operationEntry(id)))
        throw new InputError(
          `План с operationId ${input.operationId} не найден (план менялся или делался в режиме только-чтение). Ничего не ` +
            "создано — выполните новый план.",
        );
      plan = await planReconciliation(conn, input);
      if (!plan.ready)
        throw new InputError(
          `Нужен выбор: ${plan.choices.map((c) => `${c.reason} ${c.howTo}`).join(" ")} Затем новый план.`,
        );
      const payload = await reconciliationPayload(conn, plan, almatyNow().dateTime);
      const created = await withWriteOperation(id, hash, () => conn.client.create<ODataEntity>(set, payload));
      actRef = str(created["Ref_Key"]);
    }
    let pdf: Record<string, unknown>;
    let notes = [...(plan?.notes ?? [])];
    let number = "";
    let closing: number | undefined;
    try {
      const printed = await printReconciliation(conn, actRef, target);
      notes = [...notes, ...printed.notes.filter((n) => !/не согласована/.test(n))];
      number = printed.data.number;
      closing = printed.data.closing;
      pdf = {
        ...(printed.saved ? { path: printed.saved.path, fileName: printed.saved.fileName } : {}),
        size: printed.pdf.length,
        ...(printed.saveError ? { saveError: printed.saveError } : {}),
      };
    } catch (e) {
      pdf = {
        error: `PDF не построен: ${(e as Error).message}. Акт создан — повторите read.document.print_reconciliation.`,
      };
    }
    return ok({
      created: true,
      ...(settled
        ? { replayed: true, note: "Акт уже был создан этой операцией — повторно не создавался." }
        : {}),
      database: conn.cfg.name,
      operationId: input.operationId,
      act: { ref: actRef, number, ...(closing !== undefined ? { closing } : {}), posted: false },
      pdf,
      ...(plan?.duplicates.length ? { possibleDuplicates: plan.duplicates } : {}),
      notes: [...notes, "Акт создан без проведения; проведение не меняет учёт."],
    });
  }

  const plan = await planReconciliation(conn, input);
  if (!plan.ready)
    return ok({
      dryRun: true,
      ready: false,
      database: conn.cfg.name,
      choices: plan.choices,
      ...planView(plan),
      note: "Нужно уточнение — выберите вариант и повторите план. Ничего не создано.",
    });
  const operationId = input.operationId ?? randomUUID();
  if (!blocked) {
    const payload = await reconciliationPayload(conn, plan, almatyNow().dateTime);
    await withWriteOperation(subOperationId(operationId, "act"), subRequestHash(requestHash, "act"), () =>
      conn.client.prepareCreate(set, payload),
    );
  }
  return ok({
    dryRun: true,
    ready: true,
    database: conn.cfg.name,
    operationId,
    ...planView(plan),
    willCreate: "Акт сверки (без проведения) + PDF",
    ...(plan.notes.length ? { notes: plan.notes } : {}),
    note:
      (plan.duplicates.length
        ? `Уже есть акт с этим контрагентом на ${plan.to}: ${plan.duplicates.map((d) => `№ ${d.number} от ${d.date} (ref ${d.ref})`).join("; ")}. ` +
          "Покажите пользователю: напечатать существующий (read.document.print_reconciliation) или создать новый. "
        : "") +
      (blocked
        ? `План. ВНИМАНИЕ: ${blocked} confirm=true не пройдёт.`
        : "План. Ничего не создано. Покажите цифры пользователю; чтобы создать акт и PDF — повторите с теми же аргументами, " +
          "confirm=true и этим operationId."),
  });
}

export function registerQuickReconciliationTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    QUICK_RECONCILIATION_TOOL,
    {
      title: "Акт сверки с контрагентом в один вызов (Казахстан)",
      description:
        "Акт сверки взаиморасчетов за один-два вызова: сам находит контрагента (БИН/ИИН, ref или наименование) и договор, " +
        "считает сальдо на начало, движения по документам за период, обороты и сальдо на конец по регистру бухгалтерии — " +
        "как кнопка «Заполнить» акта в 1С (счета расчётов — с субконто «Контрагенты» и «Договоры»; внутренние обороты не " +
        "включаются; сторона контрагента — зеркально). confirm=false — план: строки, сальдо, «задолженность в пользу …», " +
        "possibleDuplicates (акт с тем же контрагентом и концом периода) и operationId; ничего не пишет. confirm=true с тем " +
        "же operationId и аргументами — создаёт акт без проведения и сразу сохраняет PDF (pdf.path), как " +
        "read.document.print_reconciliation. Без contract — по всем договорам; без from — с начала учёта; без to — сегодня. " +
        "Показывайте план пользователю и подтверждайте только с его согласия.",
      inputSchema: quickReconciliationInput,
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
      guard(QUICK_RECONCILIATION_TOOL, async () => {
        const input = z.object(quickReconciliationInput).parse(args) as QuickInput;
        return quickReconciliation(ctx.db(input.database), input);
      }),
  );
}
