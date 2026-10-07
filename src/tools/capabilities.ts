import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { guard,ok,databaseField } from "./_shared.js";
import { KZ_WRITE_TOOLS } from "./write-kz.js";

// Balances and turnovers read the Kazakhstan Типовой register (odata_accounting); these still assume Russian
// accounts, posting fields or tax-payment operations and stay blocked there.
const russianAccounting = new Set([
  "read.analytics.get_inventory","read.accounting.get_document_postings","read.analytics.get_taxes_paid",
]);
const kzReadReason = "Этот инструмент использует российский план счетов/налоговые правила. Для казахстанской базы нужен проверенный профиль учета; не предлагайте опубликовать российский Хозрасчетный и не считайте отказ нулевым остатком.";
// Kazakhstan writes cover the invoice path (counterparty, nomenclature, contract, invoice); documents with
// postings (shipments, receipts, payments) still assume Russian accounts and VAT.
const kzWriteReason = `В казахстанской базе пока доступна запись: ${KZ_WRITE_TOOLS.join(", ")}. Документы с проводками (реализация, поступление, деньги и др.) ещё не настроены под казахстанские счета и НДС.`;

export async function capabilities(ctx: ServerContext,database?:string) {
  const conn=ctx.db(database);
  // Without metadata the base keeps upstream behaviour: no Kazakhstan profile, nothing blocked.
  const meta=typeof (conn as {getMetadata?:unknown}).getMetadata==="function" ? await conn.getMetadata() : {entities:new Map<string,{properties:{name:string}[]}>()};
  const cp=meta.entities.get("Catalog_Контрагенты");
  const kz=meta.entities.has("ChartOfAccounts_Типовой") || !!cp?.properties.some(p=>p.name==="ИдентификационныйКодЛичности");
  return {database:conn.cfg.name,profile:kz?"kazakhstan":"upstream-russian-or-custom",
    blockedReads:kz?[...russianAccounting]:[],
    writePolicy:kz?"kazakhstan-limited":"preview-and-confirmation",
    ...(kz?{kazakhstanWrites:[...KZ_WRITE_TOOLS]}:{}),
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
}

export function registerCapabilities(server:McpServer,ctx:ServerContext) {
  server.registerTool("read.system.capabilities",{
    title:"Доступные возможности и ограничения 1С",
    description:"Проверяет профиль выбранной базы, ограничения бухгалтерских/налоговых инструментов и записи. Вызовите перед первой работой с базой; не вызывайте blockedReads; при kazakhstan-limited записывайте только инструментами из kazakhstanWrites.",
    inputSchema:{database:databaseField},outputSchema:z.object({database:z.string(),profile:z.string(),blockedReads:z.array(z.string()),writePolicy:z.string()}).passthrough(),
  },({database})=>guard("read.system.capabilities",async()=>ok(await capabilities(ctx,database))));
}
