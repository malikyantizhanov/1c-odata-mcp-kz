import type { Connection } from "../context.js";
import { CATALOGS } from "../config/mapping.js";
import type { ODataEntity } from "../types/odata.js";
import { nameScore, normalizeName } from "./fuzzy.js";
import { ownerFilter, sameOwner } from "./owner.js";
import { fetchAll } from "./pagination.js";
import { and, cmp, odataGuid } from "./query.js";

/**
 * Договоры контрагента: чтение по владельцу (Owner_Key или составной Owner) и сопоставление того, что написал
 * пользователь/агент («Без договора», «б/н», «№ 12», часть названия), с договорами в базе. «Без договора» в базе РК —
 * обычно «Договор б/н»: договор без номера. Общий путь для quick_invoice, quick_sale, сверки и документов write.*.
 */

const EMPTY = "00000000-0000-0000-0000-000000000000";
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const guidOf = (s: string): string => s.trim().replace(/[{}']/g, "").toLowerCase();

/** Поля договора, которые нужны для выбора и вариантов в сообщениях. */
export const CONTRACT_SELECT = [
  "Ref_Key",
  "Description",
  "НомерДоговора",
  "ДатаДоговора",
  "ВидДоговора",
  "Организация_Key",
  "ДатаНачалаДействияДоговора",
  "ДатаОкончанияДействияДоговора",
  "IsFolder",
  "DeletionMark",
];

/** Запрос «без договора / без номера / б/н» — договор без номера. */
export function isNoNumberQuery(q: string): boolean {
  const t = q
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'№.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(договор )?(без договора|без номера|б\/н|б н|бн|n\/a|нет|-)$/.test(t) || t === "без договора";
}

/** Договор без номера: номер пуст или «б/н», либо «б/н»/«без номера» в наименовании. */
export function isNoNumberContract(r: ODataEntity): boolean {
  const num = str(r["НомерДоговора"]).toLowerCase();
  if (!num || /^(б\/н|бн|б\.н\.?|без номера|-)$/.test(num)) return true;
  return /(^|\s)(б\/н|без номера|без договора)(\s|$)/i.test(str(r["Description"]));
}

/**
 * Договоры из items, подходящие под запрос q: Ref_Key, точное наименование или номер («№ 12» = «12»), вхождение,
 * «без договора»/«б/н» — договоры без номера, затем похожее написание (score ≥ 0.85).
 */
export function matchContracts(items: ODataEntity[], q: string): ODataEntity[] {
  const text = q.trim();
  if (!text) return [];
  if (GUID_RE.test(text)) return items.filter((r) => guidOf(str(r["Ref_Key"])) === guidOf(text));
  const n = (s: string) => normalizeName(s);
  const bare = text.replace(/^(договор\s*)?№\s*/i, "");
  const exact = items.filter(
    (r) =>
      n(str(r["Description"])) === n(text) ||
      (!!str(r["НомерДоговора"]) && n(str(r["НомерДоговора"])) === n(bare)),
  );
  if (exact.length) return exact;
  if (isNoNumberQuery(text)) return items.filter(isNoNumberContract);
  const inside = items.filter((r) => n(str(r["Description"])).includes(n(text)));
  if (inside.length) return inside;
  return items.filter((r) => nameScore(text, str(r["Description"])) >= 0.85);
}

/** Договор действует на дату (пустые даты начала/окончания — без ограничения). */
export function contractActiveOn(r: ODataEntity, date: string | undefined): boolean {
  if (!date) return true;
  const from = str(r["ДатаНачалаДействияДоговора"]).slice(0, 10);
  const to = str(r["ДатаОкончанияДействияДоговора"]).slice(0, 10);
  const set = (d: string) => d && !d.startsWith("0001");
  return (!set(from) || from <= date) && (!set(to) || to >= date);
}

/** Строка варианта договора для сообщений: «Договор б/н» (ref …, СПокупателем). */
export const contractOption = (r: ODataEntity): string =>
  `«${str(r["Description"])}» (ref ${str(r["Ref_Key"])}${str(r["ВидДоговора"]) ? `, ${str(r["ВидДоговора"])}` : ""})`;

/**
 * Договоры контрагента (не группы, не помеченные на удаление); org — только этой организации. Владелец — через
 * ownerFilter: Owner_Key или составной Owner (cast на Catalog_Контрагенты). Нет справочника — пустой список.
 */
export async function counterpartyContracts(
  conn: Connection,
  counterparty: string,
  org?: string | undefined,
  set?: string | undefined,
): Promise<ODataEntity[]> {
  const available = await conn.available();
  const contracts = set ?? CATALOGS.contracts.find((c) => available.has(c));
  if (!contracts) return [];
  const props = new Set(
    ((await conn.getMetadata()).entities.get(contracts)?.properties ?? []).map((p) => p.name),
  );
  const owner = await ownerFilter(conn, contracts, counterparty, "Catalog_Контрагенты");
  const select = CONTRACT_SELECT.filter((f) => props.size === 0 || props.has(f));
  const { rows } = await fetchAll(
    conn.client,
    contracts,
    {
      filter:
        and(
          owner?.filter,
          org && props.has("Организация_Key") ? cmp("Организация_Key", "eq", odataGuid(org)) : undefined,
          props.has("DeletionMark") ? cmp("DeletionMark", "eq", "false") : undefined,
        ) || undefined,
      select: [...select, ...(owner?.clientField ? [owner.clientField] : [])],
    },
    50,
    owner?.clientField ? conn.behavior.maxRows : 100,
  );
  return rows.filter(
    (r) =>
      r["IsFolder"] !== true &&
      (!owner?.clientField || sameOwner(r[owner.clientField], counterparty)) &&
      str(r["Ref_Key"]) !== EMPTY,
  );
}

/** Договор выбран сам из нескольких подходящих — структурное поле плана: карточка показывает «можно сменить». */
export interface ContractAutoSelected {
  ref: string;
  name: string;
  reason: string;
  alternatives: Array<{ ref: string; name: string }>;
}

const KIND_TEXT: Record<string, string> = { СПокупателем: "С покупателем", СПоставщиком: "С поставщиком" };

/**
 * Наиболее вероятный договор из подходящих (уже отобранных по организации, виду, сроку): основной договор
 * контрагента (ОсновнойДоговорКонтрагента_Key), иначе последний по дате (ДатаДоговора, затем начало действия).
 * Пустой список — undefined.
 */
export function pickLikelyContract(
  candidates: ODataEntity[],
  kind: string,
  mainContract?: string | undefined,
): { row: ODataEntity; auto: ContractAutoSelected; note: string } | undefined {
  if (!candidates.length) return undefined;
  const main = mainContract ? guidOf(mainContract) : "";
  const byMain = main ? candidates.find((r) => guidOf(str(r["Ref_Key"])) === main) : undefined;
  const dateOf = (r: ODataEntity) =>
    [str(r["ДатаДоговора"]), str(r["ДатаНачалаДействияДоговора"])].find((d) => d && !d.startsWith("0001")) ??
    "";
  const row = byMain ?? [...candidates].sort((a, b) => dateOf(b).localeCompare(dateOf(a)))[0]!;
  const kindText = KIND_TEXT[kind] ?? kind;
  const reason = byMain
    ? "основной договор"
    : candidates.length === 1
      ? `единственный договор вида «${kindText}»`
      : `последний договор вида «${kindText}»`;
  const name = str(row["Description"]);
  const auto: ContractAutoSelected = {
    ref: str(row["Ref_Key"]),
    name,
    reason,
    alternatives: candidates
      .filter((r) => r !== row)
      .slice(0, 10)
      .map((r) => ({ ref: str(r["Ref_Key"]), name: str(r["Description"]) })),
  };
  const note =
    `Выбран ${reason} «${name}» (ref ${auto.ref})` +
    (auto.alternatives.length
      ? ` — можно сменить: ${auto.alternatives.map((a) => `«${a.name}» (ref ${a.ref})`).join("; ")}.`
      : ".");
  return { row, auto, note };
}
