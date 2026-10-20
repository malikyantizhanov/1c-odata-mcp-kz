/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import {
  PAYROLL_FORM_HINT,
  PAYROLL_SUM_DOCS,
  checkPayrollSums,
  payrollPostRefusal,
  payrollSumNotes,
} from "../src/tools/payroll-sums.js";
import { KZ_FLOW_BY_SET } from "../src/tools/kz-flow.js";
import { postRejected, rawResponse } from "../src/tools/write.js";

/**
 * Зарплатные документы: суммы считает 1С в форме («Заполнить»/«Рассчитать»), через OData не досчитывает —
 * пустой документ проводится с нулями (проверено на Aru Market). Проведение такого документа MCP отклоняет;
 * create/update — только предупреждают. Отказ 1С при проведении — понятное сообщение + сырой ответ полем.
 */

const ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const EP = "Document_РасчетЕдиногоПлатежа";
const TO_PAY = "Document_ЗарплатаКВыплатеОрганизаций";
const ref = "55555555-5555-4555-8555-555555555555";

describe("checkPayrollSums / payrollSumNotes / payrollPostRefusal", () => {
  it("пустая ТЧ и нулевые суммы — пусто; ненулевая — не пусто; не зарплатный документ — undefined", () => {
    expect(checkPayrollSums(ACCRUAL, {})!.empty).toBe(true);
    expect(checkPayrollSums(ACCRUAL, { Начисления: [] })!.empty).toBe(true);
    expect(checkPayrollSums(ACCRUAL, { Начисления: [{ Результат: 0 }, { Результат: "0" }] })!.empty).toBe(
      true,
    );
    expect(checkPayrollSums(ACCRUAL, { Начисления: [{ Результат: 150000 }] })!.empty).toBe(false);
    expect(checkPayrollSums("Document_РеализацияТоваровУслуг", {})).toBeUndefined();
    expect(payrollPostRefusal("Document_РеализацияТоваровУслуг", {})).toBeUndefined();
  });

  it("часть строк с нулём — предупреждение со строками, но не отказ", () => {
    const doc = {
      Начисления: [
        { LineNumber: "1", Результат: 1000 },
        { LineNumber: "2", Результат: 0 },
      ],
    };
    expect(checkPayrollSums(ACCRUAL, doc)!.zeroRows).toEqual(["Начисления: строки 2"]);
    expect(payrollSumNotes(ACCRUAL, doc).join("\n")).toContain("нулевые суммы в части строк");
    expect(payrollPostRefusal(ACCRUAL, doc)).toBeUndefined();
  });

  it("сумма в шапке (ЗарплатаКВыплате.СуммаДокумента) считается", () => {
    expect(checkPayrollSums(TO_PAY, { СуммаДокумента: 5000 })!.empty).toBe(false);
    expect(checkPayrollSums(TO_PAY, { СуммаДокумента: 0, Зарплата: [] })!.empty).toBe(true);
  });

  it("onlyPresent (update): проверяются только передаваемые части", () => {
    expect(payrollSumNotes(EP, { Комментарий: "x" }, true)).toEqual([]);
    expect(payrollSumNotes(EP, { ИсчисленныйЕП: [{ СуммаПлатежа: 0 }] }, true).join("")).toContain(
      "суммы пустые или нулевые",
    );
  });

  it("отказ: явная причина «суммы ставит 1С в форме — нажмите Заполнить/Рассчитать»", () => {
    const r = payrollPostRefusal(EP, { ИсчисленныйЕП: [] })!;
    expect(r).toContain("Проведение отклонено");
    expect(r).toContain("Суммы ставит 1С в форме — нажмите «Заполнить»/«Рассчитать»");
  });

  it("kz_document_guide: у всех зарплатных документов подсказка «суммы считает 1С в форме»", () => {
    for (const set of Object.keys(PAYROLL_SUM_DOCS)) {
      const flow = KZ_FLOW_BY_SET.get(set);
      expect(flow, set).toBeTruthy();
      expect(flow!.hints ?? [], set).toContain(PAYROLL_FORM_HINT);
    }
  });
});

