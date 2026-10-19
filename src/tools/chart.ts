import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { CHART_CANDIDATES } from "../odata/accounting.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { buildQuery, cmp, contains, odataGuid, odataString, or } from "../odata/query.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, guard, ok } from "./_shared.js";
import { clean, confirmField, createOrPreview } from "./write.js";

/**
 * План счетов (ChartOfAccounts_Типовой / _Хозрасчетный): счета, субсчета (Parent_Key), признаки валютного,
 * количественного и забалансового учёта, вид счёта (А/П/АП) и виды субконто (ExtDimensionTypes) с типами
 * значений из плана видов характеристик (ValueType.Types). Справочник «Ценные бумаги» — создание элемента.
 */

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;

/** Вид субконто: наименование и допустимые типы значений в нотации OData (Catalog_X, Document_X, перечисление X). */
export interface SubcontoKind {
  ref: string;
  name: string;
  /** Имена сущностей OData: Catalog_Контрагенты, Document_ГТДИмпорт, ВидыПлатежейВБюджетИФонды (перечисление). */
  types: string[];
  /** Сырые имена типов 1С из ValueType (CatalogRef.Контрагенты, EnumRef.…, String…). */
  rawTypes: string[];
}

/** CatalogRef.X → Catalog_X; DocumentRef.X → Document_X; EnumRef.X → X (перечисление); примитивы — как есть. */
export function odataTypeOf(raw: string): {
  entity: string;
  kind: "catalog" | "document" | "enum" | "other";
} {
  const m = /^(\w+)Ref\.(.+)$/.exec(raw);
  if (!m) return { entity: raw, kind: "other" };
  const [, prefix, name] = m;
  if (prefix === "Catalog") return { entity: `Catalog_${name}`, kind: "catalog" };
  if (prefix === "Document") return { entity: `Document_${name}`, kind: "document" };
  if (prefix === "Enum") return { entity: name!, kind: "enum" };
  return { entity: `${prefix}_${name}`, kind: "other" };
}

const kindsCache = new WeakMap<object, Promise<Map<string, SubcontoKind>>>();

/** Все виды субконто базы (планы видов характеристик «ВидыСубконто…»), Ref_Key в нижнем регистре → вид. */
export function subcontoKinds(conn: Connection): Promise<Map<string, SubcontoKind>> {
  const cached = kindsCache.get(conn);
  if (cached) return cached;
  const p = (async () => {
    const out = new Map<string, SubcontoKind>();
    const sets = [...(await conn.available())].filter(
      (s) => s.startsWith("ChartOfCharacteristicTypes_") && s.includes("Субконто"),
    );
    for (const set of sets) {
      let rows: ODataEntity[];
      try {
        rows = (
          await fetchAll(conn.client, set, { select: ["Ref_Key", "Description", "ValueType"] }, 200, 2000)
        ).rows;
      } catch {
        try {
          rows = (await fetchAll(conn.client, set, { select: ["Ref_Key", "Description"] }, 200, 2000)).rows;
        } catch {
          continue;
        }
      }
      for (const r of rows) {
        const vt = r["ValueType"] as { Types?: unknown } | undefined;
        const rawTypes = Array.isArray(vt?.Types) ? vt!.Types.map(String) : [];
        out.set(String(r["Ref_Key"]).toLowerCase(), {
          ref: String(r["Ref_Key"]),
          name: String(r["Description"] ?? ""),
          rawTypes,
          types: rawTypes.map((t) => odataTypeOf(t).entity),
        });
      }
    }
    return out;
  })();
  kindsCache.set(conn, p);
  p.catch(() => kindsCache.delete(conn));
  return p;
}

export interface AccountSubconto {
  index: number;
  kindRef: string;
  kind: string;
  types: string[];
  turnoversOnly: boolean;
  /** Учёт по субконто: суммовой / валютный / количественный. */
  amount: boolean;
  currency: boolean;
  quantity: boolean;
}

