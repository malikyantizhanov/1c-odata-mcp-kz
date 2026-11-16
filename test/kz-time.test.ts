import { describe, expect, it } from "vitest";
import { docDate, kzNow } from "../src/odata/kz-time.js";
import { almatyNow } from "../src/tools/quick-invoice.js";

// 16.11.2026 11:07:51 UTC = 16:07:51 по Алматы (UTC+05:00)
const NOW = new Date("2026-11-16T11:07:51.656Z");

describe("время Казахстана для даты документа (16.11.2026: «время фактического создания по Алматы»)", () => {
  it("kzNow — UTC+05:00 независимо от пояса хоста; вечером по UTC — уже завтра по Алматы", () => {
    expect(kzNow(NOW)).toEqual({ date: "2026-11-16", time: "16:07:51", dateTime: "2026-11-16T16:07:51" });
    expect(kzNow(new Date("2026-11-16T20:30:00Z")).dateTime).toBe("2026-11-17T01:30:00");
    expect(almatyNow(NOW)).toEqual({ date: "2026-11-16", dateTime: "2026-11-16T16:07:51" });
  });

  it("дата без времени и полночь — день бухгалтера + время создания, а не 00:00:00", () => {
    expect(docDate("2026-11-06", NOW)).toBe("2026-11-06T16:07:51");
    expect(docDate("2026-11-06T00:00:00", NOW)).toBe("2026-11-06T16:07:51");
    expect(docDate("2026-11-06T00:00", NOW)).toBe("2026-11-06T16:07:51");
  });

  it("без даты — сейчас по Алматы; настоящее время — как есть; не дата — как есть", () => {
    expect(docDate(undefined, NOW)).toBe("2026-11-16T16:07:51");
    expect(docDate("", NOW)).toBe("2026-11-16T16:07:51");
    expect(docDate(null, NOW)).toBe("2026-11-16T16:07:51");
    expect(docDate("2026-11-06T12:20:05", NOW)).toBe("2026-11-06T12:20:05");
    expect(docDate("2026-11-06 12:20", NOW)).toBe("2026-11-06T12:20:00");
    expect(docDate("06.11.2026", NOW)).toBe("06.11.2026");
  });
});
