import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { buildQuery } from "../odata/query.js";
import { fetchAll } from "../odata/pagination.js";
import { createResultSchema, patchResultSchema } from "../schemas/output.js";
import { databaseField, guard, organizationField } from "./_shared.js";
import { confirmField, createOrPreview, patchOrPreview } from "./write.js";
import { prepareDocument, prepareDocumentPatch } from "./write-documents.js";

/**
 * Профильная запись двух документов казахстанской базы: «Доверенность» (на получение ТМЦ) и
 * «Комплектация номенклатуры» (комплектация / разукомплектация). Понятные аргументы → реквизиты и табличные
 * части по $metadata; дальше — общий путь create_document / update_document (предпросмотр, confirm, журнал).
 * Проведение комплектации — write.document.post_document; доверенность не проводится (движений нет).
 */

export const POWER_OF_ATTORNEY = "Document_Доверенность";
export const KITTING = "Document_КомплектацияНоменклатуры";
export const KITTING_OPERATIONS = ["Комплектация", "Разукомплектация"] as const;

type Scalar = string | number | boolean | null;
type Row = Record<string, Scalar>;

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;
const dateField = (what: string) =>
  z.string().regex(DATE, "Дата 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:mm:ss'").describe(what);
const asDateTime = (d: string) => (d.length === 10 ? `${d}T00:00:00` : d);
const extraFields = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .default({})
  .describe("Другие реквизиты шапки по $metadata (как в create_document); перекрывают понятные аргументы");

// ---------- Доверенность ----------

const poaLine = z
  .object({
    nomenclatureRef: z
      .string()
      .optional()
      .describe("Ref_Key номенклатуры (Catalog_Номенклатура) — если ТМЦ есть в справочнике"),
    name: z
      .string()
      .optional()
      .describe("Наименование ТМЦ строкой — если в справочнике её нет (одно из nomenclatureRef / name)"),
    unitRef: z
      .string()
      .optional()
      .describe(
        "Ref_Key единицы по классификатору (Catalog_КлассификаторЕдиницИзмерения); для nomenclatureRef по умолчанию — базовая единица номенклатуры",
      ),
    unit: z
      .string()
      .optional()
      .describe(
        "Единица для ТМЦ строкой: обозначение или код по классификатору ('шт', 'кг', '796'); по умолчанию — 'шт' (796)",
      ),
    quantity: z.number().positive().describe("Количество"),
  })
  .refine((l) => !!l.nomenclatureRef !== !!l.name, {
    message: "В строке укажите ровно одно: nomenclatureRef или name",
  });

const poaHeaderArgs = {
  personRef: z
    .string()
    .describe("Ref_Key физлица, которому выдана доверенность (Catalog_ФизическиеЛица, ФизЛицо_Key)"),
  validUntil: dateField("Срок действия — по какую дату включительно (ДатаДействия)"),
  counterpartyRef: z
    .string()
    .describe("Ref_Key контрагента-поставщика, у которого получают ТМЦ (Контрагент_Key)"),
  contractRef: z.string().describe("Ref_Key договора с поставщиком (ДоговорКонтрагента_Key)"),
  receiveFrom: z
    .string()
    .describe("«На получение от» — от кого получать ТМЦ, как в печатной форме (НаПолучениеОт)"),
  byDocument: z
    .string()
    .describe("«По документу» — наряд, счёт и т.п.: «Счёт на оплату № 15 от 01.10.2026» (ПоДокументу)"),
  basisRef: z.string().describe("Ref_Key документа-основания (ДокументОснование_Key)"),
  comment: z.string().describe("Комментарий"),
};

function poaFields(a: Partial<Record<keyof typeof poaHeaderArgs, string>>): Row {
  return {
    ...(a.personRef ? { ФизЛицо_Key: a.personRef } : {}),
    ...(a.validUntil ? { ДатаДействия: asDateTime(a.validUntil) } : {}),
    ...(a.counterpartyRef ? { Контрагент_Key: a.counterpartyRef } : {}),
    ...(a.contractRef ? { ДоговорКонтрагента_Key: a.contractRef } : {}),
    ...(a.receiveFrom !== undefined ? { НаПолучениеОт: a.receiveFrom } : {}),
    ...(a.byDocument !== undefined ? { ПоДокументу: a.byDocument } : {}),
    ...(a.basisRef ? { ДокументОснование_Key: a.basisRef } : {}),
    ...(a.comment !== undefined ? { Комментарий: a.comment } : {}),
  };
}

