import { z } from "zod";
import type { Connection } from "../context.js";
import { InputError } from "../errors.js";
import { resolveCatalogItem } from "./catalog-lookup.js";
import { resolveAccountCodes } from "./kz-flow.js";
import {
  accountLayout,
  fillCompositeTypes,
  fillSubcontoTypes,
  isGuid,
  placeAnalytics,
  STAGES,
  type Stage,
} from "./subconto.js";

/**
 * Аналитика затрат в строках УЖЕ существующего документа (поступление услуг и др.): счёт затрат БУ/НУ, статья затрат,
 * подразделение, номенклатурная группа, контрагент и явные СубконтоЗатратБУ1..3 / НУ1..3. Раскладка по слотам и
 * `_Type` — по субконто счёта затрат, как в write.purchase.create_services_receipt. Только подготовка строк:
 * запись (PATCH табличной части) — в инструментах изменения строк, по dry-run/confirm.
 */
const ARTICLES = "Catalog_СтатьиЗатрат";
const DEPARTMENTS = "Catalog_ПодразделенияОрганизаций";
const GROUPS = "Catalog_НоменклатурныеГруппы";
const COUNTERPARTIES = "Catalog_Контрагенты";

/** Явные слоты субконто строки: СубконтоЗатратБУ1..3/НУ1..3, СубконтоДоходовБУn, СубконтоРасходов…n и т.п. */
export const SUBCONTO_FIELD_RE = /^Субконто\p{L}*[1-3]$/u;
const COST_SUBCONTO_RE = /^СубконтоЗатрат(БУ|НУ)[1-3]$/;

export const analyticsFields = {
  costAccount: z
    .string()
    .optional()
    .describe(
      "Счёт затрат БУ: код Типового плана ('7210', '7310') или Ref_Key. Без него берётся счёт, уже стоящий в строке. " +
        "При смене счёта прежние субконто БУ строки очищаются",
    ),
  taxCostAccount: z
    .string()
    .optional()
    .describe("Счёт затрат НУ: код Налогового плана ('7210Н') или Ref_Key; при смене субконто НУ очищаются"),
  costArticle: z
    .string()
    .optional()
    .describe(
      "Статья затрат: код (цифры, напр. 000000104 или 104), название (часть) или Ref_Key (Catalog_СтатьиЗатрат); " +
        "найти — read.catalog.list_catalog",
    ),
  department: z.string().optional().describe("Подразделение: название, код или Ref_Key"),
  nomenclatureGroup: z
    .string()
    .optional()
    .describe("Номенклатурная группа: название, код или Ref_Key — если у счёта есть такое субконто"),
  subcontoCounterparty: z
    .string()
    .optional()
    .describe("Контрагент для слота «Контрагенты» субконто: название, код или Ref_Key (Catalog_Контрагенты)"),
  subconto: z
    .record(
      z
        .string()
        .regex(
          SUBCONTO_FIELD_RE,
          "ключ — поле субконто строки: СубконтоЗатратБУ1..3, СубконтоДоходовБУ1..3 и т.п.",
        ),
      z.string(),
    )
    .optional()
    .describe(
      'Явные значения слотов: {"СубконтоЗатратБУ1":"<Ref_Key>","СубконтоДоходовБУ1":"<Ref_Key>"}. Перекрывают то, что ' +
        "подобрано по названиям; <поле>_Type сервер допишет сам — по виду субконто счёта строки (СчетЗатрат…/СчетДоходов…) " +
        "или по справочнику, где найден Ref_Key",
    ),
};

export const analyticsObject = z.object(analyticsFields);
export type LineAnalytics = z.infer<typeof analyticsObject>;

export const hasAnalytics = (a: Partial<LineAnalytics> | undefined): a is LineAnalytics =>
  !!a &&
  !!(
    a.costAccount ||
    a.taxCostAccount ||
    a.costArticle ||
    a.department ||
    a.nomenclatureGroup ||
    a.subcontoCounterparty ||
    (a.subconto && Object.keys(a.subconto).length)
  );

/** Выделяет из объекта строки поля аналитики (остальное остаётся строкой товара). */
export function pickAnalytics(l: Partial<LineAnalytics>): LineAnalytics | undefined {
  const a: Partial<LineAnalytics> = {};
  for (const k of Object.keys(analyticsFields) as Array<keyof LineAnalytics>) {
    if (l[k] !== undefined) (a as Record<string, unknown>)[k] = l[k];
  }
  return hasAnalytics(a) ? a : undefined;
}

