import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { ODataError } from "../src/odata/errors.js";
import { withDefaultContract, withEnumValues } from "../src/tools/write.js";

const ACT = "Document_РеализацияТоваровУслуг";
const cp = "11111111-1111-1111-1111-111111111111";
const org = "22222222-2222-2222-2222-222222222222";
const GIVEN = "55555555-5555-4555-8555-555555555555";

const connWith = (contracts: Array<Record<string, unknown>>, main?: string) => {
  const getCollection = vi.fn(async (_path: string) => ({ value: contracts }));
  return {
    getCollection,
    conn: {
      available: async () => new Set(["Catalog_ДоговорыКонтрагентов"]),
      getMetadata: async () => ({
        entities: new Map([
          [
            "Catalog_ДоговорыКонтрагентов",
            {
              properties: [
                "Ref_Key",
                "Description",
                "Owner_Key",
                "Организация_Key",
                "ВидДоговора",
                "ДатаДоговора",
                "DeletionMark",
              ].map((name) => ({ name })),
            },
          ],
        ]),
      }),
      // Указанный Ref_Key договора существует — оставляем как есть; у контрагента — основной договор main.
      client: {
        getCollection,
        getEntity: async () => ({ Ref_Key: GIVEN, ОсновнойДоговорКонтрагента_Key: main }),
      },
    } as never,
  };
};

describe("договор по умолчанию — как форма 1С при выборе контрагента", () => {
  const payload = { Контрагент_Key: cp, Организация_Key: org };

  it("ровно один договор нужного вида → подставляется, с пояснением", async () => {
    const { conn, getCollection } = connWith([
      { Ref_Key: "ctr-1", Description: "Договор 1", ВидДоговора: "СПокупателем" },
      { Ref_Key: "ctr-2", Description: "Поставка", ВидДоговора: "СПоставщиком" },
    ]);
    const r = await withDefaultContract(conn, ACT, payload);
    expect(r.payload["ДоговорКонтрагента_Key"]).toBe("ctr-1");
    expect(r.notes[0]).toContain("подставлен единственный договор с покупателем");
    expect(r.contractAutoSelected).toBeUndefined();
    const url = decodeURIComponent(getCollection.mock.calls[0]![0]);
    expect(url).toContain(`Owner_Key eq guid'${cp}'`);
    expect(url).toContain(`Организация_Key eq guid'${org}'`);
    expect(url).toContain("DeletionMark eq false");
  });

  it("несколько договоров, основного нет → последний по дате, contractAutoSelected с вариантами", async () => {
    const { conn } = connWith([
      { Ref_Key: "a", Description: "A", ВидДоговора: "СПокупателем", ДатаДоговора: "2026-01-10T00:00:00" },
      { Ref_Key: "b", Description: "B", ВидДоговора: "СПокупателем", ДатаДоговора: "2026-05-01T00:00:00" },
      { Ref_Key: "c", Description: "C", ВидДоговора: "СПоставщиком", ДатаДоговора: "2026-09-01T00:00:00" },
    ]);
    const r = await withDefaultContract(conn, ACT, payload);
    expect(r.payload["ДоговорКонтрагента_Key"]).toBe("b");
    expect(r.contractAutoSelected).toEqual({
      ref: "b",
      name: "B",
      reason: "последний договор вида «С покупателем»",
      alternatives: [{ ref: "a", name: "A" }],
    });
    expect(r.notes[0]).toContain("можно сменить: «A» (ref a)");
  });

  it("несколько договоров → основной договор контрагента, если он среди подходящих", async () => {
    const rows = [
      { Ref_Key: "a", Description: "A", ВидДоговора: "СПокупателем", ДатаДоговора: "2026-01-10T00:00:00" },
      { Ref_Key: "b", Description: "B", ВидДоговора: "СПокупателем", ДатаДоговора: "2026-05-01T00:00:00" },
      { Ref_Key: "c", Description: "C", ВидДоговора: "СПоставщиком", ДатаДоговора: "2026-09-01T00:00:00" },
    ];
    const r = await withDefaultContract(connWith(rows, "a").conn, ACT, payload);
    expect(r.payload["ДоговорКонтрагента_Key"]).toBe("a");
    expect(r.contractAutoSelected).toMatchObject({ ref: "a", reason: "основной договор" });
    // Основной договор чужого вида не берётся.
    const other = await withDefaultContract(connWith(rows, "c").conn, ACT, payload);
    expect(other.contractAutoSelected).toMatchObject({
      ref: "b",
      reason: "последний договор вида «С покупателем»",
    });
  });

  it("указанный договор не найден, подходящих несколько → наиболее вероятный, не ошибка", async () => {
    const { conn } = connWith([
      { Ref_Key: "a", Description: "A", ВидДоговора: "СПокупателем", ДатаДоговора: "2026-01-10T00:00:00" },
      { Ref_Key: "b", Description: "B", ВидДоговора: "СПокупателем", ДатаДоговора: "2026-05-01T00:00:00" },
    ]);
    const r = await withDefaultContract(conn, ACT, { ...payload, ДоговорКонтрагента_Key: "Договор № 77" });
    expect(r.payload["ДоговорКонтрагента_Key"]).toBe("b");
    expect(r.contractAutoSelected).toMatchObject({ ref: "b" });
    expect(r.notes[0]).toContain("Договор «Договор № 77» у контрагента не найден");
  });

  it("указанный договор не найден и подходящих нет вовсе → ошибка", async () => {
    const { conn } = connWith([{ Ref_Key: "c", Description: "C", ВидДоговора: "СПоставщиком" }]);
    await expect(
      withDefaultContract(conn, ACT, { ...payload, ДоговорКонтрагента_Key: "Договор № 77" }),
    ).rejects.toThrow(/договоров с покупателем с этой организацией нет/);
  });

  it("ни одного → предупреждаем, что 1С не проведёт", async () => {
    const { conn } = connWith([]);
    const r = await withDefaultContract(conn, ACT, payload);
    expect(r.payload["ДоговорКонтрагента_Key"]).toBeUndefined();
    expect(r.notes[0]).toContain("нет договора с покупателем");
  });

  it("договор указан, документ закупки → вид СПоставщиком; денежные документы не трогаем", async () => {
    const { conn, getCollection } = connWith([
      { Ref_Key: "x", Description: "X", ВидДоговора: "СПокупателем" },
      { Ref_Key: "y", Description: "Y", ВидДоговора: "СПоставщиком" },
    ]);
    expect(
      (await withDefaultContract(conn, ACT, { ...payload, ДоговорКонтрагента_Key: GIVEN })).notes,
    ).toEqual([]);
    const purchase = await withDefaultContract(conn, "Document_ПоступлениеТоваровУслуг", payload);
    expect(purchase.payload["ДоговорКонтрагента_Key"]).toBe("y");
    expect(purchase.notes[0]).toContain("единственный договор с поставщиком");
    const calls = getCollection.mock.calls.length;
    expect((await withDefaultContract(conn, "Document_ПриходныйКассовыйОрдер", payload)).notes).toEqual([]);
    expect(getCollection.mock.calls.length).toBe(calls);
  });
});

