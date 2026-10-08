import { inflateRawSync, inflateSync } from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, organizationField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { resolveOrgOrDefault } from "../odata/orgs.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, contains, odataGuid, odataString, or } from "../odata/query.js";
import { resolveNames } from "../odata/accounting.js";
import { CATALOGS, resolveEntity } from "../config/mapping.js";
import { InputError } from "../errors.js";

/**
 * ЭСФ, цены номенклатуры и присоединённые файлы. ЭСФ — документ 1С:Бухгалтерии для Казахстана;
 * цены и файлы устроены одинаково в казахстанской и российской конфигурациях (БСП).
 */
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}]/g, "");

async function orgKey(conn: Connection, organization: string | undefined): Promise<string | undefined> {
  return organization ? (await resolveOrgOrDefault(conn, organization)).ref : undefined;
}

/** Типы файлов для MIME присоединённого файла. */
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xml: "application/xml",
  txt: "text/plain",
};
/** Сигнатуры, по которым узнаём «сырой» файл. */
const MAGIC: Array<[string, Buffer]> = [
  ["pdf", Buffer.from("%PDF")],
  ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ["jpg", Buffer.from([0xff, 0xd8, 0xff])],
  ["zip", Buffer.from("PK\x03\x04", "latin1")],
  ["xml", Buffer.from("<?xml")],
];
const known = (b: Buffer) => MAGIC.some(([, m]) => b.subarray(0, m.length).equals(m));

/**
 * Содержимое файла из «ФайлХранилище» (хранилище значения 1С). Чаще это сам файл; бывает упакованным
 * (deflate) — распаковываем, если после этого узнаём формат. Иначе отдаём как есть с пометкой.
 */
export function attachmentBytes(base64: string): { bytes: Buffer; decoded: "raw" | "inflated" | "unknown" } {
  const raw = Buffer.from(base64, "base64");
  if (known(raw)) return { bytes: raw, decoded: "raw" };
  for (const inflate of [inflateRawSync, inflateSync]) {
    try {
      const out = inflate(raw);
      if (known(out)) return { bytes: out, decoded: "inflated" };
    } catch {
      // не deflate — пробуем следующий способ
    }
  }
  return { bytes: raw, decoded: "unknown" };
}

