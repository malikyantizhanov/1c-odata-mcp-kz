import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { ok, guard, databaseField, dateField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { buildQuery, cmp, odataGuid, or } from "../odata/query.js";
import { resolveEntity } from "../config/mapping.js";
import { InputError } from "../errors.js";
import type { ODataEntity } from "../types/odata.js";
import { isKazakhstan } from "./write-kz.js";
import { findDocumentByNumber, printTarget } from "./print.js";
import { currentPosition, partyContacts, printedFileSchema, shortFio } from "./print-sale.js";
import { fioDative, positionDative } from "../print/declension.js";
import {
  renderPowerOfAttorneyPdf,
  type PowerOfAttorneyData,
  type PowerOfAttorneyLine,
  type PowerOfAttorneyPassport,
} from "../print/power-of-attorney-pdf.js";
import { safeFileName, saveUnique, type SavedFile } from "../print/save.js";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const ref = (v: unknown): string | undefined => (typeof v === "string" && v && v !== EMPTY ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown): number => Number(v ?? 0) || 0;

export const POWER_OF_ATTORNEY_SET = "Document_Доверенность";
/** Подкаталог каталога печати (ODATA_PRINT_DIR) для доверенностей, если outputDir не задан. */
export const POWER_OF_ATTORNEY_SUBDIR = "доверенности";

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

/**
 * «Бухгалтеру, Касымовой Диане Сериковне.» — как строка «Выдана» в 1С: должность и ФИО в дательном падеже через
 * запятую; без должности — только ФИО. Точка в конце наименования физлица сохраняется, как в 1С.
 */
export function issuedToText(fio: string, gender: string, position?: string): string {
  const g = gender === "Женский" ? "female" : gender === "Мужской" ? "male" : undefined;
  const who = fioDative(fio, g);
  return position ? `${positionDative(position)}, ${who}` : who;
}

export interface PowerOfAttorneyPrintData {
  ref: string;
  number: string;
  date: string;
  form: PowerOfAttorneyData;
  notes: string[];
}

/** Данные доверенности (Д-1) для печати: организация, счёт, кому выдана, от кого и по какому документу, ТМЗ. */
export async function powerOfAttorneyPrintData(
  conn: Connection,
  docRef: string,
  passport?: PowerOfAttorneyPassport,
): Promise<PowerOfAttorneyPrintData> {
  const available = await conn.available();
  const set = await requireEntity(conn, [POWER_OF_ATTORNEY_SET], "Документ «Доверенность»");
  const doc = await conn.client.getEntity(`${set}(guid'${docRef}')?$format=json`);
  const orgRef = ref(doc["Организация_Key"]);
  const personRef = ref(doc["ФизЛицо_Key"]);
  const [org, account, person, counterparty, orgContacts, position] = await Promise.all([
    entity(conn, "Catalog_Организации", orgRef, [
      "Description",
      "НаименованиеПолное",
      "ИдентификационныйНомер",
      "ЮрФизЛицо",
      "ИндивидуальныйПредприниматель_Key",
    ]),
    entity(conn, "Catalog_БанковскиеСчета", ref(doc["СтруктурнаяЕдиница_Key"]), ["НомерСчета", "Банк_Key"]),
    entity(conn, "Catalog_ФизическиеЛица", personRef, ["Description", "Пол"]),
    entity(conn, "Catalog_Контрагенты", ref(doc["Контрагент_Key"]), ["Description", "НаименованиеПолное"]),
    partyContacts(conn, [["Catalog_Организации", orgRef]]),
    orgRef && personRef ? currentPosition(conn, new Map(), orgRef, personRef) : Promise.resolve(undefined),
  ]);
  const individual = org["ЮрФизЛицо"] === "ФизЛицо";
  const [bank, ipPerson] = await Promise.all([
    entity(conn, "Catalog_Банки", ref(account["Банк_Key"]), ["Description"]),
    individual
      ? entity(conn, "Catalog_ФизическиеЛица", ref(org["ИндивидуальныйПредприниматель_Key"]), ["Description"])
      : Promise.resolve({} as ODataEntity),
  ]);

  // ТМЗ: наименование — ссылка на номенклатуру или строка; единица — по классификатору.
  const rows = (doc["Товары"] as ODataEntity[] | undefined) ?? [];
  const byKeys = async (s: string | undefined, keys: Array<string | undefined>) => {
    const list = [...new Set(keys.filter((k): k is string => !!k))];
    if (!s || !list.length || !available.has(s)) return new Map<string, ODataEntity>();
    const { rows: found } = await fetchAll(
      conn.client,
      s,
      {
        filter: or(...list.map((k) => cmp("Ref_Key", "eq", odataGuid(k)))),
        select: ["Ref_Key", "Description"],
      },
      50,
      list.length,
    );
    return new Map(found.map((x) => [String(x["Ref_Key"]), x]));
  };
  const isNomenclature = (r: ODataEntity) => /Catalog_Номенклатура$/.test(str(r["НаименованиеТовара_Type"]));
  const [noms, units] = await Promise.all([
    byKeys(
      "Catalog_Номенклатура",
      rows.filter(isNomenclature).map((r) => ref(r["НаименованиеТовара"])),
    ),
    byKeys(
      resolveEntity(["Catalog_КлассификаторЕдиницИзмерения", "Catalog_ЕдиницыИзмерения"], available),
      rows.map((r) => ref(r["ЕдиницаПоКлассификатору_Key"])),
    ),
  ]);
  const lines: PowerOfAttorneyLine[] = rows.map((r) => ({
    name: isNomenclature(r)
      ? str(noms.get(str(r["НаименованиеТовара"]))?.["Description"])
      : str(r["НаименованиеТовара"]),
    unit: str(units.get(str(r["ЕдиницаПоКлассификатору_Key"]))?.["Description"]) || undefined,
    quantity: n(r["Количество"]),
  }));

  // Получатель и плательщик — организация: «<полное наименование>, БИН / ИИН <номер>[, <юр. адрес>]».
  const orgName = str(org["НаименованиеПолное"]) || str(org["Description"]);
  const orgId = str(org["ИдентификационныйНомер"]);
  const party = [
    orgName,
    `БИН / ИИН ${orgId}`,
    ...(orgContacts.found.address ? [orgContacts.found.address] : []),
  ]
    .filter(Boolean)
    .join(", ");
  const fio = str(person["Description"]);

  const notes: string[] = [];
  if (!passport)
    notes.push(
      "Паспортные данные (удостоверение личности) в OData не опубликованы — строка паспорта пустая. " +
        "Передайте passport {series, number, date, issuedBy} или впишите от руки.",
    );
  if (!individual)
    notes.push(
      "Руководитель и главный бухгалтер в OData не опубликованы (регистр «Ответственные лица организаций») — " +
        "расшифровки подписей пустые, заполните от руки.",
    );
  if (fio && !position)
    notes.push("Должность получателя не найдена (сотрудник организации) — в «Выдана» только ФИО.");

  const number = str(doc["Number"]);
  const date = str(doc["Date"]).slice(0, 10);
  const form: PowerOfAttorneyData = {
    number: number.replace(/^0+(?=\d)/, ""),
    date,
    validUntil: str(doc["ДатаДействия"]).slice(0, 10) || undefined,
    organization: orgName,
    organizationId: orgId,
    recipient: party,
    payer: party,
    account: str(account["НомерСчета"]) || undefined,
    bank: str(bank["Description"]) || undefined,
    issuedTo: fio ? issuedToText(fio, str(person["Пол"]), position) : "",
    passport,
    supplier: str(doc["НаПолучениеОт"]) || str(counterparty["НаименованиеПолное"]) || undefined,
    basis: typeof doc["ПоДокументу"] === "string" ? doc["ПоДокументу"].trimEnd() || undefined : undefined,
    lines,
    head: str(ipPerson["Description"]) ? shortFio(str(ipPerson["Description"])) : undefined,
  };
  return { ref: docRef, number, date, form, notes };
}

const POA_NUMBER_WORDS = {
  what: "Доверенность",
  several: "доверенностей",
  empty: "Укажите номер доверенности.",
};

export function registerPowerOfAttorneyPrintTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "read.document.print_power_of_attorney",
    {
      title: "Печать доверенности (PDF)",
      description:
        "PDF доверенности на получение ТМЗ (Казахстан) по печатной форме 1С «Доверенность (Д-1)»: организация и ИИН/БИН, " +
        "срок действия, получатель и плательщик, ИИК и банк, «Выдана» (должность и ФИО в дательном падеже), паспорт, " +
        "поставщик, документ-основание, таблица ТМЗ с количеством прописью, подписи. Доверенность — по ref или номеру " +
        "(number; date или year при повторе). Паспортные данные в OData не опубликованы — передайте passport, иначе " +
        "строка пустая. PDF сохраняется в каталог печати (ODATA_PRINT_DIR), подкаталог «доверенности» (или outputDir); " +
        "существующий файл не перезаписывается. Возвращает путь (path) и файл ресурсом MCP. Печать 1С через OData не " +
        "вызвать — форма повторяет её по данным документа.",
      inputSchema: {
        database: databaseField,
        ref: z
          .string()
          .regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID")
          .optional()
          .describe("Ref_Key доверенности. Либо ref, либо number."),
        number: z.string().max(50).optional().describe("Номер как в 1С: «1» или «00000000001»."),
        date: dateField("Дата доверенности — сужает поиск по номеру").optional(),
        year: z.number().int().min(2000).max(2100).optional().describe("Год — сужает поиск по номеру"),
        passport: z
          .object({
            series: z.string().max(20).optional(),
            number: z.string().max(30).optional(),
            date: dateField("Дата выдачи удостоверения").optional(),
            issuedBy: z.string().max(200).optional().describe("Кем выдано: «МВД РЕСПУБЛИКИ КАЗАХСТАН»"),
          })
          .optional()
          .describe("Удостоверение личности получателя — в OData не опубликовано; без него строка пустая."),
        outputDir: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Подкаталог внутри каталога печати. Не задан — «доверенности». Выход за каталог печати отклоняется.",
          ),
      },
      outputSchema: z
        .object({
          database: z.string(),
          ref: z.string(),
          number: z.string(),
          date: z.string(),
          files: z.array(printedFileSchema),
          path: z.string().optional(),
          note: z.string().optional(),
        })
        .passthrough(),
    },
    (args) =>
      guard("read.document.print_power_of_attorney", async (): Promise<CallToolResult> => {
        const {
          database,
          ref: docRef,
          number,
          date,
          year,
          passport,
          outputDir,
        } = z
          .object({
            database: z.string().optional(),
            ref: z.string().optional(),
            number: z.string().optional(),
            date: z.string().optional(),
            year: z.number().optional(),
            passport: z
              .object({
                series: z.string().optional(),
                number: z.string().optional(),
                date: z.string().optional(),
                issuedBy: z.string().optional(),
              })
              .optional(),
            outputDir: z.string().optional(),
          })
          .parse(args);
        const conn = ctx.db(database);
        if (!docRef && !number) throw new InputError("Укажите ref доверенности или её номер (number).");
        if (docRef && number) throw new InputError("Укажите что-то одно: ref или number.");
        if (!(await isKazakhstan(conn)))
          throw new InputError("Печать доверенности поддержана для казахстанской базы.");
        // Каталог проверяется до чтения 1С: выход за корень — ошибка ввода сразу.
        const target = await printTarget(conn, outputDir ?? POWER_OF_ATTORNEY_SUBDIR);
        const set = await requireEntity(conn, [POWER_OF_ATTORNEY_SET], "Документ «Доверенность»");
        const r = (
          docRef ?? (await findDocumentByNumber(conn, set, number!, { date, year }, POA_NUMBER_WORDS)).ref
        ).replace(/[{}]/g, "");
        const data = await powerOfAttorneyPrintData(conn, r, passport);
        const pdf = await renderPowerOfAttorneyPdf(data.form);
        const name = `Доверенность № ${data.form.number} от ${data.date.split("-").reverse().join(".")}.pdf`;
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
          form: "Д-1",
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
