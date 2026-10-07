import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { guard,ok,databaseField } from "./_shared.js";
import { KZ_DOCUMENT_TOOLS, KZ_DOCUMENTS, KZ_WRITE_TOOLS } from "./write-kz.js";

// Balances, turnovers and document postings read the Kazakhstan Типовой register; tax payments still assume
// Russian tax-payment operations and stay blocked there.
const russianAccounting = new Set([
  "read.analytics.get_taxes_paid",
]);
const kzReadReason = "Этот инструмент использует российский план счетов/налоговые правила. Для казахстанской базы нужен проверенный профиль учета; не предлагайте опубликовать российский Хозрасчетный и не считайте отказ нулевым остатком.";
// Kazakhstan writes cover the invoice path (counterparty, nomenclature, contract, invoice) and, through the generic
// document tools, payroll, its taxes and payouts; other documents with postings still assume Russian accounts and VAT.
const kzWriteReason = `В казахстанской базе пока доступна запись: ${KZ_WRITE_TOOLS.join(", ")}. Документы зарплаты, налогов и выплат — через ${KZ_DOCUMENT_TOOLS.join(", ")} (см. kazakhstanDocuments). Реализация, поступление и прочие документы с проводками ещё не настроены под казахстанские счета и НДС.`;
const kzDocumentReason = (entitySet: unknown) => `Документ ${String(entitySet)} в казахстанской базе этим инструментом не пишется. Доступны: ${KZ_DOCUMENTS.join(", ")}.`;
const kzDocumentsUsage = [
  "Документы зарплаты и выплат пишутся write.document.create_document / update_document и проводятся write.document.post_document. Суммы, ставки и вычеты задаёте сами — 1С при записи через OData их не пересчитывает.",
  "Поля: read.schema.describe_entity по документу и по '<Документ>_<ТабличнаяЧасть>'. Образец — документ того же вида, рассчитанный самой 1С по тому же сотруднику (read.document.get_document); сверяйте с ним суммы и строки, а не только с похожими документами.",
  "Перед начислением проверьте месяц (read.payroll.get_accruals): если начисление уже есть, оклад повторно не начисляйте. Документы, помеченные на удаление, не используйте и пометку с них не снимайте — создавайте новые.",
  "Сначала определите режим сотрудника за месяц. Есть проведённый Document_РасчетЕдиногоПлатежа (единый платёж, ЕП) — ИПН, ОПВ, ВОСМС, СО, ООСМС и ОПВР уже в нём (таблица ИсчисленныйЕП): РасчетУдержаний и РасчетСНиСО не делайте, к выплате = начислено − часть ЕП работника (ОПВ+ВОСМС+ИПН из ИсчисленныйЕП). Иначе — классический расчёт.",
  "ИПН в классическом расчёте: базовый вычет — только если у сотрудника есть заявление на вычет; иначе базу уменьшают лишь ОПВ и ВОСМС. Как считала 1С раньше — видно в прошлых РасчетУдержанийРаботниковОрганизаций (ИсчисленныйИПН, ВычетыИПН).",
  "Начисление, расчёт удержаний и расчёт СН и СО проводок по счетам не делают — «0 проводок» после их проведения норма. Проводки делает ОтражениеЗарплатыВРеглУчете, и в нём должно быть всё: начисление Дт <счёт затрат> Кт 3350; удержания Дт 3350 Кт 3120 (ИПН), 3220 (ОПВ), 3212 (ВОСМС); взносы работодателя Дт <счёт затрат> Кт 3211 (СО), 3250 (ОПВР), 3213 (ООСМС). При ЕП вместо них: Дт 3350 Кт 3231 — часть работника, Дт <счёт затрат> Кт 3231 — часть работодателя (СО+ООСМС+ОПВР), статья затрат «Единый платеж (за счет работодателя)», вид расчёта и субконто Кт1 — «Единый платеж» из НалогиСборыОтчисления. Строки (субконто, ВидРасчета) копируйте с отражения, собранного 1С.",
  "После выплаты сальдо 3350 по сотруднику за месяц должно быть 0 (read.accounting.get_account_turnover account=3350 byAnalytics=true). Способ выплаты — как просил пользователь: просили платёжку — Document_ПлатежноеПоручениеИсходящее, наличные (РКО) — только с его согласия.",
].join(" ");

