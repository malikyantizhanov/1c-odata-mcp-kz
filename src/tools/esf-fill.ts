import { z } from "zod";
import type { Connection } from "../context.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { and, buildQuery, cmp, odataGuid, odataString } from "../odata/query.js";
import type { ODataEntity } from "../types/odata.js";

/**
 * Заполнение ЭСФ (Document_ЭСФ) так, как это делает форма 1С:Бухгалтерии для Казахстана, но через OData:
 *  • номер документа («Номер учётной системы», строка 1.1 ЭСФ) — следующий по нумератору ЭСФ;
 *  • реквизиты поставщика и получателя из карточек (адрес из регистра «Контактная информация», БИН/ИИН,
 *    свидетельство НДС, банковские реквизиты, КБе, код страны, резидентство, госучреждение);
 *  • грузоотправитель/грузополучатель и условия поставки из счёта-фактуры.
 * Регистрационный номер ИС ЭСФ не заполняется никогда — его присваивает ИС при регистрации.
 */

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const guidOf = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const realDate = (v: unknown) => (str(v).slice(0, 10) && !str(v).startsWith("0001") ? str(v) : undefined);
const typeOf = (t: unknown) => String(t ?? "").replace(/^StandardODATA\./, "");

export const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== null));

/** Общий контекст заполнения: предупреждения, кэш видов контактной информации. */
export interface FillCtx {
  warnings: string[];
  checks: string[];
  kinds?: Map<string, string>;
  contactRegister?: "ok" | "missing" | "error";
}

async function getOptional(
  conn: Connection,
  set: string,
  ref: unknown,
  select?: string[],
): Promise<ODataEntity | undefined> {
  if (!isRef(ref) || !(await conn.available()).has(set)) return undefined;
  try {
    return await conn.client.getEntity(`${set}(guid'${guidOf(ref)}')${buildQuery(select ? { select } : {})}`);
  } catch {
    return undefined;
  }
}

// ───────────────────────────── Номер ЭСФ ─────────────────────────────

/** Номер документа 1С: префикс (всё до последней группы цифр) + числовая часть; ширина — длина номера. */
export function splitNumber(n: unknown): { prefix: string; value: number; width: number } | undefined {
  const s = str(n);
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return undefined;
  return { prefix: m[1]!, value: Number(m[2]), width: s.length };
}

/** Как 1С: префикс + числовая часть, дополненная нулями до прежней длины номера. */
export function formatNumber(prefix: string, value: number, width: number): string {
  const digits = Math.max(width - prefix.length, String(value).length);
  return prefix + String(value).padStart(digits, "0");
}

/**
 * Следующий номер по существующим номерам: формат (префикс и длина) — самый частый среди образцов,
 * значение — максимум числовой части с этим префиксом + 1.
 */
