import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { ensurePublished } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, odataGuid } from "../odata/query.js";
import { createResultSchema, patchResultSchema } from "../schemas/output.js";
import type { EntityMeta, ODataEntity } from "../types/odata.js";
import { databaseField, fail, guard, organizationField } from "./_shared.js";
import { confirmField, createOrPreview, odataDate, patchOrPreview, resolveOrg } from "./write.js";
import { isKazakhstan } from "./write-kz.js";

/**
 * Общая запись документов казахстанской базы: создать, изменить шапку и табличные части. Проведение —
 * write.document.post_document. Суммы, ставки и расчёты задаёт вызывающий (агент): MCP их не считает,
 * а проверяет имена полей по $metadata базы и не даёт править проведённый документ.
 */

type Scalar = string | number | boolean | null;
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fieldsShape = z
  .record(z.string(), scalar)
  .describe(
    'Реквизиты шапки: { техническоеИмя: значение }, напр. {"ПериодРегистрации":"2026-09-01","Организация_Key":"<GUID>"}. ' +
      "Ссылки — поле <Имя>_Key с Ref_Key; даты — 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:mm:ss'; перечисления — имя значения.",
  );
const tablesShape = z
  .record(z.string(), z.array(z.record(z.string(), scalar)))
  .describe(
    'Табличные части: { ИмяТабличнойЧасти: [строки] }, напр. {"Начисления":[{"Сотрудник_Key":"…","Результат":600000}]}. ' +
      "LineNumber проставляется сам. Поля строки — describe_entity по '<Документ>_<ТабличнаяЧасть>'.",
  );

/** Служебные поля: их заполняет 1С или отдельные инструменты. */
const SERVICE_FIELDS: Record<string, string> = {
  Ref_Key: "ссылку назначает 1С",
  DataVersion: "версию данных ведёт 1С",
  Posted: "проводите через write.document.post_document",
  DeletionMark: "помечайте через write.entity.mark_for_deletion",
  LineNumber: "номер строки проставляется сам",
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Имя набора строк табличной части из типа поля: Collection(StandardODATA.<Набор>_RowType). */
export function rowEntitySet(type: string): string | undefined {
  return /^Collection\(StandardODATA\.(.+)_RowType\)$/.exec(type)?.[1];
}

const tableNames = (em: EntityMeta): string[] =>
  em.properties.filter((p) => rowEntitySet(p.type)).map((p) => p.name);

/** Проверяет имена полей по $metadata и приводит даты к формату 1С. */
export function normalizeFields(em: EntityMeta, fields: Record<string, Scalar>, where: string): Record<string, unknown> {
  const props = new Map(em.properties.map((p) => [p.name, p]));
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const prop = props.get(name);
    if (SERVICE_FIELDS[name]) problems.push(`${name} — ${SERVICE_FIELDS[name]}`);
    else if (!prop) unknown.push(name);
    else if (rowEntitySet(prop.type)) problems.push(`${name} — табличная часть, передайте её в tables`);
    else out[name] = prop.type === "Edm.DateTime" && typeof value === "string" && DATE_ONLY.test(value) ? `${value}T00:00:00` : value;
  }
  if (unknown.length) {
    const known = em.properties
      .filter((p) => !SERVICE_FIELDS[p.name] && !rowEntitySet(p.type) && !p.name.endsWith("_Type"))
      .map((p) => p.name);
    problems.push(`нет полей ${unknown.join(", ")}; есть: ${known.join(", ")}`);
  }
  if (problems.length) throw new InputError(`${where}: ${problems.join("; ")}.`);
  return out;
}

/** Табличные части: имена и поля строк по $metadata, LineNumber по порядку. */
export async function normalizeTables(
  conn: Connection,
  em: EntityMeta,
  tables: Record<string, Array<Record<string, Scalar>>>,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const meta = await conn.getMetadata();
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [name, rows] of Object.entries(tables)) {
    const prop = em.properties.find((p) => p.name === name);
    const rowSet = prop ? rowEntitySet(prop.type) : undefined;
    if (!rowSet) {
      throw new InputError(`${em.entitySet}: нет табличной части «${name}»; есть: ${tableNames(em).join(", ") || "нет"}.`);
    }
    const rowMeta = meta.entities.get(rowSet);
    out[name] = rows.map((row, i) => ({
      ...(rowMeta ? normalizeFields(rowMeta, row, `${name}, строка ${i + 1}`) : row),
      LineNumber: i + 1,
    }));
  }
  return out;
}

const ACCRUAL_DOC = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const EMPTY_REF = "00000000-0000-0000-0000-000000000000";

/**
 * Начисления тех же сотрудников за тот же месяц. Агент однажды начислил оклад повторно, не проверив месяц.
 * Не запрещаем — премия или доплата отдельным документом законны, — но говорим об этом в предпросмотре.
 */
