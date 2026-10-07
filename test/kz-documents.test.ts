import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { kzPostingWarnings } from "../src/tools/write-kz.js";

/**
 * Общая запись документов казахстанской базы: зарплата, налоги и выплаты. Поля проверяются по $metadata,
 * суммы задаёт вызывающий; проведённый документ не правится, лишние документы отклоняются.
 */

type Tool = { handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult> };
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const ORG = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE = "00000000-0000-4000-8000-000000000002";
const DOC = "00000000-0000-4000-8000-000000000003";
const ACCRUALS = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const WITHHOLDING = "Document_РасчетУдержанийРаботниковОрганизаций";
const PERSON = "00000000-0000-4000-8000-000000000004";

const prop = (name: string, type = "Edm.String") => ({ name, type, nullable: true });

function connection({ kazakhstan = true, posted = false, deleted = false, accrued = false, singlePayment = false } = {}) {
  const entities = new Map<string, { entitySet: string; properties: ReturnType<typeof prop>[] }>([
    ["Catalog_Контрагенты", { entitySet: "Catalog_Контрагенты", properties: [prop(kazakhstan ? "ИдентификационныйКодЛичности" : "ИНН")] }],
    ["Catalog_Организации", { entitySet: "Catalog_Организации", properties: [prop("Ref_Key", "Edm.Guid"), prop("Description")] }],
    [
      ACCRUALS,
      {
        entitySet: ACCRUALS,
        properties: [
          prop("Ref_Key", "Edm.Guid"),
          prop("Posted", "Edm.Boolean"),
          prop("Date", "Edm.DateTime"),
          prop("Организация_Key", "Edm.Guid"),
          prop("ПериодРегистрации", "Edm.DateTime"),
          prop("Комментарий"),
          prop("Начисления", `Collection(StandardODATA.${ACCRUALS}_Начисления_RowType)`),
        ],
      },
    ],
    [
      `${ACCRUALS}_Начисления`,
      {
        entitySet: `${ACCRUALS}_Начисления`,
        properties: [prop("Ref_Key", "Edm.Guid"), prop("LineNumber", "Edm.Int64"), prop("Сотрудник_Key", "Edm.Guid"), prop("Результат", "Edm.Double"), prop("ДатаНачала", "Edm.DateTime")],
      },
    ],
    [
      WITHHOLDING,
      {
        entitySet: WITHHOLDING,
        properties: [prop("Организация_Key", "Edm.Guid"), prop("ПериодРегистрации", "Edm.DateTime"), prop("ФизическиеЛица", `Collection(StandardODATA.${WITHHOLDING}_ФизическиеЛица_RowType)`)],
      },
    ],
    [`${WITHHOLDING}_ФизическиеЛица`, { entitySet: `${WITHHOLDING}_ФизическиеЛица`, properties: [prop("ФизическоеЛицо_Key", "Edm.Guid")] }],
    ...(singlePayment ? [["Document_РасчетЕдиногоПлатежа", { entitySet: "Document_РасчетЕдиногоПлатежа", properties: [] }] as const] : []),
    ["Document_РеализацияТоваровУслуг", { entitySet: "Document_РеализацияТоваровУслуг", properties: [prop("Ref_Key", "Edm.Guid")] }],
    ...(kazakhstan ? [["ChartOfAccounts_Типовой", { entitySet: "ChartOfAccounts_Типовой", properties: [] }] as const] : []),
  ]);
  const patch = vi.fn(async () => ({ Ref_Key: DOC }));
  const conn = {
    cfg: { name: "default", writable: true },
    behavior: { writeOperationMarker: false, pageSize: 100, maxRows: 1000 },
    getMetadata: async () => ({ entities }),
    available: async () => new Set(entities.keys()),
    client: {
      prepareCreate: vi.fn(async () => undefined),
      patch,
      getEntity: async () => ({ Posted: posted, DeletionMark: deleted }),
      getCollection: async (path: string) => ({
        value: path.startsWith("Catalog_Организации")
          ? [{ Ref_Key: ORG, Description: "ТОО Тест" }]
          : path.startsWith(ACCRUALS) && accrued
            ? [{ Number: "00000000011", Date: "2026-08-31T23:59:59", Posted: true, Начисления: [{ Сотрудник_Key: EMPLOYEE, Результат: 600000 }] }]
            : path.startsWith("Document_РасчетЕдиногоПлатежа")
              ? [
                  { Number: "00000000009", Date: "2026-04-30T23:59:59", ИсчисленныйЕП: [{ ФизЛицо_Key: PERSON, СуммаПлатежа: 148642.2 }] },
                  { Number: "00000000013", Date: "2026-04-30T23:59:59", ИсчисленныйЕП: [{ ФизЛицо_Key: PERSON, СуммаПлатежа: 0 }] },
                ]
              : [],
      }),
    },
  };
  return { conn, patch };
}

const call = async (tool: string, args: Record<string, unknown>, opts?: Parameters<typeof connection>[0]) => {
  const { conn, patch } = connection(opts);
  const res = await toolsOf(conn)[tool]!.handler({ database: "default", confirm: false, ...args }, {});
  return { res, patch, sc: res.structuredContent as Record<string, unknown> };
};
const text = (res: CallToolResult) => JSON.stringify(res.content);

