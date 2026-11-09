import type { Connection } from "../context.js";
import { ODataError } from "./errors.js";
import { buildQuery, cmp, odataGuid } from "./query.js";

/**
 * Отбор элементов справочника по владельцу. У одних справочников владелец одного типа — поле Owner_Key
 * (договоры контрагента в типовой БП), у других составной — Owner/Владелец + <поле>_Type (банковские счета:
 * организация или контрагент; договоры в части баз РК). Составное поле 1С отбирает только как
 * «Owner eq cast(guid'…', 'Catalog_…')»: тип владельца узнаём по тому, в каком справочнике найден его Ref_Key.
 * Простое «Owner eq guid'…'» по составному полю 1С не отбирает, а без поля в $select сравнивать на стороне
 * MCP нечего — отсюда «пустой» результат по владельцу, который был раньше.
 */

/** Справочники, элементы которых бывают владельцами (по убыванию частоты). */
export const OWNER_CATALOGS = [
  "Catalog_Контрагенты",
  "Catalog_Организации",
  "Catalog_ФизическиеЛица",
  "Catalog_Банки",
  "Catalog_СотрудникиОрганизаций",
  "Catalog_Номенклатура",
] as const;

export interface OwnerField {
  /** key — ссылка одного типа (Owner_Key), composite — составная (Owner + Owner_Type). */
  kind: "key" | "composite";
  field: string;
}

/** Поле владельца справочника по его свойствам в $metadata. */
export function ownerFieldOf(props: ReadonlyArray<{ name: string }>): OwnerField | undefined {
  const has = (n: string) => props.some((p) => p.name === n);
  for (const f of ["Owner_Key", "Владелец_Key"]) if (has(f)) return { kind: "key", field: f };
  for (const f of ["Owner", "Владелец", "ОбъектВладелец"]) if (has(f)) return { kind: "composite", field: f };
  return undefined;
}

/** Найденный справочник ссылки — на подключение: вид элемента по его Ref_Key не меняется. */
const refCatalogs = new WeakMap<Connection, Map<string, string>>();

/**
 * Справочник, в котором есть элемент с этим Ref_Key (из candidates, опубликованных в базе); нет — undefined.
 * Сначала самый частый (первый в candidates), остальные — только если там нет: раньше каждый отбор по владельцу
 * спрашивал все шесть справочников сразу, и пять 404 на каждый вызов засоряли журнал (прод: по 99 на справочник).
 * Найденный — в памяти подключения.
 */
export async function catalogOfRef(
  conn: Connection,
  ref: string,
  candidates: readonly string[] = OWNER_CATALOGS,
): Promise<string | undefined> {
  const guid = ref.trim().replace(/[{}']/g, "").toLowerCase();
  let known = refCatalogs.get(conn);
  if (!known) refCatalogs.set(conn, (known = new Map()));
  const cached = known.get(guid);
  if (cached && candidates.includes(cached)) return cached;
  const available = await conn.available();
  const sets = candidates.filter((s) => available.has(s));
  const has = (s: string) =>
    conn.client
      .getEntity(`${s}(guid'${guid}')${buildQuery({ select: ["Ref_Key"] })}`)
      .then(() => true)
      .catch((e: unknown) => {
        if (e instanceof ODataError && e.kind !== "not_found" && e.kind !== "auth") throw e;
        return false;
      });
  const [first, ...rest] = sets;
  let hit: string | undefined;
  if (first && (await has(first))) hit = first;
  else {
    const found = await Promise.all(rest.map(has));
    hit = rest.find((_, i) => found[i]);
  }
  if (hit) known.set(guid, hit);
  return hit;
}

export interface OwnerFilter {
  field: OwnerField;
  /** Серверный отбор (eq по Owner_Key или cast по составному полю). */
  filter?: string | undefined;
  /** Тип владельца для составного поля (Catalog_…), если определён. */
  ownerType?: string | undefined;
  /** Составное поле, тип владельца не определён: отбираем на стороне MCP по значению поля (его надо выбрать в $select). */
  clientField?: string | undefined;
}

/**
 * Отбор по владельцу для справочника set. ownerType — тип владельца, если вызывающий его знает
 * (договоры — «Catalog_Контрагенты»); иначе ищем Ref_Key в справочниках-владельцах. undefined — у справочника нет владельца.
 */
export async function ownerFilter(
  conn: Connection,
  set: string,
  owner: string,
  ownerType?: string,
): Promise<OwnerFilter | undefined> {
  const props = (await conn.getMetadata()).entities.get(set)?.properties ?? [];
  const field = ownerFieldOf(props);
  if (!field) return undefined;
  const guid = owner.trim().replace(/[{}']/g, "");
  if (field.kind === "key") return { field, filter: cmp(field.field, "eq", odataGuid(guid)) };
  const type = ownerType ?? (await catalogOfRef(conn, guid));
  if (!type) return { field, clientField: field.field };
  return { field, ownerType: type, filter: `${field.field} eq cast(${odataGuid(guid)}, '${type}')` };
}

/** Значение владельца в строке совпадает с guid (для отбора на стороне MCP). */
export const sameOwner = (value: unknown, guid: string): boolean =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase() === guid.replace(/[{}']/g, "").toLowerCase();