export function nextNumber(
  existing: string[],
  fallback: { prefix: string; width: number },
): { number: string; prefix: string; width: number; max: number } {
  const parsed = existing.map(splitNumber).filter((x): x is NonNullable<typeof x> => !!x);
  const freq = new Map<string, number>();
  for (const p of parsed)
    freq.set(`${p.prefix}\u0000${p.width}`, (freq.get(`${p.prefix}\u0000${p.width}`) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const [prefix, width] = top
    ? [top.split("\u0000")[0]!, Number(top.split("\u0000")[1])]
    : [fallback.prefix, fallback.width];
  const max = parsed.filter((p) => p.prefix === prefix).reduce((m, p) => Math.max(m, p.value), 0);
  return { number: formatNumber(prefix, max + 1, width), prefix, width, max };
}

const yearBounds = (date: string) => {
  const y = date.slice(0, 4);
  return and(
    cmp("Date", "ge", `datetime'${y}-01-01T00:00:00'`),
    cmp("Date", "le", `datetime'${y}-12-31T23:59:59'`),
  );
};

export interface PlannedNumber {
  number: string;
  /** Откуда взят формат и с какого номера продолжили — для предпросмотра. */
  how: string;
}

/** Номер ЭСФ, заданный вручную: цифры, допускается префикс без пробелов (ИС ЭСФ получает номер без префикса). */
export const esfNumberField = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^\S*\d$/, "Номер ЭСФ — цифры (допускается префикс без пробелов), например 00000000012");

/**
 * Следующий номер ЭСФ, как его ставит форма 1С. Сверено с боевой базой: у исходящих ЭСФ, созданных в 1С, своя
 * последовательность (00000000001, 00000000002 …), а входящие несут номер учётной системы поставщика из ИС ЭСФ
 * (00000000569 …) и в нумерацию исходящих не входят. Поэтому номер — максимум среди ИСХОДЯЩИХ ЭСФ этой
 * организации за год + 1 (периодичность «в пределах года» — типовая для документов БП; если база доработана —
 * проверьте в конфигураторе). Формат — префикс и длина как у этих ЭСФ; если в году их ещё нет — как у последнего
 * исходящего ЭСФ организации, затем любого ЭСФ, затем счёта-фактуры выданного, иначе 11 цифр без префикса.
 * Префикс 1С при отправке в ИС ЭСФ отбрасывает («Представление номеров документов без префикса и без нулей»).
 */
export async function planEsfNumber(
  conn: Connection,
  set: string,
  date: string,
  orgRef: string,
): Promise<PlannedNumber> {
  const own = and(
    cmp("Направление", "eq", odataString("Исходящий")),
    cmp("Организация_Key", "eq", odataGuid(guidOf(orgRef))),
  );
  const inYear = await conn.client.getCollection<ODataEntity>(
    `${set}${buildQuery({ select: ["Number", "Date"], filter: and(own, yearBounds(date)), orderby: "Number desc", top: 200 })}`,
  );
  const numbers = (inYear.value ?? []).map((r) => str(r["Number"])).filter(Boolean);
  if (numbers.length) {
    const n = nextNumber(numbers, { prefix: "", width: 11 });
    return {
      number: n.number,
      how: `следующий после ${formatNumber(n.prefix, n.max, n.width)} среди исходящих ЭСФ организации за ${date.slice(0, 4)} год (префикс «${n.prefix}», ${n.width} знаков)`,
    };
  }
  const sample = async (s: string, filter?: string) => {
    if (!(await conn.available()).has(s)) return undefined;
    const r = await conn.client.getCollection<ODataEntity>(
      `${s}${buildQuery({ select: ["Number", "Date"], ...(filter ? { filter } : {}), orderby: "Date desc", top: 20 })}`,
    );
    return (r.value ?? []).map((x) => splitNumber(x["Number"])).find(Boolean);
  };
  const fromOwn = await sample(set, own);
  const fromEsf = fromOwn ? undefined : await sample(set);
  const fromInvoice = fromOwn || fromEsf ? undefined : await sample("Document_СчетФактураВыданный");
  const fmt = fromOwn ?? fromEsf ?? fromInvoice ?? { prefix: "", width: 11 };
  return {
    number: formatNumber(fmt.prefix, 1, fmt.width),
    how:
      `первый исходящий ЭСФ организации за ${date.slice(0, 4)} год; формат — ` +
      (fromOwn
        ? "как у прошлых исходящих ЭСФ организации"
        : fromEsf
          ? "как у ЭСФ базы"
          : fromInvoice
            ? "как у счетов-фактур выданных (ЭСФ в базе ещё нет)"
            : "11 цифр без префикса (в базе нет ни ЭСФ, ни счетов-фактур)"),
  };
}

/**
 * Дубль номера: тот же номер у другого исходящего ЭСФ этой организации в том же году — отказ (ИС ЭСФ к тому же
 * отклоняет «номер + дата», не уникальные в пределах дня). Входящие ЭСФ несут номер поставщика — с ними
 * совпадение не мешает. Тот же номер в другом году — предупреждение.
 */
export async function checkEsfNumber(
  conn: Connection,
  set: string,
  number: string,
  date: string,
  orgRef: string,
  selfRef?: string,
): Promise<{ refuse?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(
        cmp("Number", "eq", odataString(number)),
        cmp("Направление", "eq", odataString("Исходящий")),
        cmp("Организация_Key", "eq", odataGuid(guidOf(orgRef))),
      ),
      select: ["Ref_Key", "Number", "Date", "DeletionMark"],
    },
    50,
    200,
  );
  const others = rows.filter((r) => !selfRef || guidOf(str(r["Ref_Key"])) !== guidOf(selfRef));
  const sameYear = others.filter((r) => str(r["Date"]).slice(0, 4) === date.slice(0, 4));
  if (sameYear.length)
    return {
      refuse: `Номер ${number} уже занят исходящим ЭСФ организации в ${date.slice(0, 4)} году: ${sameYear
        .map(
          (r) =>
            `ЭСФ от ${str(r["Date"]).slice(0, 10)}${r["DeletionMark"] === true ? " (помечен на удаление)" : ""}, Ref_Key ${str(r["Ref_Key"])}`,
        )
        .join("; ")}. Укажите другой номер.`,
      warnings,
    };
  if (others.length)
    warnings.push(
      `Номер ${number} уже был у исходящего ЭСФ в другом году (${others.map((r) => str(r["Date"]).slice(0, 10)).join(", ")}) — при годовой нумерации это допустимо.`,
    );
  return { warnings };
}

