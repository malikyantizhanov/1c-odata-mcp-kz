import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { DOCUMENTS } from "../src/config/mapping.js";
import { attachmentBytes } from "../src/tools/kz-records.js";

/** Зарплата, ЭСФ, цены и файлы — на подделке подключения с данными в форме, как их отдаёт 1С:Fresh.kz. */
type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const PERSON = "00000000-0000-4000-8000-0000000000a1";
const EMPLOYEE = "00000000-0000-4000-8000-0000000000a2";
const KIND = "00000000-0000-4000-8000-0000000000a3";
const OWNER = "00000000-0000-4000-8000-0000000000a4";
const FILE = "00000000-0000-4000-8000-0000000000a5";
const PDF = Buffer.from("%PDF-1.4\n%test\n");

function connection(
  rows: Record<string, Array<Record<string, unknown>>>,
  entity: Record<string, unknown> = {},
) {
  const paths: string[] = [];
  return {
    paths,
    conn: {
      cfg: { name: "default" },
      behavior: { pageSize: 100, maxRows: 1000, analyticsMaxRows: 10000 },
      getMetadata: async () => ({ entities: new Map([["ChartOfAccounts_Типовой", { properties: [] }]]) }),
      available: async () =>
        new Set([
          ...Object.keys(rows).map((k) => k.split("/")[0]!),
          "Catalog_ФизическиеЛица",
          "Catalog_Контрагенты",
        ]),
      client: {
        getEntity: async (path: string) => (paths.push(path), entity),
        getCollection: async (path: string) => {
          paths.push(decodeURIComponent(path));
          const key = Object.keys(rows)
            .sort((a, b) => b.length - a.length)
            .find((k) => path.startsWith(k) || decodeURIComponent(path).startsWith(k));
          return { value: key ? rows[key]! : [] };
        },
      },
    },
  };
}
const call = async (conn: unknown, tool: string, args: Record<string, unknown> = {}) =>
  await toolsOf(conn)[tool]!.handler({ database: "default", ...args }, {});
const data = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

