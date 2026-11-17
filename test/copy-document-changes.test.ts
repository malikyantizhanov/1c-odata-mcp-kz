import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";

/**
 * copy_document: правки копии в changes. Прод 17.11.2026 (RENTAL, INAYAT): агент передавал
 * changes: {Date, СуммаОперации/СуммаДокумента, НомерВходящегоДокумента…}, а инструмент знал только date/fields/lines —
 * ключ молча отбрасывался, 78 копий записались с датой «сегодня» и суммами образца.
 */

type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const ORDER = "Document_ПлатежныйОрдерПоступлениеДенежныхСредств";
const SRC = "00000000-0000-4000-8000-000000000010";
const prop = (name: string, type = "Edm.String") => ({ name, type, nullable: true });

function setup() {
  const entities = new Map([
    [
      ORDER,
      {
        entitySet: ORDER,
        properties: [
          prop("Ref_Key", "Edm.Guid"),
          prop("Date", "Edm.DateTime"),
          prop("Posted", "Edm.Boolean"),
          prop("СуммаДокумента", "Edm.Double"),
          prop("НомерВходящегоДокумента"),
          prop("НазначениеПлатежа"),
        ],
      },
    ],
  ]);
  const prepareCreate = vi.fn(async () => undefined);
  const conn = {
    cfg: { name: "default", writable: true },
    behavior: { writeOperationMarker: false, pageSize: 100, maxRows: 1000 },
    getMetadata: async () => ({ entities }),
    available: async () => new Set(entities.keys()),
    client: {
      prepareCreate,
      getEntity: async () => ({
        Ref_Key: SRC,
        Number: "00000000485",
        Date: "2026-11-05T12:00:00",
        Posted: true,
        СуммаДокумента: 1147.05,
        НомерВходящегоДокумента: "309",
        НазначениеПлатежа: "Проценты по Kaspi Депозиту за вычетом налога 202,42 т",
      }),
      getCollection: async () => ({ value: [] }),
    },
  };
  const tools = (
    createServer({ db: () => conn } as never) as unknown as { _registeredTools: Record<string, Tool> }
  )._registeredTools;
  return { copy: tools["write.document.copy_document"]!, prepareCreate };
}

describe("write.document.copy_document: правки в changes", () => {
  it("Date → дата копии (с временем создания), остальное → реквизиты шапки; fields важнее changes", async () => {
    const { copy, prepareCreate } = setup();
    const res = await copy.handler(
      {
        entitySet: ORDER,
        ref: SRC,
        changes: {
          Date: "2026-11-07T00:00:00",
          СуммаДокумента: 978.08,
          НомерВходящегоДокумента: "311",
          НазначениеПлатежа: "Проценты по Kaspi Депозиту за вычетом налога 172,59 т",
        },
        fields: { НомерВходящегоДокумента: "312" },
      },
      {},
    );
    expect(res.isError).toBeFalsy();
    const payload = (prepareCreate.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(String(payload["Date"])).toMatch(/^2026-11-07T\d{2}:\d{2}:\d{2}$/);
    expect(payload["СуммаДокумента"]).toBe(978.08);
    expect(payload["НазначениеПлатежа"]).toBe("Проценты по Kaspi Депозиту за вычетом налога 172,59 т");
    expect(payload["НомерВходящегоДокумента"]).toBe("312");
    expect(payload["Posted"]).toBe(false);
  });

  it("date важнее changes.Date; без правок — копия образца на сегодня", async () => {
    const { copy, prepareCreate } = setup();
    await copy.handler(
      { entitySet: ORDER, ref: SRC, date: "2026-11-08", changes: { Date: "2026-11-07" } },
      {},
    );
    const first = (prepareCreate.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(String(first["Date"]).slice(0, 10)).toBe("2026-11-08");
    await copy.handler({ entitySet: ORDER, ref: SRC }, {});
    const second = (prepareCreate.mock.calls[1] as unknown as [string, Record<string, unknown>])[1];
    expect(second["СуммаДокумента"]).toBe(1147.05);
  });
});