// ───────────────────────── Контактная информация ─────────────────────────

const CONTACT_REGISTER = "InformationRegister_КонтактнаяИнформация";
const CONTACT_KINDS = "Catalog_ВидыКонтактнойИнформации";

async function kindNames(conn: Connection, ctx: FillCtx): Promise<Map<string, string>> {
  if (ctx.kinds) return ctx.kinds;
  ctx.kinds = new Map();
  if (!(await conn.available()).has(CONTACT_KINDS)) return ctx.kinds;
  try {
    const r = await conn.client.getCollection<ODataEntity>(
      `${CONTACT_KINDS}${buildQuery({ select: ["Ref_Key", "PredefinedDataName", "Description"] })}`,
    );
    for (const k of r.value ?? [])
      ctx.kinds.set(guidOf(str(k["Ref_Key"])), str(k["PredefinedDataName"]) || str(k["Description"]));
  } catch {
    /* без имён видов адрес всё равно возьмём — по первому адресу объекта */
  }
  return ctx.kinds;
}

/**
 * Адрес объекта из регистра «Контактная информация» (БП для Казахстана хранит адреса там, а не в табличной
 * части справочника). Отбор по составному полю Объект — через cast(guid'…', 'Catalog_…'): так 1С отбирает
 * (простое «Объект eq guid» 1С не принимает). Вид — по имени предопределённого элемента в порядке kinds.
 */
export async function addressOf(
  conn: Connection,
  objectSet: string,
  objectRef: unknown,
  kinds: string[],
  ctx: FillCtx,
): Promise<{ address: string; kind: string } | undefined> {
  if (!isRef(objectRef)) return undefined;
  if (ctx.contactRegister === "missing" || ctx.contactRegister === "error") return undefined;
  if (!(await conn.available()).has(CONTACT_REGISTER)) {
    ctx.contactRegister = "missing";
    ctx.warnings.push(
      "Регистр «Контактная информация» не опубликован в OData — адреса из карточек не подставлены. Добавьте его в «Состав OData».",
    );
    return undefined;
  }
  let rows: ODataEntity[];
  try {
    rows =
      (
        await conn.client.getCollection<ODataEntity>(
          `${CONTACT_REGISTER}${buildQuery({
            select: ["Вид", "Вид_Type", "Тип", "Представление", "ЗначениеПоУмолчанию"],
            filter: and(
              `Объект eq cast(${odataGuid(guidOf(objectRef))}, '${objectSet}')`,
              cmp("Тип", "eq", odataString("Адрес")),
            ),
          })}`,
        )
      ).value ?? [];
    ctx.contactRegister = "ok";
  } catch (e) {
    ctx.contactRegister = "error";
    ctx.warnings.push(
      `Не удалось прочитать регистр «Контактная информация» (${e instanceof ODataError ? e.kind : "ошибка"}) — адреса не подставлены, заполните их в 1С.`,
    );
    return undefined;
  }
  const names = await kindNames(conn, ctx);
  const withKind = rows
    .filter((r) => str(r["Представление"]))
    .map((r) => ({ r, kind: names.get(guidOf(str(r["Вид"]))) ?? "" }));
  for (const k of kinds) {
    const hit = withKind
      .filter((x) => x.kind === k)
      .sort(
        (a, b) => Number(b.r["ЗначениеПоУмолчанию"] === true) - Number(a.r["ЗначениеПоУмолчанию"] === true),
      )[0];
    if (hit) return { address: str(hit.r["Представление"]), kind: k };
  }
  return undefined;
}

