import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { fetchAll } from "../odata/pagination.js";
import { ensurePublished, requireEntity } from "../odata/publication.js";
import { and, cmp, odataGuid, odataString, type Comparison } from "../odata/query.js";
import type { MetaProperty, ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok } from "./_shared.js";

/**
 * Чтение регистров сведений: записи (с отбором и периодом) и срез последних/первых на дату
 * (виртуальные таблицы SliceLast/SliceFirst). Курсы валют — отдельный удобный инструмент поверх
 * InformationRegister_КурсыВалют с кодами и наименованиями валют.
 */

/** Регистры со служебными/секретными данными (авторизация, сессии, сертификаты, ЭЦП) — не читаем. */
const BLOCKED_REGISTER_RE =
  /Авторизац|Сесси|Сертификат|ЭлектронныеПодписи|Парол|Токен|УчетныеЗаписи|ПраваПользовател|ЗначенияПравПользователя|НастройкиПользователей|ПараметрыМетодовИСЭСФ|ВременныеИдентификаторы|ИдентификаторыЗапросов/i;
/** Колонки с секретами и бинарными данными — вырезаются из ответа. */
const SECRET_FIELD_RE = /Парол|Password|Токен|Token|Secret|Секрет|_Base64Data$/i;

/** Сегодня по местному времени (YYYY-MM-DD), а не по UTC. */
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const OPS = ["eq", "ne", "gt", "ge", "lt", "le"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

const filterItem = z.object({
  field: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Поле регистра (измерение/ресурс/реквизит), напр. Валюта_Key"),
  op: z.enum(OPS).default("eq"),
  value: z
    .union([z.string().max(300), z.number(), z.boolean()])
    .describe("Значение: GUID, строка, число, дата YYYY-MM-DD"),
});
type FilterItem = z.infer<typeof filterItem>;

/** Литерал OData по типу поля из $metadata — пользовательский ввод не склеивается в $filter как есть. */
export function literalFor(prop: MetaProperty, value: string | number | boolean): string {
  const t = (prop.type ?? "").replace(/^Edm\./, "");
  if (t === "Guid") return odataGuid(String(value));
  if (t === "Boolean") {
    if (typeof value === "boolean") return String(value);
    if (/^(true|false)$/i.test(String(value))) return String(value).toLowerCase();
    throw new InputError(`Поле ${prop.name} — логическое: укажите true или false.`);
  }
  if (["Double", "Decimal", "Int16", "Int32", "Int64", "Single", "Byte"].includes(t)) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new InputError(`Поле ${prop.name} — число: «${String(value)}» не число.`);
    return String(n);
  }
  if (t === "DateTime") {
    const s = String(value);
    if (!DATE_RE.test(s))
      throw new InputError(`Поле ${prop.name} — дата: формат YYYY-MM-DD или YYYY-MM-DDThh:mm:ss.`);
    return `datetime'${s.length === 10 ? `${s}T00:00:00` : s}'`;
  }
  return odataString(String(value));
}

export interface RegisterShape {
  /** Набор строк записей (для подчинённых регистратору — <Регистр>_RecordType). */
  rowsSet: string;
  props: Map<string, MetaProperty>;
  periodic: boolean;
  subordinate: boolean;
  /** Поля составного типа (есть поле <имя>_Type): 1С по ним не отбирает — фильтруем на стороне MCP. */
  composite: Set<string>;
}

export async function registerShape(
  conn: Connection,
  register: string,
): Promise<{ set: string; shape: RegisterShape }> {
  const set = register.startsWith("InformationRegister_") ? register : `InformationRegister_${register}`;
  if (BLOCKED_REGISTER_RE.test(set))
    throw new InputError(
      `Регистр ${set} хранит служебные данные (авторизация, сессии, сертификаты, подписи) — чтение закрыто.`,
    );
  ensurePublished(await conn.available(), set, `Регистр сведений ${set}`);
  const meta = await conn.getMetadata();
  const em = meta.entities.get(set);
  const subordinate = !!em?.properties.some((p) => p.name === "RecordSet");
  const rowsSet = subordinate ? `${set}_RecordType` : set;
  const rowMeta = meta.entities.get(rowsSet) ?? em;
  const props = new Map((rowMeta?.properties ?? []).map((p) => [p.name, p]));
  const composite = new Set([...props.keys()].filter((n) => props.has(`${n}_Type`)));
  return { set, shape: { rowsSet, props, periodic: props.has("Period"), subordinate, composite } };
}

