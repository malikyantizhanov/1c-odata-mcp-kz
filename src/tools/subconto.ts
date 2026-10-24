import type { Connection } from "../context.js";
import { fetchAll } from "../odata/pagination.js";
import { buildQuery } from "../odata/query.js";
import type { EntityMeta, ODataEntity } from "../types/odata.js";

/**
 * Субконто затрат в строках документов («Услуги» поступления, «Начисления» и т.п.): поля СубконтоЗатратБУ1..3 /
 * СубконтоЗатратНУ1..3 — составные ссылки: значение (Ref_Key) + <поле>_Type («StandardODATA.Catalog_СтатьиЗатрат»).
 * Какой справочник в каком слоте — задаёт счёт затрат (ExtDimensionTypes плана счетов), поэтому «Статья затрат» —
 * не отдельный реквизит, а субконто счёта 7210/7110/8110. Без _Type 1С запись не принимает или кладёт пустое значение.
 */

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: unknown): v is string =>
  typeof v === "string" && GUID_RE.test(v.replace(/[{}']/g, ""));
const filled = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && v.replace(/[{}']/g, "") !== EMPTY_GUID;

/** Виды субконто (наименование элемента плана видов характеристик, регистр не важен) → справочник значения. */
export const SUBCONTO_ENTITY_BY_KIND: Readonly<Record<string, string>> = {
  "статьи затрат": "Catalog_СтатьиЗатрат",
  подразделения: "Catalog_ПодразделенияОрганизаций",
  "номенклатурные группы": "Catalog_НоменклатурныеГруппы",
  номенклатура: "Catalog_Номенклатура",
  контрагенты: "Catalog_Контрагенты",
  договоры: "Catalog_ДоговорыКонтрагентов",
  склады: "Catalog_Склады",
  "основные средства": "Catalog_ОсновныеСредства",
  "нематериальные активы": "Catalog_НематериальныеАктивы",
  "статьи движения денежных средств": "Catalog_СтатьиДвиженияДенежныхСредств",
  "работники организации": "Catalog_СотрудникиОрганизаций",
  "объекты строительства": "Catalog_ОбъектыСтроительства",
  "биологические активы": "Catalog_БиологическиеАктивы",
  "ценные бумаги": "Catalog_ЦенныеБумаги",
  "расходы будущих периодов": "Catalog_РасходыБудущихПериодов",
  "доходы будущих периодов": "Catalog_ДоходыБудущихПериодов",
};

export const KIND_ARTICLE = "статьи затрат";
export const KIND_DEPARTMENT = "подразделения";
export const KIND_GROUP = "номенклатурные группы";
export const KIND_COUNTERPARTY = "контрагенты";

export type Stage = "БУ" | "НУ";
export const STAGES: readonly Stage[] = ["БУ", "НУ"];
const DEFAULT_CHART: Record<Stage, string> = {
  БУ: "ChartOfAccounts_Типовой",
  НУ: "ChartOfAccounts_Налоговый",
};

export interface SubcontoSlot {
  index: number;
  /** Наименование вида субконто («Статьи затрат»); undefined — вид не удалось прочитать. */
  kind?: string | undefined;
  /** Справочник значений (Catalog_…), если известен. */
  entity?: string | undefined;
}
export interface AccountLayout {
  code: string;
  slots: SubcontoSlot[];
}

export const typeName = (entity: string): string => `StandardODATA.${entity}`;
const entityOfType = (t: string): string => t.replace(/^StandardODATA\./, "");

const BARE_TYPE_RE =
  /^(Catalog|Document|ChartOfAccounts|ChartOfCharacteristicTypes|ChartOfCalculationTypes|ExchangePlan|BusinessProcess|Task)_/;

/**
 * Тип составной ссылки (<поле>_Type) без пространства имён — «Catalog_НоменклатурныеГруппы» — 1С не принимает
 * («Недопустимое значение … составного типа»): дописываем «StandardODATA.» в шапке и в строках табличных частей.
 */
export function withTypeNamespace<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => withTypeNamespace(v)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] =
      k.endsWith("_Type") && typeof v === "string" && BARE_TYPE_RE.test(v.trim())
        ? typeName(v.trim())
        : withTypeNamespace(v);
  return out as T;
}

/** Планы видов характеристик: Ref_Key → наименование (читаем один раз на соединение и план). */
const kindCache = new WeakMap<object, Map<string, Map<string, string>>>();
async function kindNames(conn: Connection, pvc: string): Promise<Map<string, string>> {
  const perConn = kindCache.get(conn) ?? new Map<string, Map<string, string>>();
  kindCache.set(conn, perConn);
  const cached = perConn.get(pvc);
  if (cached) return cached;
  const map = new Map<string, string>();
  try {
    const { rows } = await fetchAll(conn.client, pvc, { select: ["Ref_Key", "Description"] }, 100, 500);
    for (const r of rows) map.set(String(r["Ref_Key"]).toLowerCase(), String(r["Description"] ?? ""));
  } catch {
    // нет прав/не опубликован — слоты останутся без названия вида
  }
  perConn.set(pvc, map);
  return map;
}

/** Субконто счёта затрат (ExtDimensionTypes плана счетов) с видами и справочниками значений. */
export async function accountLayout(
  conn: Connection,
  chart: string,
  accountRef: string,
): Promise<AccountLayout | undefined> {
  let acc: ODataEntity;
  try {
    acc = await conn.client.getEntity(`${chart}(guid'${accountRef.replace(/[{}']/g, "")}')${buildQuery({})}`);
  } catch {
    return undefined;
  }
  const dims = (acc["ExtDimensionTypes"] as ODataEntity[] | undefined) ?? [];
  const meta = await conn.getMetadata();
  const available = await conn.available();
  const names = new Map<string, string>();
  for (const set of available) {
    if (!set.startsWith("ChartOfCharacteristicTypes_")) continue;
    for (const [k, v] of await kindNames(conn, set)) names.set(k, v);
  }
  const slots = dims.map((d, i): SubcontoSlot => {
    const kind = names.get(String(d["ExtDimensionType_Key"]).toLowerCase());
    const entity = kind ? SUBCONTO_ENTITY_BY_KIND[kind.trim().toLowerCase()] : undefined;
    return { index: i + 1, kind, entity: entity && meta.entities.has(entity) ? entity : undefined };
  });
  return { code: String(acc["Code"] ?? ""), slots };
}

const slotKind = (s: SubcontoSlot): string => (s.kind ?? "").trim().toLowerCase();

export interface AnalyticsWant {
  article?: string | undefined;
  department?: string | undefined;
  group?: string | undefined;
  counterparty?: string | undefined;
}
const WANT_KINDS: ReadonlyArray<[keyof AnalyticsWant, string, string]> = [
  ["article", KIND_ARTICLE, "статья затрат"],
  ["department", KIND_DEPARTMENT, "подразделение"],
  ["group", KIND_GROUP, "номенклатурная группа"],
  ["counterparty", KIND_COUNTERPARTY, "контрагент"],
];

/**
 * Раскладывает статью затрат, подразделение, номенклатурную группу и контрагента по слотам субконто счёта.
 * Статья затрат — главное: при strict её отсутствие у счёта — ошибка (иначе значение ушло бы не туда или пропало).
 * Остальное, чего у счёта нет, пропускается с предупреждением (warnings); quiet — виды, о которых молчим
 * (значение подставлено по умолчанию, а не запрошено явно, напр. контрагент документа).
 */
export function placeAnalytics(
  layout: AccountLayout,
  stage: Stage,
  want: AnalyticsWant,
  opts: { strict?: boolean; quiet?: ReadonlyArray<keyof AnalyticsWant> } = {},
): { fields: Record<string, string>; warnings: string[]; error?: string } {
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [key, kind, label] of WANT_KINDS) {
    const ref = want[key];
    if (!ref) continue;
    const slot = layout.slots.find((s) => slotKind(s) === kind);
    const have = layout.slots.map((s) => `${s.index}) ${s.kind ?? "?"}`).join(", ") || "субконто нет";
    if (!slot) {
      if (opts.quiet?.includes(key)) continue;
      const text = `У счёта затрат ${layout.code} (${stage}) нет субконто «${kind}» — ${label} не задаётся. Субконто счёта: ${have}.`;
      if (key === "article" && opts.strict)
        return { fields, warnings, error: `${text} Выберите другой счёт затрат или уберите ${label}.` };
      warnings.push(`${text} Пропущено.`);
      continue;
    }
    if (!slot.entity) {
      const text = `Не удалось определить справочник для субконто «${slot.kind}» счёта ${layout.code} (${stage}) — тип значения неизвестен.`;
      if (key === "article" && opts.strict) return { fields, warnings, error: text };
      warnings.push(`${text} Пропущено.`);
      continue;
    }
    fields[`СубконтоЗатрат${stage}${slot.index}`] = ref;
    fields[`СубконтоЗатрат${stage}${slot.index}_Type`] = typeName(slot.entity);
  }
  return { fields, warnings };
}

const rowSetOf = (type: string): string | undefined =>
  /^Collection\(StandardODATA\.(.+)_RowType\)$/.exec(type)?.[1];

/**
 * Дописывает недостающие <Субконто…>_Type в строках табличных частей по счёту затрат строки, проверяет заданные
 * типы и предупреждает о пустых субконто «Статьи затрат». Возвращает итог по каждой строке для предпросмотра.
 */
export async function fillSubcontoTypes(
  conn: Connection,
  em: EntityMeta,
  payload: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; notes: string[] }> {
  const meta = await conn.getMetadata();
  const out: Record<string, unknown> = { ...withTypeNamespace(payload) };
  const notes: string[] = [];
  const layouts = new Map<string, Promise<AccountLayout | undefined>>();
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (entity: string, ref: string) => {
    const key = `${entity}|${ref}`;
    if (!names.has(key))
      names.set(
        key,
        conn.client
          .getEntity(
            `${entity}(guid'${ref.replace(/[{}']/g, "")}')${buildQuery({ select: ["Description"] })}`,
          )
          .then((e) => (e["Description"] ? String(e["Description"]) : undefined))
          .catch(() => undefined),
      );
    return names.get(key)!;
  };
  for (const part of em.properties) {
    const rowSet = rowSetOf(part.type);
    const rowMeta = rowSet ? meta.entities.get(rowSet) : undefined;
    const rows = out[part.name];
    if (!rowMeta || !Array.isArray(rows)) continue;
    if (!rowMeta.properties.some((p) => p.name.startsWith("СубконтоЗатрат"))) continue;
    const copy = (rows as Array<Record<string, unknown>>).map((r) => ({ ...r }));
    out[part.name] = copy;
    for (const [i, row] of copy.entries()) {
      const where = `${part.name}, строка ${i + 1}`;
      for (const stage of STAGES) {
        const accRef = row[`СчетЗатрат${stage}_Key`];
        const subs = [1, 2, 3].filter((n) => filled(row[`СубконтоЗатрат${stage}${n}`]));
        if (!filled(accRef) || !isGuid(accRef)) {
          if (subs.length)
            notes.push(
              `${where}: задано субконто затрат ${stage}, но счёт затрат ${stage} не задан или не разрешён в ссылку — тип субконто не проверен.`,
            );
          continue;
        }
        const chart =
          rowMeta.navigations
            ?.find((n) => n.name === `СчетЗатрат${stage}`)
            ?.toType.replace(/^StandardODATA\./, "") ?? DEFAULT_CHART[stage];
        const key = `${chart}|${accRef}`;
        if (!layouts.has(key)) layouts.set(key, accountLayout(conn, chart, accRef));
        const layout = await layouts.get(key)!;
        if (!layout) {
          if (subs.length)
            notes.push(`${where}: счёт затрат ${stage} не прочитан в ${chart} — тип субконто не проверен.`);
          continue;
        }
        const lines: string[] = [];
        for (const slot of layout.slots) {
          const field = `СубконтоЗатрат${stage}${slot.index}`;
          const value = row[field];
          if (!filled(value)) {
            notes.push(
              `${where}: слот ${slot.index} (вид «${slot.kind ?? "не прочитан"}») счёта ${layout.code} (${stage}) не заполнен` +
                (slotKind(slot) === KIND_ARTICLE
                  ? " — проводка пойдёт с пустой статьёй; найдите её: read.catalog.list_catalog (Catalog_СтатьиЗатрат)."
                  : "."),
            );
            continue;
          }
          const given = row[`${field}_Type`];
          if (typeof given === "string" && given) {
            const full = given.startsWith("StandardODATA.") ? given : typeName(given);
            row[`${field}_Type`] = full;
            if (slot.entity && entityOfType(full) !== slot.entity)
              notes.push(
                `${where}: ${field} — тип ${entityOfType(full)}, а субконто ${slot.index} счёта ${layout.code} — «${slot.kind}» (${slot.entity}).`,
              );
          } else if (slot.entity) {
            row[`${field}_Type`] = typeName(slot.entity);
          } else {
            notes.push(
              `${where}: тип для ${field} не определён (вид субконто ${slot.kind ?? "не прочитан"}) — передайте ${field}_Type.`,
            );
            continue;
          }
          const ent = entityOfType(String(row[`${field}_Type`]));
          const label = await nameOf(ent, String(value));
          lines.push(`${slot.index}) ${slot.kind ?? ent}: ${label ? `«${label}»` : String(value)} [${ent}]`);
        }
        for (const n of subs)
          if (n > layout.slots.length)
            notes.push(
              `${where}: ${stage}-субконто ${n} задано, а у счёта ${layout.code} всего ${layout.slots.length} субконто.`,
            );
        if (lines.length)
          notes.push(`Субконто затрат ${stage}, ${where}, счёт ${layout.code}: ${lines.join("; ")}.`);
      }
    }
  }
  return { payload: out, notes };
}
