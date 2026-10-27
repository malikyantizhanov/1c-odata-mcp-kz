import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { buildQuery, cmp } from "../odata/query.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard } from "./_shared.js";
import { confirmField, createOrPreview, odataDate } from "./write.js";
import {
  bankDetails,
  buyerParty,
  checkEsfNumber,
  clean,
  consignment,
  headerDefaults,
  invoiceExtras,
  partyWarnings,
  planEsfNumber,
  esfNumberField,
  recipientRow,
  supplierParty,
  supplierRow,
  type FillCtx,
} from "./esf-fill.js";

/**
 * Черновики исходящих ЭСФ и ЭАВР по документу-основанию. Через OData нельзя ни подписать, ни отправить
 * документ в ИС ЭСФ (в $metadata только Post/Unpost): инструмент создаёт НЕпроведённый черновик с данными
 * основания, а проверка, подписание ЭЦП и отправка — в 1С (модуль «ЭСФ»/«ЭАВР»). Поля обмена с ИС
 * (Идентификатор, РегистрационныйНомер, Состояние, ЭЦП, Причина, подписи) не заполняются никогда; Статус — только
 * «Черновик» при создании (как в форме 1С).
 */

const ESF = "Document_ЭСФ";
const AVR = "Document_ЭлектронныйАктВыполненныхРабот";
const INVOICE_OUT = "Document_СчетФактураВыданный";
const SALE = "Document_РеализацияТоваровУслуг";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const typeOf = (t: unknown) => String(t ?? "").replace(/^StandardODATA\./, "");
const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const day = (v: unknown) => str(v).slice(0, 10);
const realDate = (v: unknown) => (day(v) && !day(v).startsWith("0001") ? str(v) : undefined);
const fmt = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2 }).replace(/\u00a0/g, " ");
const num = (r: ODataEntity) => str(r["Number"]).replace(/^0+(?=\d)/, "");

/**
 * Статус нового ЭСФ — «Черновик», как у документа, созданного в форме 1С: с пустым статусом бухгалтер не видит
 * ЭСФ в отборе черновиков и не может отправить его из рабочего места ЭСФ. Других полей обмена не пишем.
 */
export const DRAFT_STATUS = "Черновик";

/** Поля обмена с ИС — в черновик не пишем (проверяется перед записью); исключение — Статус «Черновик». */
export const EXCHANGE_FIELDS = new Set([
  "Идентификатор",
  "РегистрационныйНомер",
  "Статус",
  "Состояние",
  "ЭЦП",
  "ЭЦППолучателя",
  "ЭЦПОтправителя",
  "Причина",
  "ФайлЭСФ_Key",
  "ДатаПринятияСтатуса",
  "ДатаПодписи",
  "ДатаПодписиОтправителя",
  "ДатаПодписиПолучателя",
  "УполномоченныйСотрудник",
  "УполномоченныйСотрудникПолучателя",
  "Posted",
]);

async function get(
  conn: Connection,
  set: string,
  ref: string,
  label: string,
  select?: string[],
): Promise<ODataEntity> {
  try {
    return await conn.client.getEntity(`${set}(guid'${guidOf(ref)}')${buildQuery(select ? { select } : {})}`);
  } catch (e) {
    if (e instanceof ODataError && e.kind === "not_found")
      throw new InputError(`${label} ${ref} не найден в базе.`);
    throw e;
  }
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

/** Только поля, которые есть в $metadata объекта (и его табличной части); остальное — в предупреждение. */
export async function fitToMetadata(
  conn: Connection,
  set: string,
  payload: Record<string, unknown>,
  warnings: string[],
): Promise<Record<string, unknown>> {
  const meta = await conn.getMetadata();
  const props = new Set((meta.entities.get(set)?.properties ?? []).map((p) => p.name));
  if (props.size === 0) return payload;
  const dropped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!props.has(k)) {
      dropped.push(k);
      continue;
    }
    if (Array.isArray(v)) {
      const rowProps = new Set((meta.entities.get(`${set}_${k}`)?.properties ?? []).map((p) => p.name));
      out[k] = rowProps.size
        ? v.map((row: Record<string, unknown>) =>
            Object.fromEntries(
              Object.entries(row).filter(([rk]) => {
                if (rowProps.has(rk)) return true;
                dropped.push(`${k}.${rk}`);
                return false;
              }),
            ),
          )
        : v;
    } else out[k] = v;
  }
  if (dropped.length) warnings.push(`В этой базе нет полей ${[...new Set(dropped)].join(", ")} — пропущены.`);
  for (const k of Object.keys(out))
    if (EXCHANGE_FIELDS.has(k) && !(k === "Статус" && out[k] === DRAFT_STATUS))
      throw new Error(`Внутренняя ошибка: поле обмена ${k} в черновике.`);
  return out;
}

