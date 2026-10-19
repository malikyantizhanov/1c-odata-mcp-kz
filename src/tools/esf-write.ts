import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { buildQuery, cmp, odataGuid } from "../odata/query.js";
import { databaseField, fail, guard, ok } from "./_shared.js";
import { counterpartyByBin } from "./esf-avr.js";
import { confirmField, patchOrPreview } from "./write.js";

/**
 * Запись связей ЭАВР → документ-основание и ЭСФ → счёт-фактура (Казахстан). Пишутся ТОЛЬКО перечисленные поля:
 *  • ЭАВР: ДокументОснование (+ _Type), при необходимости Договор_Key и БезДоговора;
 *  • ЭСФ: СчетФактура (+ _Type), при необходимости ДоговорПоставки_Key.
 * Номер, даты, суммы, статус, регистрационный номер и прочие реквизиты обмена с ИС не затрагиваются.
 * Предпросмотр (confirm=false) по умолчанию; перед записью сервер проверяет документ, основание, совпадение
 * организации и контрагента, отсутствие дубля и что обмен с ИС не нарушится.
 */

const AVR = "Document_ЭлектронныйАктВыполненныхРабот";
const ESF = "Document_ЭСФ";
const CONTRACTS = "Catalog_ДоговорыКонтрагентов";
const REG_ESF_ACTUAL = "InformationRegister_АктуальныеЭСФ";
const REG_ESF_HISTORY = "InformationRegister_ИсторияЭСФ";
const REG_ESF_QUEUE = "InformationRegister_ОчередьОтправкиЭСФ";
const REG_ESF_BY_PRIMARY = "InformationRegister_АктуальныеЭСФПоПервичнымДокументам";
const REG_AVR_ACTUAL = "InformationRegister_АктуальныеЭАВР";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}]/g, "").toLowerCase();
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const typeOf = (t: unknown): string => String(t ?? "").replace(/^StandardODATA\./, "");
const money = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const day = (v: unknown): string => String(v ?? "").slice(0, 10);
const dayNum = (v: unknown): number | undefined => {
  const s = day(v);
  const t = Date.parse(s);
  return Number.isFinite(t) && !s.startsWith("0001") ? t / 86_400_000 : undefined;
};
const fmt = (n: number): string =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: 2 }).replace(/\u00a0/g, " ");

/** Документ-основание ЭАВР и счёт-фактура ЭСФ по направлению. */
const BASIS_BY_DIRECTION: Record<string, string> = {
  Входящий: "Document_ПоступлениеТоваровУслуг",
  Исходящий: "Document_РеализацияТоваровУслуг",
};
const INVOICE_BY_DIRECTION: Record<string, string> = {
  Входящий: "Document_СчетФактураПолученный",
  Исходящий: "Document_СчетФактураВыданный",
};

/** Состояния, при которых привязывать нечего: ЭСФ/ЭАВР отозван или аннулирован. */
const DEAD_STATE = /Отозван|Аннулирован|ОжидаетПодтвержденияОтзыва/;

export interface ExchangeFacts {
  direction: string;
  status: string;
  state: string;
  registrationNumber: string;
  /** Записи истории обмена (ИсторияЭСФ) по документу. */
  historyCount: number;
  /** Документ стоит в очереди отправки (ОчередьОтправкиЭСФ). */
  queued: boolean;
  /** Состояние из регистра «Актуальные…» (пусто — записи нет). */
  actualState: string;
}

/**
 * Можно ли менять связи документа, не нарушая обмен с ИС.
 *  • Исходящий — только пока он НЕ ушёл в ИС: нет регистрационного номера, истории обмена, очереди отправки и
 *    записи в «Актуальных»; иначе отказ «уже отправлен/принят».
 *  • Входящий получен из ИС (состояния вроде «ПринятОтПоставщика» — норма): связь с первичным документом —
 *    локальная, обмен не затрагивается. Отказ — только для отозванных/аннулированных и документов в очереди.
 */
export function exchangeVerdict(
  f: ExchangeFacts,
  kind: "ЭСФ" | "ЭАВР",
): { refuse?: string; warnings: string[] } {
  const warnings: string[] = [];
  const what = `${kind} «${f.status || f.state || "—"}»`;
  if (f.queued)
    return {
      refuse: `${kind} стоит в очереди отправки в ИС — менять связи нельзя, дождитесь отправки или снимите её в 1С.`,
      warnings,
    };
  if (DEAD_STATE.test(`${f.status} ${f.state}`))
    return {
      refuse: `${what}: документ отозван/аннулирован — привязывать к нему ничего не нужно.`,
      warnings,
    };
  if (f.direction === "Исходящий") {
    const sent = f.registrationNumber || f.historyCount > 0 || f.actualState;
    if (sent)
      return {
        refuse: `Исходящий ${kind} уже отправлен/принят в ИС (${[
          f.registrationNumber && `рег. номер ${f.registrationNumber}`,
          (f.actualState || f.state) && `состояние «${f.actualState || f.state}»`,
          f.historyCount > 0 && `записей истории обмена: ${f.historyCount}`,
        ]
          .filter(Boolean)
          .join(", ")}). Менять его связи нельзя — это нарушит обмен с ИС.`,
        warnings,
      };
  } else {
    warnings.push(
      `${kind} входящий (получен из ИС, состояние «${f.actualState || f.state || f.status}»): связь с учётным документом локальная, обмен с ИС не затрагивается.`,
    );
  }
  return { warnings };
}