export interface AccountInfo {
  ref: string;
  code: string;
  description: string;
  parentRef?: string | undefined;
  parentCode?: string | undefined;
  /** Active / Passive / ActivePassive (А / П / АП). */
  type: string;
  typeShort: string;
  offBalance: boolean;
  currency: boolean;
  quantity: boolean;
  /** Группа: проводки на счёт запрещены (ЗапретитьИспользоватьВПроводках) — используйте субсчёт. */
  forbiddenInEntries: boolean;
  deleted: boolean;
  subconto: AccountSubconto[];
  subaccounts?: string[] | undefined;
}

const TYPE_SHORT: Record<string, string> = { Active: "А", Passive: "П", ActivePassive: "АП" };

export function accountInfo(
  r: ODataEntity,
  kinds: Map<string, SubcontoKind>,
  codeByRef: Map<string, string>,
): AccountInfo {
  const dims = ((r["ExtDimensionTypes"] as ODataEntity[] | undefined) ?? [])
    .slice()
    .sort((a, b) => Number(a["LineNumber"] ?? 0) - Number(b["LineNumber"] ?? 0));
  const parent = isRef(r["Parent_Key"]) ? String(r["Parent_Key"]) : undefined;
  return {
    ref: String(r["Ref_Key"] ?? ""),
    code: String(r["Code"] ?? ""),
    description: String(r["Description"] ?? ""),
    ...(parent ? { parentRef: parent, parentCode: codeByRef.get(parent.toLowerCase()) } : {}),
    type: String(r["Type"] ?? ""),
    typeShort: TYPE_SHORT[String(r["Type"] ?? "")] ?? String(r["Type"] ?? ""),
    offBalance: r["OffBalance"] === true,
    currency: r["Валютный"] === true,
    quantity: r["Количественный"] === true,
    forbiddenInEntries: r["ЗапретитьИспользоватьВПроводках"] === true,
    deleted: r["DeletionMark"] === true,
    subconto: dims.map((d, i) => {
      const kindRef = String(d["ExtDimensionType_Key"] ?? "");
      const k = kinds.get(kindRef.toLowerCase());
      return {
        index: i + 1,
        kindRef,
        kind: k?.name ?? "",
        types: k?.types ?? [],
        turnoversOnly: d["TurnoversOnly"] === true,
        amount: d["Суммовой"] !== false,
        currency: d["Валютный"] === true,
        quantity: d["Количественный"] === true,
      };
    }),
  };
}

const ACCOUNT_SELECT = [
  "Ref_Key",
  "Code",
  "Description",
  "Parent_Key",
  "Type",
  "OffBalance",
  "DeletionMark",
  "Валютный",
  "Количественный",
  "ЗапретитьИспользоватьВПроводках",
  "ExtDimensionTypes",
];

/** Весь план счетов (кешируется на соединение — читается один раз, ~300–400 строк). */
const chartCache = new WeakMap<object, Promise<{ chart: string; rows: ODataEntity[] }>>();
export function loadChart(conn: Connection): Promise<{ chart: string; rows: ODataEntity[] }> {
  const cached = chartCache.get(conn);
  if (cached) return cached;
  const p = (async () => {
    const chart = await requireEntity(conn, CHART_CANDIDATES, "План счетов");
    const props = new Set(
      ((await conn.getMetadata()).entities.get(chart)?.properties ?? []).map((x) => x.name),
    );
    const select = props.size ? ACCOUNT_SELECT.filter((f) => props.has(f)) : ACCOUNT_SELECT;
    const { rows, truncated } = await fetchAll(conn.client, chart, { select, orderby: "Code" }, 500, 5000);
    if (truncated) throw new Error("План счетов больше 5000 счетов — чтение прервано.");
    return { chart, rows };
  })();
  chartCache.set(conn, p);
  p.catch(() => chartCache.delete(conn));
  return p;
}