async function sameMonthAccruals(conn: Connection, payload: Record<string, unknown>): Promise<string[]> {
  const period = payload["ПериодРегистрации"];
  const lines = payload["Начисления"];
  if (typeof period !== "string" || !Array.isArray(lines)) return [];
  const people = new Set(
    (lines as Array<Record<string, unknown>>)
      .flatMap((r) => [r["Сотрудник_Key"], r["Физлицо_Key"]])
      .filter((v): v is string => typeof v === "string" && v !== EMPTY_REF),
  );
  if (!people.size) return [];
  const org = payload["Организация_Key"];
  const { rows } = await fetchAll(
    conn.client,
    ACCRUAL_DOC,
    {
      filter: and(
        cmp("ПериодРегистрации", "eq", `datetime'${period}'`),
        cmp("DeletionMark", "eq", "false"),
        typeof org === "string" ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined,
      ),
      select: ["Number", "Date", "Posted", "Начисления"],
    },
    50,
    200,
  );
  const found = rows
    .filter((d) =>
      ((d["Начисления"] as ODataEntity[] | undefined) ?? []).some(
        (r) => people.has(String(r["Сотрудник_Key"])) || people.has(String(r["Физлицо_Key"])),
      ),
    )
    .map((d) => `№ ${String(d["Number"])} от ${String(d["Date"]).slice(0, 10)}${d["Posted"] === true ? " (проведён)" : ""}`);
  return found.length
    ? [
        `У этих сотрудников уже есть начисление за этот месяц: ${found.join(", ")}. Оклад повторно не начисляйте — ` +
          "отдельный документ нужен только для другого начисления (премия, доплата). Проверьте read.payroll.get_accruals.",
      ]
    : [];
}

const SINGLE_PAYMENT_DOC = "Document_РасчетЕдиногоПлатежа";
/** Классические расчёты налогов с зарплаты: при едином платеже (ЕП) эти налоги уже в нём. */
const CLASSIC_TAX_DOCS = ["Document_РасчетУдержанийРаботниковОрганизаций", "Document_РасчетСНиСО"];

/**
 * Классический расчёт налогов для сотрудника, у которого за месяц уже проведён единый платёж: агент однажды
 * посчитал ИПН/ОПВ/ВОСМС и СО/СН поверх ЕП, и налоги задвоились. Предупреждаем в предпросмотре.
 */
async function singlePaymentForMonth(conn: Connection, payload: Record<string, unknown>): Promise<string[]> {
  const period = payload["ПериодРегистрации"];
  const lines = payload["ФизическиеЛица"];
  if (typeof period !== "string" || !Array.isArray(lines)) return [];
  const people = new Set(
    (lines as Array<Record<string, unknown>>)
      .map((r) => r["ФизическоеЛицо_Key"])
      .filter((v): v is string => typeof v === "string" && v !== EMPTY_REF),
  );
  if (!people.size || !(await conn.available()).has(SINGLE_PAYMENT_DOC)) return [];
  const org = payload["Организация_Key"];
  const { rows } = await fetchAll(
    conn.client,
    SINGLE_PAYMENT_DOC,
    {
      filter: and(
        cmp("ПериодРегистрации", "eq", `datetime'${period}'`),
        cmp("Posted", "eq", "true"),
        typeof org === "string" ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined,
      ),
      select: ["Number", "Date", "ИсчисленныйЕП"],
    },
    50,
    200,
  );
  // Пустой расчёт ЕП (сумма 0) налогов не содержит — его не считаем.
  const found = rows
    .filter((d) =>
      ((d["ИсчисленныйЕП"] as ODataEntity[] | undefined) ?? []).some(
        (r) => people.has(String(r["ФизЛицо_Key"])) && Number(r["СуммаПлатежа"] ?? 0) !== 0,
      ),
    )
    .map((d) => `№ ${String(d["Number"])} от ${String(d["Date"]).slice(0, 10)}`);
  return found.length
    ? [
        `За этот месяц у сотрудника уже проведён расчёт единого платежа (${found.join(", ")}): ИПН, ОПВ, ВОСМС, СО, ` +
          "ООСМС и ОПВР входят в ЕП, отдельный расчёт задвоит налоги. В отражении ЕП: Дт 3350 Кт 3231 (часть работника), " +
          "Дт <счёт затрат> Кт 3231 (часть работодателя).",
      ]
    : [];
}

/** Документ казахстанской базы, опубликованный в OData. Список разрешённых документов — в preflightTool. */
async function documentMeta(conn: Connection, entitySet: string): Promise<EntityMeta> {
  if (!(await isKazakhstan(conn))) {
    throw new InputError("Общая запись документов — для казахстанской базы. В этой базе используйте профильные инструменты write.*.");
  }
  ensurePublished(await conn.available(), entitySet);
  const em = (await conn.getMetadata()).entities.get(entitySet);
  if (!em) throw new InputError(`Документа ${entitySet} нет в $metadata базы.`);
  return em;
}