async function countryOf(
  conn: Connection,
  ref: unknown,
): Promise<{ alpha2: string; name: string } | undefined> {
  const c = await getOptional(conn, "Catalog_КлассификаторСтранМира", ref, [
    "КодАльфа2",
    "Description",
    "Code",
  ]);
  if (!c) return undefined;
  return { alpha2: str(c["КодАльфа2"]).toUpperCase(), name: str(c["Description"]) };
}

// ───────────────────────────── Стороны ─────────────────────────────

export interface EsfParty {
  ref: string;
  type: string;
  bin: string;
  name: string;
  vatSeries: string;
  vatNumber: string;
  vatDate?: string | undefined;
  kbe: string;
  address?: string | undefined;
  addressKind?: string | undefined;
  country?: string | undefined;
  nonResident: boolean;
  gov: boolean;
  individual: boolean;
  mainBankAccount?: string | undefined;
}

const ORG_ADDRESS = ["ЮрАдресОрганизации", "ФактАдресОрганизации", "АдресОрганизацииПочтовый"];
const CP_ADDRESS = ["ЮрАдресКонтрагента", "ФактАдресКонтрагента"];
const PERSON_ADDRESS = ["ЮрАдресФизЛица", "ФактАдресФизЛица"];
const KIND_TEXT: Record<string, string> = {
  ЮрАдресОрганизации: "юридический адрес организации",
  ФактАдресОрганизации: "фактический адрес организации",
  АдресОрганизацииПочтовый: "почтовый адрес организации",
  ЮрАдресКонтрагента: "юридический адрес контрагента",
  ФактАдресКонтрагента: "фактический адрес контрагента",
  ЮрАдресФизЛица: "адрес по прописке ИП",
  ФактАдресФизЛица: "адрес проживания ИП",
};
export const kindText = (k: string | undefined) => (k ? (KIND_TEXT[k] ?? k) : "");

/** Поставщик — организация: реквизиты карточки и адрес (юр. → факт. → почтовый; у ИП — адрес физлица). */
export async function supplierParty(conn: Connection, ref: string, ctx: FillCtx): Promise<EsfParty> {
  const o = await conn.client.getEntity<ODataEntity>(
    `Catalog_Организации(guid'${guidOf(ref)}')?$format=json`,
  );
  let addr = await addressOf(conn, "Catalog_Организации", ref, ORG_ADDRESS, ctx);
  if (!addr && isRef(o["ИндивидуальныйПредприниматель_Key"]))
    addr = await addressOf(
      conn,
      "Catalog_ФизическиеЛица",
      o["ИндивидуальныйПредприниматель_Key"],
      PERSON_ADDRESS,
      ctx,
    );
  const country = await countryOf(conn, o["СтранаРегистрации_Key"]);
  const foreign = o["ИностраннаяОрганизация"] === true;
  return {
    ref: guidOf(ref),
    type: "StandardODATA.Catalog_Организации",
    bin: str(o["ИдентификационныйНомер"]),
    name: str(o["НаименованиеПолное"]) || str(o["Description"]),
    vatSeries: str(o["СерияСвидетельстваПоНДС"]),
    vatNumber: str(o["НомерСвидетельстваПоНДС"]),
    vatDate: realDate(o["ДатаПостановкиНаУчетПоНДС"]),
    kbe: str(o["КБЕ"]),
    address: addr?.address,
    addressKind: addr?.kind,
    country: country?.alpha2 || (foreign ? undefined : "KZ"),
    nonResident: foreign || (!!country?.alpha2 && country.alpha2 !== "KZ"),
    gov: false,
    individual: false,
    mainBankAccount: isRef(o["ОсновнойБанковскийСчет_Key"])
      ? String(o["ОсновнойБанковскийСчет_Key"])
      : undefined,
  };
}