type Row = Record<string, unknown>;

async function readOptional(
  label: string,
  fn: () => Promise<number>,
  warnings: string[],
): Promise<number | undefined> {
  try {
    return await fn();
  } catch (e) {
    const why = e instanceof ODataError ? e.kind : "ошибка";
    warnings.push(`Не удалось проверить регистр «${label}» (${why}) — проверьте вручную в 1С.`);
    return undefined;
  }
}

async function registerRows(
  conn: Connection,
  set: string,
  filter: string | undefined,
  select: string[],
): Promise<Row[]> {
  if (!(await conn.available()).has(set))
    throw new ODataError({ kind: "not_found", message: `${set} не опубликован` });
  const { rows } = await fetchAll(conn.client, set, { ...(filter ? { filter } : {}), select }, 50, 200);
  return rows;
}

/**
 * Полный просмотр набора с отбором на стороне MCP: 1С не умеет отбирать по полям составного типа
 * (СчетФактура, ДокументОснование, ПервичныеДокументыЭАВР) — фильтр молча возвращает пусто, поэтому дубль
 * ищем сами. Если набор больше лимита строк, предупреждаем, что проверка неполная.
 */
async function scanAll(
  conn: Connection,
  set: string,
  filter: string | undefined,
  select: string[],
  label: string,
  warnings: string[],
): Promise<Row[]> {
  if (!(await conn.available()).has(set))
    throw new ODataError({ kind: "not_found", message: `${set} не опубликован` });
  const { rows, truncated } = await fetchAll(
    conn.client,
    set,
    { ...(filter ? { filter } : {}), select },
    conn.behavior.pageSize,
    conn.behavior.maxRows,
  );
  if (truncated)
    warnings.push(
      `«${label}» больше лимита строк (${conn.behavior.maxRows}) — проверка на дубль неполная, проверьте вручную в 1С.`,
    );
  return rows;
}

async function getDoc(
  conn: Connection,
  set: string,
  ref: string,
  select: string[],
  label: string,
): Promise<Row> {
  try {
    return await conn.client.getEntity(`${set}(guid'${guidOf(ref)}')${buildQuery({ select })}`);
  } catch (e) {
    if (e instanceof ODataError && e.kind === "not_found")
      throw new InputError(`${label} ${ref} не найден в базе.`);
    throw e;
  }
}

const docLabel = (r: Row, withAmount = true): string =>
  `№ ${String(r["Number"] ?? "").replace(/^0+(?=\d)/, "")} от ${day(r["Date"])}${withAmount ? `, ${fmt(money(r["СуммаДокумента"]))}` : ""}`;

interface Change {
  field: string;
  was: unknown;
  will: unknown;
  wasText?: string | undefined;
  willText?: string | undefined;
}

const sameValue = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

function buildChanges(
  current: Row,
  fields: Record<string, unknown>,
  texts: Record<string, { was?: string; will?: string }>,
): Change[] {
  return Object.entries(fields)
    .filter(
      ([k, v]) =>
        !sameValue(current[k], v) && !(k.endsWith("_Type") && sameValue(typeOf(current[k]), typeOf(v))),
    )
    .map(([k, v]) => ({
      field: k,
      was: current[k] ?? null,
      will: v,
      ...(texts[k]?.was ? { wasText: texts[k]!.was } : {}),
      ...(texts[k]?.will ? { willText: texts[k]!.will } : {}),
    }));
}

/** Договор должен принадлежать контрагенту; организация договора, если указана, должна совпасть. */
async function checkContract(
  conn: Connection,
  contractRef: string,
  counterparty: string | undefined,
  org: string | undefined,
  refuse: string[],
  warnings: string[],
): Promise<string> {
  const c = await getDoc(
    conn,
    CONTRACTS,
    contractRef,
    [
      "Ref_Key",
      "Description",
      "Owner_Key",
      "Организация_Key",
      "DeletionMark",
      "НомерДоговора",
      "ДатаДоговора",
    ],
    "Договор",
  );
  const name =
    String(c["Description"] ?? "") || `№ ${String(c["НомерДоговора"] ?? "")} от ${day(c["ДатаДоговора"])}`;
  if (c["DeletionMark"] === true) refuse.push(`Договор «${name}» помечен на удаление.`);
  if (!counterparty)
    refuse.push("Контрагент документа не определён — принадлежность договора проверить нельзя.");
  else if (!sameValue(c["Owner_Key"], counterparty))
    refuse.push(`Договор «${name}» принадлежит другому контрагенту.`);
  if (isRef(c["Организация_Key"]) && org && !sameValue(c["Организация_Key"], org))
    warnings.push(`Организация в договоре «${name}» отличается от организации документа.`);
  return name;
}

function result(
  conn: Connection,
  title: string,
  entitySet: string,
  ref: string,
  fields: Record<string, unknown>,
  changes: Change[],
  checks: string[],
  warnings: string[],
) {
  return { database: conn.cfg.name, title, entitySet, ref, fields, changes, checks, warnings };
}

