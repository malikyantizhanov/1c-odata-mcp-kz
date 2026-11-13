import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { REGISTERS } from "../config/mapping.js";
import { resolveAccounts } from "../odata/accounting.js";
import { requireEntity } from "../odata/publication.js";
import { fetchAll } from "../odata/pagination.js";
import { resolveOrganization } from "../odata/orgs.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard, ok, organizationField } from "./_shared.js";

/**
 * Карточка счёта: движения регистра бухгалтерии по счёту (и субсчетам) за период, по документам, новые первыми.
 * Отвечает на «когда была последняя операция по счёту / по банковскому счёту / по сотруднику», в том числе в базах,
 * где сами документы (банковские, кассовые) не опубликованы в OData, а регистр — опубликован.
 */
export const ACCOUNT_CARD_TOOL = "read.accounting.get_account_card";

const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const MAX_RECORDS = 20000;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const round2 = (n: number): number => Math.round(n * 100) / 100;
const sideFields = (side: "Dr" | "Cr"): string[] => [1, 2, 3].map((i) => `ExtDimension${side}${i}`);

export interface AccountCardRow {
  date: string;
  documentRef: string;
  documentType: string;
  /** Оборот по дебету счёта (для 1030 — поступление), тенге. */
  debit: number;
  /** Оборот по кредиту счёта (для 1030 — списание), тенге. */
  credit: number;
  currencyDebit?: number;
  currencyCredit?: number;
  content?: string;
}

export interface AccountCardParams {
  account: string;
  from: string;
  to: string;
  limit: number;
  org?: string | undefined;
  subconto?: string | undefined;
}

export interface AccountCard {
  accounts: string[];
  rows: AccountCardRow[];
  lastDate: string | null;
  documents: number;
  truncated: boolean;
}

/** Движения по счёту за период, свёрнутые по документам; новые первыми, не больше limit. */
export async function accountCard(conn: Connection, p: AccountCardParams): Promise<AccountCard> {
  if (p.from > p.to) throw new InputError(`Период задан наоборот: from (${p.from}) позже to (${p.to}).`);
  if (p.subconto && !GUID_RE.test(p.subconto))
    throw new InputError("subconto — Ref_Key (GUID) значения субконто.");
  const reg = await requireEntity(conn, REGISTERS.accounting, "Регистр бухгалтерии «Хозрасчётный»");
  const accounts = await resolveAccounts(conn, [p.account]);
  if (accounts.length === 0) throw new InputError(`Счёт "${p.account}" не найден в плане счетов базы.`);
  const keys = new Set(accounts.map((a) => a.key));
  const sub = p.subconto ? p.subconto.replace(/[{}]/g, "").toLowerCase() : "";

  // Отбор — у нас, не в $filter: 1С (БК для Казахстана, прод 13.11.2026) на $filter по полям
  // RecordsWithExtDimensions — и по организации, и по субконто — отвечает 500 «Операция не разрешена в
  // предложении ГДЕ»; ссылку в Condition не передать, $orderby игнорируется. Проводок немного (≈3,3 тыс. за год
  // в средней базе) — берём период целиком; сузить нагрузку — коротким периодом.
  const path =
    `${reg}/RecordsWithExtDimensions(StartPeriod=datetime'${p.from}T00:00:00',` +
    `EndPeriod=datetime'${p.to}T23:59:59')`;
  const { rows: records, truncated } = await fetchAll(conn.client, path, {}, 500, MAX_RECORDS);
  const org = p.org ? p.org.replace(/[{}]/g, "").toLowerCase() : "";

  const hasSub = (r: ODataEntity, side: "Dr" | "Cr"): boolean =>
    !sub || sideFields(side).some((f) => str(r[f]).toLowerCase() === sub);
  const byDoc = new Map<string, AccountCardRow & { period: string }>();
  for (const r of records) {
    if (r["Active"] === false) continue;
    if (org && str(r["Организация_Key"]).toLowerCase() !== org) continue;
    const dr = keys.has(str(r["AccountDr_Key"])) && hasSub(r, "Dr");
    const cr = keys.has(str(r["AccountCr_Key"])) && hasSub(r, "Cr");
    if (!dr && !cr) continue;
    const period = str(r["Period"]);
    const key = `${str(r["Recorder_Type"])}|${str(r["Recorder"])}`;
    const row = byDoc.get(key) ?? {
      date: period.slice(0, 10),
      period,
      documentRef: str(r["Recorder"]),
      documentType: str(r["Recorder_Type"]).replace(/^StandardODATA\./, ""),
      debit: 0,
      credit: 0,
    };
    const amount = Number(r["Сумма"] ?? 0);
    if (dr) {
      row.debit = round2(row.debit + amount);
      const cur = Number(r["ВалютнаяСуммаDr"] ?? 0);
      if (cur) row.currencyDebit = round2((row.currencyDebit ?? 0) + cur);
    }
    if (cr) {
      row.credit = round2(row.credit + amount);
      const cur = Number(r["ВалютнаяСуммаCr"] ?? 0);
      if (cur) row.currencyCredit = round2((row.currencyCredit ?? 0) + cur);
    }
    if (!row.content && str(r["Содержание"])) row.content = str(r["Содержание"]);
    if (period > row.period) row.period = period;
    byDoc.set(key, row);
  }
  const all = [...byDoc.values()].sort((a, b) => b.period.localeCompare(a.period));
  const rows = all.slice(0, p.limit).map(({ period: _p, ...r }) => ({ ...r, date: _p.slice(0, 10) }));
  return {
    accounts: accounts.map((a) => a.code),
    rows,
    lastDate: rows[0]?.date ?? null,
    documents: all.length,
    truncated,
  };
}