/** Получатель — контрагент: БИН/ИИН, наименование, свидетельство НДС, адрес (юр. → факт.), страна, признаки. */
export async function buyerParty(conn: Connection, ref: string, ctx: FillCtx): Promise<EsfParty> {
  const c = await conn.client.getEntity<ODataEntity>(
    `Catalog_Контрагенты(guid'${guidOf(ref)}')?$format=json`,
  );
  const addr = await addressOf(conn, "Catalog_Контрагенты", ref, CP_ADDRESS, ctx);
  const country = await countryOf(conn, c["СтранаРезидентства_Key"]);
  const bin = str(c["ИдентификационныйКодЛичности"]);
  const kzBin = /^\d{12}$/.test(bin) && !/^0+$/.test(bin);
  return {
    ref: guidOf(ref),
    type: "StandardODATA.Catalog_Контрагенты",
    bin,
    name: str(c["НаименованиеПолное"]) || str(c["Description"]),
    vatSeries: str(c["СерияСвидетельстваПоНДС"]),
    vatNumber: str(c["НомерСвидетельстваПоНДС"]),
    kbe: str(c["КБЕ"]),
    address: addr?.address,
    addressKind: addr?.kind,
    country: country?.alpha2 || (kzBin ? "KZ" : undefined),
    nonResident: !!country?.alpha2 && country.alpha2 !== "KZ",
    gov: c["ГосударственноеУчреждение"] === true,
    individual:
      str(c["ЮрФизЛицо"]) === "ФизЛицо" && c["ИндивидуальныйПредпринимательАдвокатЧастныйНотариус"] !== true,
    mainBankAccount: isRef(c["ОсновнойБанковскийСчет_Key"])
      ? String(c["ОсновнойБанковскийСчет_Key"])
      : undefined,
  };
}

/** ИИК/БИК/банк по банковскому счёту. */
export async function bankDetails(conn: Connection, accountRef: unknown) {
  const acc = await getOptional(conn, "Catalog_БанковскиеСчета", accountRef);
  if (!acc) return {};
  const bank = await getOptional(conn, "Catalog_Банки", acc["Банк_Key"]);
  return clean({
    ИИК: str(acc["НомерСчета"]),
    БИК: str(bank?.["БИК"]) || str(bank?.["Code"]),
    НаименованиеБанка: str(bank?.["Description"]),
  });
}

/** Строка «Поставщики» ЭСФ. */
export function supplierRow(p: EsfParty, bank: Record<string, unknown>): Record<string, unknown> {
  return clean({
    LineNumber: 1,
    Поставщик: p.ref,
    Поставщик_Type: p.type,
    ПоставщикИдентификатор: p.bin,
    ПоставщикНаименование: p.name,
    Адрес: p.address,
    СерияСвидетельстваПоНДС: p.vatSeries,
    НомерСвидетельстваПоНДС: p.vatNumber,
    ДатаПостановкиНаРегистрационныйУчетПоНДС: p.vatDate,
    КБе: p.kbe,
    // В ЭСФ, созданных в 1С, код страны поставщика-резидента не заполнен — только у нерезидента.
    КодСтраны: p.nonResident ? p.country : undefined,
    Нерезидент: p.nonResident ? true : undefined,
    ...bank,
  });
}