const strip = (r: ODataEntity): ODataEntity =>
  Object.fromEntries(
    Object.entries(r).filter(([k]) => !k.includes("@navigationLinkUrl") && !SECRET_FIELD_RE.test(k)),
  );

function serverFilter(
  shape: RegisterShape,
  filters: FilterItem[],
): { server: string[]; client: FilterItem[] } {
  const server: string[] = [];
  const client: FilterItem[] = [];
  for (const f of filters) {
    if (SECRET_FIELD_RE.test(f.field)) throw new InputError(`Поле ${f.field} недоступно.`);
    const prop = shape.props.get(f.field);
    if (!prop)
      throw new InputError(
        `В регистре нет поля «${f.field}». Поля: ${[...shape.props.keys()].filter((n) => !SECRET_FIELD_RE.test(n)).join(", ")}.`,
      );
    if (shape.composite.has(f.field)) {
      if (f.op !== "eq" && f.op !== "ne")
        throw new InputError(`Поле ${f.field} составного типа — отбор только eq/ne.`);
      client.push(f);
    } else server.push(cmp(f.field, f.op as Comparison, literalFor(prop, f.value)));
  }
  return { server, client };
}

const clientMatch = (r: ODataEntity, fs: FilterItem[]) =>
  fs.every((f) => {
    const same = String(r[f.field] ?? "").toLowerCase() === String(f.value).toLowerCase();
    return f.op === "eq" ? same : !same;
  });

/** Строки регистра: записи с отбором/периодом или срез последних/первых на дату. */
export async function readInformationRegister(
  conn: Connection,
  register: string,
  opts: {
    filters?: FilterItem[];
    mode?: "records" | "sliceLast" | "sliceFirst";
    date?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit?: number;
  },
) {
  const { set, shape } = await registerShape(conn, register);
  const mode = opts.mode ?? "records";
  const limit = opts.limit ?? 200;
  const { server, client } = serverFilter(shape, opts.filters ?? []);
  const notes: string[] = [];
  if (client.length)
    notes.push(
      `Отбор по полям составного типа (${client.map((f) => f.field).join(", ")}) выполнен на стороне MCP: 1С по ним не фильтрует.`,
    );
  let path: string;
  let filter: string | undefined;
  if (mode === "records") {
    if (opts.from || opts.to) {
      if (!shape.periodic) throw new InputError(`Регистр ${set} непериодический — from/to не применимы.`);
      if (opts.from) server.push(cmp("Period", "ge", `datetime'${opts.from}T00:00:00'`));
      if (opts.to) server.push(cmp("Period", "le", `datetime'${opts.to}T23:59:59'`));
    }
    path = shape.rowsSet;
    filter = server.length ? and(...server) : undefined;
  } else {
    if (!shape.periodic) throw new InputError(`Регистр ${set} непериодический — срез (${mode}) не применим.`);
    const at = opts.date ? `${opts.date}T23:59:59` : undefined;
    const fn = mode === "sliceLast" ? "SliceLast" : "SliceFirst";
    const params = [
      ...(at ? [`Period=datetime'${at}'`] : []),
      ...(server.length ? [`Condition=${odataString(and(...server))}`] : []),
    ];
    path = `${shape.rowsSet}/${fn}(${params.join(",")})`;
  }
  const cap = client.length ? Math.max(limit, conn.behavior.maxRows) : limit;
  const { rows, truncated } = await fetchAll(
    conn.client,
    path,
    {
      ...(filter ? { filter } : {}),
      ...(mode === "records" && shape.periodic ? { orderby: "Period desc" } : {}),
    },
    conn.behavior.pageSize,
    cap,
  );
  const matched = rows.filter((r) => clientMatch(r, client)).map(strip);
  const out = matched.slice(0, limit);
  if (truncated || matched.length > limit)
    notes.push(`Показано ${out.length} строк — есть ещё; уточните отбор или период.`);
  return {
    database: conn.cfg.name,
    register: set,
    mode,
    periodic: shape.periodic,
    subordinate: shape.subordinate,
    ...(opts.date ? { date: opts.date } : {}),
    count: out.length,
    rows: out,
    ...(notes.length ? { notes } : {}),
  };
}

