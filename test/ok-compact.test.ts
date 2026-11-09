import { describe, expect, it } from "vitest";
import { ok } from "../src/tools/_shared.js";

describe("ok", () => {
  it("текст ответа — компактный JSON (без отступов), то же содержимое, что structuredContent", () => {
    const data = { rows: [{ ref: "a", name: "ТОО Альфа", amount: 1500 }], count: 1 };
    const r = ok(data);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toBe('{"rows":[{"ref":"a","name":"ТОО Альфа","amount":1500}],"count":1}');
    expect(JSON.parse(text)).toEqual(r.structuredContent);
  });
});
