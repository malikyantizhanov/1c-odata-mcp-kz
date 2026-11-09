import type { Connection } from "../context.js";
import { InputError } from "../errors.js";
import { catalogFields } from "../odata/catalog-fields.js";
import { fetchAll } from "../odata/pagination.js";
import { and, cmp, contains, odataGuid } from "../odata/query.js";
import { HEADER_FROM, ROW_FROM, TABLES_FROM } from "../odata/vocab.js";
import type { ODataEntity } from "../types/odata.js";
import { COMMON_TARGETS } from "./preview-view.js";

/**
 * Запись в тех же понятных полях, что и читаемый вид (odata/vocab.ts): {"counterparty": "ИП Алексеев",
 * "contract": {"name": "Договор №2"}, "services": [{"nomenclature": "Стирка", "quantity": 1, "price": 170050}]}.
 * Имена — в реквизиты 1С; ссылка — guid, {guid}, {name} или просто название (БИН у контрагента) — находится в
 * справочнике сам; КНП — код или {code}. Реквизиты 1С (Контрагент_Key, …) принимаются как раньше.
 */

export type Loose =
  string | number | boolean | null | { guid?: string; name?: string; code?: string; type?: string };
type Scalar = string | number | boolean | null;

const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const norm = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/["'«»“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

interface EntityMeta {
  entitySet: string;
  properties: Array<{ name: string; type?: string }>;
  navigations?: Array<{ name: string; toType: string }>;
}

function targetOf(em: EntityMeta, base: string, given?: string): string | undefined {
  if (given) return given.replace(/^StandardODATA\./, "");
  return em.navigations?.find((n) => n.name === base)?.toType ?? COMMON_TARGETS[base];
}

/** Ссылка по названию (или БИН у контрагента) в справочнике; одна — guid, ни одной/несколько — понятная ошибка. */
async function findRef(
  conn: Connection,
  set: string,
  text: string,
  where: string,
  owner?: string,
): Promise<string> {
  const f = await catalogFields(conn, set);
  const name = f.name || "Description";
  const bin = /^\d{12}$/.test(text.trim()) && f.inn ? f.inn : "";
  const meta = (await conn.getMetadata()).entities.get(set);
  const hasOwner = owner && meta?.properties.some((p) => p.name === "Owner_Key");
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        bin ? cmp(bin, "eq", `'${text.trim()}'`) : contains(name, text.trim()),
        hasOwner ? cmp("Owner_Key", "eq", odataGuid(owner!)) : undefined,
      ),
      select: [
        "Ref_Key",
        name,
        ...(meta?.properties.some((p) => p.name === "DeletionMark") ? ["DeletionMark"] : []),
      ],
    },
    20,
    20,
  );
  const live = (rows as ODataEntity[]).filter((r) => r["DeletionMark"] !== true);
  const exact = live.filter((r) => key(String(r[name] ?? "")) === key(text));
  const pick = exact.length === 1 ? exact : live.length === 1 ? live : exact.length ? exact : live;
  if (pick.length === 1) return String(pick[0]!["Ref_Key"]);
  if (!pick.length)
    throw new InputError(`${where}: «${text}» не найден в ${set}. Передайте guid или точное название.`);
  throw new InputError(
    `${where}: под «${text}» подходит несколько: ${pick
      .slice(0, 8)
      .map((r) => `${String(r[name])} (${String(r["Ref_Key"])})`)
      .join("; ")}. Передайте guid.`,
  );
}

/** Одно поле: понятное имя → реквизит 1С, значение-ссылка → guid (с _Type у составного поля). */
async function field(
  conn: Connection,
  em: EntityMeta,
  name: string,
  value: Loose,
  where: string,
  out: Record<string, Scalar>,
  dict: Readonly<Record<string, string>>,
  ctx: { counterparty?: string },
): Promise<void> {
  const base = dict[name] ?? name;
  const props = new Set(em.properties.map((p) => p.name));
  if (base === "КодНазначенияПлатежа") {
    out[base] = value && typeof value === "object" ? String(value.code ?? "") : (value as Scalar);
    return;
  }
  const refField = props.has(`${base}_Key`) ? `${base}_Key` : props.has(`${base}_Type`) ? base : undefined;
  if (!refField) {
    if (value && typeof value === "object")
      throw new InputError(`${where}: ${name} — не ссылка, передайте значение, а не объект.`);
    out[base] = value as Scalar;
    return;
  }
  if (value === null || value === "") {
    out[refField] = null;
    return;
  }
  const obj = typeof value === "object" ? value : undefined;
  const text = obj ? (obj.guid ?? obj.name ?? obj.code ?? "") : String(value);
  const target = targetOf(em, base, obj?.type);
  let guid: string;
  if (GUID_RE.test(text)) guid = norm(text);
  else {
    if (!target) throw new InputError(`${where}: для ${name} не известен справочник — передайте guid.`);
    guid = norm(
      await findRef(
        conn,
        target,
        text,
        `${where}, ${name}`,
        base === "ДоговорКонтрагента" ? ctx.counterparty : undefined,
      ),
    );
  }
  out[refField] = guid;
  if (refField === base && target) out[`${base}_Type`] = `StandardODATA.${target}`; // составное поле
  if (base === "Контрагент") ctx.counterparty = guid;
}

/** Шапка и табличные части в понятных полях → реквизиты 1С для prepareDocument/prepareDocumentPatch. */
export async function fromReadable(
  conn: Connection,
  em: EntityMeta,
  fields: Record<string, Loose>,
  tables: Record<string, Array<Record<string, Loose>>>,
): Promise<{ fields: Record<string, Scalar>; tables: Record<string, Array<Record<string, Scalar>>> }> {
  const meta = await conn.getMetadata();
  const ctx: { counterparty?: string } = {};
  const header: Record<string, Scalar> = {};
  // контрагент — первым: договор ищется среди договоров этого контрагента
  const order = Object.entries(fields).sort(
    ([a], [b]) => Number(HEADER_FROM[b] === "Контрагент") - Number(HEADER_FROM[a] === "Контрагент"),
  );
  for (const [name, value] of order)
    await field(conn, em, name, value, em.entitySet, header, HEADER_FROM, ctx);
  const outTables: Record<string, Array<Record<string, Scalar>>> = {};
  for (const [tname, rows] of Object.entries(tables)) {
    const ru = TABLES_FROM[tname] ?? tname;
    const type = em.properties.find((p) => p.name === ru)?.type ?? "";
    const rowSet = /^Collection\(StandardODATA\.(.+)_RowType\)$/.exec(type)?.[1] ?? `${em.entitySet}_${ru}`;
    const rm = (meta.entities.get(rowSet) as EntityMeta | undefined) ?? { entitySet: rowSet, properties: [] };
    outTables[ru] = [];
    for (const [i, row] of rows.entries()) {
      const r: Record<string, Scalar> = {};
      for (const [name, value] of Object.entries(row)) {
        if (name === "line_number") continue; // номер строки проставляется сам
        await field(conn, rm, name, value, `${ru}, строка ${i + 1}`, r, ROW_FROM, ctx);
      }
      outTables[ru].push(r);
    }
  }
  return { fields: header, tables: outTables };
}
