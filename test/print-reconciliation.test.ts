import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { actRowDate, debtStatement, renderReconciliationPdf } from "../src/print/reconciliation-pdf.js";
import { documentTitle } from "../src/print/doc-titles.js";
import { reconciliationPrintData } from "../src/tools/print-reconciliation.js";

/**
 * Акт сверки (Казахстан): данные как в печатной форме 1С (образец из 1С:Fresh.kz — акт № 2 между ИП «Aru Market» и
 * ТОО «TRADESPACE»), строка задолженности, PDF и сохранение без перезаписи.
 */
type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const roots: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "1c-act-test-")));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACT = id(1);
const SALE = id(2);
const ACT_SET = "Document_АктСверкиВзаиморасчетов";

function connection(printDir?: string) {
  const entities: Record<string, Record<string, unknown>> = {
    [`${ACT_SET}(guid'${ACT}')`]: {
      Number: "00000000002",
      Date: "2026-10-09T14:30:53",
      ДатаНачала: "0001-01-01T00:00:00",
      ДатаОкончания: "2026-10-09T00:00:00",
      Организация_Key: id(3),
      Контрагент_Key: id(4),
      ДоговорКонтрагента_Key: id(5),
      ВалютаДокумента_Key: id(6),
      ОстатокНаНачало: 0,
      СверкаСогласована: false,
      ПоДаннымОрганизации: [
        {
          Дата: "2026-10-09T00:00:00",
          Документ: SALE,
          Документ_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
          Дебет: 1000000,
          Кредит: 0,
        },
      ],
      ПоДаннымКонтрагента: [
        {
          Дата: "2026-10-09T00:00:00",
          Документ: "",
          Документ_Type: "StandardODATA.Undefined",
          Дебет: 0,
          Кредит: 1000000,
        },
      ],
    },
    [`Catalog_Организации(guid'${id(3)}')`]: {
      НаименованиеПолное: 'Индивидуальный предприниматель "Aru Market"',
      ИдентификационныйНомер: "123123123123",
      ЮрФизЛицо: "ФизЛицо",
    },
    [`Catalog_Контрагенты(guid'${id(4)}')`]: {
      НаименованиеПолное: 'Товарищество с ограниченной ответственностью "TRADESPACE"',
      ИдентификационныйКодЛичности: "240440007327",
      ЮрФизЛицо: "ЮрЛицо",
    },
    [`Catalog_ДоговорыКонтрагентов(guid'${id(5)}')`]: { Description: "Договор б/н" },
    [`Catalog_Валюты(guid'${id(6)}')`]: {
      Description: "KZT",
      ПараметрыПрописиНаРусском: "теңге, теңге, теңге, м, тиын, тиын, тиын, м, 2",
    },
  };
  const collections: Record<string, Array<Record<string, unknown>>> = {
    Document_РеализацияТоваровУслуг: [{ Ref_Key: SALE, Number: "00000000019", Date: "2026-10-09T14:30:29" }],
    [ACT_SET]: [{ Ref_Key: ACT, Number: "00000000002", Date: "2026-10-09T14:30:53", Posted: true }],
  };
  const paths: string[] = [];
  const props = (...names: string[]) => ({ properties: names.map((name) => ({ name, type: "Edm.String" })) });
  return {
    paths,
    conn: {
      cfg: { name: "default" },
      behavior: { pageSize: 100, maxRows: 1000, ...(printDir ? { printDir } : {}) },
      getMetadata: async () => ({
        entities: new Map([
          ["ChartOfAccounts_Типовой", props()],
          [ACT_SET, props("Ref_Key", "Number", "Date", "Posted", "DeletionMark")],
        ]),
      }),
      available: async () => new Set([ACT_SET, "Document_РеализацияТоваровУслуг"]),
      client: {
        getEntity: async (path: string) =>
          entities[Object.keys(entities).find((k) => path.startsWith(k)) ?? ""] ?? {},
        getCollection: async (path: string) => {
          paths.push(path);
          return { value: collections[Object.keys(collections).find((k) => path.startsWith(k)) ?? ""] ?? [] };
        },
      },
    },
  };
}