function poaRows(lines: Array<z.infer<typeof poaLine>>): Row[] {
  return lines.map((l) => ({
    НаименованиеТовара: (l.nomenclatureRef ?? l.name)!,
    НаименованиеТовара_Type: l.nomenclatureRef ? "StandardODATA.Catalog_Номенклатура" : "Edm.String",
    ...(l.unitRef ? { ЕдиницаПоКлассификатору_Key: l.unitRef } : {}),
    Количество: l.quantity,
  }));
}

const UNIT_CLASSIFIER = "Catalog_КлассификаторЕдиницИзмерения";
/** Единица по умолчанию для ТМЦ строкой — «шт» (код 796 по классификатору), как чаще всего в доверенности. */
export const DEFAULT_UNIT = "796";

/**
 * ТМЦ строкой (нет карточки номенклатуры): единица по классификатору по обозначению или коду строки (unit),
 * по умолчанию «шт» (796). Ищется в Catalog_КлассификаторЕдиницИзмерения базы (код хранится с пробелами).
 */
async function fillNamedUnits(
  conn: Connection,
  rows: Row[],
  lines: Array<z.infer<typeof poaLine>>,
): Promise<string[]> {
  const need = rows
    .map((r, i) => ({ r, i, unit: (lines[i]?.unit ?? DEFAULT_UNIT).trim() }))
    .filter(({ r }) => r["НаименованиеТовара_Type"] === "Edm.String" && !r["ЕдиницаПоКлассификатору_Key"]);
  if (!need.length) return [];
  const em = (await conn.getMetadata()).entities.get(UNIT_CLASSIFIER);
  const names = new Set(em?.properties.map((p) => p.name) ?? []);
  let units: Array<Record<string, unknown>> = [];
  if (em) {
    try {
      units = (
        await fetchAll(
          conn.client,
          UNIT_CLASSIFIER,
          {
            select: ["Ref_Key", "Code", "Description", "DeletionMark"].concat(
              names.has("НаименованиеПолное") ? ["НаименованиеПолное"] : [],
            ),
          },
          conn.behavior.pageSize,
          2000,
        )
      ).rows;
    } catch {
      units = [];
    }
  }
  const low = (v: unknown) =>
    String(v ?? "")
      .trim()
      .toLowerCase();
  const find = (u: string) => {
    const live = units.filter((x) => x["DeletionMark"] !== true);
    return (
      live.find((x) => low(x["Code"]) === low(u)) ??
      live.find((x) => low(x["Description"]) === low(u)) ??
      live.find((x) => low(x["НаименованиеПолное"]) === low(u))
    );
  };
  const filled: string[] = [];
  const missing: string[] = [];
  for (const { r, i, unit } of need) {
    const hit = find(unit);
    if (hit) {
      r["ЕдиницаПоКлассификатору_Key"] = String(hit["Ref_Key"]);
      filled.push(`${i + 1} — ${String(hit["Description"] ?? unit).trim()}`);
    } else missing.push(`${i + 1} («${unit}»)`);
  }
  return [
    ...(filled.length
      ? [`Товары: ТМЦ строкой — единица по классификатору: строки ${filled.join(", ")}.`]
      : []),
    ...(missing.length
      ? [
          `Товары: единица не найдена в классификаторе — строки ${missing.join(", ")}; передайте unit (обозначение/код) или unitRef.`,
        ]
      : []),
  ];
}

function poaNotes(
  date: string | undefined,
  validUntil: string | undefined,
  rows: Row[] | undefined,
): string[] {
  const notes: string[] = [];
  if (date && validUntil && validUntil.slice(0, 10) < date.slice(0, 10))
    throw new InputError(
      `Срок действия ${validUntil.slice(0, 10)} раньше даты доверенности ${date.slice(0, 10)}.`,
    );
  if (rows?.some((r) => r["НаименованиеТовара_Type"] === "Edm.String"))
    notes.push(
      "ТМЦ строкой: НаименованиеТовара_Type = Edm.String. Если в базе есть проведённая доверенность, сверьте с ней тип строки (read.document.get_document).",
    );
  notes.push(
    "Доверенность не проводится и движений не делает. Печать — read.document.print_power_of_attorney.",
  );
  return notes;
}

// ---------- Комплектация ----------