export function registerDocumentWriteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.document.create_document",
    {
      title: "Создать документ (зарплата, налоги, выплата)",
      description:
        "Создаёт документ казахстанской базы с заданными реквизитами шапки и табличными частями: начисление " +
        "зарплаты, расчёт удержаний (ИПН/ОПВ/ВОСМС), расчёт СН и СО, единый платёж, отражение зарплаты в учёте, " +
        "ведомость к выплате, платёжное поручение, перечисления в фонды, расходный кассовый ордер. Суммы и ставки " +
        "считаете сами — 1С их не пересчитает. Состав полей — read.schema.describe_entity по документу и по " +
        "'<Документ>_<ТабличнаяЧасть>'; образец заполнения — read.document.get_document существующего документа " +
        "того же вида, лучше рассчитанного самой 1С по тому же сотруднику. Перед начислением проверьте месяц " +
        "(read.payroll.get_accruals): повторное начисление предпросмотр покажет в notes. Документы, помеченные на " +
        "удаление, не используйте. Документ создаётся непроведённым; провести — write.document.post_document. " +
        "По умолчанию предпросмотр (dry-run); создание — при confirm=true после согласия пользователя.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        entitySet: z.string().describe("Документ, напр. Document_НачислениеЗарплатыРаботникамОрганизаций"),
        date: z.string().optional().describe("Дата документа 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:mm:ss' (по умолчанию — сейчас)"),
        fields: fieldsShape.default({}),
        tables: tablesShape.default({}),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, organization, entitySet, date, fields = {}, tables = {}, confirm }) =>
      guard("write.document.create_document", async () => {
        const conn = ctx.db(database);
        const em = await documentMeta(conn, entitySet);
        const header = normalizeFields(em, fields, entitySet);
        const hasOrg = em.properties.some((p) => p.name === "Организация_Key");
        const org = hasOrg && !header["Организация_Key"] ? await resolveOrg(conn, organization) : undefined;
        const when = date ? (DATE_ONLY.test(date) ? `${date}T00:00:00` : date) : odataDate(new Date());
        const payload = {
          ...header,
          Date: when,
          Posted: false,
          ...(org ? { Организация_Key: org.key } : {}),
          ...(await normalizeTables(conn, em, tables)),
        };
        const notes =
          entitySet === ACCRUAL_DOC
            ? await sameMonthAccruals(conn, payload)
            : CLASSIC_TAX_DOCS.includes(entitySet)
              ? await singlePaymentForMonth(conn, payload)
              : [];
        return createOrPreview(conn, entitySet, payload, confirm, notes);
      }),
  );

  server.registerTool(
    "write.document.update_document",
    {
      title: "Изменить документ (шапка и табличные части)",
      description:
        "Меняет реквизиты шапки и/или табличные части документа из write.document.create_document. Табличная часть " +
        "заменяется целиком: прочитайте документ (read.document.get_document), измените строки и передайте все. " +
        "Проведённый документ не меняется — сначала отмените проведение (write.document.post_document post=false), " +
        "затем измените и проведите снова. По умолчанию предпросмотр (dry-run); применение — при confirm=true.",
      inputSchema: {
        database: databaseField,
        entitySet: z.string().describe("Документ, напр. Document_ПлатежноеПоручениеИсходящее"),
        ref: z.string().describe("Ref_Key документа (GUID)"),
        fields: fieldsShape.default({}),
        tables: tablesShape.default({}),
        confirm: confirmField,
      },
      outputSchema: patchResultSchema,
    },
    ({ database, entitySet, ref, fields = {}, tables = {}, confirm }) =>
      guard("write.document.update_document", async () => {
        const conn = ctx.db(database);
        const em = await documentMeta(conn, entitySet);
        if (!Object.keys(fields).length && !Object.keys(tables).length) return fail("Не заданы fields или tables для изменения.");
        const patch = { ...normalizeFields(em, fields, entitySet), ...(await normalizeTables(conn, em, tables)) };
        const guid = ref.replace(/[{}']/g, "");
        const doc = await conn.client.getEntity(`${entitySet}(guid'${guid}')${buildQuery({ select: ["Posted", "DeletionMark"] })}`);
        if (doc["DeletionMark"] === true) {
          return fail("Документ помечен на удаление — не используйте его и не снимайте пометку: создайте новый документ.");
        }
        if (doc["Posted"] === true) {
          return fail(
            "Документ проведён — так его не меняют. Отмените проведение (write.document.post_document post=false), " +
              "внесите изменения и проведите снова.",
          );
        }
        return patchOrPreview(conn, entitySet, guid, patch, confirm);
      }),
  );
}
