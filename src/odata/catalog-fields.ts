import type { Connection } from "../context.js";
import { InputError } from "../errors.js";

/** Upstream field names, used when a connection cannot describe its metadata. */
const UPSTREAM_FIELDS = {
  ref: "Ref_Key", name: "Description", code: "Code", inn: "ИНН", kpp: "КПП",
  fullName: "НаименованиеПолное", isFolder: "IsFolder",
};

/** Catalog fields of this base: Kazakhstan configurations keep the tax id in ИдентификационныйКодЛичности (counterparties) or ИдентификационныйНомер (organizations). */
export async function catalogFields(conn: Connection, set: string) {
  if (typeof (conn as { getMetadata?: unknown }).getMetadata !== "function") return { ...UPSTREAM_FIELDS };
  const entity = (await conn.getMetadata()).entities.get(set);
  const published = new Set(entity?.properties.map(p => p.name) ?? []);
  const choose = (...names: string[]) => names.find(name => published.has(name)) ?? "";
  const fields = {
    ref: choose("Ref_Key"), name: choose("Description"), code: choose("Code"),
    inn: choose("ИНН", "ИдентификационныйКодЛичности", "ИдентификационныйНомер", "БИН", "ИИН"),
    kpp: choose("КПП"), fullName: choose("НаименованиеПолное"), isFolder: choose("IsFolder"),
  };
  if (!fields.ref || !fields.name) throw new InputError("В справочнике отсутствуют поля Ref_Key/Description.");
  return fields;
}
