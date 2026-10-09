import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { guard, ok, databaseField } from "./_shared.js";
import { KZ_DOCUMENT_TOOLS, KZ_DOCUMENTS, KZ_WRITE_TOOLS } from "./write-kz.js";
import { KZ_FLOW, KZ_RATES_2026, KZ_SOURCES, kzGuide } from "./kz-flow.js";

// Balances, turnovers and document postings read the Kazakhstan Типовой register; tax payments still assume
// Russian tax-payment operations and stay blocked there.
const russianAccounting = new Set(["read.analytics.get_taxes_paid"]);
const kzReadReason =
  "Этот инструмент использует российский план счетов/налоговые правила. Для казахстанской базы нужен проверенный профиль учета; не предлагайте опубликовать российский Хозрасчетный и не считайте отказ нулевым остатком.";
// Kazakhstan writes cover the invoice path (counterparty, nomenclature, contract, invoice) and, through the generic
// document tools, payroll, its taxes and payouts; other documents with postings still assume Russian accounts and VAT.
const kzWriteReason = `В казахстанской базе доступна запись: ${KZ_WRITE_TOOLS.join(", ")}. Документы флоу бухгалтера (продажи, закупки, деньги, зарплата, кадры, склад, ОС/НМА, подотчёт, сверка, закрытие месяца, налоги) — через ${KZ_DOCUMENT_TOOLS.join(", ")} (список — kazakhstanDocuments, схемы и нормы — read.system.kz_document_guide). Профильные российские инструменты (create_shipment, create_payment и т.п.) здесь не работают: они ставят российские счета и НДС.`;
const kzDocumentReason = (entitySet: unknown) =>
  `Документ ${String(entitySet)} в казахстанской базе этим инструментом не пишется. Доступны: ${KZ_DOCUMENTS.join(", ")}.`;
const kzDocumentsUsage = [
  "Акт сверки с контрагентом — write.counterparty.quick_reconciliation одним вызовом: сам считает сальдо, документы и обороты по регистру (как «Заполнить» в 1С), план → confirm=true → акт без проведения и PDF. Не собирайте акт вручную через create_document.",
  "Документы флоу пишутся write.document.create_document / update_document и проводятся write.document.post_document; схема проводок, нормы НК и особенности каждого — read.system.kz_document_guide. Суммы, ставки и вычеты задаёте сами — 1С при записи через OData их не пересчитывает и счета учёта по умолчанию не подставляет: передавайте sampleRef — проведённый документ того же вида, сделанный в 1С; из него берутся только счета, субконто и виды операций НДС.",
  "Порядок всегда: create_document без confirm (dry-run) → прочитать notes → confirm=true с operationId → post_document → проверить posted, проводки и warnings в ответе → при необходимости read.accounting.get_account_turnover по счетам.",
  "Поля: read.schema.describe_entity по документу и по '<Документ>_<ТабличнаяЧасть>'. Образец — документ того же вида, рассчитанный самой 1С по тому же сотруднику (read.document.get_document); сверяйте с ним суммы и строки, а не только с похожими документами.",
  "Перед начислением проверьте месяц (read.payroll.get_accruals): если начисление уже есть, оклад повторно не начисляйте. Документы, помеченные на удаление, не используйте и пометку с них не снимайте — создавайте новые.",
  "Сначала определите режим сотрудника за месяц. Есть проведённый Document_РасчетЕдиногоПлатежа (единый платёж, ЕП) — ИПН, ОПВ, ВОСМС, СО, ООСМС и ОПВР уже в нём (таблица ИсчисленныйЕП): РасчетУдержаний и РасчетСНиСО не делайте, к выплате = начислено − часть ЕП работника (ОПВ+ВОСМС+ИПН из ИсчисленныйЕП). Иначе — классический расчёт.",
  "ИПН в классическом расчёте: базовый вычет — только если у сотрудника есть заявление на вычет; иначе базу уменьшают лишь ОПВ и ВОСМС. Как считала 1С раньше — видно в прошлых РасчетУдержанийРаботниковОрганизаций (ИсчисленныйИПН, ВычетыИПН).",
  "Начисление, расчёт удержаний и расчёт СН и СО проводок по счетам не делают — «0 проводок» после их проведения норма. Проводки делает ОтражениеЗарплатыВРеглУчете, и в нём должно быть всё: начисление Дт <счёт затрат> Кт 3350; удержания Дт 3350 Кт 3120 (ИПН), 3220 (ОПВ), 3212 (ВОСМС); взносы работодателя Дт <счёт затрат> Кт 3211 (СО), 3250 (ОПВР), 3213 (ООСМС). При ЕП вместо них: Дт 3350 Кт 3231 — часть работника, Дт <счёт затрат> Кт 3231 — часть работодателя (СО+ООСМС+ОПВР), статья затрат «Единый платеж (за счет работодателя)», вид расчёта и субконто Кт1 — «Единый платеж» из НалогиСборыОтчисления. Строки (субконто, ВидРасчета) копируйте с отражения, собранного 1С.",
  "Платёжные поручения (входящее и исходящее) 1С проводит только при Оплачено=true и ДатаВыписки — это факт движения по выписке банка; ставьте только по факту и с согласия пользователя. Post с Оплачено=false отвечает 200, но не проводит. КНП/КБК налогов и взносов проверяются в notes.",
  "После выплаты сальдо 3350 по сотруднику за месяц должно быть 0 (read.accounting.get_account_turnover account=3350 byAnalytics=true). Способ выплаты — как просил пользователь: просили платёжку — Document_ПлатежноеПоручениеИсходящее, наличные (РКО) — только с его согласия.",
].join(" ");