interface Line {
  nomenclature?: string | undefined;
  name: string;
  unitRef?: string | undefined;
  unitName: string;
  unitCode: string;
  quantity: number;
  price: number;
  base: number;
  vatRef?: string | undefined;
  vatRate?: number | undefined;
  noVat: boolean;
  vat: number;
  total: number;
  service: boolean;
}

/** Строки «Товары» и «Услуги» документа: наименования, единицы, ставки НДС; суммы без/с НДС. */
async function documentLines(
  conn: Connection,
  doc: ODataEntity,
  includesVat: boolean,
  warnings: string[],
): Promise<Line[]> {
  const parts: Array<[string, boolean]> = [
    ["Товары", false],
    ["Услуги", true],
  ];
  const lines: Line[] = [];
  const nomCache = new Map<string, ODataEntity | undefined>();
  const unitCache = new Map<string, ODataEntity | undefined>();
  const vatCache = new Map<string, ODataEntity | undefined>();
  const cached = async (m: Map<string, ODataEntity | undefined>, set: string, ref: unknown) => {
    if (!isRef(ref)) return undefined;
    if (!m.has(ref)) m.set(ref, await getOptional(conn, set, ref));
    return m.get(ref);
  };
  for (const [part, service] of parts) {
    for (const r of (doc[part] as ODataEntity[] | undefined) ?? []) {
      const nom = await cached(nomCache, "Catalog_Номенклатура", r["Номенклатура_Key"]);
      const unitRef = isRef(r["ЕдиницаИзмерения_Key"])
        ? String(r["ЕдиницаИзмерения_Key"])
        : isRef(nom?.["БазоваяЕдиницаИзмерения_Key"])
          ? String(nom!["БазоваяЕдиницаИзмерения_Key"])
          : undefined;
      const unit = await cached(unitCache, "Catalog_КлассификаторЕдиницИзмерения", unitRef);
      const vatRow = await cached(vatCache, "Catalog_СтавкиНДС", r["СтавкаНДС_Key"]);
      const sum = money(r["Сумма"]);
      const vat = money(r["СуммаНДС"]);
      const base = includesVat ? money(sum - vat) : sum;
      const rate = vatRow && str(vatRow["Ставка"]) !== "" ? Number(vatRow["Ставка"]) : undefined;
      const noVat =
        !vatRow ||
        /без\s*НДС/i.test(str(vatRow["Description"])) ||
        vatRow["ДляОсвобожденногоОборота"] === true;
      const name = str(r["Содержание"]) || str(nom?.["НаименованиеПолное"]) || str(nom?.["Description"]);
      if (!name) warnings.push(`Строка ${lines.length + 1}: нет наименования товара/услуги.`);
      if (!unit)
        warnings.push(`Строка ${lines.length + 1} «${name}»: не найдена единица измерения — заполните в 1С.`);
      lines.push({
        nomenclature: isRef(r["Номенклатура_Key"]) ? String(r["Номенклатура_Key"]) : undefined,
        name,
        unitRef: unit ? unitRef : undefined,
        unitName: str(unit?.["Description"]),
        unitCode: str(unit?.["Code"]),
        quantity: Number(r["Количество"] ?? 0),
        price: Number(r["Цена"] ?? 0),
        base,
        vatRef: isRef(r["СтавкаНДС_Key"]) ? String(r["СтавкаНДС_Key"]) : undefined,
        vatRate: Number.isFinite(rate) && !noVat ? rate : undefined,
        noVat,
        vat,
        total: money(base + vat),
        service: service || nom?.["Услуга"] === true,
      });
    }
  }
  return lines;
}