/** Строка «Получатели» ЭСФ. */
export function recipientRow(p: EsfParty): Record<string, unknown> {
  return clean({
    LineNumber: 1,
    Получатель: p.ref,
    Получатель_Type: p.type,
    ПолучательИдентификатор: p.bin,
    ПолучательНаименование: p.name,
    Адрес: p.address,
    СерияСвидетельстваПоНДС: p.vatSeries,
    НомерСвидетельстваПоНДС: p.vatNumber,
    КодСтраны: p.country,
    Нерезидент: p.nonResident ? true : undefined,
    ГосударственноеУчреждение: p.gov ? true : undefined,
    ФизическоеЛицо: p.individual ? true : undefined,
  });
}

/** Предупреждения о том, чего не хватает в карточках (без этого ИС ЭСФ документ не примет). */
export function partyWarnings(supplier: EsfParty, buyer: EsfParty, ctx: FillCtx): void {
  if (supplier.address) ctx.checks.push(`адрес поставщика: ${kindText(supplier.addressKind)}`);
  else if (ctx.contactRegister === "ok" || ctx.contactRegister === undefined)
    ctx.warnings.push(
      "В карточке организации нет адреса (юридического/фактического, у ИП — адреса физлица) — адрес поставщика не заполнен. Внесите его в карточку организации или передайте supplierAddress.",
    );
  if (buyer.address) ctx.checks.push(`адрес получателя: ${kindText(buyer.addressKind)}`);
  else if (ctx.contactRegister === "ok" || ctx.contactRegister === undefined)
    ctx.warnings.push(
      `В карточке контрагента «${buyer.name}» нет адреса — адрес получателя не заполнен (ИС ЭСФ без него не примет). Внесите адрес в карточку или передайте recipientAddress.`,
    );
  if (buyer.nonResident) ctx.checks.push(`получатель — нерезидент (${buyer.country})`);
  if (!buyer.country)
    ctx.warnings.push(
      `У контрагента «${buyer.name}» не указана страна резидентства и нет БИН/ИИН РК — код страны получателя не заполнен.`,
    );
}

/**
 * Грузоотправитель и грузополучатель (раздел D ЭСФ). Как в ЭСФ, созданных в 1С (сверено с боевой базой, в т.ч. для
 * услуг): из счёта-фактуры — Грузоотправитель (организация/контрагент, пусто = «Он же», т.е. поставщик),
 * Грузополучатель_Key (иначе покупатель); БИН и наименование — как у сторон; адрес отправки — юридический
 * (иначе фактический) адрес грузоотправителя; адрес доставки — АдресДоставки счёта-фактуры или юридический
 * (иначе фактический) адрес грузополучателя; код страны грузополучателя.
 */
export async function consignment(
  conn: Connection,
  inv: ODataEntity,
  supplier: EsfParty,
  buyer: EsfParty,
  ctx: FillCtx,
): Promise<Record<string, unknown>> {
  const shipperType = typeOf(inv["Грузоотправитель_Type"]);
  let shipper: EsfParty = supplier;
  if (isRef(inv["Грузоотправитель"]) && shipperType === "Catalog_Контрагенты")
    shipper = await buyerParty(conn, String(inv["Грузоотправитель"]), ctx);
  else if (
    isRef(inv["Грузоотправитель"]) &&
    shipperType === "Catalog_Организации" &&
    guidOf(String(inv["Грузоотправитель"])) !== supplier.ref
  )
    shipper = await supplierParty(conn, String(inv["Грузоотправитель"]), ctx);
  const consigneeRef = isRef(inv["Грузополучатель_Key"])
    ? guidOf(String(inv["Грузополучатель_Key"]))
    : buyer.ref;
  const consignee = consigneeRef === buyer.ref ? buyer : await buyerParty(conn, consigneeRef, ctx);
  const shipFrom = shipper.type.endsWith("Catalog_Организации")
    ? ((
        await addressOf(
          conn,
          "Catalog_Организации",
          shipper.ref,
          ["ЮрАдресОрганизации", "ФактАдресОрганизации"],
          ctx,
        )
      )?.address ?? shipper.address)
    : ((
        await addressOf(
          conn,
          "Catalog_Контрагенты",
          shipper.ref,
          ["ЮрАдресКонтрагента", "ФактАдресКонтрагента"],
          ctx,
        )
      )?.address ?? shipper.address);
  const deliverTo =
    str(inv["АдресДоставки"]) ||
    (
      await addressOf(
        conn,
        "Catalog_Контрагенты",
        consignee.ref,
        ["ЮрАдресКонтрагента", "ФактАдресКонтрагента"],
        ctx,
      )
    )?.address ||
    consignee.address;
  if (!shipFrom)
    ctx.warnings.push("Адрес отправки (грузоотправитель) не найден в карточке — заполните в 1С.");
  if (!deliverTo)
    ctx.warnings.push(
      "Адрес доставки (грузополучатель) не найден — заполните АдресДоставки в счёте-фактуре или адрес в карточке.",
    );
  return clean({
    Грузоотправитель: shipper.ref,
    Грузоотправитель_Type: shipper.type,
    ГрузоотправительИдентификатор: shipper.bin,
    ГрузоотправительНаименование: shipper.name,
    АдресОтправки: shipFrom,
    Грузополучатель: consignee.ref,
    Грузополучатель_Type: consignee.type,
    ГрузополучательИдентификатор: consignee.bin,
    ГрузополучательНаименование: consignee.name,
    АдресДоставки: deliverTo,
    ГрузополучательКодСтраны: consignee.country,
  });
}