const kitComponent = z.object({
  nomenclatureRef: z.string().describe("Ref_Key комплектующей (Catalog_Номенклатура)"),
  quantity: z.number().positive().describe("Количество комплектующей на весь комплект документа"),
  unitRef: z
    .string()
    .optional()
    .describe(
      "Ref_Key единицы (Catalog_КлассификаторЕдиницИзмерения); по умолчанию — базовая единица из карточки номенклатуры",
    ),
  coefficient: z.number().positive().optional().describe("Коэффициент единицы (по умолчанию 1)"),
  costShare: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Доля стоимости (целое число, ДоляСтоимости) — для разукомплектации: как делить стоимость комплекта",
    ),
  account: z.string().optional().describe("Счёт учёта БУ: код ('1330') или Ref_Key"),
  taxAccount: z.string().optional().describe("Счёт учёта НУ: код или Ref_Key"),
});

const kitHeaderArgs = {
  operation: z
    .enum(KITTING_OPERATIONS)
    .describe("Комплектация — собрать комплект из комплектующих; Разукомплектация — разобрать комплект"),
  warehouseRef: z.string().describe("Ref_Key склада (Catalog_Склады)"),
  nomenclatureRef: z.string().describe("Ref_Key комплекта (Catalog_Номенклатура)"),
  quantity: z.number().positive().describe("Количество комплектов"),
  unitRef: z
    .string()
    .describe(
      "Ref_Key единицы комплекта (Catalog_КлассификаторЕдиницИзмерения); по умолчанию — базовая единица из карточки номенклатуры",
    ),
  coefficient: z.number().positive().describe("Коэффициент единицы комплекта (по умолчанию 1)"),
  account: z.string().describe("Счёт учёта комплекта БУ: код ('1330') или Ref_Key"),
  taxAccount: z.string().describe("Счёт учёта комплекта НУ: код или Ref_Key"),
  comment: z.string().describe("Комментарий"),
};

type KitHeader = {
  operation?: (typeof KITTING_OPERATIONS)[number] | undefined;
  warehouseRef?: string | undefined;
  nomenclatureRef?: string | undefined;
  quantity?: number | undefined;
  unitRef?: string | undefined;
  coefficient?: number | undefined;
  account?: string | undefined;
  taxAccount?: string | undefined;
  comment?: string | undefined;
};

function kitFields(a: KitHeader): Row {
  return {
    ...(a.operation ? { ВидОперации: a.operation } : {}),
    ...(a.warehouseRef ? { Склад_Key: a.warehouseRef } : {}),
    ...(a.nomenclatureRef ? { Номенклатура_Key: a.nomenclatureRef } : {}),
    ...(a.quantity !== undefined ? { Количество: a.quantity } : {}),
    ...(a.unitRef ? { ЕдиницаИзмерения_Key: a.unitRef } : {}),
    ...(a.coefficient !== undefined ? { Коэффициент: a.coefficient } : {}),
    ...(a.account ? { СчетУчетаБУ_Key: a.account } : {}),
    ...(a.taxAccount ? { СчетУчетаНУ_Key: a.taxAccount } : {}),
    ...(a.comment !== undefined ? { Комментарий: a.comment } : {}),
  };
}

function kitRows(components: Array<z.infer<typeof kitComponent>>): Row[] {
  return components.map((c) => ({
    Номенклатура_Key: c.nomenclatureRef,
    Количество: c.quantity,
    Коэффициент: c.coefficient ?? 1,
    ...(c.unitRef ? { ЕдиницаИзмерения_Key: c.unitRef } : {}),
    ...(c.costShare !== undefined ? { ДоляСтоимости: c.costShare } : {}),
    ...(c.account ? { СчетУчетаБУ_Key: c.account } : {}),
    ...(c.taxAccount ? { СчетУчетаНУ_Key: c.taxAccount } : {}),
  }));
}

function kitNotes(
  operation: string | undefined,
  kitRef: string | undefined,
  components: Array<z.infer<typeof kitComponent>> | undefined,
): string[] {
  const notes: string[] = [];
  if (components && kitRef && components.some((c) => c.nomenclatureRef === kitRef))
    throw new InputError(
      "Комплект не может быть своей же комплектующей: nomenclatureRef совпадает со строкой.",
    );
  if (operation === "Разукомплектация" && components) {
    const shares = components.filter((c) => c.costShare !== undefined).length;
    if (shares === 0)
      notes.push(
        "Разукомплектация без долей стоимости (costShare): 1С не узнает, как разделить стоимость комплекта между строками.",
      );
    else if (shares < components.length)
      notes.push("Доли стоимости (costShare) заданы не у всех строк — у остальных доля 0.");
  }
  notes.push(
    "Проведение — write.document.post_document; схему проводок (Дт/Кт счетов запасов) сверьте с первым проведённым документом.",
  );
  return notes;
}