export interface Rate {
  currencyRef: string;
  code: string;
  name: string;
  period: string;
  rate: number;
  multiplier: number;
  /** Тенге (нац. валюты) за 1 единицу валюты: Курс / Кратность. */
  perUnit: number;
}

/** Курс валюты на дату (срез последних КурсыВалют); undefined — курса нет. */
export async function rateOn(conn: Connection, currencyRef: string, date: string): Promise<Rate | undefined> {
  const res = await currencyRates(conn, { date, currencies: [currencyRef] });
  return res.rates[0];
}

async function currencyRates(
  conn: Connection,
  opts: {
    date?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    currencies?: string[];
  },
): Promise<{ rates: Rate[]; notes: string[] }> {
  const reg = await requireEntity(conn, ["InformationRegister_КурсыВалют"], "Регистр сведений «Курсы валют»");
  const curSet = await requireEntity(conn, ["Catalog_Валюты"], "Справочник «Валюты»");
  const { rows: cur } = await fetchAll(
    conn.client,
    curSet,
    { select: ["Ref_Key", "Code", "Description"] },
    200,
    1000,
  );
  const byRef = new Map(cur.map((c) => [String(c["Ref_Key"]).toLowerCase(), c]));
  const notes: string[] = [];
  const wanted = (opts.currencies ?? []).map((q) => {
    const s = q.trim().replace(/[{}']/g, "").toLowerCase();
    const hit = cur.find(
      (c) =>
        String(c["Ref_Key"]).toLowerCase() === s ||
        String(c["Code"] ?? "").trim() === s ||
        String(c["Description"] ?? "")
          .trim()
          .toLowerCase() === s,
    );
    if (!hit)
      throw new InputError(`Валюта «${q}» не найдена в справочнике «Валюты» (укажите код 840 или USD).`);
    return String(hit["Ref_Key"]);
  });
  const cond = wanted.length
    ? wanted.map((r) => cmp("Валюта_Key", "eq", odataGuid(r))).join(" or ")
    : undefined;
  let rows: ODataEntity[];
  if (opts.from || opts.to) {
    const f = and(
      opts.from ? cmp("Period", "ge", `datetime'${opts.from}T00:00:00'`) : undefined,
      opts.to ? cmp("Period", "le", `datetime'${opts.to}T23:59:59'`) : undefined,
      cond ? `(${cond})` : undefined,
    );
    const r = await fetchAll(
      conn.client,
      reg,
      { filter: f, orderby: "Period" },
      conn.behavior.pageSize,
      conn.behavior.maxRows,
    );
    if (r.truncated) notes.push("Строк больше лимита — показана часть периода; сузьте период или валюты.");
    rows = r.rows;
  } else {
    const at = `${opts.date ?? localToday()}T23:59:59`;
    const params = [`Period=datetime'${at}'`, ...(cond ? [`Condition=${odataString(cond)}`] : [])];
    rows = (await fetchAll(conn.client, `${reg}/SliceLast(${params.join(",")})`, {}, 200, 1000)).rows;
  }
  const rates = rows.map((r) => {
    const c = byRef.get(String(r["Валюта_Key"]).toLowerCase());
    const rate = Number(r["Курс"] ?? 0);
    const mult = Number(r["Кратность"] ?? 1) || 1;
    return {
      currencyRef: String(r["Валюта_Key"]),
      code: String(c?.["Code"] ?? ""),
      name: String(c?.["Description"] ?? ""),
      period: String(r["Period"] ?? "").slice(0, 10),
      rate,
      multiplier: mult,
      perUnit: Math.round((rate / mult) * 1e6) / 1e6,
    };
  });
  for (const w of wanted)
    if (!rates.some((r) => r.currencyRef.toLowerCase() === w.toLowerCase()))
      notes.push(
        `Курса валюты ${String(byRef.get(w.toLowerCase())?.["Description"] ?? w)} на дату/период в регистре нет.`,
      );
  return { rates, notes };
}

export function registerInformationRegisterTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.register.get_information_register",
    {
      title: "Регистр сведений",
      description:
        "Читает любой регистр сведений (InformationRegister_<Имя>, префикс можно опустить): mode=records — записи " +
        "(для периодических — от новых к старым, from/to ограничивают Period), mode=sliceLast/sliceFirst — срез " +
        "последних/первых на дату date (виртуальная таблица SliceLast/SliceFirst). Отбор filters: [{field, op, value}] " +
        "по полям из $metadata (GUID, строка, число, дата; составные поля — eq/ne на стороне MCP). Подчинённые " +
        "регистратору регистры читаются через <Регистр>_RecordType. Служебные регистры (авторизация, сессии, " +
        "сертификаты, ЭЦП) закрыты, поля с паролями/токенами вырезаются. Только чтение. Курсы валют удобнее через " +
        "read.currency.get_rates.",
      inputSchema: {
        database: databaseField,
        register: z
          .string()
          .trim()
          .min(1)
          .max(150)
          .describe("Имя регистра, напр. КурсыВалют или InformationRegister_ЦеныНоменклатуры"),
        mode: z.enum(["records", "sliceLast", "sliceFirst"]).default("records"),
        date: dateField("Дата среза (для sliceLast/sliceFirst; по умолчанию — текущая)").optional(),
        from: dateField("Начало периода (records, периодический регистр)").optional(),
        to: dateField("Конец периода (records, периодический регистр)").optional(),
        filters: z.array(filterItem).max(10).default([]).describe("Отбор по полям регистра"),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      outputSchema: z
        .object({
          database: z.string(),
          register: z.string(),
          count: z.number(),
          rows: z.array(z.record(z.string(), z.unknown())),
        })
        .passthrough(),
    },
    ({ database, register, mode, date, from, to, filters, limit }) =>
      guard("read.register.get_information_register", async () => {
        const conn = ctx.db(database);
        return ok(await readInformationRegister(conn, register, { mode, date, from, to, filters, limit }));
      }),
  );

  server.registerTool(
    "read.currency.get_rates",
    {
      title: "Курсы валют",
      description:
        "Курсы валют из регистра «Курсы валют» (InformationRegister_КурсыВалют): на дату date — последний курс на эту " +
        "дату по каждой валюте (срез последних), либо за период from–to — все установленные курсы. currencies — " +
        "коды (840), буквенные коды (USD) или Ref_Key; без них — все валюты. В ответе курс, кратность и perUnit " +
        "(тенге за 1 единицу = Курс / Кратность). Только чтение.",
      inputSchema: {
        database: databaseField,
        date: dateField("Дата курса (по умолчанию — сегодня)").optional(),
        from: dateField("Начало периода (вместо date)").optional(),
        to: dateField("Конец периода (вместо date)").optional(),
        currencies: z
          .array(z.string().trim().min(1).max(60))
          .max(20)
          .optional()
          .describe("Валюты: 840, USD, EUR или Ref_Key"),
      },
      outputSchema: z
        .object({ database: z.string(), rates: z.array(z.object({}).passthrough()) })
        .passthrough(),
    },
    ({ database, date, from, to, currencies }) =>
      guard("read.currency.get_rates", async () => {
        if (date && (from || to))
          throw new InputError("Задайте либо date (курс на дату), либо период from–to.");
        if (from && to && from > to) throw new InputError(`Период задан наоборот: ${from} позже ${to}.`);
        const conn = ctx.db(database);
        const { rates, notes } = await currencyRates(conn, {
          date,
          from,
          to,
          ...(currencies ? { currencies } : {}),
        });
        return ok({
          database: conn.cfg.name,
          ...(from || to ? { period: { from, to } } : { date: date ?? localToday() }),
          count: rates.length,
          rates,
          ...(notes.length ? { notes } : {}),
        });
      }),
  );
}