const docText = (label: string, r: ODataEntity) => `${label} № ${num(r)} от ${day(r["Date"])}`;

async function scanDocs(conn: Connection, set: string, select: string[], warnings: string[], label: string) {
  const { rows, truncated } = await fetchAll(
    conn.client,
    set,
    { filter: cmp("DeletionMark", "eq", "false"), select },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  if (truncated)
    warnings.push(`«${label}» больше лимита строк — проверка на дубль неполная, проверьте вручную в 1С.`);
  return rows;
}

const today = () => {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
};

export function registerEsfCreateTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.esf.create_draft",
    {
      title: "Черновик исходящего ЭСФ по счёту-фактуре / реализации",
      description:
        "Создаёт НЕпроведённый черновик исходящего ЭСФ (Document_ЭСФ, Вид «Обычный») по счёту-фактуре выданному " +
        "(basisRef) или по реализации (берётся её счёт-фактура выданный). Заполняет как форма 1С: номер документа " +
        "(«Номер учётной системы») — следующий по нумератору ЭСФ (префикс и длина как у ЭСФ этого года, проверка дубля; " +
        "свой номер — number), организацию и контрагента, СчетФактура, дату оборота, договор поставки и условия " +
        "(оплата, способ отправления, условия поставки, доверенность, пункт назначения), документ, подтверждающий " +
        "поставку, валюту и курс; поставщика (БИН, наименование, адрес из контактной информации организации — " +
        "юридический → фактический, у ИП — адрес физлица; свидетельство НДС, ИИК/БИК/банк, КБе, код страны) и " +
        "получателя (БИН/ИИН, наименование, адрес контрагента, свидетельство НДС, код страны, нерезидент, " +
        "госучреждение с ИИК/БИК); для товаров — грузоотправителя и грузополучателя с адресами; строки Товары " +
        "(наименование, единица, количество, цена, суммы без НДС/с НДС, ставка и сумма НДС; услугам признак " +
        "происхождения 6). Статус — «Черновик»; регистрационный номер ИС ЭСФ, состояние, ЭЦП не заполняет, не проводит. Отказ, если по " +
        "счёту-фактуре уже есть ЭСФ, номер занят, СФ помечена на удаление, не «Обычный» или выставлена на бумаге. " +
        "Чего нет в карточках — в предупреждениях; поправить черновик до отправки — write.esf.update_draft. " +
        "Подписание и отправка в ИС ЭСФ — только в 1С. Предпросмотр по умолчанию; создание — confirm=true с " +
        "operationId после согласия бухгалтера.",
      inputSchema: {
        database: databaseField,
        basisRef: GUID.describe("Ref_Key счёта-фактуры выданного или реализации товаров и услуг"),
        date: dateField("Дата ЭСФ (по умолчанию — сегодня)").optional(),
        number: esfNumberField
          .optional()
          .describe("Номер ЭСФ вручную (по умолчанию — следующий по нумератору ЭСФ, как в форме 1С)"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, basisRef, date, number, confirm }) =>
      guard("write.esf.create_draft", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [ESF], "Документ «ЭСФ»");
        const invSet = await requireEntity(conn, [INVOICE_OUT], "Документ «Счёт-фактура выданный»");
        const warnings: string[] = [];
        const checks: string[] = [];
        const refuse: string[] = [];
        const available = await conn.available();

        // Счёт-фактура: сама или по реализации.
        let inv: ODataEntity | undefined = await getOptional(conn, invSet, basisRef);
        if (!inv) {
          if (!available.has(SALE)) throw new InputError(`Счёт-фактура выданный ${basisRef} не найден.`);
          const sale = await getOptional(conn, SALE, basisRef, ["Ref_Key", "Number", "Date"]);
          if (!sale) throw new InputError(`${basisRef}: не найден ни счёт-фактура выданный, ни реализация.`);
          const invs = (
            await scanDocs(
              conn,
              invSet,
              ["Ref_Key", "Number", "Date", "ДокументОснование", "ДокументОснование_Type"],
              warnings,
              "Счета-фактуры выданные",
            )
          ).filter(
            (r) => same(r["ДокументОснование"], basisRef) && typeOf(r["ДокументОснование_Type"]) === SALE,
          );
          if (invs.length === 0)
            throw new InputError(
              `По реализации ${docText("", sale).trim()} нет счёта-фактуры выданного. Сначала выпишите счёт-фактуру ` +
                "(write.document.create_document Document_СчетФактураВыданный, СпособВыставления «Электронно») — ЭСФ создаётся по ней.",
            );
          if (invs.length > 1)
            throw new InputError(
              `По реализации несколько счетов-фактур: ${invs.map((r) => docText("СФ", r)).join("; ")}. Укажите нужную в basisRef.`,
            );
          inv = await get(conn, invSet, String(invs[0]!["Ref_Key"]), "Счёт-фактура");
          checks.push(`счёт-фактура найдена по реализации: ${docText("СФ", inv)}`);
        } else checks.push(`счёт-фактура: ${docText("СФ", inv)}`);
        const invRef = guidOf(String(inv["Ref_Key"]));
        if (inv["DeletionMark"] === true) refuse.push("Счёт-фактура помечена на удаление.");
        if (inv["Posted"] !== true)
          warnings.push("Счёт-фактура не проведена — проведите её до отправки ЭСФ.");
        const kind = str(inv["ВидСчетаФактуры"]);
        if (kind && kind !== "Обычный")
          refuse.push(
            `Вид счёта-фактуры «${kind}»: инструмент создаёт только обычный ЭСФ (дополнительный/исправленный — в 1С).`,
          );
        const way = str(inv["СпособВыставления"]);
        if (way && way !== "Электронно")
          refuse.push(`Счёт-фактура выставлена «${way}», не электронно — ЭСФ по ней не создаётся.`);
        const org = isRef(inv["Организация_Key"]) ? String(inv["Организация_Key"]) : undefined;
        const cp = isRef(inv["Контрагент_Key"])
          ? String(inv["Контрагент_Key"])
          : isRef(inv["Покупатель_Key"])
            ? String(inv["Покупатель_Key"])
            : undefined;
        if (!org) refuse.push("В счёте-фактуре не указана организация.");
        if (!cp) refuse.push("В счёте-фактуре не указан контрагент (покупатель).");

        // Дубль: ЭСФ по этой СФ уже есть.
        const dups = (
          await scanDocs(
            conn,
            set,
            ["Ref_Key", "Number", "Date", "СчетФактура", "СчетФактура_Type", "Статус", "Вид"],
            warnings,
            "ЭСФ",
          )
        ).filter((r) => same(r["СчетФактура"], invRef) && typeOf(r["СчетФактура_Type"]) === INVOICE_OUT);
        if (dups.length)
          refuse.push(
            `По счёту-фактуре уже есть ЭСФ: ${dups.map((r) => `${docText("ЭСФ", r)} (${str(r["Статус"]) || "без статуса"}, Ref_Key ${String(r["Ref_Key"])})`).join("; ")}. Дубль не создаём.`,
          );
        else checks.push("по счёту-фактуре ЭСФ ещё нет");
        if (refuse.length)
          throw new InputError(`ЭСФ не создан — проверки не пройдены:\n- ${refuse.join("\n- ")}`);

        // Реализация-основание (документ, подтверждающий поставку; признак «Сумма включает НДС»).
        const basis =
          isRef(inv["ДокументОснование"]) && typeOf(inv["ДокументОснование_Type"]) === SALE
            ? await getOptional(conn, SALE, inv["ДокументОснование"], [
                "Ref_Key",
                "Number",
                "Date",
                "СуммаВключаетНДС",
                "ДоговорКонтрагента_Key",
                "СуммаДокумента",
              ])
            : undefined;
        const includesVat = inv["СуммаВключаетНДС"] === true || basis?.["СуммаВключаетНДС"] === true;
        const fill: FillCtx = { warnings, checks };
        const supplier = await supplierParty(conn, org!, fill);
        const buyer = await buyerParty(conn, cp!, fill);
        if (!supplier.bin) warnings.push("У организации не заполнен БИН — ЭСФ не пройдёт проверку ИС ЭСФ.");
        if ((!buyer.bin || /^0+$/.test(buyer.bin)) && !buyer.nonResident)
          warnings.push(
            `У контрагента «${buyer.name}» не заполнен БИН/ИИН${buyer.bin ? ` (${buyer.bin})` : ""} — ИС ЭСФ такой ЭСФ не примет; для нерезидента укажите страну резидентства в карточке.`,
          );
        partyWarnings(supplier, buyer, fill);
        const bank = await bankDetails(
          conn,
          isRef(inv["СчетОрганизации_Key"]) ? inv["СчетОрганизации_Key"] : supplier.mainBankAccount,
        );
        if (!Object.keys(bank).length)
          warnings.push(
            "Банковский счёт организации не найден (ни в счёте-фактуре, ни основной) — ИИК/БИК заполните в 1С.",
          );
        else if (!isRef(inv["СчетОрганизации_Key"]))
          checks.push("ИИК/БИК — основной банковский счёт организации");
        const contractRef = isRef(inv["ДоговорКонтрагента_Key"])
          ? String(inv["ДоговорКонтрагента_Key"])
          : isRef(basis?.["ДоговорКонтрагента_Key"])
            ? String(basis!["ДоговорКонтрагента_Key"])
            : undefined;
        const contract = await getOptional(conn, "Catalog_ДоговорыКонтрагентов", contractRef);
        const currency = await getOptional(conn, "Catalog_Валюты", inv["ВалютаДокумента_Key"]);
        const lines = await documentLines(conn, inv, includesVat, warnings);
        if (!lines.length)
          throw new InputError("В счёте-фактуре нет строк товаров/услуг — ЭСФ не из чего заполнить.");
        if (lines.some((l) => !l.service))
          warnings.push(
            "Для товаров признак происхождения (1–5) не заполнен — укажите его в 1С перед подписанием.",
          );
        const total = money(lines.reduce((s, l) => s + l.total, 0));
        if (Math.abs(total - money(inv["СуммаДокумента"])) > 0.01)
          warnings.push(
            `Сумма строк ${fmt(total)} не равна сумме счёта-фактуры ${fmt(money(inv["СуммаДокумента"]))}.`,
          );
        else checks.push(`сумма ${fmt(total)} согласуется со счётом-фактурой`);
        const version = (
          await fetchAll(conn.client, set, { select: ["ВерсияБланкаЭСФ"], orderby: "Date desc" }, 1, 1).catch(
            () => ({ rows: [] as ODataEntity[] }),
          )
        ).rows[0]?.["ВерсияБланкаЭСФ"];
        if (version === undefined || version === null || version === "")
          warnings.push(
            "Версия бланка ЭСФ не определена (в базе ещё нет ЭСФ) — проверьте её в 1С при открытии черновика.",
          );

        const esfDate = date ? `${date}T${odataDate(today()).slice(11)}` : odataDate(today());
        let esfNumber = number;
        if (esfNumber) checks.push(`номер ${esfNumber} — задан вручную`);
        else {
          const planned = await planEsfNumber(conn, set, esfDate, org!);
          esfNumber = planned.number;
          checks.push(`номер ${esfNumber}: ${planned.how}`);
        }
        const dupNumber = await checkEsfNumber(conn, set, esfNumber, esfDate, org!);
        if (dupNumber.refuse) throw new InputError(`ЭСФ не создан: ${dupNumber.refuse}`);
        warnings.push(...dupNumber.warnings);
        checks.push(`номер ${esfNumber} не занят другим исходящим ЭСФ организации в этом году`);
        const consign = await consignment(conn, inv, supplier, buyer, fill);
        const extras = await invoiceExtras(conn, inv, buyer);

        const payload = clean({
          Number: esfNumber,
          Date: esfDate,
          Организация_Key: guidOf(org!),
          Контрагент_Key: guidOf(cp!),
          Направление: "Исходящий",
          Вид: "Обычный",
          Статус: DRAFT_STATUS,
          ВерсияБланкаЭСФ: version,
          СчетФактура: invRef,
          СчетФактура_Type: `StandardODATA.${INVOICE_OUT}`,
          ДатаОборота: realDate(inv["ДатаСовершенияОборотаПоРеализации"]) ?? realDate(basis?.["Date"]),
          ДоговорПоставки_Key: contractRef ? guidOf(contractRef) : undefined,
          ДоговорПоставкиНомер: str(contract?.["НомерДоговора"]) || undefined,
          ДоговорПоставкиДата: realDate(contract?.["ДатаДоговора"]),
          ДокументПодтверждающийПоставкуНомер: basis ? num(basis) : undefined,
          ДокументПодтверждающийПоставкуДата: basis
            ? str(basis["Date"]).slice(0, 10) + "T00:00:00"
            : undefined,
          Валюта_Key: isRef(inv["ВалютаДокумента_Key"]) ? String(inv["ВалютаДокумента_Key"]) : undefined,
          ВалютаКод: str(currency?.["Description"]) || undefined,
          ...headerDefaults(
            str(currency?.["Description"]) || undefined,
            Number(inv["КурсВзаиморасчетов"] ?? 1),
          ),
          СуммаДокумента: total,
          ...extras,
          ...consign,
          Поставщики: [supplierRow(supplier, bank)],
          Получатели: [recipientRow(buyer)],
          Товары: lines.map((l, i) =>
            clean({
              LineNumber: i + 1,
              ТоварНаименование: l.name,
              Товар: l.nomenclature,
              Товар_Type: l.nomenclature ? "StandardODATA.Catalog_Номенклатура" : undefined,
              ЕдиницаИзмерения_Key: l.unitRef,
              ЕдиницаИзмеренияНаименование: l.unitName,
              ЕдиницаИзмеренияКод: l.unitCode,
              Количество: l.quantity,
              Цена: l.price,
              СуммаБезНалогов: l.base,
              ОборотПоРеализации: l.base,
              СтавкаНДС_Key: l.vatRef,
              СтавкаНДСЧисло: l.vatRate,
              БезНДС: l.noVat ? true : undefined,
              СуммаНДС: l.vat,
              Сумма: l.total,
              ПризнакПроисхождения: l.service ? "6" : undefined,
              ИдентификаторТовара: String(i + 1),
            }),
          ),
        });
        warnings.push(
          "Черновик не проведён и не отправлен: проверка, подписание ЭЦП и отправка в ИС ЭСФ — только в 1С. " +
            "Поправить номер, адреса, реквизиты или строки до отправки — write.esf.update_draft.",
        );
        const fitted = await fitToMetadata(conn, set, payload, warnings);
        return createOrPreview(conn, set, fitted, confirm, [
          ...checks.map((c) => `Проверено: ${c}`),
          ...warnings,
        ]);
      }),
  );

  server.registerTool(
    "write.avr.create_draft",
    {
      title: "Черновик исходящего ЭАВР по реализации услуг",
      description:
        "Создаёт НЕпроведённый черновик исходящего ЭАВР (Document_ЭлектронныйАктВыполненныхРабот, тип «Первичный») " +
        "по реализации товаров и услуг (basisRef): ДокументОснование, организация, заказчик, договор (номер/дата) или " +
        "«Без договора», валюта и курс, дата выполнения работ, исполнитель (БИН, наименование, свидетельство НДС, " +
        "ИИК/БИК/банк, КБе), заказчик (БИН/ИИН, наименование), строки Услуги (наименование, единица, количество, цена, " +
        "стоимость без/с косвенными налогами, ставка и сумма НДС, размер оборота) и итоги. В ЭАВР идут только услуги " +
        "(строки «Товары» реализации пропускаются с предупреждением). Поля обмена с ИС (рег. номер, статус, ЭЦП, " +
        "подписи) не заполняет, не проводит. Отказ, если по реализации уже есть ЭАВР, она помечена на удаление или в " +
        "ней нет услуг. Подписание и отправка — только в 1С. Предпросмотр по умолчанию; создание — confirm=true с " +
        "operationId после согласия бухгалтера.",
      inputSchema: {
        database: databaseField,
        basisRef: GUID.describe("Ref_Key реализации товаров и услуг"),
        date: dateField("Дата ЭАВР (по умолчанию — сегодня)").optional(),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, basisRef, date, confirm }) =>
      guard("write.avr.create_draft", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [AVR], "Документ «Электронный акт выполненных работ» (ЭАВР)");
        const saleSet = await requireEntity(conn, [SALE], "Документ «Реализация товаров и услуг»");
        const warnings: string[] = [];
        const checks: string[] = [];
        const refuse: string[] = [];
        const sale = await get(conn, saleSet, basisRef, "Реализация");
        checks.push(`основание: ${docText("реализация", sale)}`);
        if (sale["DeletionMark"] === true) refuse.push("Реализация помечена на удаление.");
        if (sale["Posted"] !== true)
          warnings.push("Реализация не проведена — проведите её до отправки ЭАВР.");
        const org = isRef(sale["Организация_Key"]) ? String(sale["Организация_Key"]) : undefined;
        const cp = isRef(sale["Контрагент_Key"]) ? String(sale["Контрагент_Key"]) : undefined;
        if (!org) refuse.push("В реализации не указана организация.");
        if (!cp) refuse.push("В реализации не указан контрагент.");
        const goods = ((sale["Товары"] as ODataEntity[] | undefined) ?? []).length;
        if (goods)
          warnings.push(
            `В реализации ${goods} строк(и) товаров — в ЭАВР не включаются (для товаров — ЭСФ/СНТ).`,
          );
        const services = { ...sale, Товары: [] };
        const includesVat = sale["СуммаВключаетНДС"] === true;
        const lines = await documentLines(conn, services, includesVat, warnings);
        if (!lines.length) refuse.push("В реализации нет строк услуг — ЭАВР не из чего заполнить.");

        const dups = (
          await scanDocs(
            conn,
            set,
            [
              "Ref_Key",
              "Number",
              "Date",
              "ДокументОснование",
              "ДокументОснование_Type",
              "Статус",
              "Направление",
            ],
            warnings,
            "ЭАВР",
          )
        ).filter(
          (r) => same(r["ДокументОснование"], basisRef) && typeOf(r["ДокументОснование_Type"]) === SALE,
        );
        if (dups.length)
          refuse.push(
            `По реализации уже есть ЭАВР: ${dups.map((r) => `${docText("ЭАВР", r)} (${str(r["Статус"]) || "без статуса"}, Ref_Key ${String(r["Ref_Key"])})`).join("; ")}. Дубль не создаём.`,
          );
        else checks.push("по реализации ЭАВР ещё нет");
        if (refuse.length)
          throw new InputError(`ЭАВР не создан — проверки не пройдены:\n- ${refuse.join("\n- ")}`);

        // Адреса в ЭАВР этот инструмент не пишет: контекст заполнения — отдельный, его предупреждения не нужны.
        const avrFill: FillCtx = { warnings: [], checks: [] };
        const supplier = await supplierParty(conn, org!, avrFill);
        const buyer = await buyerParty(conn, cp!, avrFill);
        if (!supplier.bin) warnings.push("У организации не заполнен БИН — ЭАВР не пройдёт проверку ИС.");
        if (!buyer.bin || /^0+$/.test(buyer.bin))
          warnings.push(
            `У контрагента «${buyer.name}» не заполнен БИН/ИИН${buyer.bin ? ` (${buyer.bin})` : ""} — проверьте в 1С.`,
          );
        const bank = await bankDetails(conn, sale["БанковскийСчетОрганизации_Key"]);
        const contractRef = isRef(sale["ДоговорКонтрагента_Key"])
          ? String(sale["ДоговорКонтрагента_Key"])
          : undefined;
        const contract = await getOptional(conn, "Catalog_ДоговорыКонтрагентов", contractRef);
        const currency = await getOptional(conn, "Catalog_Валюты", sale["ВалютаДокумента_Key"]);
        const base = money(lines.reduce((s, l) => s + l.base, 0));
        const vat = money(lines.reduce((s, l) => s + l.vat, 0));
        const total = money(base + vat);
        if (goods === 0 && Math.abs(total - money(sale["СуммаДокумента"])) > 0.01)
          warnings.push(
            `Сумма услуг ${fmt(total)} не равна сумме реализации ${fmt(money(sale["СуммаДокумента"]))}.`,
          );
        else if (goods === 0) checks.push(`сумма ${fmt(total)} согласуется с реализацией`);

        const payload = clean({
          Date: date ? `${date}T${odataDate(today()).slice(11)}` : odataDate(today()),
          Организация_Key: guidOf(org!),
          Направление: "Исходящий",
          ТипАВР: "Первичный",
          ДокументОснование: guidOf(basisRef),
          ДокументОснование_Type: `StandardODATA.${SALE}`,
          Контрагент: guidOf(cp!),
          Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
          ДатаВыполненияРабот: str(sale["Date"]).slice(0, 10) + "T00:00:00",
          БезДоговора: contract ? false : true,
          Договор_Key: contract ? guidOf(contractRef!) : undefined,
          НомерДоговора: str(contract?.["НомерДоговора"]) || undefined,
          ДатаДоговора: realDate(contract?.["ДатаДоговора"]),
          Валюта_Key: isRef(sale["ВалютаДокумента_Key"]) ? String(sale["ВалютаДокумента_Key"]) : undefined,
          КодВалюты: str(currency?.["Description"]) || undefined,
          КурсВалюты: Number(sale["КурсВзаиморасчетов"] ?? 1) || 1,
          ИтогоСтоимостьБезУчетаКосвенныхНалогов: base,
          ИтогоСуммаНДС: vat,
          ИтогоСтоимостьСУчетомКосвенныхНалогов: total,
          ИтогоРазмерОборота: base,
          Поставщики: [
            clean({
              LineNumber: 1,
              Поставщик: supplier.ref,
              Поставщик_Type: supplier.type,
              ПоставщикИдентификатор: supplier.bin,
              ПоставщикНаименование: supplier.name,
              СерияСвидетельстваПоНДС: supplier.vatSeries,
              НомерСвидетельстваПоНДС: supplier.vatNumber,
              КБе: supplier.kbe,
              ТипРегистрации: "ЮридическоеЛицо",
              ...bank,
            }),
          ],
          Получатели: [
            clean({
              LineNumber: 1,
              Получатель: buyer.ref,
              Получатель_Type: buyer.type,
              ПолучательИдентификатор: buyer.bin,
              ПолучательНаименование: buyer.name,
            }),
          ],
          Услуги: lines.map((l, i) =>
            clean({
              LineNumber: i + 1,
              Номенклатура_Key: l.nomenclature,
              УслугаНаименование: l.name,
              ЕдиницаИзмерения_Key: l.unitRef,
              ЕдиницаИзмеренияНаименование: l.unitName,
              ЕдиницаИзмеренияКод: l.unitCode,
              Количество: l.quantity,
              Цена: l.price,
              СтоимостьБезУчетаКосвенныхНалогов: l.base,
              РазмерОборота: l.base,
              СтавкаНДС_Key: l.vatRef,
              СтавкаНДСЧисло: l.vatRate,
              БезНДС: l.noVat ? true : undefined,
              СуммаНДС: l.vat,
              СтоимостьСУчетомКосвенныхНалогов: l.total,
            }),
          ),
        });
        warnings.push(
          "Адреса сторон, код ГСВС услуг и должности подписантов не заполняются — заполните/проверьте в 1С. Черновик не " +
            "проведён и не отправлен: подписание ЭЦП и отправка — только в 1С.",
        );
        const fitted = await fitToMetadata(conn, set, payload, warnings);
        return createOrPreview(conn, set, fitted, confirm, [
          ...checks.map((c) => `Проверено: ${c}`),
          ...warnings,
        ]);
      }),
  );
}