const NOMENCLATURE = "Catalog_Номенклатура";
const BASE_UNIT = "БазоваяЕдиницаИзмерения_Key";
const EMPTY_REF = "00000000-0000-0000-0000-000000000000";

/**
 * Единица по умолчанию — базовая единица из карточки номенклатуры (как подставляет форма 1С). Через OData 1С её
 * не подставит; без единицы печатная форма и пересчёт в базовые единицы остаются пустыми.
 */
async function baseUnits(conn: Connection, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const em = (await conn.getMetadata()).entities.get(NOMENCLATURE);
  if (!em?.properties.some((p) => p.name === BASE_UNIT)) return out;
  for (const ref of [...new Set(refs)]) {
    try {
      const guid = ref.replace(/[{}']/g, "");
      const row = await conn.client.getEntity(
        `${NOMENCLATURE}(guid'${guid}')${buildQuery({ select: [BASE_UNIT] })}`,
      );
      const unit = row[BASE_UNIT];
      if (typeof unit === "string" && unit && unit !== EMPTY_REF) out.set(ref, unit);
    } catch {
      // Нет карточки или прав — единица остаётся пустой, предупреждение ниже.
    }
  }
  return out;
}

/** Дописывает единицу строкам без неё по номенклатуре строки; возвращает предупреждения. */
async function fillUnits(
  conn: Connection,
  rows: Row[],
  unitField: string,
  nomOf: (r: Row) => string | undefined,
  where: string,
): Promise<string[]> {
  const need = rows.filter((r) => !r[unitField] && nomOf(r));
  if (!need.length) return [];
  const units = await baseUnits(
    conn,
    need.map((r) => nomOf(r)!),
  );
  const filled: number[] = [];
  const missing: number[] = [];
  for (const r of need) {
    const unit = units.get(nomOf(r)!);
    const n = rows.indexOf(r) + 1;
    if (unit) {
      r[unitField] = unit;
      filled.push(n);
    } else missing.push(n);
  }
  return [
    ...(filled.length
      ? [`${where}: единица взята из карточки номенклатуры (базовая единица) — строки ${filled.join(", ")}.`]
      : []),
    ...(missing.length
      ? [
          `${where}: единица не задана и в карточке номенклатуры не найдена — строки ${missing.join(", ")}; передайте unitRef.`,
        ]
      : []),
  ];
}

const NOM_ACCOUNTS = "InformationRegister_СчетаУчетаНоменклатуры";
const TAX_KINDS = "Catalog_ВидыУчетаНУ";
/** Предопределённый вид учёта «НУ» — так стоят складские документы, проведённые в форме (Aru Market). */
export const TAX_KIND_NU = "НУ";
const realRef = (v: unknown): string | undefined =>
  typeof v === "string" && v && v !== EMPTY_REF ? v : undefined;

/** Цепочка «номенклатура → её группы» (Parent_Key), как ищет счета форма 1С. */
async function nomChain(conn: Connection, ref: string): Promise<string[]> {
  const chain = [ref];
  let cur = ref;
  for (let i = 0; i < 10; i++) {
    try {
      const row = await conn.client.getEntity(
        `${NOMENCLATURE}(guid'${cur.replace(/[{}']/g, "")}')${buildQuery({ select: ["Parent_Key"] })}`,
      );
      const parent = realRef(row["Parent_Key"]);
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      cur = parent;
    } catch {
      break;
    }
  }
  return chain;
}

/**
 * Счета учёта БУ/НУ номенклатуры из регистра «Счета учёта номенклатуры» (казахстанские поля СчетУчетаБУ_Key /
 * СчетУчетаНУ_Key), как форма 1С: самая точная запись — сама номенклатура, затем её группа, затем пустая
 * номенклатура («для всех»); запись для организации точнее пустой организации. Регистра нет — пустая карта.
 */
export async function kzNomAccounts(
  conn: Connection,
  orgKey: string | undefined,
  refs: string[],
): Promise<Map<string, { bu?: string; nu?: string }>> {
  const out = new Map<string, { bu?: string; nu?: string }>();
  const em = (await conn.getMetadata()).entities.get(NOM_ACCOUNTS);
  const has = new Set(em?.properties.map((p) => p.name) ?? []);
  if (!em || !has.has("Номенклатура_Key") || !has.has("СчетУчетаНУ_Key")) return out;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (
      await fetchAll(
        conn.client,
        NOM_ACCOUNTS,
        {
          select: ["Организация_Key", "Номенклатура_Key", "СчетУчетаБУ_Key", "СчетУчетаНУ_Key"].filter((f) =>
            has.has(f),
          ),
        },
        conn.behavior.pageSize,
        5000,
      )
    ).rows;
  } catch {
    return out;
  }
  for (const ref of [...new Set(refs)]) {
    const chain = await nomChain(conn, ref);
    let best: Record<string, unknown> | undefined;
    let bestScore = -1;
    for (const r of rows) {
      const nm = realRef(r["Номенклатура_Key"]);
      const og = realRef(r["Организация_Key"]);
      if (og && og !== orgKey) continue;
      const pos = nm ? chain.indexOf(nm) : chain.length;
      if (pos < 0) continue;
      const score = (chain.length - pos) * 2 + (og ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best) continue;
    const bu = realRef(best["СчетУчетаБУ_Key"]);
    const nu = realRef(best["СчетУчетаНУ_Key"]);
    if (bu || nu) out.set(ref, { ...(bu ? { bu } : {}), ...(nu ? { nu } : {}) });
  }
  return out;
}

/** Ref_Key предопределённого вида учёта НУ «НУ» или undefined. */
async function taxKindNU(conn: Connection): Promise<string | undefined> {
  if (!(await conn.getMetadata()).entities.has(TAX_KINDS)) return undefined;
  try {
    const { rows } = await fetchAll(
      conn.client,
      TAX_KINDS,
      { select: ["Ref_Key", "PredefinedDataName", "DeletionMark"] },
      conn.behavior.pageSize,
      200,
    );
    const hit = rows.find((r) => r["PredefinedDataName"] === TAX_KIND_NU && r["DeletionMark"] !== true);
    return realRef(hit?.["Ref_Key"]);
  } catch {
    return undefined;
  }
}

/**
 * Настройки учёта комплектации, которые форма 1С ставит сама, а через OData 1С оставляет пустыми или ставит
 * «не отражается в НУ» (проверено: комплектация из OData получила ВидУчетаНУ «ПР: не отражается в налоговом
 * учете», без СчетУчетаНУ, и не провелась): счета БУ/НУ комплекта и строк — из регистра «Счета учёта
 * номенклатуры»; ВидУчетаНУ — «НУ» (setTaxKind, только при создании). Заданное явно и взятое из образца не меняет.
 */
export async function applyKittingDefaults(
  conn: Connection,
  header: Record<string, unknown>,
  rows: Array<Record<string, unknown>> | undefined,
  orgKey: string | undefined,
  setTaxKind: boolean,
): Promise<string[]> {
  const notes: string[] = [];
  const em = (await conn.getMetadata()).entities.get(KITTING);
  const headerProps = new Set(em?.properties.map((p) => p.name) ?? []);
  const nom = (r: Record<string, unknown>) => realRef(r["Номенклатура_Key"]);
  const targets = [...(nom(header) ? [header] : []), ...(rows ?? []).filter((r) => nom(r))];
  const need = targets.filter((r) => !realRef(r["СчетУчетаБУ_Key"]) || !realRef(r["СчетУчетаНУ_Key"]));
  if (need.length) {
    const acc = await kzNomAccounts(
      conn,
      orgKey,
      need.map((r) => nom(r)!),
    );
    const filled: string[] = [];
    for (const r of need) {
      const a = acc.get(nom(r)!);
      if (!a) continue;
      const set: string[] = [];
      if (!realRef(r["СчетУчетаБУ_Key"]) && a.bu) {
        r["СчетУчетаБУ_Key"] = a.bu;
        set.push("БУ");
      }
      if (!realRef(r["СчетУчетаНУ_Key"]) && a.nu) {
        r["СчетУчетаНУ_Key"] = a.nu;
        set.push("НУ");
      }
      if (set.length)
        filled.push(
          `${r === header ? "комплект" : `строка ${(rows ?? []).indexOf(r) + 1}`} (${set.join(", ")})`,
        );
    }
    if (filled.length)
      notes.push(
        `Счета учёта подставлены из регистра «Счета учёта номенклатуры», как в форме 1С: ${filled.join("; ")}.`,
      );
  }
  if (setTaxKind && headerProps.has("ВидУчетаНУ_Key") && !realRef(header["ВидУчетаНУ_Key"])) {
    const nu = await taxKindNU(conn);
    if (nu) {
      header["ВидУчетаНУ_Key"] = nu;
      notes.push(
        "ВидУчетаНУ = «НУ», как в складских документах, проведённых в форме; без него 1С ставит «не отражается в НУ».",
      );
    }
  }
  const noBu = (rows ?? [])
    .filter((r) => !realRef(r["СчетУчетаБУ_Key"]))
    .map((r) => (rows ?? []).indexOf(r) + 1);
  if (noBu.length)
    notes.push(
      `Счёт учёта БУ не задан и в регистре не найден — строки ${noBu.join(", ")}; без счёта проводка не сформируется.`,
    );
  if (nom(header) && !realRef(header["СчетУчетаНУ_Key"]))
    notes.push("Счёт учёта НУ комплекта не задан и в регистре не найден — передайте taxAccount.");
  return notes;
}

/** Предупреждение «не задан ни один счёт учёта» из общей подготовки неактуально, если счета подставлены из регистра. */
function dropStaleAccountNote(notes: string[], rows: unknown): string[] {
  const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  const allSet = list.every((r) => realRef(r["СчетУчетаБУ_Key"]) || realRef(r["СчетУчетаНУ_Key"]));
  return allSet ? notes.filter((n) => !n.includes("не задан ни один счёт учёта")) : notes;
}

const poaNom = (r: Row) =>
  r["НаименованиеТовара_Type"] === "StandardODATA.Catalog_Номенклатура"
    ? String(r["НаименованиеТовара"])
    : undefined;
const kitNom = (r: Row) => (typeof r["Номенклатура_Key"] === "string" ? r["Номенклатура_Key"] : undefined);

// ---------- Регистрация ----------

export function registerPoaKittingTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.document.create_power_of_attorney",
    {
      title: "Создать доверенность на получение ТМЦ",
      description:
        "Создаёт документ «Доверенность» (Document_Доверенность): кому выдана (personRef — физлицо), срок действия " +
        "(validUntil), у кого получать (counterpartyRef, contractRef, receiveFrom), по какому документу (byDocument) и " +
        "список ТМЦ (lines: nomenclatureRef или name строкой, единица по классификатору, количество; для ТМЦ строкой " +
        "единица — unit, по умолчанию «шт»). Доверенность не " +
        "проводится. Предпросмотр (confirm=false) показывает тело запроса и предупреждения; создание — confirm=true после " +
        "согласия пользователя. Печать — read.document.print_power_of_attorney. Изменить — " +
        "write.document.update_power_of_attorney. Пример: " +
        '{"personRef":"<GUID>","validUntil":"2026-10-31","counterpartyRef":"<GUID>","byDocument":"Счёт № 15 от 01.10.2026",' +
        '"lines":[{"name":"Бумага А4","quantity":10}]}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        date: dateField("Дата доверенности (по умолчанию — сейчас)").optional(),
        personRef: poaHeaderArgs.personRef,
        validUntil: poaHeaderArgs.validUntil,
        counterpartyRef: poaHeaderArgs.counterpartyRef.optional(),
        contractRef: poaHeaderArgs.contractRef.optional(),
        receiveFrom: poaHeaderArgs.receiveFrom.optional(),
        byDocument: poaHeaderArgs.byDocument.optional(),
        basisRef: poaHeaderArgs.basisRef.optional(),
        comment: poaHeaderArgs.comment.optional(),
        fields: extraFields,
        lines: z.array(poaLine).min(1).describe("Строки «Товары» — что получить"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.document.create_power_of_attorney", async () => {
        const conn = ctx.db(a.database);
        const rows = poaRows(a.lines);
        const notes = poaNotes(a.date, a.validUntil, rows);
        notes.push(...(await fillUnits(conn, rows, "ЕдиницаПоКлассификатору_Key", poaNom, "Товары")));
        notes.push(...(await fillNamedUnits(conn, rows, a.lines)));
        const prepared = await prepareDocument(conn, {
          organization: a.organization,
          entitySet: POWER_OF_ATTORNEY,
          date: a.date,
          fields: { ...poaFields(a), ...(a.fields ?? {}) },
          tables: { Товары: rows },
        });
        return createOrPreview(conn, POWER_OF_ATTORNEY, prepared.payload, a.confirm ?? false, [
          ...notes,
          ...prepared.notes,
        ]);
      }),
  );

  server.registerTool(
    "write.document.update_power_of_attorney",
    {
      title: "Изменить доверенность",
      description:
        "Меняет доверенность из write.document.create_power_of_attorney: срок, физлицо, контрагента, «по документу», " +
        "ТМЦ. Передавайте только то, что меняется; lines заменяют табличную часть «Товары» целиком. Помеченную на " +
        "удаление доверенность не меняет. По умолчанию предпросмотр; применение — confirm=true после согласия пользователя.",
      inputSchema: {
        database: databaseField,
        ref: z.string().describe("Ref_Key доверенности (GUID)"),
        personRef: poaHeaderArgs.personRef.optional(),
        validUntil: poaHeaderArgs.validUntil.optional(),
        counterpartyRef: poaHeaderArgs.counterpartyRef.optional(),
        contractRef: poaHeaderArgs.contractRef.optional(),
        receiveFrom: poaHeaderArgs.receiveFrom.optional(),
        byDocument: poaHeaderArgs.byDocument.optional(),
        basisRef: poaHeaderArgs.basisRef.optional(),
        comment: poaHeaderArgs.comment.optional(),
        fields: extraFields,
        lines: z.array(poaLine).min(1).optional().describe("Новые строки «Товары» — заменяют все"),
        confirm: confirmField,
      },
      outputSchema: patchResultSchema,
    },
    (a) =>
      guard("write.document.update_power_of_attorney", async () => {
        const conn = ctx.db(a.database);
        const rows = a.lines ? poaRows(a.lines) : undefined;
        const notes = poaNotes(undefined, a.validUntil, rows).filter(
          (n) => !n.startsWith("Доверенность не проводится"),
        );
        if (rows && a.lines) {
          notes.push(...(await fillUnits(conn, rows, "ЕдиницаПоКлассификатору_Key", poaNom, "Товары")));
          notes.push(...(await fillNamedUnits(conn, rows, a.lines)));
        }
        const prepared = await prepareDocumentPatch(conn, {
          entitySet: POWER_OF_ATTORNEY,
          ref: a.ref,
          fields: { ...poaFields(a), ...(a.fields ?? {}) },
          tables: rows ? { Товары: rows } : {},
        });
        if (a.validUntil) {
          const cur = await conn.client.getEntity(
            `${POWER_OF_ATTORNEY}(guid'${prepared.guid}')${buildQuery({ select: ["Date"] })}`,
          );
          const d = String(cur["Date"] ?? "");
          if (d && a.validUntil.slice(0, 10) < d.slice(0, 10))
            throw new InputError(
              `Срок действия ${a.validUntil.slice(0, 10)} раньше даты доверенности ${d.slice(0, 10)}.`,
            );
        }
        return patchOrPreview(conn, POWER_OF_ATTORNEY, prepared.guid, prepared.patch, a.confirm ?? false, [
          ...notes,
          ...prepared.notes,
        ]);
      }),
  );

  server.registerTool(
    "write.warehouse.create_kitting",
    {
      title: "Создать комплектацию / разукомплектацию номенклатуры",
      description:
        "Создаёт НЕПРОВЕДЁННЫЙ документ «Комплектация номенклатуры» (Document_КомплектацияНоменклатуры): operation " +
        "«Комплектация» (собрать комплект nomenclatureRef из components) или «Разукомплектация» (разобрать; доли " +
        "стоимости — costShare). Склад, количество комплектов, единица и счета учёта (код '1330' или Ref_Key) — в " +
        "шапке, комплектующие — в табличной части «Комплектующие». Остатки и себестоимость 1С проверит при проведении " +
        "(write.document.post_document). sampleRef — проведённая комплектация, из которой взять счета и настройки учёта. " +
        "Не заданные счета БУ/НУ берутся из регистра «Счета учёта номенклатуры», ВидУчетаНУ — «НУ», как в форме 1С. " +
        "Предпросмотр (confirm=false) по умолчанию; создание — confirm=true после согласия пользователя. Пример: " +
        '{"operation":"Комплектация","warehouseRef":"<GUID>","nomenclatureRef":"<GUID комплекта>","quantity":5,' +
        '"account":"1330","components":[{"nomenclatureRef":"<GUID>","quantity":10,"account":"1330"}]}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        date: dateField("Дата документа (по умолчанию — сейчас)").optional(),
        operation: kitHeaderArgs.operation.default("Комплектация"),
        warehouseRef: kitHeaderArgs.warehouseRef,
        nomenclatureRef: kitHeaderArgs.nomenclatureRef,
        quantity: kitHeaderArgs.quantity,
        unitRef: kitHeaderArgs.unitRef.optional(),
        coefficient: kitHeaderArgs.coefficient.optional(),
        account: kitHeaderArgs.account.optional(),
        taxAccount: kitHeaderArgs.taxAccount.optional(),
        comment: kitHeaderArgs.comment.optional(),
        fields: extraFields,
        sampleRef: z
          .string()
          .optional()
          .describe("Ref_Key проведённой комплектации — взять недостающие счета и настройки учёта"),
        components: z.array(kitComponent).min(1).describe("Строки «Комплектующие»"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.warehouse.create_kitting", async () => {
        const conn = ctx.db(a.database);
        const notes = kitNotes(a.operation, a.nomenclatureRef, a.components);
        const header = kitFields({ ...a, coefficient: a.coefficient ?? 1 });
        notes.push(...(await fillUnits(conn, [header], "ЕдиницаИзмерения_Key", kitNom, "Комплект")));
        const components = kitRows(a.components);
        notes.push(...(await fillUnits(conn, components, "ЕдиницаИзмерения_Key", kitNom, "Комплектующие")));
        const prepared = await prepareDocument(conn, {
          organization: a.organization,
          entitySet: KITTING,
          date: a.date,
          fields: { ...header, ...(a.fields ?? {}) },
          tables: { Комплектующие: components },
          sampleRef: a.sampleRef,
        });
        const payload = prepared.payload as Record<string, unknown>;
        notes.push(
          ...(await applyKittingDefaults(
            conn,
            payload,
            payload["Комплектующие"] as Array<Record<string, unknown>> | undefined,
            realRef(payload["Организация_Key"]),
            true,
          )),
        );
        return createOrPreview(conn, KITTING, prepared.payload, a.confirm ?? false, [
          ...notes,
          ...dropStaleAccountNote(prepared.notes, payload["Комплектующие"]),
        ]);
      }),
  );

  server.registerTool(
    "write.warehouse.update_kitting",
    {
      title: "Изменить комплектацию номенклатуры",
      description:
        "Меняет непроведённую комплектацию из write.warehouse.create_kitting: вид операции, склад, комплект, количество, " +
        "счета, комплектующие (components заменяют табличную часть «Комплектующие» целиком). Проведённый документ не " +
        "меняется — сначала write.document.post_document post=false. По умолчанию предпросмотр; применение — " +
        "confirm=true после согласия пользователя.",
      inputSchema: {
        database: databaseField,
        ref: z.string().describe("Ref_Key комплектации (GUID)"),
        operation: kitHeaderArgs.operation.optional(),
        warehouseRef: kitHeaderArgs.warehouseRef.optional(),
        nomenclatureRef: kitHeaderArgs.nomenclatureRef.optional(),
        quantity: kitHeaderArgs.quantity.optional(),
        unitRef: kitHeaderArgs.unitRef.optional(),
        coefficient: kitHeaderArgs.coefficient.optional(),
        account: kitHeaderArgs.account.optional(),
        taxAccount: kitHeaderArgs.taxAccount.optional(),
        comment: kitHeaderArgs.comment.optional(),
        fields: extraFields,
        components: z
          .array(kitComponent)
          .min(1)
          .optional()
          .describe("Новые строки «Комплектующие» — заменяют все"),
        confirm: confirmField,
      },
      outputSchema: patchResultSchema,
    },
    (a) =>
      guard("write.warehouse.update_kitting", async () => {
        const conn = ctx.db(a.database);
        const notes = a.components ? kitNotes(a.operation, a.nomenclatureRef, a.components) : [];
        const header = kitFields(a);
        if (a.nomenclatureRef)
          notes.push(...(await fillUnits(conn, [header], "ЕдиницаИзмерения_Key", kitNom, "Комплект")));
        const components = a.components ? kitRows(a.components) : undefined;
        if (components)
          notes.push(...(await fillUnits(conn, components, "ЕдиницаИзмерения_Key", kitNom, "Комплектующие")));
        const prepared = await prepareDocumentPatch(conn, {
          entitySet: KITTING,
          ref: a.ref,
          fields: { ...header, ...(a.fields ?? {}) },
          tables: components ? { Комплектующие: components } : {},
        });
        const patch = prepared.patch as Record<string, unknown>;
        if (patch["Номенклатура_Key"] || Array.isArray(patch["Комплектующие"])) {
          const cur = await conn.client.getEntity(
            `${KITTING}(guid'${prepared.guid}')${buildQuery({ select: ["Организация_Key"] })}`,
          );
          notes.push(
            ...(await applyKittingDefaults(
              conn,
              patch["Номенклатура_Key"] ? patch : {},
              patch["Комплектующие"] as Array<Record<string, unknown>> | undefined,
              realRef(cur["Организация_Key"]),
              false,
            )),
          );
        }
        return patchOrPreview(conn, KITTING, prepared.guid, prepared.patch, a.confirm ?? false, [
          ...notes,
          ...dropStaleAccountNote(prepared.notes, patch["Комплектующие"]),
        ]);
      }),
  );
}