describe("write.document.create_document в казахстанской базе", () => {
  it("предпросмотр: шапка и строки как задал агент, организация и дата по умолчанию, документ непроведённый", async () => {
    const { res, sc } = await call("write.document.create_document", {
      entitySet: ACCRUALS,
      date: "2026-09-30",
      fields: { ПериодРегистрации: "2026-09-01", Комментарий: "Зарплата за сентябрь" },
      tables: { Начисления: [{ Сотрудник_Key: EMPLOYEE, Результат: 600000, ДатаНачала: "2026-09-01" }] },
    });
    expect(res.isError).toBeFalsy();
    expect(sc["payload"]).toEqual({
      ПериодРегистрации: "2026-09-01T00:00:00",
      Комментарий: "Зарплата за сентябрь",
      Date: "2026-09-30T00:00:00",
      Posted: false,
      Организация_Key: ORG,
      Начисления: [{ Сотрудник_Key: EMPLOYEE, Результат: 600000, ДатаНачала: "2026-09-01T00:00:00", LineNumber: 1 }],
    });
  });

  it("начисление за месяц, где у сотрудника уже есть начисление, — предупреждение в предпросмотре", async () => {
    const args = {
      entitySet: ACCRUALS,
      fields: { ПериодРегистрации: "2026-09-01" },
      tables: { Начисления: [{ Сотрудник_Key: EMPLOYEE, Результат: 600000 }] },
    };
    const repeated = await call("write.document.create_document", args, { accrued: true });
    expect(repeated.sc["notes"]).toEqual([expect.stringContaining("№ 00000000011 от 2026-08-31 (проведён)")]);
    const first = await call("write.document.create_document", args);
    expect(first.sc["notes"]).toBeUndefined();
  });

  it("классический расчёт удержаний при проведённом едином платеже — предупреждение о задвоении", async () => {
    const args = { entitySet: WITHHOLDING, fields: { ПериодРегистрации: "2026-09-01" }, tables: { ФизическиеЛица: [{ ФизическоеЛицо_Key: PERSON }] } };
    const withEp = await call("write.document.create_document", args, { singlePayment: true });
    expect(withEp.sc["notes"]).toEqual([expect.stringContaining("расчёт единого платежа (№ 00000000009 от 2026-04-30)")]);
    const without = await call("write.document.create_document", args);
    expect(without.sc["notes"]).toBeUndefined();
  });

  it("неизвестное поле — ошибка со списком полей документа", async () => {
    const { res } = await call("write.document.create_document", { entitySet: ACCRUALS, fields: { Месяц: "2026-09-01" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("нет полей Месяц");
    expect(text(res)).toContain("ПериодРегистрации");
  });

  it("служебные поля и неизвестная табличная часть — понятный отказ", async () => {
    const posted = await call("write.document.create_document", { entitySet: ACCRUALS, fields: { Posted: true } });
    expect(text(posted.res)).toContain("write.document.post_document");
    const table = await call("write.document.create_document", { entitySet: ACCRUALS, tables: { Удержания: [] } });
    expect(text(table.res)).toContain("нет табличной части «Удержания»; есть: Начисления");
    const row = await call("write.document.create_document", { entitySet: ACCRUALS, tables: { Начисления: [{ Сумма: 1 }] } });
    expect(text(row.res)).toContain("Начисления, строка 1: нет полей Сумма");
  });

  it("документ не из списка зарплаты и выплат — отказ со списком доступных", async () => {
    const { res } = await call("write.document.create_document", { entitySet: "Document_РеализацияТоваровУслуг" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Document_ПлатежноеПоручениеИсходящее");
  });

  it("в российской базе общий инструмент не работает", async () => {
    const { res } = await call("write.document.create_document", { entitySet: ACCRUALS }, { kazakhstan: false });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("для казахстанской базы");
  });
});

describe("write.document.update_document", () => {
  it("непроведённый документ: предпросмотр правки шапки и табличной части", async () => {
    const { res, sc } = await call("write.document.update_document", {
      entitySet: ACCRUALS,
      ref: DOC,
      tables: { Начисления: [{ Сотрудник_Key: EMPLOYEE, Результат: 650000 }] },
    });
    expect(res.isError).toBeFalsy();
    expect(sc["fields"]).toEqual({ Начисления: [{ Сотрудник_Key: EMPLOYEE, Результат: 650000, LineNumber: 1 }] });
  });

  it("проведённый документ не правится — сначала отмена проведения", async () => {
    const { res, patch } = await call(
      "write.document.update_document",
      { entitySet: ACCRUALS, ref: DOC, fields: { Комментарий: "x" }, confirm: true },
      { posted: true },
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("post=false");
    expect(patch).not.toHaveBeenCalled();
  });

  it("документ, помеченный на удаление, не правится", async () => {
    const { res } = await call("write.document.update_document", { entitySet: ACCRUALS, ref: DOC, fields: { Комментарий: "x" } }, { deleted: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("помечен на удаление");
  });
});

describe("проверка проводок отражения зарплаты", () => {
  it("без начисления и удержаний — предупреждения, полная схема — без них", () => {
    const reflection = "Document_ОтражениеЗарплатыВРеглУчете";
    expect(kzPostingWarnings(reflection, [{ debitAccount: "7210", creditAccount: "3220" }])).toHaveLength(2);
    expect(
      kzPostingWarnings(reflection, [
        { debitAccount: "7210", creditAccount: "3350" },
        { debitAccount: "3350", creditAccount: "3120" },
      ]),
    ).toEqual([]);
    expect(kzPostingWarnings(ACCRUALS, [])).toEqual([]);
  });
});

describe("write.document.post_document в казахстанской базе", () => {
  it("документы зарплаты проводятся, остальные — отказ", async () => {
    const ok = await call("write.document.post_document", { entitySet: ACCRUALS, ref: DOC });
    expect(ok.res.isError).toBeFalsy();
    expect(ok.sc["dryRun"]).toBe(true);
    const other = await call("write.document.post_document", { entitySet: "Document_РеализацияТоваровУслуг", ref: DOC });
    expect(other.res.isError).toBe(true);
  });
});