export async function capabilities(ctx: ServerContext, database?: string) {
  const conn = ctx.db(database);
  // Without metadata the base keeps upstream behaviour: no Kazakhstan profile, nothing blocked.
  const meta =
    typeof (conn as { getMetadata?: unknown }).getMetadata === "function"
      ? await conn.getMetadata()
      : { entities: new Map<string, { properties: { name: string }[] }>() };
  const cp = meta.entities.get("Catalog_Контрагенты");
  const kz =
    meta.entities.has("ChartOfAccounts_Типовой") ||
    !!cp?.properties.some((p) => p.name === "ИдентификационныйКодЛичности");
  return {
    database: conn.cfg.name,
    profile: kz ? "kazakhstan" : "upstream-russian-or-custom",
    blockedReads: kz ? [...russianAccounting] : [],
    writePolicy: kz ? "kazakhstan-limited" : "preview-and-confirmation",
    ...(kz
      ? {
          kazakhstanWrites: [...KZ_WRITE_TOOLS],
          kazakhstanDocuments: [...KZ_DOCUMENTS],
          kazakhstanDocumentsUsage: kzDocumentsUsage,
        }
      : {}),
    reasons: { accounting: kzReadReason, write: kzWriteReason },
    usage: {
      organization:
        "database выбирает подключение; organization — юридическое лицо внутри выбранной базы. Не подменяйте одно другим.",
      period:
        "Периоды задавайте явными датами. Нулевой результат относится только к выбранному периоду/фильтру.",
      pages:
        "Если truncated=true, результат неполный; используйте nextOffset при наличии либо уточняйте фильтр.",
      references:
        "Ref_Key берите из результата чтения; не придумывайте GUID. Нет примера документа — не означает отсутствие инструмента.",
    },
    ...(kz
      ? {
          kazakhstanAccounts:
            "Задолженность — по Типовому плану счетов: get_debtors (1210 покупатели), get_account_turnover account=3310 (поставщики), 31 (налоги), 32 (соцплатежи). Кредитовое сальдо на конец по 31/32/3310 — наш долг, дебетовое — переплата или аванс. Указывайте дату или период, на который получено сальдо. Для ответа по конкретным сотрудникам, контрагентам или налогам и при «красном» сальдо передавайте byAnalytics=true: итог может скрывать долг одному и переплату другому.",
        }
      : {}),
  };
}