/**
 * Условия поставки, доверенность, реквизиты госучреждения — из счёта-фактуры. ПунктНазначения СФ форма 1С в ЭСФ
 * не переносит (сверено: в СФ заполнен, в ЭСФ пусто) — не переносим и мы.
 */
export async function invoiceExtras(
  conn: Connection,
  inv: ODataEntity,
  buyer: EsfParty,
): Promise<Record<string, unknown>> {
  const govBank = buyer.gov
    ? await bankDetails(
        conn,
        isRef(inv["СчетКонтрагента_Key"]) ? inv["СчетКонтрагента_Key"] : buyer.mainBankAccount,
      )
    : {};
  return clean({
    ДоговорПоставкиУсловияОплаты: str(inv["УсловияОплаты"]),
    ДоговорПоставкиСпособОтправления: str(inv["СпособОтправления"]),
    СпособОтправленияПоКлассификатору: str(inv["СпособОтправленияПоКлассификатору"]),
    ДоговорПоставкиУсловияПоставки: str(inv["УсловияПоставки"]),
    ДоверенностьНаПоставкуНомер: str(inv["ДоверенностьНомер"]),
    ДоверенностьНаПоставкуДата: realDate(inv["ДоверенностьДата"]),
    ГосучреждениеКодТоваров: buyer.gov ? str(inv["ГосучреждениеКодТоваров"]) : undefined,
    ГосучреждениеНазначениеПлатежа: buyer.gov ? str(inv["ГосучреждениеНазначениеПлатежа"]) : undefined,
    ГосучреждениеИИК: govBank["ИИК"],
    ГосучреждениеБИК: govBank["БИК"],
  });
}

/** Адрес для ЭСФ: ИС ЭСФ требует от 3 до 400 символов (текст ошибки ИС). */
export function addressProblem(label: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.length < 3 || t.length > 400)
    return `${label}: адрес должен быть от 3 до 400 символов (сейчас ${t.length}).`;
  return undefined;
}

/**
 * Реквизиты шапки, которые форма 1С ставит по умолчанию (сверено с ЭСФ, созданными в 1С): ТипПодписи
 * «ЮридическоеЛицо», СпособРасчета «Безналичный», и курс 1 для ЭСФ в тенге — даже если у счёта-фактуры курс
 * взаиморасчётов по валютному договору (в 1С: ВалютаКод KZT, КурсВалюты 1).
 */
export function headerDefaults(currencyCode: string | undefined, rate: number): Record<string, unknown> {
  const kzt = !currencyCode || currencyCode.toUpperCase() === "KZT" || currencyCode === "398";
  return {
    ТипПодписи: "ЮридическоеЛицо",
    СпособРасчета: "Безналичный",
    КурсВалюты: kzt ? 1 : rate || 1,
  };
}