export async function capabilities(ctx: ServerContext,database?:string) {
  const conn=ctx.db(database);
  // Without metadata the base keeps upstream behaviour: no Kazakhstan profile, nothing blocked.
  const meta=typeof (conn as {getMetadata?:unknown}).getMetadata==="function" ? await conn.getMetadata() : {entities:new Map<string,{properties:{name:string}[]}>()};
  const cp=meta.entities.get("Catalog_Контрагенты");
  const kz=meta.entities.has("ChartOfAccounts_Типовой") || !!cp?.properties.some(p=>p.name==="ИдентификационныйКодЛичности");
  return {database:conn.cfg.name,profile:kz?"kazakhstan":"upstream-russian-or-custom",
    blockedReads:kz?[...russianAccounting]:[],
    writePolicy:kz?"kazakhstan-limited":"preview-and-confirmation",
    ...(kz?{kazakhstanWrites:[...KZ_WRITE_TOOLS],kazakhstanDocuments:[...KZ_DOCUMENTS],kazakhstanDocumentsUsage:kzDocumentsUsage}:{}),
    reasons:{accounting:kzReadReason,write:kzWriteReason},
    usage:{organization:"database выбирает подключение; organization — юридическое лицо внутри выбранной базы. Не подменяйте одно другим.",period:"Периоды задавайте явными датами. Нулевой результат относится только к выбранному периоду/фильтру.",pages:"Если truncated=true, результат неполный; используйте nextOffset при наличии либо уточняйте фильтр.",references:"Ref_Key берите из результата чтения; не придумывайте GUID. Нет примера документа — не означает отсутствие инструмента."},
    ...(kz?{kazakhstanAccounts:"Задолженность — по Типовому плану счетов: get_debtors (1210 покупатели), get_account_turnover account=3310 (поставщики), 31 (налоги), 32 (соцплатежи). Кредитовое сальдо на конец по 31/32/3310 — наш долг, дебетовое — переплата или аванс. Указывайте дату или период, на который получено сальдо. Для ответа по конкретным сотрудникам, контрагентам или налогам и при «красном» сальдо передавайте byAnalytics=true: итог может скрывать долг одному и переплату другому."}:{}),
  };
}

/** Kazakhstan bases: refuse tools that assume the Russian chart of accounts or VAT instead of returning wrong numbers. */
export async function preflightTool(ctx:ServerContext,name:string,args:Record<string,unknown>) {
  if(name==="read.system.list_databases" || name.startsWith("read.schema.") || name==="read.system.health_check" || name==="read.system.capabilities" || name==="write.operation.status") return;
  const cap=await capabilities(ctx,typeof args.database==="string" && args.database ? args.database : undefined);
  if(cap.blockedReads.includes(name)) throw new InputError(kzReadReason);
  if(name.startsWith("write.") && cap.writePolicy==="kazakhstan-limited" && !(KZ_WRITE_TOOLS as readonly string[]).includes(name)) throw new InputError(kzWriteReason);
  if(cap.writePolicy==="kazakhstan-limited" && (KZ_DOCUMENT_TOOLS as readonly string[]).includes(name) && !(KZ_DOCUMENTS as readonly string[]).includes(String(args.entitySet))) throw new InputError(kzDocumentReason(args.entitySet));
}

export function registerCapabilities(server:McpServer,ctx:ServerContext) {
  server.registerTool("read.system.capabilities",{
    title:"Доступные возможности и ограничения 1С",
    description:"Проверяет профиль выбранной базы, ограничения бухгалтерских/налоговых инструментов и записи. Вызовите перед первой работой с базой; не вызывайте blockedReads; при kazakhstan-limited записывайте только инструментами из kazakhstanWrites.",
    inputSchema:{database:databaseField},outputSchema:z.object({database:z.string(),profile:z.string(),blockedReads:z.array(z.string()),writePolicy:z.string()}).passthrough(),
  },({database})=>guard("read.system.capabilities",async()=>ok(await capabilities(ctx,database))));
}
