/* eslint-disable @typescript-eslint/no-explicit-any -- разбор строк payload в тестах */
import { describe, expect, it } from "vitest";
import { CONTRACT, KZT, fake1C, id } from "./support/fake-1c.js";
import { USD, usdStore } from "./support/usd-store.js";
import { fillSettlementRates } from "../src/tools/settlement-rate.js";

/**
 * Курс взаиморасчётов в строках документа (прод 09.11.2026: платёжки по выписке IGS Caspian — курс 0, кратность 0,
 * сумма взаиморасчётов 0; у бухгалтера — 1, 1, сумма платежа). Как в форме 1С: валюта договора, курс строго на дату
 * документа (в регистре usdStore курс USD есть на 2026-10-07, на 2026-10-08 — нет).
 */

const PP = "Document_ПлатежноеПоручениеИсходящее";
const KZT_CONTRACT = id(90);

function setup(withUsdRate = true) {
  const store = usdStore();
  store["Catalog_ДоговорыКонтрагентов"]!.push({
    Ref_Key: KZT_CONTRACT,
    Description: "тенговый",
    ВалютаВзаиморасчетов_Key: KZT,
  });
  if (!withUsdRate)
    store["InformationRegister_КурсыВалют"] = store["InformationRegister_КурсыВалют"]!.filter(
      (r) => r["Валюта_Key"] !== USD || r["Курс"] === 1,
    );
  const f = fake1C({ store });
  const p = (name: string, type = "Edm.String") => ({ name, type });
  const em = {
    entitySet: PP,
    properties: [
      p("Date"),
      p("ВалютаДокумента_Key"),
      p("РасшифровкаПлатежа", `Collection(StandardODATA.${PP}_РасшифровкаПлатежа_RowType)`),
    ],
  };
  const rowMeta = {
    properties: [
      p("ДоговорКонтрагента_Key"),
      p("СуммаПлатежа", "Edm.Double"),
      p("КурсВзаиморасчетов", "Edm.Double"),
      p("КратностьВзаиморасчетов"),
      p("СуммаВзаиморасчетов", "Edm.Double"),
    ],
    navigations: [
      { name: "ДоговорКонтрагента", toType: "StandardODATA.Catalog_ДоговорыКонтрагентов", collection: false },
    ],
  };
  return { f, em, rowMeta };
}

async function fill(
  docCur: string,
  rows: Array<Record<string, unknown>>,
  { date = "2026-10-07", withUsdRate = true } = {},
) {
  const { f, em, rowMeta } = setup(withUsdRate);
  const meta = await f.conn.getMetadata();
  (meta.entities as Map<string, unknown>).set(`${PP}_РасшифровкаПлатежа`, rowMeta);
  return fillSettlementRates(f.conn, em as any, {
    Date: `${date}T00:00:00`,
    ВалютаДокумента_Key: docCur,
    РасшифровкаПлатежа: rows,
  });
}

const line = (r: { payload: Record<string, unknown> }) => (r.payload as any).РасшифровкаПлатежа[0];

describe("курс взаиморасчётов в строках документа", () => {
  it("тенге по тенговому договору — 1 и 1, сумма взаиморасчётов = сумме платежа (как у бухгалтера)", async () => {
    const r = await fill(KZT, [{ ДоговорКонтрагента_Key: KZT_CONTRACT, СуммаПлатежа: 20880 }]);
    expect(line(r)).toMatchObject({
      КурсВзаиморасчетов: 1,
      КратностьВзаиморасчетов: "1",
      СуммаВзаиморасчетов: 20880,
    });
    expect(r.notes).toEqual([]);
  });

  it("доллары по долларовому договору — курс из 1С на дату документа и заметка о нём", async () => {
    const r = await fill(USD, [{ ДоговорКонтрагента_Key: CONTRACT, СуммаПлатежа: 1000 }]);
    expect(line(r)).toMatchObject({
      КурсВзаиморасчетов: 453.65,
      КратностьВзаиморасчетов: "1",
      СуммаВзаиморасчетов: 1000,
    });
    expect(r.notes.join(" ")).toMatch(/USD 453\.65 за 1 — курс из 1С на дату документа 2026-10-07/);
  });

  it("тенге по долларовому договору — сумма взаиморасчётов пересчитана в доллары", async () => {
    const r = await fill(KZT, [{ ДоговорКонтрагента_Key: CONTRACT, СуммаПлатежа: 453650 }]);
    expect(line(r)).toMatchObject({ КурсВзаиморасчетов: 453.65, СуммаВзаиморасчетов: 1000 });
  });

  it("на дату документа курса нет — не подставляем прошлый, говорим, какой загружен последним", async () => {
    const r = await fill(USD, [{ ДоговорКонтрагента_Key: CONTRACT, СуммаПлатежа: 1000 }], {
      date: "2026-10-08",
    });
    expect(line(r).КурсВзаиморасчетов).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(
      /нет курса USD на дату документа 2026-10-08 \(последний загруженный — 453\.65 от 2026-10-07\)/,
    );
  });

  it("явный курс не трогаем; курсов валюты в 1С нет совсем — поле пустое и заметка", async () => {
    const own = await fill(USD, [
      {
        ДоговорКонтрагента_Key: CONTRACT,
        СуммаПлатежа: 10,
        КурсВзаиморасчетов: 470,
        КратностьВзаиморасчетов: "1",
      },
    ]);
    expect(line(own).КурсВзаиморасчетов).toBe(470);
    const none = await fill(USD, [{ ДоговорКонтрагента_Key: CONTRACT, СуммаПлатежа: 10 }], {
      withUsdRate: false,
    });
    expect(line(none).КурсВзаиморасчетов).toBeUndefined();
    expect(none.notes.join(" ")).toMatch(/Курс взаиморасчётов не заполнен: в 1С нет курса USD на 2026-10-07/);
  });
});
