import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { ensurePublished } from "../odata/publication.js";
import { createResultSchema } from "../schemas/output.js";
import { databaseField, guard, organizationField } from "./_shared.js";
import { resolveCatalogItem } from "./catalog-lookup.js";
import { resolveAccountCodes } from "./kz-flow.js";
import { accountLayout, placeAnalytics, STAGES, type Stage } from "./subconto.js";
import { confirmField, createOrPreview } from "./write.js";
import { prepareDocument } from "./write-documents.js";

const RECEIPT = "Document_ПоступлениеТоваровУслуг";
const ARTICLES = "Catalog_СтатьиЗатрат";
const DEPARTMENTS = "Catalog_ПодразделенияОрганизаций";
const GROUPS = "Catalog_НоменклатурныеГруппы";
const COUNTERPARTIES = "Catalog_Контрагенты";

const analyticsFields = {
  expenseAccount: z
    .string()
    .optional()
    .describe(
      "Счёт затрат БУ: код Типового плана ('7210', '7110', '8110') или Ref_Key. Субконто зависят от счёта",
    ),
  taxExpenseAccount: z
    .string()
    .optional()
    .describe("Счёт затрат НУ: код Налогового плана ('7210Н') или Ref_Key"),
  costArticle: z
    .string()
    .optional()
    .describe(
      "Статья затрат: название (точное или часть) или Ref_Key из read.catalog.list_catalog (Catalog_СтатьиЗатрат)",
    ),
  department: z
    .string()
    .optional()
    .describe("Подразделение: название или Ref_Key (Catalog_ПодразделенияОрганизаций)"),
  subcontoCounterparty: z
    .string()
    .optional()
    .describe(
      "Контрагент для субконто «Контрагенты» (название, код или Ref_Key); по умолчанию — контрагент документа. " +
        "Подставляется в любой слот СубконтоЗатратБУn/НУn, где вид субконто счёта «Контрагенты»",
    ),
  nomenclatureGroup: z
    .string()
    .optional()
    .describe("Номенклатурная группа: название или Ref_Key — только если у счёта есть такое субконто"),
};

const line = z.object({
  nomenclatureRef: z.string().describe("Ref_Key номенклатуры (услуги)"),
  content: z.string().optional().describe("Содержание услуги (печатается в документе)"),
  quantity: z.number().positive().default(1),
  price: z.number().min(0).describe("Цена за единицу"),
  amount: z.number().min(0).optional().describe("Сумма строки; по умолчанию количество × цена"),
  vatRateRef: z
    .string()
    .optional()
    .describe("Ref_Key ставки НДС (Catalog_СтавкиНДС); без неё СтавкаНДС не задаётся"),
  vatAmount: z.number().min(0).optional().describe("Сумма НДС строки (1С её не пересчитывает)"),
  ...analyticsFields,
});

type Line = z.infer<typeof line>;
type Row = Record<string, unknown>;