describe("post_document: без договора — понятная ошибка до вызова 1С", () => {
  const ref = "33333333-3333-4333-8333-333333333333";
  const tool = (contract: string, sticks = true) => {
    let posted = false;
    const action = vi.fn(async () => {
      if (sticks) posted = true;
      return { status: 200, body: "" };
    });
    const connection = {
      cfg: { name: "default", writable: true },
      available: async () => new Set([ACT]),
      getMetadata: async () => ({
        entities: new Map([
          [ACT, { properties: [{ name: "Контрагент_Key" }, { name: "ДоговорКонтрагента_Key" }] }],
        ]),
      }),
      client: {
        actionRaw: action,
        getEntity: async () => ({
          Контрагент_Key: cp,
          ДоговорКонтрагента_Key: contract,
          Posted: posted,
          DataVersion: posted ? "v2" : "v1",
        }),
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
      run: () => t.handler({ database: "default", entitySet: ACT, ref, post: true, confirm: true }, {}),
    };
  };

  it("договор пуст → ошибка с подсказкой, Post не вызывается", async () => {
    const { action, run } = tool("00000000-0000-0000-0000-000000000000");
    const res = await run();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("не заполнен договор");
    expect(action).not.toHaveBeenCalled();
  });

  it("договор заполнен → проводим", async () => {
    const { action, run } = tool("44444444-4444-4444-8444-444444444444");
    const res = await run();
    expect(res.isError).toBeFalsy();
    expect(action).toHaveBeenCalledOnce();
  });

  it("1С ответила 2xx, но Posted=false → ошибка, а не «проведён»", async () => {
    const { action, run } = tool("44444444-4444-4444-8444-444444444444", false);
    const res = await run();
    expect(action).toHaveBeenCalledOnce();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("НЕ проведён");
  });
});

describe("ошибка значения перечисления — с допустимыми значениями", () => {
  it("дописывает члены перечисления из $metadata", async () => {
    const conn = {
      client: {
        getText: async () =>
          '<EnumType Name="ВидыОперацийПКО"><Member Name="ОплатаПокупателя"/><Member Name="ПрочийПриход"/></EnumType>',
      },
    } as never;
    const e = new ODataError({
      kind: "bad_request",
      message: "Перечисление 'ВидыОперацийПКО' не содержит элемент 'ПоступлениеОплатыОтПокупателя'.",
    });
    const r = (await withEnumValues(conn, e)) as ODataError;
    expect(r.message).toContain("Допустимые значения ВидыОперацийПКО: ОплатаПокупателя, ПрочийПриход.");
    expect(r.kind).toBe("bad_request");
    expect(await withEnumValues(conn, new Error("другое"))).toBeInstanceOf(Error);
  });
});