export function registerAccountCardTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    ACCOUNT_CARD_TOOL,
    {
      title: "Карточка счёта",
      description:
        "Движения регистра бухгалтерии по счёту (код или префикс субсчетов: «1030», «1010», «3350») за период — " +
        "по документам, новые первыми: дата, вид и ссылка документа, оборот Дт и Кт (тенге и валюта), содержание. " +
        "Отбор по значению субконто: subconto — Ref_Key (банковский счёт организации из Catalog_БанковскиеСчета с " +
        "владельцем-организацией, контрагент, сотрудник…). lastDate — дата последней операции. Отвечает на «когда была " +
        "последняя операция по счёту Kaspi / по долларовому счёту». Проводки за период читаются целиком — для «последней " +
        "операции» начинайте с короткого периода. Сальдо — read.accounting.get_account_turnover.",
      inputSchema: {
        database: databaseField,
        organization: organizationField,
        account: z.string().trim().min(1).max(20).describe("Код счёта или префикс субсчетов, напр. 1030"),
        from: dateField("Дата начала периода"),
        to: dateField("Дата конца периода"),
        subconto: z.string().trim().max(40).optional().describe("Ref_Key значения субконто для отбора"),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(20)
          .describe("Сколько последних документов вернуть"),
      },
      outputSchema: {
        account: z.string(),
        organization: z.string().optional(),
        period: z.object({ from: z.string(), to: z.string() }),
        accounts: z.array(z.string()).describe("Коды счетов, вошедших в отбор (счёт и субсчета)"),
        rows: z.array(
          z.object({
            date: z.string(),
            documentRef: z.string(),
            documentType: z.string(),
            debit: z.number(),
            credit: z.number(),
            currencyDebit: z.number().optional(),
            currencyCredit: z.number().optional(),
            content: z.string().optional(),
          }),
        ),
        lastDate: z.string().nullable().describe("Дата последней операции за период или null"),
        documents: z.number().describe("Всего документов с движениями за период"),
        truncated: z.boolean(),
        note: z.string().optional(),
      },
    },
    ({ database, organization, account, from, to, subconto, limit = 20 }) =>
      guard(ACCOUNT_CARD_TOOL, async () => {
        const conn = ctx.db(database);
        const org = organization ? await resolveOrganization(conn, organization) : undefined;
        const card = await accountCard(conn, {
          account,
          from,
          to,
          limit,
          org: org?.ref,
          subconto,
        });
        const note = card.truncated
          ? "Записей за период больше предела — сузьте период: последние операции могли не попасть в выборку."
          : undefined;
        return ok({
          account,
          ...(org ? { organization: org.name } : {}),
          period: { from, to },
          ...card,
          ...(note ? { note } : {}),
        });
      }),
  );
}