describe("зарплата", () => {
  it("долг по зарплате — сумма остатков по месяцам, без точки в конце ФИО", async () => {
    const { conn } = connection({
      "AccumulationRegister_ВзаиморасчетыСРаботникамиОрганизаций/Balance": [
        {
          Физлицо_Key: PERSON,
          ПериодВзаиморасчетов: "2026-01-01T00:00:00",
          СуммаВзаиморасчетовBalance: 517118.4,
        },
        {
          Физлицо_Key: PERSON,
          ПериодВзаиморасчетов: "2026-02-01T00:00:00",
          СуммаВзаиморасчетовBalance: 517118.4,
        },
      ],
      Catalog_ФизическиеЛица: [{ Ref_Key: PERSON, Description: "Касымова Диана Сериковна." }],
    });
    const d = data(await call(conn, "read.payroll.get_salary_debts", { byMonth: true }));
    expect(d).toMatchObject({ totalOwed: 1034236.8, count: 1 });
    expect((d["people"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      person: "Касымова Диана Сериковна",
      amount: 1034236.8,
      months: [
        { month: "2026-01", amount: 517118.4 },
        { month: "2026-02", amount: 517118.4 },
      ],
    });
  });

  it("начисления: по сотрудникам и видам расчёта из строк проведённых документов", async () => {
    const { conn, paths } = connection({
      Document_НачислениеЗарплатыРаботникамОрганизаций: [
        { Ref_Key: "d1", Начисления: [{ Сотрудник_Key: EMPLOYEE, ВидРасчета_Key: KIND, Результат: 600000 }] },
        { Ref_Key: "d2", Начисления: [{ Сотрудник_Key: EMPLOYEE, ВидРасчета_Key: KIND, Результат: 600000 }] },
      ],
      Catalog_СотрудникиОрганизаций: [{ Ref_Key: EMPLOYEE, Description: "Касымова Диана Сериковна." }],
      ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций: [
        { Ref_Key: KIND, Description: "Оклад по дням" },
      ],
    });
    const d = data(await call(conn, "read.payroll.get_accruals", { from: "2026-01-15", to: "2026-02-28" }));
    expect(d).toMatchObject({ total: 1200000, documents: 2 });
    expect((d["employees"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      employee: "Касымова Диана Сериковна",
      kinds: [{ kind: "Оклад по дням", amount: 1200000 }],
    });
    expect(paths.find((p) => p.startsWith("Document_"))).toContain(
      "ПериодРегистрации ge datetime'2026-01-01T00:00:00'",
    );
  });
});

describe("ЭСФ, цены, банк", () => {
  it("ЭСФ: фильтр по статусу и имя контрагента", async () => {
    const { conn, paths } = connection({
      Document_ЭСФ: [
        {
          Ref_Key: "e1",
          Number: "1",
          Date: "2026-10-01T00:00:00",
          Статус: "Доставлен",
          Контрагент_Key: OWNER,
          СуммаДокумента: 1000,
        },
      ],
      Catalog_Контрагенты: [{ Ref_Key: OWNER, Description: "ТОО Покупатель" }],
    });
    const d = data(await call(conn, "read.esf.list_esf", { status: "Доставлен", limit: 50, offset: 0 }));
    expect((d["esf"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      number: "1",
      status: "Доставлен",
      counterparty: "ТОО Покупатель",
      amount: 1000,
    });
    expect(paths.find((p) => p.startsWith("Document_ЭСФ"))).toContain("Статус eq 'Доставлен'");
  });

  it("цены: срез последних на наборе записей регистра, подчинённого регистратору", async () => {
    const { conn, paths } = connection({
      "InformationRegister_ЦеныНоменклатуры_RecordType/SliceLast": [
        { Номенклатура_Key: OWNER, Цена: 2500, Period: "2026-09-01T00:00:00" },
      ],
      InformationRegister_ЦеныНоменклатуры: [],
      Catalog_Номенклатура: [{ Ref_Key: OWNER, Description: "Одежда" }],
    });
    const d = data(
      await call(conn, "read.nomenclature.get_prices", { nomenclatureRefs: [OWNER], asOf: "2026-10-07" }),
    );
    expect((d["prices"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      nomenclature: "Одежда",
      price: 2500,
      since: "2026-09-01",
    });
    expect(
      paths.some((p) =>
        p.startsWith(
          "InformationRegister_ЦеныНоменклатуры_RecordType/SliceLast(Period=datetime'2026-10-07T23:59:59')",
        ),
      ),
    ).toBe(true);
  });

  it("банк Казахстана входит в документы движения денег", () => {
    expect(DOCUMENTS.bankIn).toContain("Document_ПлатежноеПоручениеВходящее");
    expect(DOCUMENTS.bankOut).toContain("Document_ПлатежноеПоручениеИсходящее");
    expect(DOCUMENTS.bankIn[0]).toBe("Document_ПоступлениеНаРасчетныйСчет");
  });
});

describe("присоединённые файлы", () => {
  it("содержимое: сырой и упакованный PDF узнаются, прочее — как есть", () => {
    expect(attachmentBytes(PDF.toString("base64"))).toMatchObject({ decoded: "raw" });
    const packed = attachmentBytes(deflateRawSync(PDF).toString("base64"));
    expect(packed.decoded).toBe("inflated");
    expect(packed.bytes.equals(PDF)).toBe(true);
    expect(attachmentBytes(Buffer.from("опаньки").toString("base64")).decoded).toBe("unknown");
  });

  it("список файлов ищется в справочнике владельца, файл отдаётся ресурсом с MIME", async () => {
    const { conn, paths } = connection(
      {
        Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы: [
          { Ref_Key: FILE, Description: "Счёт 1", Расширение: "pdf", Размер: 15 },
        ],
      },
      {
        Description: "Счёт 1",
        Расширение: "pdf",
        ТипХраненияФайла: "ВИнформационнойБазе",
        ФайлХранилище_Base64Data: PDF.toString("base64"),
      },
    );
    const list = data(
      await call(conn, "read.files.list_attachments", {
        entitySet: "Document_СчетНаОплатуПокупателю",
        ref: OWNER,
      }),
    );
    expect(list).toMatchObject({
      filesCatalog: "Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы",
      count: 1,
    });
    expect(paths.find((p) => p.startsWith("Catalog_"))).toContain(`ВладелецФайла_Key eq guid'${OWNER}'`);
    const res = await call(conn, "read.files.get_attachment", {
      filesCatalog: "Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы",
      ref: FILE,
      maxBytes: 1000,
    });
    expect(data(res)).toMatchObject({ name: "Счёт 1.pdf", mimeType: "application/pdf", decoded: "raw" });
    const resource = res.content.find((c) => c.type === "resource") as {
      resource: { blob: string; mimeType: string };
    };
    expect(Buffer.from(resource.resource.blob, "base64").equals(PDF)).toBe(true);
  });

  it("файл в томе на диске — понятный отказ", async () => {
    const { conn } = connection(
      { Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы: [] },
      { Description: "x", Расширение: "pdf", ТипХраненияФайла: "ВТомахНаДиске" },
    );
    const res = await call(conn, "read.files.get_attachment", {
      filesCatalog: "Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы",
      ref: FILE,
      maxBytes: 1000,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("томе на диске");
  });
});
