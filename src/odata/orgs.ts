import type { Connection } from "../context.js";
import { fetchAll } from "./pagination.js";
import { CATALOGS } from "../config/mapping.js";
import { requireEntity } from "./publication.js";
import { catalogFields } from "./catalog-fields.js";
import { InputError } from "../errors.js";

export interface Organization {
  ref: string;
  name: string;
  inn?: string;
}

const orgSet = (conn: Connection): Promise<string> =>
  requireEntity(conn, CATALOGS.organizations, "Справочник «Организации»");

/** Все организации (юрлица) базы. */
export async function listOrganizations(conn: Connection): Promise<Organization[]> {
  const set = await orgSet(conn);
  const fields = await catalogFields(conn, set);
  const { rows } = await fetchAll(
    conn.client,
    set,
    { select: [fields.ref, fields.name, fields.inn].filter(Boolean), orderby: "Description" },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  return rows.map((r) => ({
    ref: String(r["Ref_Key"] ?? ""),
    name: String(r["Description"] ?? ""),
    inn: r[fields.inn] ? String(r[fields.inn]) : undefined,
  }));
}

const GUID_RE = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

/** Название для сравнения: без кавычек любых видов, регистра и лишних пробелов («ЧК "IGS Caspian Ltd"» = «ЧК IGS Caspian Ltd»). */
export const orgKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/["'«»“”„`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Резолвит организацию в Ref_Key: по ссылке (Ref_Key — модели часто передают её из list_organizations), по
 * БИН/ИИН (12 цифр) или по названию — часть названия, кавычки и регистр не важны.
 * Прод 09.11.2026: «Организация "<guid>" не найдена» — 105 раз за 400 ч, «ЧК "IGS Caspian Ltd"» при названии
 * в 1С «ЧК IGS Caspian Ltd» — тоже «не найдена».
 * Бросает понятную ошибку, если ничего не найдено или найдено неоднозначно.
 */
export async function resolveOrganization(conn: Connection, query: string): Promise<Organization> {
  const q = query.trim();
  const all = await listOrganizations(conn);
  const guid = GUID_RE.exec(q)?.[1]?.toLowerCase();
  if (guid) {
    const hit = all.find((o) => o.ref.toLowerCase() === guid);
    if (hit) return hit;
    throw new InputError(
      `Организации с Ref_Key ${guid} в базе нет. Доступные: ${all.map((o) => o.name).join(", ") || "—"}.`,
    );
  }
  if (/^\d{12}$/.test(q)) {
    const byInn = all.filter((o) => (o.inn ?? "").replace(/\D/g, "") === q);
    if (byInn.length === 1) return byInn[0]!;
  }
  const key = orgKey(q);
  const exact = all.filter((o) => orgKey(o.name) === key);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length ? exact : all.filter((o) => key && orgKey(o.name).includes(key));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) {
    throw new InputError(
      `Организация "${query}" не найдена. Доступные: ${all.map((o) => o.name).join(", ") || "—"} ` +
        "(передавайте название, БИН/ИИН или Ref_Key из list_organizations).",
    );
  }
  throw new InputError(
    `Под "${query}" подходит несколько организаций: ${partial.map((o) => o.name).join(", ")}. Уточните название или передайте Ref_Key.`,
  );
}

/**
 * Резолвит организацию по названию; без названия — авто-выбор, если в базе
 * ровно одна. Общий хелпер для всех инструментов с необязательным `organization`.
 */
export async function resolveOrgOrDefault(
  conn: Connection,
  organization: string | undefined,
): Promise<Organization> {
  if (organization) return resolveOrganization(conn, organization);
  const orgs = await listOrganizations(conn);
  if (orgs.length === 1) return orgs[0]!;
  throw new InputError(
    `В базе несколько организаций — укажите organization. Доступные: ${orgs.map((o) => o.name).join(", ")}`,
  );
}