describe("акт сверки: данные как в печатной форме 1С", () => {
  it("стороны с ИИН/БИН, договор, строки обеих сторон, документ «Реализация ТМЗ и услуг 19 от 09.10.2026»", async () => {
    const d = await reconciliationPrintData(connection().conn as never, ACT);
    expect(d.closing).toBe(1000000);
    expect(d.form).toMatchObject({
      number: "2",
      periodEnd: "2026-10-09",
      organization: { name: 'Индивидуальный предприниматель "Aru Market"', id: "ИИН: 123123123123" },
      counterparty: {
        name: 'Товарищество с ограниченной ответственностью "TRADESPACE"',
        id: "БИН: 240440007327",
      },
      contract: "Договор б/н",
      currency: "KZT",
      agreed: false,
      amountWords: "Один миллион теңге 00 тиын",
    });
    expect(d.form.periodStart).toBeUndefined();
    expect(d.form.organizationRows).toEqual([
      { date: "2026-10-09", document: "Реализация ТМЗ и услуг 19 от 09.10.2026", debit: 1000000, credit: 0 },
    ]);
    expect(d.form.counterpartyRows).toEqual([
      { date: "2026-10-09", document: undefined, debit: 0, credit: 1000000 },
    ]);
    expect(d.notes.join(" ")).toMatch(/не согласована/);
  });

  it("задолженность — в пользу той стороны, у которой сальдо; нет сальдо — «отсутствует»", async () => {
    const { form } = await reconciliationPrintData(connection().conn as never, ACT);
    expect(debtStatement(form, 1000000)).toBe(
      'на 09.10.2026 задолженность  в пользу Индивидуальный предприниматель "Aru Market"  1 000 000,00  KZT (Один миллион теңге 00 тиын)',
    );
    expect(debtStatement(form, -5)).toMatch(
      /в пользу Товарищество с ограниченной ответственностью "TRADESPACE" {2}5,00 {2}KZT/,
    );
    expect(debtStatement(form, 0)).toBe("на 09.10.2026 задолженность отсутствует");
    expect(actRowDate("2026-10-09")).toBe("09.10.26");
    expect(documentTitle("StandardODATA.Document_ПлатежноеПоручениеВходящее")).toBe(
      "Платежное поручение входящее",
    );
  });
});

describe("read.document.print_reconciliation", () => {
  it("по номеру (без «СуммаДокумента» в $select): PDF в «акты сверки», повтор — « (2)»", async () => {
    const root = tmp();
    const { conn, paths } = connection(root);
    const tool = toolsOf(conn)["read.document.print_reconciliation"]!;
    const res = await tool.handler({ database: "default", number: "2", year: 2026 }, {});
    const name = "Акт сверки № 2 от 09.10.2026.pdf";
    expect(res.isError).toBeFalsy();
    expect(paths.filter((p) => p.startsWith(ACT_SET)).every((p) => !p.includes("СуммаДокумента"))).toBe(true);
    expect(res.structuredContent).toMatchObject({
      number: "2",
      closing: 1000000,
      path: join(root, "акты сверки", name),
    });
    expect(
      readFileSync(join(root, "акты сверки", name))
        .subarray(0, 4)
        .toString(),
    ).toBe("%PDF");
    const again = await tool.handler({ database: "default", number: "2", year: 2026 }, {});
    expect(again.structuredContent!["path"]).toBe(
      join(root, "акты сверки", "Акт сверки № 2 от 09.10.2026 (2).pdf"),
    );
  });

  it("много строк — таблица переносится на следующую страницу", async () => {
    const { form } = await reconciliationPrintData(connection().conn as never, ACT);
    const rows = Array.from({ length: 90 }, () => form.organizationRows[0]!);
    const pdf = await renderReconciliationPdf({ ...form, organizationRows: rows });
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