/** Применяет запись (confirm) или показывает предпросмотр «было → станет». */
async function applyOrPreview(
  conn: Connection,
  set: string,
  ref: string,
  fields: Record<string, unknown>,
  info: ReturnType<typeof result>,
  confirm: boolean,
) {
  if (info.changes.length === 0) return fail("Менять нечего: перечисленные поля уже имеют нужные значения.");
  if (!confirm) {
    return ok({
      dryRun: true,
      ...info,
      willPatch: `${set}(${guidOf(ref)})`,
      note: conn.cfg.writable
        ? "Предпросмотр. Будут записаны только перечисленные поля; для записи повторите вызов с confirm=true после согласия бухгалтера."
        : `Предпросмотр. ВНИМАНИЕ: запись в базу "${conn.cfg.name}" запрещена — задайте writable: true для этой базы.`,
    });
  }
  if (conn.behavior.readOnly)
    return fail("Запись запрещена: включён режим READ_ONLY=true. Уберите его (или задайте READ_ONLY=false).");
  if (!conn.cfg.writable)
    return fail(`Запись в базу "${conn.cfg.name}" запрещена: у базы нет writable: true.`);
  const res = await patchOrPreview(conn, set, ref, fields, true, info.warnings);
  if (res.isError) return res;
  const after = await conn.client.getEntity(
    `${set}(guid'${guidOf(ref)}')${buildQuery({ select: Object.keys(fields) })}`,
  );
  const mismatched = Object.entries(fields).filter(
    ([k, v]) => !(k.endsWith("_Type") ? sameValue(typeOf(after[k]), typeOf(v)) : sameValue(after[k], v)),
  );
  return ok({
    updated: true,
    ...info,
    verified: mismatched.length === 0,
    ...(mismatched.length ? { notVerified: mismatched.map(([k]) => k) } : {}),
    note: mismatched.length
      ? "1С приняла запрос, но после перечитывания часть полей отличается — проверьте документ в 1С."
      : "Записано и проверено повторным чтением.",
  });
}

/**
 * Проведённый документ: отмена проведения → PATCH полей → проведение. PATCH проведённого документа без
 * перепроведения оставил бы движения (регистры ЭСФ со связью) старыми, поэтому только так. Успех каждого шага —
 * по перечитанному признаку Posted, а не по HTTP 200.
 */
async function repostAndPatch(
  conn: Connection,
  set: string,
  ref: string,
  fields: Record<string, unknown>,
  info: ReturnType<typeof result>,
  confirm: boolean,
) {
  const g = guidOf(ref);
  const steps = [
    `1) отменить проведение: ${set}(${g})/Unpost`,
    `2) записать поля: ${Object.keys(fields).join(", ")}`,
    `3) провести заново: ${set}(${g})/Post`,
  ];
  if (!confirm)
    return ok({
      dryRun: true,
      ...info,
      repost: true,
      steps,
      willPatch: `${set}(${g})`,
      note: conn.cfg.writable
        ? "Предпросмотр. ЭСФ проведён: будет выполнено три шага (см. steps). Для записи повторите с confirm=true после согласия бухгалтера."
        : `Предпросмотр. ВНИМАНИЕ: запись в базу "${conn.cfg.name}" запрещена — задайте writable: true для этой базы.`,
    });
  if (conn.behavior.readOnly)
    return fail("Запись запрещена: включён режим READ_ONLY=true. Уберите его (или задайте READ_ONLY=false).");
  if (!conn.cfg.writable)
    return fail(`Запись в базу "${conn.cfg.name}" запрещена: у базы нет writable: true.`);
  const postedNow = async () =>
    (await conn.client.getEntity(`${set}(guid'${g}')${buildQuery({ select: ["Posted"] })}`))["Posted"] ===
    true;
  await conn.client.action(`${set}(guid'${g}')/Unpost?$format=json`);
  if (await postedNow())
    return fail("1С не отменила проведение ЭСФ — связь не записана, документ не изменён.");
  try {
    await patchOrPreview(conn, set, ref, fields, true, info.warnings);
  } catch (e) {
    let reposted = false;
    try {
      await conn.client.action(`${set}(guid'${g}')/Post?$format=json`);
      reposted = await postedNow();
    } catch {
      /* сообщим ниже */
    }
    throw new InputError(
      `Связь не записана: ${(e as Error).message}. ` +
        (reposted
          ? "ЭСФ проведён обратно без изменений."
          : "ВНИМАНИЕ: ЭСФ остался НЕпроведённым — проведите его в 1С."),
    );
  }
  let postError = "";
  try {
    await conn.client.action(`${set}(guid'${g}')/Post?$format=json`);
  } catch (e) {
    postError = (e as Error).message;
  }
  const reposted = await postedNow();
  const after = await conn.client.getEntity(
    `${set}(guid'${g}')${buildQuery({ select: Object.keys(fields) })}`,
  );
  const mismatched = Object.entries(fields).filter(
    ([k, v]) => !(k.endsWith("_Type") ? sameValue(typeOf(after[k]), typeOf(v)) : sameValue(after[k], v)),
  );
  if (!reposted)
    return fail(
      `Связь записана, но ЭСФ НЕ проведён заново${postError ? ` (1С: ${postError})` : ""}. Проведите ЭСФ в 1С и проверьте ` +
        "регистры ЭСФ; до проведения связь в регистрах не обновится.",
    );
  return ok({
    updated: true,
    ...info,
    repost: true,
    steps,
    verified: mismatched.length === 0,
    ...(mismatched.length ? { notVerified: mismatched.map(([k]) => k) } : {}),
    note: mismatched.length
      ? "ЭСФ перепроведён, но после перечитывания часть полей отличается — проверьте документ в 1С."
      : "Проведение отменено, связь записана, ЭСФ проведён заново; проверено повторным чтением.",
  });
}