/** Kazakhstan bases: refuse tools that assume the Russian chart of accounts or VAT instead of returning wrong numbers. */
export async function preflightTool(ctx: ServerContext, name: string, args: Record<string, unknown>) {
  if (
    name === "read.system.list_databases" ||
    name.startsWith("read.schema.") ||
    name === "read.system.health_check" ||
    name === "read.system.capabilities" ||
    name === "write.operation.status"
  )
    return;
  const cap = await capabilities(
    ctx,
    typeof args.database === "string" && args.database ? args.database : undefined,
  );
  if (cap.blockedReads.includes(name)) throw new InputError(kzReadReason);
  if (
    name.startsWith("write.") &&
    cap.writePolicy === "kazakhstan-limited" &&
    !(KZ_WRITE_TOOLS as readonly string[]).includes(name)
  )
    throw new InputError(kzWriteReason);
  if (
    cap.writePolicy === "kazakhstan-limited" &&
    (KZ_DOCUMENT_TOOLS as readonly string[]).includes(name) &&
    !(KZ_DOCUMENTS as readonly string[]).includes(String(args.entitySet))
  )
    throw new InputError(kzDocumentReason(args.entitySet));
  if (cap.writePolicy === "kazakhstan-limited" && name === "write.entity.update_entity")
    kzUpdateEntityCheck(args);
}

/** update_entity в казахстанской базе: справочники и документы флоу; Posted и DeletionMark — только своими инструментами. */
export function kzUpdateEntityCheck(args: Record<string, unknown>) {
  const set = String(args.entitySet ?? "");
  const fields = args.fields && typeof args.fields === "object" ? Object.keys(args.fields as object) : [];
  if (fields.includes("Posted"))
    throw new InputError(
      "Posted не меняют правкой полей: проведение — write.document.post_document (1С сама проверит документ).",
    );
  if (fields.includes("DeletionMark"))
    throw new InputError("Пометка на удаление — write.entity.mark_for_deletion.");
  if (set.startsWith("Document_") && !KZ_DOCUMENTS.includes(set)) throw new InputError(kzDocumentReason(set));
  if (!set.startsWith("Document_") && !set.startsWith("Catalog_"))
    throw new InputError(
      "В казахстанской базе update_entity меняет только справочники (Catalog_*) и документы флоу (Document_*).",
    );
}

export function registerCapabilities(server: McpServer, ctx: ServerContext) {
  server.registerTool(
    "read.system.capabilities",
    {
      title: "Доступные возможности и ограничения 1С",
      description:
        "Проверяет профиль выбранной базы, ограничения бухгалтерских/налоговых инструментов и записи. Вызовите перед первой работой с базой; не вызывайте blockedReads; при kazakhstan-limited записывайте только инструментами из kazakhstanWrites.",
      inputSchema: { database: databaseField },
      outputSchema: z
        .object({
          database: z.string(),
          profile: z.string(),
          blockedReads: z.array(z.string()),
          writePolicy: z.string(),
        })
        .passthrough(),
    },
    ({ database }) => guard("read.system.capabilities", async () => ok(await capabilities(ctx, database))),
  );

  server.registerTool(
    "read.system.kz_document_guide",
    {
      title: "Справочник флоу бухгалтера (Казахстан): документы, проводки, нормы НК",
      description:
        "Для казахстанской базы: какие документы пишет MCP (create_document/update_document/post_document), типовая схема проводок по Типовому плану счетов, нормы Налогового кодекса РК 2026 со ссылками, особенности заполнения через OData и ставки 2026 (МРП, МЗП, НДС, ИПН, ОПВ, ОПВР, СО, ОСМС, СН, ЕП, КПН, 910), КНП и КБК. Фильтр — entitySet или block (продажи, закупки, деньги, зарплата, кадры, склад, ОС и НМА, подотчёт, расчёты, закрытие месяца, налоги). Ничего не читает из 1С.",
      inputSchema: {
        entitySet: z
          .string()
          .optional()
          .describe("Документ, напр. Document_РеализацияТоваровУслуг (префикс Document_ можно опустить)"),
        block: z.string().optional().describe("Блок флоу, напр. «деньги»"),
        withRates: z.boolean().default(true).describe("Добавить ставки 2026, КНП и КБК"),
      },
    },
    ({ entitySet, block, withRates }) =>
      guard("read.system.kz_document_guide", async () =>
        ok({
          documents: kzGuide({ ...(entitySet ? { entitySet } : {}), ...(block ? { block } : {}) }),
          ...(withRates !== false ? { rates2026: KZ_RATES_2026, sources: KZ_SOURCES } : {}),
          blocks: [...new Set(KZ_FLOW.map((d) => d.block))],
          note: "Схемы — типовые для 1С:Бухгалтерии для Казахстана (Типовой план счетов). Фактические проводки смотрите в ответе post_document и read.accounting.get_document_postings: post_document сам сверяет их с ожидаемыми и пишет warnings.",
        }),
      ),
  );
}
