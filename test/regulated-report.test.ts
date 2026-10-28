import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { monthlyBreakdown, parseRegulatedReportXml, reportXml } from "../src/odata/regulated-report.js";
import { omitLargeBinary } from "../src/tools/documents.js";

/** ФНО: данные РегламентированныйОтчет (ХранилищеЗначения, XML XDTO) — на синтетическом примере, без данных клиентов. */
const XML = readFileSync("test/fixtures/regulated-report/form200-synthetic.xml", "utf8");
const REF = "00000000-0000-4000-8000-0000000000f1";
const HEAD = {
  Ref_Key: REF,
  Number: "00000000015",
  Date: "2026-10-27T13:50:57",
  Posted: false,
  DeletionMark: false,
  ВыбраннаяФорма: "Форма2002026Кв1",
  НаименованиеОтчета: "Декларация по ИПН и социальному налогу, форма 200.00",
  ДатаНачала: "2026-07-01T00:00:00",
  ДатаОкончания: "2026-09-30T00:00:00",
  Периодичность: "Квартал",
  ДанныеОтчета_Type: "application/xml+xdto",
};

type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
function fake(opts: { text?: () => string; base64?: string } = {}) {
  const paths: string[] = [];
  const conn = {
    cfg: { name: "default" },
    behavior: { pageSize: 100, maxRows: 1000 },
    available: async () => new Set(["Document_РегламентированныйОтчет"]),
    client: {
      getCollection: async (p: string) => (paths.push(decodeURIComponent(p)), { value: [HEAD] }),
      getEntity: async (p: string) => {
        paths.push(decodeURIComponent(p));
        return p.includes("Base64Data") ? { ДанныеОтчета_Base64Data: opts.base64 ?? "" } : HEAD;
      },
      getText: async (p: string) => (paths.push(decodeURIComponent(p)), (opts.text ?? (() => XML))()),
    },
  };
  const tools = (
    createServer({ db: () => conn } as never) as unknown as { _registeredTools: Record<string, Tool> }
  )._registeredTools;
  const call = async (args: Record<string, unknown>) =>
    (await tools["read.reports.regulated_report"]!.handler({ database: "default", ...args }, {}))
      .structuredContent as Record<string, unknown>;
  return { paths, call };
}

describe("разбор данных регламентированного отчёта", () => {
  const parsed = parseRegulatedReportXml(XML);

  it("показатели по кодам строк, номер колонки учитывает <i> и пропуски", () => {
    const sec = parsed.sections.find((s) => s.section === "200.01")!;
    expect(sec.pages).toEqual([1]);
    const line = sec.lines.find((l) => l.code === "200.01.001")!;
    expect(line.columns).toEqual({ "1": 100, "2": 200, "3": 300.5, "4": 600.5, A: 550 });
    expect(line.title).toBe("Начисленные доходы");
    expect(line.columnTitles).toEqual({ A: "А доходы работников" });
    // Пустая ячейка (нет значения в сетке) — строки нет; ИИН с ведущими нулями — строкой.
    expect(sec.lines.map((l) => l.code)).toEqual(["200.01.001"]);
    expect(sec.fields).toEqual({ ИИН_БИН: "000123456789" });
  });

  it("пустой раздел-страница не выдаётся за нули; многострочная таблица, служебные _Расшифровка отброшены", () => {
    expect(parsed.emptySections).toEqual([]);
    expect(parsed.tables).toEqual([
      {
        name: "ТаблицаСтрокГруппыФорма200_05Страница1",
        section: "200.05",
        rows: [{ Ф200_05ИИН: "000000000001", Ф200_05_F: 42 }],
      },
    ]);
    expect(parsed.values).toEqual({ ЧисленностьРаботников1: 3 });
    expect(parsed.comment).toBe("Синтетический пример");
    const noTable = XML.replace(/<row>.*<\/row>/s, "");
    expect(parseRegulatedReportXml(noTable).emptySections).toEqual(["200.05"]);
  });

  it("месяцы квартала и итог с проверкой суммы", () => {
    const line = parsed.sections[0]!.lines[0]!;
    expect(monthlyBreakdown(line, "2026-07-01", "Квартал")).toEqual({
      months: [
        { month: "2026-07", label: "июль 2026", value: 100 },
        { month: "2026-08", label: "август 2026", value: 200 },
        { month: "2026-09", label: "сентябрь 2026", value: 300.5 },
      ],
      quarter: 600.5,
      sumMatches: true,
    });
    expect(
      monthlyBreakdown({ ...line, columns: { ...line.columns, "4": 1 } }, "2026-07-01", "Квартал")
        ?.sumMatches,
    ).toBe(false);
    expect(monthlyBreakdown(line, "2026-01-01", "Год")).toBeUndefined();
    const { "2": _may, ...noMay } = line.columns;
    expect(
      monthlyBreakdown({ ...line, columns: { ...noMay, "4": 400.5 } }, "2026-07-01", "Квартал"),
    ).toMatchObject({ blankMonths: ["2026-08"], quarter: 400.5, sumMatches: true });
  });

  it("хранилище: XML как есть, deflate без заголовка — распаковывается, прочее — понятная ошибка", () => {
    expect(reportXml(Buffer.from(`\uFEFF${XML}`))).toBe(XML);
    expect(reportXml(deflateRawSync(Buffer.from(XML)))).toBe(XML);
    expect(() => reportXml(Buffer.from([1, 2, 3, 4]))).toThrow(/не разбирает/);
  });
});