const resultSchema = z
  .object({
    dryRun: z.boolean().optional(),
    updated: z.boolean().optional(),
    verified: z.boolean().optional(),
    database: z.string(),
    entitySet: z.string(),
    ref: z.string(),
    fields: z.record(z.string(), z.unknown()),
    changes: z.array(z.object({ field: z.string() }).passthrough()),
    checks: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .passthrough();

const refusal = (what: string, refuse: string[], warnings: string[], checks: string[]) =>
  fail(
    `${what} не выполнена — проверки не пройдены:\n- ${refuse.join("\n- ")}` +
      (warnings.length ? `\nПредупреждения:\n- ${warnings.join("\n- ")}` : "") +
      (checks.length ? `\nПройдено:\n- ${checks.join("\n- ")}` : ""),
  );

export function registerEsfWriteTools(server: McpServer, ctx: ServerContext): void {
  // ───────────────────────── ЭАВР → основание ─────────────────────────
  server.registerTool(
    "write.avr.set_basis",
    {
      title: "Привязать основание (и договор) к ЭАВР",
      description:
        "Записывает в ЭАВР (Document_ЭлектронныйАктВыполненныхРабот) документ-основание: ДокументОснование + _Type " +
        "(поступление товаров и услуг для входящего ЭАВР, реализация — для исходящего) и, по желанию, договор: " +
        "contractRef / contractFromBasis (Договор_Key, БезДоговора=false) либо withoutContract (БезДоговора=true). " +
        "Меняет ТОЛЬКО эти поля; номер, даты, суммы, статус и регистрационный номер не трогает. Проверяет: ЭАВР и " +
        "основание существуют, организация и контрагент совпадают, основание не занято другим ЭАВР (в т.ч. по " +
        "регистру АктуальныеЭАВР), ЭАВР не отправлен в ИС и не отозван; суммы и даты — предупреждения. " +
        "Предпросмотр «было → станет» по умолчанию; запись — confirm=true после согласия бухгалтера. Кандидатов " +
        "подбирает read.esf.find_avr_basis.",
      inputSchema: {
        database: databaseField,
        avrRef: GUID.describe("Ref_Key ЭАВР"),
        basisRef: GUID.describe("Ref_Key документа-основания (поступление/реализация)"),
        contractRef: GUID.optional().describe("Ref_Key договора контрагента (Договор_Key)"),
        contractFromBasis: z.boolean().optional().describe("Взять договор из документа-основания"),
        withoutContract: z.boolean().optional().describe("Отметить «Без договора» (Договор_Key очищается)"),
        replaceExisting: z
          .boolean()
          .default(false)
          .describe("Заменить уже заданное другое основание (по умолчанию отказ)"),
        confirm: confirmField,
      },
      outputSchema: resultSchema,
    },
    ({
      database,
      avrRef,
      basisRef,
      contractRef,
      contractFromBasis,
      withoutContract,
      replaceExisting,
      confirm,
    }) =>
      guard("write.avr.set_basis", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [AVR], "Документ «Электронный акт выполненных работ» (ЭАВР)");
        if ([contractRef, contractFromBasis, withoutContract].filter(Boolean).length > 1)
          throw new InputError(
            "Договор: задайте что-то одно — contractRef, contractFromBasis или withoutContract.",
          );
        const avr = await getDoc(
          conn,
          set,
          avrRef,
          [
            "Ref_Key",
            "Number",
            "Date",
            "DeletionMark",
            "Posted",
            "Организация_Key",
            "Контрагент",
            "Контрагент_Type",
            "Направление",
            "Статус",
            "Состояние",
            "РегистрационныйНомер",
            "БезДоговора",
            "Договор_Key",
            "НомерДоговора",
            "ДатаДоговора",
            "ДокументОснование",
            "ДокументОснование_Type",
            "ДатаВыполненияРабот",
            "ИтогоСтоимостьСУчетомКосвенныхНалогов",
            "ИтогоСтоимостьБезУчетаКосвенныхНалогов",
          ],
          "ЭАВР",
        );
        const direction = String(avr["Направление"] ?? "Входящий");
        const basisSet = BASIS_BY_DIRECTION[direction];
        if (!basisSet || !(await conn.available()).has(basisSet))
          throw new InputError(`Документ-основание для направления «${direction}» в базе не опубликован.`);
        const basis = await getDoc(
          conn,
          basisSet,
          basisRef,
          [
            "Ref_Key",
            "Number",
            "Date",
            "Posted",
            "DeletionMark",
            "Организация_Key",
            "Контрагент_Key",
            "ДоговорКонтрагента_Key",
            "СуммаДокумента",
          ],
          "Документ-основание",
        );

        const refuse: string[] = [];
        const warnings: string[] = [];
        const checks: string[] = [];
        if (avr["DeletionMark"] === true) refuse.push("ЭАВР помечен на удаление.");
        if (basis["DeletionMark"] === true) refuse.push("Документ-основание помечен на удаление.");
        else checks.push(`основание найдено: ${basisSet.replace("Document_", "")} ${docLabel(basis)}`);
        if (basis["Posted"] !== true) warnings.push("Документ-основание не проведён.");

        // Организация и контрагент.
        const org = isRef(avr["Организация_Key"]) ? String(avr["Организация_Key"]) : undefined;
        if (!org) refuse.push("У ЭАВР не указана организация.");
        else if (!sameValue(org, basis["Организация_Key"]))
          refuse.push("Организация основания не совпадает с организацией ЭАВР.");
        else checks.push("организация совпадает");
        let counterparty =
          isRef(avr["Контрагент"]) && typeOf(avr["Контрагент_Type"]) === "Catalog_Контрагенты"
            ? String(avr["Контрагент"])
            : undefined;
        if (!counterparty) counterparty = await counterpartyByBin(conn, set, guidOf(avrRef));
        if (!counterparty)
          refuse.push(
            "Контрагент ЭАВР не определён (нет ссылки и БИН поставщика не найден в справочнике) — сверить с основанием нельзя.",
          );
        else if (!sameValue(counterparty, basis["Контрагент_Key"]))
          refuse.push("Контрагент основания не совпадает с контрагентом ЭАВР.");
        else checks.push("контрагент совпадает");

        // Текущее основание.
        const hasBasis =
          isRef(avr["ДокументОснование"]) && typeOf(avr["ДокументОснование_Type"]) !== "Undefined";
        const basisType = `StandardODATA.${basisSet}`;
        if (hasBasis) {
          if (
            sameValue(avr["ДокументОснование"], basisRef) &&
            typeOf(avr["ДокументОснование_Type"]) === basisSet
          )
            refuse.push("Это основание уже привязано к ЭАВР — менять нечего.");
          else if (!replaceExisting)
            refuse.push(
              `У ЭАВР уже задано другое основание (${typeOf(avr["ДокументОснование_Type"])} ${String(avr["ДокументОснование"])}); для замены передайте replaceExisting=true.`,
            );
        }

        // Обмен с ИС.
        let avrActual = "";
        await readOptional(
          "АктуальныеЭАВР",
          async () => {
            const rows = await registerRows(
              conn,
              REG_AVR_ACTUAL,
              cmp("ЭАВР_Key", "eq", odataGuid(guidOf(avrRef))),
              ["ЭАВР_Key", "СостоянияЭАВР"],
            );
            avrActual = rows[0] ? String(rows[0]["СостоянияЭАВР"] ?? "") : "";
            return rows.length;
          },
          warnings,
        );
        const verdict = exchangeVerdict(
          {
            direction,
            status: String(avr["Статус"] ?? ""),
            state: String(avr["Состояние"] ?? ""),
            registrationNumber: direction === "Исходящий" ? String(avr["РегистрационныйНомер"] ?? "") : "",
            historyCount: 0,
            queued: false,
            actualState: direction === "Исходящий" ? avrActual : "",
          },
          "ЭАВР",
        );
        if (verdict.refuse) refuse.push(verdict.refuse);
        else checks.push("обмен с ИС не нарушается");
        warnings.push(...verdict.warnings);

        // Дубль: основание уже занято другим ЭАВР.
        const taken = new Set<string>();
        const dupDocs = await scanAll(
          conn,
          set,
          cmp("DeletionMark", "eq", "false"),
          ["Ref_Key", "Number", "Date", "ДокументОснование", "ДокументОснование_Type"],
          "ЭАВР",
          warnings,
        );
        for (const d of dupDocs)
          if (
            !sameValue(d["Ref_Key"], avrRef) &&
            sameValue(d["ДокументОснование"], basisRef) &&
            typeOf(d["ДокументОснование_Type"]) === basisSet
          )
            taken.add(`ЭАВР ${docLabel(d, false)}`);
        await readOptional(
          "АктуальныеЭАВР",
          async () => {
            const rows = (
              await scanAll(
                conn,
                REG_AVR_ACTUAL,
                undefined,
                ["ПервичныеДокументыЭАВР", "ПервичныеДокументыЭАВР_Type", "ЭАВР_Key"],
                "АктуальныеЭАВР",
                warnings,
              )
            ).filter((r) => sameValue(r["ПервичныеДокументыЭАВР"], basisRef));
            for (const r of rows)
              if (!sameValue(r["ЭАВР_Key"], avrRef))
                taken.add(`ЭАВР ${String(r["ЭАВР_Key"])} (регистр АктуальныеЭАВР)`);
            return rows.length;
          },
          warnings,
        );
        if (taken.size)
          refuse.push(`Основание уже привязано к другому ЭАВР: ${[...taken].join("; ")}. Дубль не создаём.`);
        else checks.push("основание не занято другим ЭАВР");

        // Суммы и даты — предупреждения.
        const amounts = [
          money(avr["ИтогоСтоимостьСУчетомКосвенныхНалогов"]),
          money(avr["ИтогоСтоимостьБезУчетаКосвенныхНалогов"]),
        ];
        const sum = money(basis["СуммаДокумента"]);
        if (!amounts.some((a) => Math.abs(a - sum) <= 0.01))
          warnings.push(
            `Сумма основания ${fmt(sum)} не равна сумме ЭАВР (с налогами ${fmt(amounts[0]!)}, без ${fmt(amounts[1]!)}).`,
          );
        else checks.push("сумма согласуется");
        const dd = [dayNum(avr["Date"]), dayNum(avr["ДатаВыполненияРабот"])].filter(
          (x): x is number => x !== undefined,
        );
        const bd = dayNum(basis["Date"]);
        if (bd !== undefined && dd.length && Math.min(...dd.map((x) => Math.abs(x - bd))) > 31)
          warnings.push(
            `Даты расходятся более чем на 31 день: основание ${day(basis["Date"])}, ЭАВР ${day(avr["Date"])}.`,
          );

        // Договор.
        const fields: Record<string, unknown> = {
          ДокументОснование: guidOf(basisRef),
          ДокументОснование_Type: basisType,
        };
        const texts: Record<string, { was?: string; will?: string }> = {
          ДокументОснование: { will: `${basisSet.replace("Document_", "")} ${docLabel(basis)}` },
        };
        const wantedContract =
          contractRef ??
          (contractFromBasis
            ? isRef(basis["ДоговорКонтрагента_Key"])
              ? String(basis["ДоговорКонтрагента_Key"])
              : undefined
            : undefined);
        if (contractFromBasis && !wantedContract)
          refuse.push("В документе-основании договор не указан (contractFromBasis).");
        if (wantedContract) {
          const name = await checkContract(conn, wantedContract, counterparty, org, refuse, warnings);
          fields["Договор_Key"] = guidOf(wantedContract);
          fields["БезДоговора"] = false;
          texts["Договор_Key"] = { will: name };
          if (isRef(avr["Договор_Key"])) texts["Договор_Key"]!.was = String(avr["Договор_Key"]);
          if (String(avr["НомерДоговора"] ?? ""))
            warnings.push(
              `В ЭАВР заполнены реквизиты договора из ИС (№ ${String(avr["НомерДоговора"])} от ${day(avr["ДатаДоговора"])}) — они не меняются.`,
            );
        } else if (withoutContract) {
          fields["Договор_Key"] = EMPTY_GUID;
          fields["БезДоговора"] = true;
        }

        if (refuse.length) return refusal("Привязка основания к ЭАВР", refuse, warnings, checks);
        const changes = buildChanges(avr, fields, texts);
        const changed = Object.fromEntries(changes.map((c) => [c.field, c.will]));
        return applyOrPreview(
          conn,
          set,
          avrRef,
          changed,
          result(conn, `ЭАВР ${docLabel(avr, false)}`, set, avrRef, changed, changes, checks, warnings),
          confirm,
        );
      }),
  );

  // ───────────────────────── ЭСФ → счёт-фактура ─────────────────────────
  server.registerTool(
    "write.esf.link_invoice",
    {
      title: "Привязать счёт-фактуру (и договор) к ЭСФ",
      description:
        "Записывает в ЭСФ (Document_ЭСФ) счёт-фактуру: СчетФактура + _Type (полученный — для входящего ЭСФ, выданный — " +
        "для исходящего) и, по желанию, договор поставки ДоговорПоставки_Key (contractRef или contractFromInvoice). " +
        "Меняет ТОЛЬКО эти поля; номер, даты, суммы, статус, регистрационный номер и реквизиты обмена с ИС не трогает. " +
        "Проведённый ЭСФ — только с repost=true: отмена проведения → запись связи → проведение (шаги в предпросмотре; " +
        "при сбое проведения ЭСФ остаётся непроведённым с записанной связью — об этом будет сказано). " +
        "Отказ, если: ЭСФ отозван/аннулирован, в очереди отправки, исходящий ЭСФ уже отправлен/принят " +
        "(регистры АктуальныеЭСФ, ИсторияЭСФ, ОчередьОтправкиЭСФ); организация или контрагент СФ не совпадают; СФ уже " +
        "привязана к другому ЭСФ; договор не принадлежит контрагенту. Расхождение суммы и даты — предупреждения. " +
        "Предпросмотр «было → станет» по умолчанию; запись — confirm=true после согласия бухгалтера. Кандидатов " +
        "подбирает read.esf.find_esf_invoice.",
      inputSchema: {
        database: databaseField,
        esfRef: GUID.describe("Ref_Key ЭСФ"),
        invoiceRef: GUID.describe("Ref_Key счёта-фактуры (полученный/выданный по направлению ЭСФ)"),
        contractRef: GUID.optional().describe("Ref_Key договора контрагента (ДоговорПоставки_Key)"),
        contractFromInvoice: z
          .boolean()
          .optional()
          .describe("Взять договор из счёта-фактуры (ДоговорКонтрагента_Key)"),
        replaceExisting: z
          .boolean()
          .default(false)
          .describe("Заменить уже привязанную другую счёт-фактуру (по умолчанию отказ)"),
        repost: z
          .boolean()
          .default(false)
          .describe(
            "Для проведённого ЭСФ: отменить проведение → записать связь → провести заново (по умолчанию отказ)",
          ),
        confirm: confirmField,
      },
      outputSchema: resultSchema,
    },
    ({ database, esfRef, invoiceRef, contractRef, contractFromInvoice, replaceExisting, repost, confirm }) =>
      guard("write.esf.link_invoice", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [ESF], "Документ «ЭСФ»");
        if (contractRef && contractFromInvoice)
          throw new InputError("Договор: задайте что-то одно — contractRef или contractFromInvoice.");
        const esf = await getDoc(
          conn,
          set,
          esfRef,
          [
            "Ref_Key",
            "Number",
            "Date",
            "DeletionMark",
            "Posted",
            "Организация_Key",
            "Контрагент_Key",
            "Направление",
            "Статус",
            "Состояние",
            "РегистрационныйНомер",
            "СуммаДокумента",
            "ДатаОборота",
            "СчетФактура",
            "СчетФактура_Type",
            "ДоговорПоставки_Key",
            "ДоговорПоставкиНомер",
            "ДоговорПоставкиДата",
          ],
          "ЭСФ",
        );
        const direction = String(esf["Направление"] ?? "Входящий");
        const invSet = INVOICE_BY_DIRECTION[direction];
        if (!invSet || !(await conn.available()).has(invSet))
          throw new InputError(`Счета-фактуры для направления «${direction}» в базе не опубликованы.`);
        const inv = await getDoc(
          conn,
          invSet,
          invoiceRef,
          [
            "Ref_Key",
            "Number",
            "Date",
            "Posted",
            "DeletionMark",
            "Организация_Key",
            "Контрагент_Key",
            "ДоговорКонтрагента_Key",
            "СуммаДокумента",
            "ДатаСовершенияОборотаПоРеализации",
          ],
          "Счёт-фактура",
        );

        const refuse: string[] = [];
        const warnings: string[] = [];
        const checks: string[] = [];
        if (esf["DeletionMark"] === true) refuse.push("ЭСФ помечен на удаление.");
        const posted = esf["Posted"] === true;
        if (posted && !repost)
          refuse.push(
            "ЭСФ проведён. Связь пишется в регистры ЭСФ при проведении, поэтому правка проведённого ЭСФ без перепроведения " +
              "оставила бы регистры со старой связью. Передайте repost=true: инструмент отменит проведение, запишет связь " +
              "и проведёт ЭСФ заново (шаги видны в предпросмотре).",
          );
        if (inv["DeletionMark"] === true) refuse.push("Счёт-фактура помечена на удаление.");
        else checks.push(`счёт-фактура найдена: ${invSet.replace("Document_", "")} ${docLabel(inv)}`);
        if (inv["Posted"] !== true) warnings.push("Счёт-фактура не проведена.");

        // Организация и контрагент СФ.
        const org = isRef(esf["Организация_Key"]) ? String(esf["Организация_Key"]) : undefined;
        const counterparty = isRef(esf["Контрагент_Key"]) ? String(esf["Контрагент_Key"]) : undefined;
        if (!org) refuse.push("У ЭСФ не указана организация.");
        else if (!sameValue(org, inv["Организация_Key"]))
          refuse.push("Организация счёта-фактуры не совпадает с организацией ЭСФ.");
        else checks.push("организация совпадает");
        if (!counterparty) refuse.push("У ЭСФ не указан контрагент — сверить со счётом-фактурой нельзя.");
        else if (!sameValue(counterparty, inv["Контрагент_Key"]))
          refuse.push("Контрагент счёта-фактуры не совпадает с контрагентом ЭСФ.");
        else checks.push("контрагент совпадает");

        // Текущая связь.
        const invType = `StandardODATA.${invSet}`;
        const linked = isRef(esf["СчетФактура"]) && typeOf(esf["СчетФактура_Type"]) !== "Undefined";
        if (linked) {
          if (sameValue(esf["СчетФактура"], invoiceRef) && typeOf(esf["СчетФактура_Type"]) === invSet)
            refuse.push("Эта счёт-фактура уже привязана к ЭСФ — менять нечего.");
          else if (!replaceExisting)
            refuse.push(
              `К ЭСФ уже привязана другая счёт-фактура (${typeOf(esf["СчетФактура_Type"])} ${String(esf["СчетФактура"])}); для замены передайте replaceExisting=true.`,
            );
        }

        // Обмен с ИС ЭСФ: регистры.
        const facts = { actual: "", actualOther: [] as string[], history: 0, queue: 0 };
        await readOptional(
          "АктуальныеЭСФ",
          async () => {
            const rows = await registerRows(
              conn,
              REG_ESF_ACTUAL,
              cmp("ЭСФ_Key", "eq", odataGuid(guidOf(esfRef))),
              ["СчетФактура", "СчетФактура_Type", "ЭСФ_Key", "Состояние"],
            );
            facts.actual = rows[0] ? String(rows[0]["Состояние"] ?? "") : "";
            for (const r of rows)
              if (!sameValue(r["СчетФактура"], invoiceRef))
                facts.actualOther.push(`${typeOf(r["СчетФактура_Type"])} ${String(r["СчетФактура"])}`);
            return rows.length;
          },
          warnings,
        );
        await readOptional(
          "ИсторияЭСФ",
          async () => {
            facts.history = (
              await registerRows(conn, REG_ESF_HISTORY, cmp("ЭСФ_Key", "eq", odataGuid(guidOf(esfRef))), [
                "ЭСФ_Key",
                "НомерЗаписи",
              ])
            ).length;
            return facts.history;
          },
          warnings,
        );
        await readOptional(
          "ОчередьОтправкиЭСФ",
          async () => {
            facts.queue = (
              await registerRows(conn, REG_ESF_QUEUE, cmp("ЭСФ_Key", "eq", odataGuid(guidOf(esfRef))), [
                "ЭСФ_Key",
              ])
            ).length;
            return facts.queue;
          },
          warnings,
        );
        const verdict = exchangeVerdict(
          {
            direction,
            status: String(esf["Статус"] ?? ""),
            state: String(esf["Состояние"] ?? ""),
            registrationNumber: String(esf["РегистрационныйНомер"] ?? ""),
            historyCount: facts.history,
            queued: facts.queue > 0,
            actualState: facts.actual,
          },
          "ЭСФ",
        );
        if (verdict.refuse) refuse.push(verdict.refuse);
        else
          checks.push(
            "обмен с ИС ЭСФ не нарушается (регистры АктуальныеЭСФ, ИсторияЭСФ, ОчередьОтправкиЭСФ)",
          );
        warnings.push(...verdict.warnings);
        if (facts.actualOther.length && !replaceExisting && !linked)
          refuse.push(
            `В регистре АктуальныеЭСФ этот ЭСФ уже связан с другой счёт-фактурой: ${facts.actualOther.join("; ")}.`,
          );

        // Дубль: СФ уже привязана к другому ЭСФ.
        const takenBy = new Set<string>();
        const dup = await scanAll(
          conn,
          set,
          cmp("DeletionMark", "eq", "false"),
          ["Ref_Key", "Number", "Date", "СчетФактура", "СчетФактура_Type"],
          "ЭСФ",
          warnings,
        );
        for (const d of dup)
          if (
            !sameValue(d["Ref_Key"], esfRef) &&
            sameValue(d["СчетФактура"], invoiceRef) &&
            typeOf(d["СчетФактура_Type"]) === invSet
          )
            takenBy.add(`ЭСФ ${docLabel(d, false)}`);
        await readOptional(
          "АктуальныеЭСФ",
          async () => {
            const rows = (
              await scanAll(
                conn,
                REG_ESF_ACTUAL,
                undefined,
                ["СчетФактура", "СчетФактура_Type", "ЭСФ_Key"],
                "АктуальныеЭСФ",
                warnings,
              )
            ).filter((r) => sameValue(r["СчетФактура"], invoiceRef));
            for (const r of rows)
              if (!sameValue(r["ЭСФ_Key"], esfRef))
                takenBy.add(`ЭСФ ${String(r["ЭСФ_Key"])} (регистр АктуальныеЭСФ)`);
            return rows.length;
          },
          warnings,
        );
        await readOptional(
          "АктуальныеЭСФПоПервичнымДокументам",
          async () => {
            const rows = (
              await scanAll(
                conn,
                REG_ESF_BY_PRIMARY,
                undefined,
                ["ЭСФ_Key", "СчетФактура"],
                "АктуальныеЭСФПоПервичнымДокументам",
                warnings,
              )
            ).filter((r) => sameValue(r["СчетФактура"], invoiceRef));
            for (const r of rows)
              if (!sameValue(r["ЭСФ_Key"], esfRef))
                takenBy.add(`ЭСФ ${String(r["ЭСФ_Key"])} (регистр по первичным документам)`);
            return rows.length;
          },
          warnings,
        );
        if (takenBy.size)
          refuse.push(
            `Счёт-фактура уже привязана к другому ЭСФ: ${[...takenBy].join("; ")}. Дубль не создаём.`,
          );
        else checks.push("счёт-фактура не привязана к другому ЭСФ");

        // Сумма и дата — предупреждения.
        const esfSum = money(esf["СуммаДокумента"]);
        const invSum = money(inv["СуммаДокумента"]);
        if (Math.abs(esfSum - invSum) > 0.01)
          warnings.push(`Сумма счёта-фактуры ${fmt(invSum)} не равна сумме ЭСФ ${fmt(esfSum)}.`);
        else checks.push("сумма согласуется");
        const ed = [dayNum(esf["Date"]), dayNum(esf["ДатаОборота"])].filter(
          (x): x is number => x !== undefined,
        );
        const id = [dayNum(inv["Date"]), dayNum(inv["ДатаСовершенияОборотаПоРеализации"])].filter(
          (x): x is number => x !== undefined,
        );
        if (ed.length && id.length && Math.min(...ed.flatMap((a) => id.map((b) => Math.abs(a - b)))) > 31)
          warnings.push(
            `Даты расходятся более чем на 31 день: счёт-фактура ${day(inv["Date"])}, ЭСФ ${day(esf["Date"])}.`,
          );

        // Договор.
        const fields: Record<string, unknown> = {
          СчетФактура: guidOf(invoiceRef),
          СчетФактура_Type: invType,
        };
        const texts: Record<string, { was?: string; will?: string }> = {
          СчетФактура: { will: `${invSet.replace("Document_", "")} ${docLabel(inv)}` },
        };
        const wantedContract =
          contractRef ??
          (contractFromInvoice
            ? isRef(inv["ДоговорКонтрагента_Key"])
              ? String(inv["ДоговорКонтрагента_Key"])
              : undefined
            : undefined);
        if (contractFromInvoice && !wantedContract)
          refuse.push("В счёте-фактуре договор не указан (contractFromInvoice).");
        if (wantedContract) {
          const name = await checkContract(conn, wantedContract, counterparty, org, refuse, warnings);
          fields["ДоговорПоставки_Key"] = guidOf(wantedContract);
          texts["ДоговорПоставки_Key"] = { will: name };
          if (String(esf["ДоговорПоставкиНомер"] ?? ""))
            warnings.push(
              `В ЭСФ заполнены реквизиты договора поставки из ИС (№ ${String(esf["ДоговорПоставкиНомер"])} от ${day(esf["ДоговорПоставкиДата"])}) — они не меняются.`,
            );
        }

        if (refuse.length) return refusal("Привязка счёта-фактуры к ЭСФ", refuse, warnings, checks);
        const changes = buildChanges(esf, fields, texts);
        const changed = Object.fromEntries(changes.map((c) => [c.field, c.will]));
        const info = result(conn, `ЭСФ ${docLabel(esf)}`, set, esfRef, changed, changes, checks, warnings);
        if (posted) {
          if (changes.length === 0)
            return fail("Менять нечего: перечисленные поля уже имеют нужные значения.");
          return repostAndPatch(conn, set, esfRef, changed, info, confirm);
        }
        return applyOrPreview(conn, set, esfRef, changed, info, confirm);
      }),
  );
}