export function registerKzRecordTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.esf.list_esf",
    {
      title: "Электронные счета-фактуры (ЭСФ)",
      description:
        "Список ЭСФ (Казахстан, документ «ЭСФ»): номер, регистрационный номер в ИС ЭСФ, направление, статус и " +
        "состояние, дата оборота, контрагент, сумма, причина отклонения. Фильтры: период по дате документа, " +
        "direction/status — точные значения как в 1С (без фильтра — все), counterpartyRef. Сначала новые.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        from: dateField("Начало периода").optional(),
        to: dateField("Конец периода").optional(),
        direction: z.string().max(100).optional().describe("Направление — значение как в 1С"),
        status: z.string().max(100).optional().describe("Статус — значение как в 1С"),
        counterpartyRef: GUID.optional().describe("Ref_Key контрагента"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).max(1000000).default(0),
      },
      outputSchema: z
        .object({
          database: z.string(),
          count: z.number(),
          truncated: z.boolean(),
          esf: z.array(z.object({ ref: z.string() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, organization, from, to, direction, status, counterpartyRef, limit, offset }) =>
      guard("read.esf.list_esf", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, ["Document_ЭСФ"], "Документ «ЭСФ»");
        const org = await orgKey(conn, organization);
        const { rows, truncated } = await fetchAll(
          conn.client,
          set,
          {
            filter: and(
              cmp("DeletionMark", "eq", "false"),
              org ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined,
              from ? cmp("Date", "ge", `datetime'${from}T00:00:00'`) : undefined,
              to ? cmp("Date", "le", `datetime'${to}T23:59:59'`) : undefined,
              direction ? cmp("Направление", "eq", odataString(direction)) : undefined,
              status ? cmp("Статус", "eq", odataString(status)) : undefined,
              counterpartyRef ? cmp("Контрагент_Key", "eq", odataGuid(guidOf(counterpartyRef))) : undefined,
            ),
            select: [
              "Ref_Key",
              "Number",
              "Date",
              "РегистрационныйНомер",
              "Направление",
              "Статус",
              "Состояние",
              "Вид",
              "ДатаОборота",
              "Контрагент_Key",
              "СуммаДокумента",
              "Причина",
            ],
            orderby: "Date desc",
            skip: offset,
          },
          conn.behavior.pageSize,
          limit,
        );
        const cpSet = resolveEntity(CATALOGS.counterparties, await conn.available());
        const names = cpSet
          ? await resolveNames(
              conn,
              cpSet,
              rows.map((r) => String(r["Контрагент_Key"] ?? "")),
            )
          : new Map<string, string>();
        const esf = rows.map((r) => ({
          ref: String(r["Ref_Key"]),
          number: String(r["Number"] ?? ""),
          date: String(r["Date"] ?? "").slice(0, 10),
          registrationNumber: String(r["РегистрационныйНомер"] ?? "") || undefined,
          direction: String(r["Направление"] ?? "") || undefined,
          status: String(r["Статус"] ?? "") || undefined,
          state: String(r["Состояние"] ?? "") || undefined,
          kind: String(r["Вид"] ?? "") || undefined,
          turnoverDate: String(r["ДатаОборота"] ?? "").slice(0, 10) || undefined,
          counterparty: names.get(String(r["Контрагент_Key"] ?? "")) ?? undefined,
          amount: Number(r["СуммаДокумента"] ?? 0),
          reason: String(r["Причина"] ?? "") || undefined,
        }));
        return ok({
          database: conn.cfg.name,
          count: esf.length,
          truncated,
          ...(truncated ? { nextOffset: offset + esf.length } : {}),
          esf,
        });
      }),
  );

  server.registerTool(
    "read.nomenclature.get_prices",
    {
      title: "Цены номенклатуры",
      description:
        "Действующие цены номенклатуры на дату (срез последних регистра «Цены номенклатуры»): цена, тип цен, " +
        "валюта, дата установки. Позиции — nomenclatureRefs или query (часть названия); priceType — название " +
        "типа цен. Используйте, чтобы подставить цену в счёт, а не спрашивать её.",
      inputSchema: {
        database: databaseField,
        nomenclatureRefs: z.array(GUID).max(50).optional().describe("Ref_Key позиций номенклатуры"),
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Часть названия номенклатуры (если нет nomenclatureRefs)"),
        priceType: z.string().max(200).optional().describe("Тип цен — название (напр. «Розничная»)"),
        asOf: dateField("Дата цены (без параметра — текущая)").optional(),
      },
      outputSchema: z
        .object({
          database: z.string(),
          count: z.number(),
          prices: z.array(z.object({ nomenclature: z.string(), price: z.number() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, nomenclatureRefs, query, priceType, asOf }) =>
      guard("read.nomenclature.get_prices", async () => {
        const conn = ctx.db(database);
        const available = await conn.available();
        const base = await requireEntity(
          conn,
          ["InformationRegister_ЦеныНоменклатуры"],
          "Регистр «Цены номенклатуры»",
        );
        // У регистра, подчинённого регистратору, срез публикуется на наборе записей (_RecordType).
        const owner = available.has(`${base}_RecordType`) ? `${base}_RecordType` : base;
        const nomSet = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
        let refs = (nomenclatureRefs ?? []).map(guidOf);
        if (!refs.length && query?.trim()) {
          const { rows } = await fetchAll(
            conn.client,
            nomSet,
            { filter: contains("Description", query.trim()), select: ["Ref_Key"] },
            50,
            50,
          );
          refs = rows.map((r) => String(r["Ref_Key"]));
          if (!refs.length) throw new InputError(`Номенклатура «${query}» не найдена.`);
        }
        let priceTypeRef: string | undefined;
        const ptSet = resolveEntity(CATALOGS.priceTypes, available);
        if (priceType) {
          if (!ptSet) throw new InputError("Справочник типов цен не опубликован.");
          const { rows } = await fetchAll(
            conn.client,
            ptSet,
            { filter: contains("Description", priceType), select: ["Ref_Key"] },
            5,
            5,
          );
          if (!rows[0]) throw new InputError(`Тип цен «${priceType}» не найден.`);
          priceTypeRef = String(rows[0]["Ref_Key"]);
        }
        const path = `${owner}/SliceLast(${asOf ? `Period=datetime'${asOf}T23:59:59'` : ""})`;
        const { rows } = await fetchAll(
          conn.client,
          path,
          {
            filter: and(
              refs.length ? or(...refs.map((r) => cmp("Номенклатура_Key", "eq", odataGuid(r)))) : undefined,
              priceTypeRef ? cmp("ТипЦен_Key", "eq", odataGuid(priceTypeRef)) : undefined,
            ),
          },
          conn.behavior.pageSize,
          conn.behavior.maxRows,
        );
        const nomNames = await resolveNames(
          conn,
          nomSet,
          rows.map((r) => String(r["Номенклатура_Key"] ?? "")),
        );
        const ptNames = ptSet
          ? await resolveNames(
              conn,
              ptSet,
              rows.map((r) => String(r["ТипЦен_Key"] ?? "")),
            )
          : new Map<string, string>();
        const curSet = resolveEntity(CATALOGS.currencies, available);
        const curNames = curSet
          ? await resolveNames(
              conn,
              curSet,
              rows.map((r) => String(r["Валюта_Key"] ?? "")),
            )
          : new Map<string, string>();
        const prices = rows.map((r) => ({
          nomenclature: nomNames.get(String(r["Номенклатура_Key"])) ?? String(r["Номенклатура_Key"]),
          ref: String(r["Номенклатура_Key"]),
          price: Number(r["Цена"] ?? 0),
          priceType: ptNames.get(String(r["ТипЦен_Key"] ?? "")) || undefined,
          currency: curNames.get(String(r["Валюта_Key"] ?? "")) || undefined,
          since: String(r["Period"] ?? "").slice(0, 10) || undefined,
        }));
        return ok({
          database: conn.cfg.name,
          ...(asOf ? { asOf } : {}),
          count: prices.length,
          prices,
          ...(prices.length
            ? {}
            : { note: "Цен не найдено: в регистре нет записей для выбранных позиций/типа цен на эту дату." }),
        });
      }),
  );

  server.registerTool(
    "read.files.list_attachments",
    {
      title: "Присоединённые файлы объекта",
      description:
        "Файлы, прикреплённые к документу или элементу справочника в 1С (напр. сохранённая печатная форма счёта): " +
        "имя, расширение, размер, дата, подписан ли ЭП. entitySet — объект-владелец (напр. " +
        "Document_СчетНаОплатуПокупателю), ref — его Ref_Key. Содержимое — read.files.get_attachment.",
      inputSchema: {
        database: databaseField,
        entitySet: z
          .string()
          .regex(/^[^/?#]+$/, "Document_… или Catalog_…")
          .describe("Объект-владелец: Document_… или Catalog_… (без префикса — ищется среди опубликованных)"),
        ref: GUID.describe("Ref_Key объекта-владельца"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          filesCatalog: z.string(),
          count: z.number(),
          files: z.array(z.object({ ref: z.string(), name: z.string() }).passthrough()),
        })
        .passthrough(),
    },
    ({ database, entitySet, ref }) =>
      guard("read.files.list_attachments", async () => {
        const conn = ctx.db(database);
        const filesCatalog = `Catalog_${entitySet.replace(/^(Document|Catalog)_/, "")}ПрисоединенныеФайлы`;
        if (!(await conn.available()).has(filesCatalog)) {
          throw new InputError(
            `У «${entitySet}» нет опубликованного справочника присоединённых файлов (${filesCatalog}).`,
          );
        }
        const { rows } = await fetchAll(
          conn.client,
          filesCatalog,
          {
            filter: and(
              cmp("ВладелецФайла_Key", "eq", odataGuid(guidOf(ref))),
              cmp("DeletionMark", "eq", "false"),
            ),
            select: [
              "Ref_Key",
              "Description",
              "Расширение",
              "Размер",
              "ДатаСоздания",
              "ПодписанЭП",
              "ТипХраненияФайла",
            ],
            orderby: "ДатаСоздания desc",
          },
          100,
          100,
        );
        const files = rows.map((r) => ({
          ref: String(r["Ref_Key"]),
          name: String(r["Description"] ?? ""),
          extension: String(r["Расширение"] ?? "") || undefined,
          size: Number(r["Размер"] ?? 0),
          created: String(r["ДатаСоздания"] ?? "").slice(0, 19) || undefined,
          signed: r["ПодписанЭП"] === true,
          storedInBase: String(r["ТипХраненияФайла"] ?? "") !== "ВТомахНаДиске",
        }));
        return ok({ database: conn.cfg.name, filesCatalog, count: files.length, files });
      }),
  );

  server.registerTool(
    "read.files.get_attachment",
    {
      title: "Содержимое присоединённого файла",
      description:
        "Возвращает присоединённый файл (напр. PDF печатной формы) как ресурс MCP с base64-содержимым и MIME-типом — " +
        "его можно отправить клиенту. filesCatalog и ref — из read.files.list_attachments. Файлы, хранящиеся в томах " +
        "на диске сервера 1С, через OData недоступны.",
      inputSchema: {
        database: databaseField,
        filesCatalog: z
          .string()
          .regex(/^Catalog_[^/?#]+ПрисоединенныеФайлы$/, "Справочник …ПрисоединенныеФайлы"),
        ref: GUID.describe("Ref_Key файла"),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(20_000_000)
          .default(10_000_000)
          .describe("Не отдавать файлы больше этого размера"),
      },
      outputSchema: z
        .object({
          database: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.number(),
          decoded: z.string(),
        })
        .passthrough(),
    },
    ({ database, filesCatalog, ref, maxBytes }) =>
      guard("read.files.get_attachment", async (): Promise<CallToolResult> => {
        const conn = ctx.db(database);
        if (!(await conn.available()).has(filesCatalog))
          throw new InputError(`Справочник ${filesCatalog} не опубликован.`);
        const file = await conn.client.getEntity(
          `${filesCatalog}(guid'${guidOf(ref)}')${buildQuery({ select: ["Description", "Расширение", "Размер", "ТипХраненияФайла", "ФайлХранилище_Base64Data"] })}`,
        );
        const extension = String(file["Расширение"] ?? "").toLowerCase();
        const data = String(file["ФайлХранилище_Base64Data"] ?? "");
        if (!data) {
          throw new InputError(
            String(file["ТипХраненияФайла"] ?? "") === "ВТомахНаДиске"
              ? "Файл хранится в томе на диске сервера 1С — через OData его содержимое недоступно."
              : "У файла нет содержимого в базе.",
          );
        }
        const { bytes, decoded } = attachmentBytes(data);
        if (bytes.length > maxBytes)
          throw new InputError(`Файл ${bytes.length} байт — больше maxBytes (${maxBytes}).`);
        const name = `${String(file["Description"] ?? "file")}${extension ? `.${extension}` : ""}`;
        const mimeType =
          decoded === "unknown"
            ? "application/octet-stream"
            : (MIME[extension] ?? "application/octet-stream");
        const meta = {
          database: conn.cfg.name,
          name,
          mimeType,
          size: bytes.length,
          decoded,
          ...(decoded === "unknown"
            ? { note: "Формат хранилища 1С не распознан — отдаю данные как есть." }
            : {}),
        };
        const result = ok(meta);
        result.content.push({
          type: "resource",
          resource: {
            uri: `onec-file:///${encodeURIComponent(filesCatalog)}/${guidOf(ref)}/${encodeURIComponent(name)}`,
            mimeType,
            blob: bytes.toString("base64"),
          },
        });
        return result;
      }),
  );
}