/** Счёт по коду (точно) или Ref_Key, с видами субконто и признаками учёта. */
export async function getAccount(conn: Connection, codeOrRef: string): Promise<AccountInfo> {
  const { rows } = await loadChart(conn);
  const kinds = await subcontoKinds(conn);
  const codeByRef = new Map(rows.map((r) => [String(r["Ref_Key"]).toLowerCase(), String(r["Code"] ?? "")]));
  const q = codeOrRef.trim().replace(/[{}']/g, "");
  const row =
    rows.find((r) => String(r["Code"] ?? "") === q) ??
    rows.find((r) => String(r["Ref_Key"]).toLowerCase() === q.toLowerCase());
  if (!row)
    throw new InputError(`Счёт «${codeOrRef}» не найден в плане счетов (укажите точный код, напр. 1030).`);
  const info = accountInfo(row, kinds, codeByRef);
  const subs = rows
    .filter((r) => String(r["Parent_Key"] ?? "").toLowerCase() === info.ref.toLowerCase())
    .map((r) => String(r["Code"] ?? ""));
  return { ...info, ...(subs.length ? { subaccounts: subs } : {}) };
}

const accountSchema = z
  .object({ code: z.string(), description: z.string(), subconto: z.array(z.object({}).passthrough()) })
  .passthrough();

export function registerChartTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.accounting.get_chart_of_accounts",
    {
      title: "План счетов",
      description:
        "План счетов базы (Казахстан — «Типовой», Россия — «Хозрасчётный»): код, наименование, родитель (субсчета), " +
        "вид А/П/АП, признаки валютного, количественного и забалансового учёта, запрет проводок на группу и виды " +
        "субконто (до 3) с допустимыми типами значений и признаками «только обороты», валютный/количественный учёт " +
        "по субконто. Фильтры: codePrefix (напр. 10, 12, 33), currencyOnly, quantityOnly. Только чтение.",
      inputSchema: {
        database: databaseField,
        codePrefix: z.string().trim().max(20).optional().describe("Префикс кода счёта, напр. 10 или 1210"),
        search: z.string().trim().max(100).optional().describe("Часть наименования счёта"),
        currencyOnly: z.boolean().default(false).describe("Только счета с валютным учётом"),
        quantityOnly: z.boolean().default(false).describe("Только счета с количественным учётом"),
        includeDeleted: z.boolean().default(false).describe("Показывать помеченные на удаление"),
        limit: z.number().int().min(1).max(1000).default(500).describe("Максимум счетов в ответе"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          chart: z.string(),
          count: z.number(),
          accounts: z.array(accountSchema),
        })
        .passthrough(),
    },
    ({ database, codePrefix, search, currencyOnly, quantityOnly, includeDeleted, limit }) =>
      guard("read.accounting.get_chart_of_accounts", async () => {
        const conn = ctx.db(database);
        const { chart, rows } = await loadChart(conn);
        const kinds = await subcontoKinds(conn);
        const codeByRef = new Map(
          rows.map((r) => [String(r["Ref_Key"]).toLowerCase(), String(r["Code"] ?? "")]),
        );
        const s = search?.toLowerCase();
        const list = rows
          .map((r) => accountInfo(r, kinds, codeByRef))
          .filter(
            (a) =>
              (includeDeleted || !a.deleted) &&
              (!codePrefix || a.code.startsWith(codePrefix)) &&
              (!s || a.description.toLowerCase().includes(s)) &&
              (!currencyOnly || a.currency) &&
              (!quantityOnly || a.quantity),
          );
        const parents = new Set(list.map((a) => a.parentRef?.toLowerCase()).filter(Boolean));
        const accounts = list.slice(0, limit).map((a) => ({
          ...a,
          hasSubaccounts:
            parents.has(a.ref.toLowerCase()) ||
            rows.some((r) => String(r["Parent_Key"] ?? "").toLowerCase() === a.ref.toLowerCase()),
        }));
        return ok({
          database: conn.cfg.name,
          chart,
          count: list.length,
          ...(list.length > limit
            ? { truncated: true, note: `Показано ${limit} из ${list.length} — уточните codePrefix.` }
            : {}),
          accounts,
        });
      }),
  );

  server.registerTool(
    "read.accounting.get_account",
    {
      title: "Счёт плана счетов",
      description:
        "Карточка счёта по коду (или Ref_Key): вид А/П/АП, валютный/количественный/забалансовый учёт, запрет проводок " +
        "(группа), родитель и субсчета, виды субконто 1–3 с допустимыми типами значений (Catalog_…/Document_…/" +
        "перечисление) и признаками учёта по субконто. Нужна перед составлением проводок ручной операции " +
        "(write.accounting.set_operation_entries). Только чтение.",
      inputSchema: {
        database: databaseField,
        account: z.string().trim().min(1).max(40).describe("Код счёта (напр. 1030) или Ref_Key"),
      },
      outputSchema: z.object({ database: z.string(), account: accountSchema }).passthrough(),
    },
    ({ database, account }) =>
      guard("read.accounting.get_account", async () => {
        const conn = ctx.db(database);
        return ok({ database: conn.cfg.name, account: await getAccount(conn, account) });
      }),
  );

  server.registerTool(
    "write.catalog.create_security",
    {
      title: "Создать ценную бумагу",
      description:
        "Создаёт элемент справочника «Ценные бумаги» (Catalog_ЦенныеБумаги) — наименование и (опц.) код. Перед " +
        "созданием ищет дубль по наименованию (без учёта регистра) и коду; найден — отказ с Ref_Key существующего. " +
        "Ценная бумага — вид субконто счетов финансовых инвестиций (1110, 1150, 2010, 2050 и т.п.). " +
        "По умолчанию предпросмотр (dry-run); создание — при confirm=true после согласия бухгалтера.",
      inputSchema: {
        database: databaseField,
        name: z.string().trim().min(1).max(150).describe("Наименование ценной бумаги"),
        code: z.string().trim().max(20).optional().describe("Код (по умолчанию присвоит 1С)"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, name, code, confirm }) =>
      guard("write.catalog.create_security", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, ["Catalog_ЦенныеБумаги"], "Справочник «Ценные бумаги»");
        const dupFilter = or(
          contains("Description", name.replace(/\s+/g, " ")),
          code ? cmp("Code", "eq", odataString(code)) : undefined,
        );
        const { rows } = await fetchAll(
          conn.client,
          set,
          { filter: dupFilter, select: ["Ref_Key", "Code", "Description", "DeletionMark"] },
          50,
          200,
        );
        const norm = (v: unknown) =>
          String(v ?? "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
        const dup = rows.find(
          (r) => norm(r["Description"]) === norm(name) || (code && String(r["Code"] ?? "").trim() === code),
        );
        if (dup)
          throw new InputError(
            `В справочнике «Ценные бумаги» уже есть «${String(dup["Description"])}» (код ${String(dup["Code"] ?? "")}, ` +
              `Ref_Key ${String(dup["Ref_Key"])}${dup["DeletionMark"] === true ? ", помечен на удаление" : ""}). Дубль не создаём.`,
          );
        const notes = rows.length
          ? [
              `Похожие элементы (не совпадают точно): ${rows.map((r) => String(r["Description"])).join("; ")}.`,
            ]
          : [];
        return createOrPreview(conn, set, clean({ Description: name, Code: code }), confirm, notes);
      }),
  );
}

/** Значение субконто существует в справочнике/документе (GET по ключу). Перечисления не проверяются. */
export async function refExists(conn: Connection, entity: string, ref: string): Promise<boolean | undefined> {
  if (!(await conn.available()).has(entity)) return undefined;
  try {
    await conn.client.getEntity(`${entity}(${odataGuid(ref)})${buildQuery({ select: ["Ref_Key"] })}`);
    return true;
  } catch (e) {
    if (e instanceof ODataError && e.kind === "not_found") return false;
    throw e;
  }
}