describe("read.reports.regulated_report", () => {
  it("по номеру: поток ДанныеОтчета/$value целиком, только GET, без base64 в ответе", async () => {
    const { paths, call } = fake();
    const r = await call({ number: "15" });
    expect(r["number"]).toBe("00000000015");
    expect(r["readVia"]).toBe("stream");
    expect(r["dataBytes"]).toBe(Buffer.byteLength(XML));
    expect(
      paths.some((p) => p.endsWith(`Document_РегламентированныйОтчет(guid'${REF}')/ДанныеОтчета/$value`)),
    ).toBe(true);
    const sec = (r["sections"] as Array<{ section: string; lines: Array<Record<string, unknown>> }>)[0]!;
    expect(sec.lines[0]!["months"]).toHaveLength(3);
    expect(sec.lines[0]!["sumMatches"]).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Base64Data");
  });

  it("поток недоступен — запасной путь через ДанныеОтчета_Base64Data", async () => {
    const { call } = fake({
      text: () => {
        throw new Error("404");
      },
      base64: Buffer.from(XML).toString("base64"),
    });
    const r = await call({ ref: REF, section: "200.05" });
    expect(r["readVia"]).toBe("base64");
    expect(r["sections"]).toEqual([]);
    expect((r["tables"] as unknown[]).length).toBe(1);
  });

  it("без ref и number — список отчётов", async () => {
    const { paths, call } = fake();
    const r = await call({ nameContains: "200.00" });
    expect(r["count"]).toBe(1);
    expect(paths[0]).toContain("substringof('200.00', НаименованиеОтчета)");
  });
});

describe("get_document: большие двоичные поля не отдаются", () => {
  it("ДанныеОтчета_Base64Data заменяется пометкой с подсказкой, мелкие поля — как есть", () => {
    const big = "A".repeat(70_000);
    const out = omitLargeBinary(
      { Number: "1", ДанныеОтчета_Base64Data: big, Мелкий_Base64Data: "AAAA" },
      "Document_РегламентированныйОтчет",
    );
    expect(out["Number"]).toBe("1");
    expect(out["Мелкий_Base64Data"]).toBe("AAAA");
    expect(String(out["ДанныеОтчета_Base64Data"])).toMatch(
      /^<двоичные данные ~52500 байт не показаны: .*regulated_report>$/,
    );
  });
});