export function registerServicesReceiptTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.purchase.create_services_receipt",
    {
      title: "Создать поступление услуг (со статьёй затрат и подразделением)",
      description:
        "Создаёт НЕПРОВЕДЁННЫЙ документ «Поступление товаров и услуг» (ВидОперации=Услуги) с табличной частью «Услуги» " +
        "и аналитикой затрат — для расходов без склада: проценты и вознаграждение по займу, услуги банка, аренда, " +
        "консультации. Статья затрат и подразделение — это субконто счёта затрат (не отдельные реквизиты): " +
        "укажите expenseAccount ('7210', '7310'), costArticle (код '000000104', название или Ref_Key) и department " +
        "(поиск — read.catalog.list_catalog); контрагент в субконто «Контрагенты» (напр. у 7310) берётся из " +
        "counterpartyRef или subcontoCounterparty. Статья, которой нет у счёта БУ, — ошибка; подразделение, группа, " +
        "контрагент и всё по НУ — предупреждение с пропуском; пустые слоты субконто тоже перечисляются в notes; " +
        "сервер сам положит их в нужные слоты СубконтоЗатратБУn и допишет _Type " +
        "(StandardODATA.Catalog_СтатьиЗатрат и т.д.) по субконто счёта. Валюта и курс: currencyRef, exchangeRate, " +
        "rateMultiplicity; счета расчётов: settlementAccount ('3310'), advanceAccount ('1610'). Сумму, ставку и курс " +
        "считаете сами — 1С их не пересчитывает. Предпросмотр (confirm=false) в notes показывает итоговые субконто " +
        "по строкам и предупреждает о незаполненных счетах расчётов и пустой статье затрат; создание — confirm=true " +
        "после согласия пользователя. Проведение — write.document.post_document. Пример: " +
        '{"counterpartyRef":"<GUID>","contractRef":"<GUID>","expenseAccount":"7210","costArticle":"Прочие расходы",' +
        '"department":"Администрация","settlementAccount":"3310","lines":[{"nomenclatureRef":"<GUID услуги>",' +
        '"content":"Вознаграждение по займу за сентябрь","price":125000}]}.',
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        counterpartyRef: z.string().describe("Ref_Key контрагента-поставщика"),
        contractRef: z.string().optional().describe("Ref_Key договора (вид «СПоставщиком»)"),
        date: z.string().optional().describe("Дата документа YYYY-MM-DD (по умолчанию сегодня)"),
        comment: z.string().optional().describe("Комментарий (напр. расчёт ставки овернайт)"),
        incomingNumber: z.string().optional().describe("Номер входящего документа поставщика"),
        incomingDate: z.string().optional().describe("Дата входящего документа YYYY-MM-DD"),
        currencyRef: z.string().optional().describe("Ref_Key валюты документа (ВалютаДокумента_Key)"),
        exchangeRate: z.number().positive().optional().describe("Курс взаиморасчётов (КурсВзаиморасчетов)"),
        rateMultiplicity: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Кратность (КратностьВзаиморасчетов)"),
        settlementAccount: z
          .string()
          .optional()
          .describe("Счёт расчётов с контрагентом: код ('3310') или Ref_Key"),
        advanceAccount: z.string().optional().describe("Счёт расчётов по авансам: код ('1610') или Ref_Key"),
        sumIncludesVat: z.boolean().optional().describe("Сумма включает НДС"),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .default({})
          .describe("Другие реквизиты шапки по $metadata (как в create_document)"),
        sampleRef: z
          .string()
          .optional()
          .describe("Ref_Key проведённого поступления того же вида — взять недостающие настройки учёта"),
        ...analyticsFields,
        lines: z
          .array(line)
          .min(1)
          .describe("Строки «Услуги»; аналитика строки перекрывает аналитику документа"),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    (a) =>
      guard("write.purchase.create_services_receipt", async () => {
        const conn = ctx.db(a.database);
        ensurePublished(await conn.available(), RECEIPT, "Документ «Поступление товаров и услуг»");
        const meta = await conn.getMetadata();
        const em = meta.entities.get(RECEIPT);
        if (!em) throw new InputError(`Документа ${RECEIPT} нет в $metadata базы.`);
        const rowMeta = meta.entities.get(`${RECEIPT}_Услуги`);
        const pick = (l: Line, k: keyof typeof analyticsFields): string | undefined => l[k] ?? a[k];
        const lookups = new Map<string, Promise<string>>();
        const lookup = (entity: string, value: string | undefined, label: string) => {
          if (!value) return Promise.resolve(undefined);
          const key = `${entity}|${value}`;
          if (!lookups.has(key))
            lookups.set(
              key,
              resolveCatalogItem(conn, entity, value, label).then((r) => r.ref),
            );
          return lookups.get(key)!;
        };
        // Счета затрат строк: коды → Ref_Key одним запросом на план.
        const stubs = a.lines.map((l) => ({
          ...(pick(l, "expenseAccount") ? { СчетЗатратБУ_Key: pick(l, "expenseAccount")! } : {}),
          ...(pick(l, "taxExpenseAccount") ? { СчетЗатратНУ_Key: pick(l, "taxExpenseAccount")! } : {}),
        }));
        const resolvedAccounts = (
          (await resolveAccountCodes(conn, em, { Услуги: stubs })).payload["Услуги"] as Row[]
        ).map((r) => r);
        const notes: string[] = [];
        const layouts = new Map<string, ReturnType<typeof accountLayout>>();
        const layoutOf = (stage: Stage, ref: string) => {
          const chart =
            rowMeta?.navigations
              ?.find((n) => n.name === `СчетЗатрат${stage}`)
              ?.toType.replace(/^StandardODATA\./, "") ??
            (stage === "БУ" ? "ChartOfAccounts_Типовой" : "ChartOfAccounts_Налоговый");
          const key = `${chart}|${ref}`;
          if (!layouts.has(key)) layouts.set(key, accountLayout(conn, chart, ref));
          return layouts.get(key)!;
        };
        const rows: Row[] = [];
        for (const [i, l] of a.lines.entries()) {
          const where = `Услуги, строка ${i + 1}`;
          const qty = l.quantity ?? 1;
          const article = await lookup(ARTICLES, pick(l, "costArticle"), "Статья затрат");
          const department = await lookup(DEPARTMENTS, pick(l, "department"), "Подразделение");
          const group = await lookup(GROUPS, pick(l, "nomenclatureGroup"), "Номенклатурная группа");
          const cpExplicit = await lookup(
            COUNTERPARTIES,
            pick(l, "subcontoCounterparty"),
            "Контрагент (субконто)",
          );
          const want = { article, department, group, counterparty: cpExplicit ?? a.counterpartyRef };
          const explicit = !!(article || department || group || cpExplicit);
          const quiet = cpExplicit ? [] : (["counterparty"] as const);
          const row: Row = {
            Номенклатура_Key: l.nomenclatureRef,
            ...(l.content === undefined ? {} : { Содержание: l.content }),
            Количество: qty,
            Цена: l.price,
            Сумма: l.amount ?? Math.round(qty * l.price * 100) / 100,
            ...(l.vatRateRef ? { СтавкаНДС_Key: l.vatRateRef } : {}),
            ...(l.vatAmount === undefined ? {} : { СуммаНДС: l.vatAmount }),
            ...resolvedAccounts[i],
          };
          for (const stage of STAGES) {
            const acc = row[`СчетЗатрат${stage}_Key`];
            if (typeof acc !== "string") {
              if (explicit && stage === "БУ")
                throw new InputError(
                  `${where}: статья затрат/подразделение — субконто счёта затрат; укажите expenseAccount (напр. '7210').`,
                );
              continue;
            }
            const layout = await layoutOf(stage, acc);
            if (!layout) {
              if (explicit && stage === "БУ")
                throw new InputError(
                  `${where}: счёт затрат ${acc} не прочитан в плане счетов — не удалось определить субконто.`,
                );
              notes.push(
                `${where}: счёт затрат ${stage} не прочитан в плане счетов — субконто не определены.`,
              );
              continue;
            }
            // Статья затрат обязательна для БУ-счёта (ошибка, если у счёта нет такого субконто); остальное и всё по НУ —
            // предупреждение: налоговый счёт часто устроен иначе, и пропуск лучше, чем отказ.
            const placed = placeAnalytics(layout, stage, want, { strict: stage === "БУ", quiet });
            if (placed.error) throw new InputError(`${where}: ${placed.error}`);
            Object.assign(row, placed.fields);
            notes.push(...placed.warnings.map((w) => `${where}: ${w}`));
          }
          rows.push(row);
        }
        const total = Math.round(rows.reduce((s, r) => s + Number(r["Сумма"] ?? 0), 0) * 100) / 100;
        const date = (d?: string) => (d ? (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d) : undefined);
        const header: Record<string, string | number | boolean | null> = {
          ВидОперации: "Услуги",
          Контрагент_Key: a.counterpartyRef,
          ...(a.contractRef ? { ДоговорКонтрагента_Key: a.contractRef } : {}),
          ...(a.comment ? { Комментарий: a.comment } : {}),
          ...(a.incomingNumber ? { НомерВходящегоДокумента: a.incomingNumber } : {}),
          ...(a.incomingDate ? { ДатаВходящегоДокумента: date(a.incomingDate)! } : {}),
          ...(a.currencyRef ? { ВалютаДокумента_Key: a.currencyRef } : {}),
          ...(a.exchangeRate === undefined ? {} : { КурсВзаиморасчетов: a.exchangeRate }),
          ...(a.rateMultiplicity === undefined ? {} : { КратностьВзаиморасчетов: a.rateMultiplicity }),
          ...(a.settlementAccount ? { СчетУчетаРасчетовСКонтрагентом_Key: a.settlementAccount } : {}),
          ...(a.advanceAccount ? { СчетУчетаРасчетовПоАвансам_Key: a.advanceAccount } : {}),
          ...(a.sumIncludesVat === undefined ? {} : { СуммаВключаетНДС: a.sumIncludesVat }),
          СуммаДокумента: total,
          ...(a.fields ?? {}),
        };
        const prepared = await prepareDocument(conn, {
          organization: a.organization,
          entitySet: RECEIPT,
          date: a.date,
          fields: header,
          tables: { Услуги: rows as Array<Record<string, string | number | boolean | null>> },
          sampleRef: a.sampleRef,
        });
        notes.push(...prepared.notes);
        if (!a.settlementAccount && !a.sampleRef)
          notes.push(
            "Счёт расчётов с контрагентом не задан: передайте settlementAccount ('3310') и при зачёте аванса advanceAccount ('1610') — иначе проводка уйдёт на пустой счёт.",
          );
        notes.push(
          `СуммаДокумента = ${total} (сумма строк; НДС сверх суммы 1С не добавляет — проверьте sumIncludesVat и vatAmount).`,
        );
        return createOrPreview(conn, RECEIPT, prepared.payload, a.confirm ?? false, notes);
      }),
  );
}

export type { Connection };