function postTool(
  entitySet: string,
  doc: Record<string, unknown>,
  raw = { status: 200, body: "" },
  sticks = true,
) {
  let posted = false;
  const action = vi.fn(async () => {
    if (sticks) posted = true;
    return raw;
  });
  const connection = {
    cfg: { name: "default", writable: true },
    available: async () => new Set([entitySet]),
    getMetadata: async () => ({ entities: new Map([[entitySet, { properties: [] }]]) }),
    client: {
      actionRaw: action,
      getEntity: async () => ({ ...doc, Posted: posted, DataVersion: posted ? "v2" : "v1" }),
      getCollection: async () => ({ value: [] }),
    },
  };
  const t = (
    createServer({ db: () => connection } as never) as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: Record<string, unknown>, e: unknown) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools["write.document.post_document"]!;
  return {
    action,
    run: (confirm = true, post = true) =>
      t.handler({ database: "default", entitySet, ref, post, confirm }, {}),
  };
}

describe("post_document: зарплатный документ без сумм", () => {
  it("confirm=true → отказ до вызова 1С, Post не вызывается", async () => {
    const { action, run } = postTool(EP, { ИсчисленныйЕП: [{ СуммаПлатежа: 0 }], Удержания: [] });
    const res = await run();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("Суммы ставит 1С в форме");
    expect(action).not.toHaveBeenCalled();
  });

  it("предпросмотр показывает отказ в notes", async () => {
    const { action, run } = postTool(ACCRUAL, { Начисления: [] });
    const res = await run(false);
    expect(res.isError).toBeFalsy();
    expect(((res.structuredContent as any).notes as string[]).join("\n")).toContain("Проведение отклонено");
    expect(action).not.toHaveBeenCalled();
  });

  it("суммы есть → проводим", async () => {
    const { action, run } = postTool(ACCRUAL, { Начисления: [{ Результат: 250000 }] });
    const res = await run();
    expect(action).toHaveBeenCalledOnce();
    expect(JSON.stringify(res.content)).not.toContain("Проведение отклонено");
  });

  it("отмена проведения не проверяет суммы", async () => {
    const { action, run } = postTool(ACCRUAL, { Начисления: [] });
    await run(true, false);
    expect(action).toHaveBeenCalledOnce();
  });
});

describe("post_document: 1С отклонила проведение (страница 1С:Фреш)", () => {
  const page =
    "<!DOCTYPE HTML><html><head><title>1C</title><style>p{}</style></head><body><p>Сервис частично недоступен</p></body></html>";

  it("понятное сообщение, HTML не в тексте сообщения, сырой ответ — отдельным полем", async () => {
    const { action, run } = postTool(
      "Document_КомплектацияНоменклатуры",
      {},
      { status: 500, body: page },
      false,
    );
    const res = await run();
    expect(action).toHaveBeenCalledOnce();
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as any;
    expect(sc.message).toContain("1С отклонила проведение; причина видна при проведении в форме 1С");
    expect(sc.message).toContain("НЕ проведён");
    expect(sc.message).not.toContain("<html");
    expect(sc.message).not.toContain("Сервис частично недоступен");
    expect(sc.rawResponse).toMatchObject({ status: 500, contentType: "html" });
    expect(sc.rawResponse.text).toContain("Сервис частично недоступен");
    expect(sc.rejected).toBe(true);
  });

  it("rawResponse: текст, пустое тело, обрезка", () => {
    expect(rawResponse({ status: 200, body: "" })).toMatchObject({ contentType: "empty" });
    expect(rawResponse({ status: 400, body: "ошибка" })).toMatchObject({
      contentType: "text",
      body: "ошибка",
    });
    expect(String(rawResponse({ status: 500, body: "x".repeat(10000) })["body"]).length).toBeLessThan(4100);
  });

  it("отмена проведения не удалась — своё сообщение", () => {
    const r = postRejected(
      false,
      { status: 200, body: "" },
      { Posted: true, DataVersion: "v1" },
      { Posted: true, DataVersion: "v1" },
      "",
    ) as any;
    expect(r.isError).toBe(true);
    expect(r.structuredContent.message).toContain("1С не отменила проведение");
  });
});