type Row = Record<string, unknown>;
const EMPTY = "00000000-0000-0000-0000-000000000000";
const isFilled = (v: unknown): boolean =>
  typeof v === "string" && v.trim() !== "" && v.replace(/[{}']/g, "") !== EMPTY;
const watched = (k: string) => /^СчетЗатрат(БУ|НУ)_Key$/.test(k) || /^Субконто\p{L}*[1-3](_Type)?$/u.test(k);

/**
 * Применяет аналитику к строкам табличной части: specs[i] относится к rows[i] (undefined — строку не трогаем).
 * Возвращает новые строки и notes: что изменится в строке (старое → новое) и предупреждения по слотам.
 */
export async function applyLineAnalytics(
  conn: Connection,
  p: {
    entitySet: string;
    section: string;
    rows: Row[];
    specs: Array<LineAnalytics | undefined>;
    /** Контрагент документа — подставляется в слот «Контрагенты» (молча, если такого слота у счёта нет). */
    documentCounterparty?: string | undefined;
  },
): Promise<{ rows: Row[]; notes: string[] }> {
  const meta = await conn.getMetadata();
  const em = meta.entities.get(p.entitySet);
  const rowMeta = meta.entities.get(`${p.entitySet}_${p.section}`);
  if (!em || !rowMeta)
    throw new InputError(`${p.entitySet}: табличной части «${p.section}» нет в $metadata.`);
  // Без субконто затрат в строках — можно задать только явные слоты других субконто (доходов и т.п.).
  const costOnly = (sp: LineAnalytics) =>
    !!(sp.costAccount || sp.taxCostAccount || sp.costArticle || sp.department || sp.nomenclatureGroup) ||
    !!sp.subcontoCounterparty ||
    Object.keys(sp.subconto ?? {}).some((k) => COST_SUBCONTO_RE.test(k));
  if (
    !rowMeta.properties.some((x) => x.name.startsWith("СубконтоЗатрат")) &&
    p.specs.some((sp) => sp && costOnly(sp))
  )
    throw new InputError(
      `В табличной части «${p.section}» документа ${p.entitySet} нет субконто затрат (СубконтоЗатратБУn/НУn) — ` +
        "аналитика затрат здесь не задаётся.",
    );
  const touched = p.specs.map((s) => !!s);
  const original = p.rows.map((r) => ({ ...r }));
  let rows = p.rows.map((r) => ({ ...r }));

  // Счета затрат: коды → Ref_Key (одним запросом на план), только там, где счёт задан явно.
  const stubs = rows.map((_, i) => ({
    ...(p.specs[i]?.costAccount ? { СчетЗатратБУ_Key: p.specs[i]!.costAccount! } : {}),
    ...(p.specs[i]?.taxCostAccount ? { СчетЗатратНУ_Key: p.specs[i]!.taxCostAccount! } : {}),
  }));
  const resolved = (await resolveAccountCodes(conn, em, { [p.section]: stubs })).payload[p.section] as Row[];
  rows = rows.map((r, i) => {
    const out = { ...r };
    for (const stage of STAGES) {
      const nu = resolved[i]?.[`СчетЗатрат${stage}_Key`];
      if (typeof nu === "string" && nu) {
        if (String(out[`СчетЗатрат${stage}_Key`] ?? "").toLowerCase() !== nu.toLowerCase()) {
          out[`СчетЗатрат${stage}_Key`] = nu;
          for (const n of [1, 2, 3]) {
            out[`СубконтоЗатрат${stage}${n}`] = EMPTY;
            out[`СубконтоЗатрат${stage}${n}_Type`] = "StandardODATA.Undefined";
          }
        }
      }
    }
    return out;
  });

  const lookups = new Map<string, Promise<string>>();
  const lookup = (entity: string, value: string | undefined, label: string) => {
    if (!value) return Promise.resolve(undefined);
    const key = `${entity}|${value}`;
    if (!lookups.has(key))
      lookups.set(
        key,
        resolveCatalogItem(conn, entity, value, label).then((r) => r.ref),
      );
    return lookups.get(key)!;
  };
  const layouts = new Map<string, ReturnType<typeof accountLayout>>();
  const layoutOf = (stage: Stage, ref: string) => {
    const chart =
      rowMeta.navigations
        ?.find((n) => n.name === `СчетЗатрат${stage}`)
        ?.toType.replace(/^StandardODATA\./, "") ??
      (stage === "БУ" ? "ChartOfAccounts_Типовой" : "ChartOfAccounts_Налоговый");
    const key = `${chart}|${ref}`;
    if (!layouts.has(key)) layouts.set(key, accountLayout(conn, chart, ref));
    return layouts.get(key)!;
  };

  const notes: string[] = [];
  for (const [i, spec] of p.specs.entries()) {
    if (!spec) continue;
    const row = rows[i]!;
    const where = `${p.section}, строка ${i + 1}`;
    const article = await lookup(ARTICLES, spec.costArticle, "Статья затрат");
    const department = await lookup(DEPARTMENTS, spec.department, "Подразделение");
    const group = await lookup(GROUPS, spec.nomenclatureGroup, "Номенклатурная группа");
    const cpExplicit = await lookup(COUNTERPARTIES, spec.subcontoCounterparty, "Контрагент (субконто)");
    const want = { article, department, group, counterparty: cpExplicit ?? p.documentCounterparty };
    const byName = !!(article || department || group || cpExplicit);
    const quiet = cpExplicit ? [] : (["counterparty"] as const);
    if (byName) {
      for (const stage of STAGES) {
        const acc = row[`СчетЗатрат${stage}_Key`];
        if (!isFilled(acc) || !isGuid(acc)) {
          if (stage === "БУ")
            throw new InputError(
              `${where}: статья затрат/подразделение — субконто счёта затрат, а в строке нет счёта затрат БУ; укажите costAccount (напр. '7310').`,
            );
          continue;
        }
        const layout = await layoutOf(stage, acc as string);
        if (!layout) {
          if (stage === "БУ")
            throw new InputError(
              `${where}: счёт затрат ${String(acc)} не прочитан в плане счетов — не удалось определить субконто.`,
            );
          notes.push(`${where}: счёт затрат ${stage} не прочитан в плане счетов — субконто не определены.`);
          continue;
        }
        const placed = placeAnalytics(layout, stage, want, { strict: stage === "БУ", quiet });
        if (placed.error) throw new InputError(`${where}: ${placed.error}`);
        Object.assign(row, placed.fields);
        notes.push(...placed.warnings.map((w) => `${where}: ${w}`));
      }
    }
    for (const [field, value] of Object.entries(spec.subconto ?? {})) {
      if (!SUBCONTO_FIELD_RE.test(field)) throw new InputError(`${where}: недопустимое поле ${field}.`);
      if (!rowMeta.properties.some((x) => x.name === field))
        throw new InputError(
          `${where}: в строках «${p.section}» нет поля ${field}; есть: ` +
            (rowMeta.properties
              .map((x) => x.name)
              .filter((n) => SUBCONTO_FIELD_RE.test(n))
              .join(", ") || "полей субконто нет") +
            ".",
        );
      if (!isGuid(value))
        throw new InputError(`${where}: ${field} — ожидается Ref_Key (GUID), получено «${value}».`);
      row[field] = value.replace(/[{}']/g, "");
      // Тип прежнего значения не годится для нового — fillSubcontoTypes допишет по виду субконто счёта.
      delete row[`${field}_Type`];
    }
  }

  // _Type по виду субконто счёта, проверка типов и предупреждения о пустых слотах — только по тронутым строкам.
  const costTypes = await fillSubcontoTypes(conn, em, { [p.section]: rows });
  // Прочие составные слоты (СубконтоДоходовБУn и т.п.): _Type по счёту строки или справочнику ссылки.
  // Нетронутые строки не проверяем (пустые объекты вместо них — номера строк в notes сохраняются).
  const otherTypes = await fillCompositeTypes(conn, em, {
    [p.section]: (costTypes.payload[p.section] as Row[]).map((r, i) => (touched[i] ? r : {})),
  });
  const filledTypes = { notes: [...costTypes.notes, ...otherTypes.notes] };
  const typed = otherTypes.payload[p.section] as Row[];
  rows = rows.map((r, i) => (touched[i] ? typed[i]! : r));
  const touchedNo = new Set(touched.flatMap((t, i) => (t ? [i + 1] : [])));
  for (const n of filledTypes.notes) {
    const m = /строка (\d+)/.exec(n);
    if (m && touchedNo.has(Number(m[1]))) notes.push(n);
  }

  // Что именно изменится (старое → новое): по строкам, счетам и слотам субконто.
  const changes: string[] = [];
  for (const [i, r] of rows.entries()) {
    if (!touched[i]) continue;
    const diffs: string[] = [];
    for (const k of new Set([...Object.keys(r), ...Object.keys(original[i]!)])) {
      if (!watched(k)) continue;
      const before = isFilled(original[i]![k]) || /_Type$/.test(k) ? String(original[i]![k] ?? "") : "";
      const after = isFilled(r[k]) || /_Type$/.test(k) ? String(r[k] ?? "") : "";
      if (before !== after) diffs.push(`${k}: ${before || "пусто"} → ${after || "пусто"}`);
    }
    changes.push(
      `Строка ${i + 1} (${p.section}): ${diffs.length ? diffs.join("; ") : "изменений аналитики нет — значения уже такие"}.`,
    );
  }
  return { rows, notes: [...changes, ...notes] };
}
