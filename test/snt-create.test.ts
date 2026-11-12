import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { sntNumberLike } from "../src/tools/snt-create.js";
import { baseStore, BUYER, fake1C, id, ORG, type Row } from "./support/fake-1c.js";

/**
 * Черновик СНТ по реализации — по образцу прошлой СНТ покупателю (прод 12.11.2026, ТОО «Ю-Агро»: «на основании
 * реализации сформируй СНТ» — агент отвечал «1С не даёт мне записывать СНТ»: Document_СНТ не было в инструментах).
 */
const SALE = id(201);
const OLD_SALE = id(202);
const SAMPLE = id(203);
const WHEAT = id(204);
const OTHER = id(205);
const CONTRACT = id(206);
const VAT0 = id(207);

const text = (r: CallToolResult) => (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
const sc = (r: CallToolResult) => r.structuredContent as Row;

const sale = (o: Row = {}): Row => ({
  Ref_Key: SALE,
  Number: "00000000016",
  Date: "2026-11-12T00:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: CONTRACT,
  СуммаВключаетНДС: false,
  КурсВзаиморасчетов: 444.76,
  СуммаДокумента: 30600,
  Товары: [
    {
      LineNumber: "1",
      Номенклатура_Key: WHEAT,
      Количество: 136,
      Цена: 225,
      Сумма: 30600,
      СуммаНДС: 0,
      СтавкаНДС_Key: VAT0,
    },
  ],
  ...o,
});
const snt = (o: Row = {}): Row => ({
  Ref_Key: SAMPLE,
  Number: "-И-000000000000000000000000015",
  Date: "2026-11-11T14:47:52",
  Posted: true,
  DeletionMark: false,
  Направление: "Исходящий",
  Статус: "Подтвержден",
  Состояние: "ПодтвержденПолучателем",
  ТипСНТ: "Первичная",
  ВидОперации: "Вывоз",
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДокументОснование: OLD_SALE,
  ДокументОснование_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
  ДатаОтгрузкиТовара: "2026-11-11T00:00:00",
  ДоговорПоставки_Key: CONTRACT,
  ГрузополучательНаименование: "ООО «Хочи Юсуф»",
  НомерВагона: "BN",
  УникальныйНомерВалютногоКонтроля: "1/397/0051/1065",
  НомерСНТ: "000000000000000000000000015",
  Идентификатор: "436487109470724096",
  РегистрационныйНомерИСЭСФ: "KZ-SNT-4515-221240008218-20261111-57497211",
  ДатаРегистрацииИСЭСФ: "2026-11-11T16:58:17",
  ЭЦПЮрЛицаОтпуск: "5FQ2xs3j",
  ДатаОтзыва: "2026-11-12T10:37:36",
  Причина: "Ошибка в разделе G",
  Комментарий: "Директор неверно отправил тоннаж",
  КурсВалюты: 447.52,
  СуммаДокумента: 31050,
  Ошибки: [{ LineNumber: "1", Текст: "старая ошибка" }],
  ТоварыВС: [
    {
      LineNumber: "1",
      Товар: WHEAT,
      ТоварНаименование: "Пшеница 3 класс",
      КодТНВЭД: "1001990000",
      ЕдиницаИзмеренияКод: "168",
      ПризнакПроисхождения: "4",
      НомерСтрокиСНТ: 1,
      Количество: 138,
      Цена: 225,
      Сумма: 31050,
      СуммаБезНалогов: 31050,
      ОборотПоРеализации: 31050,
      СтавкаНДС_Key: VAT0,
    },
  ],
  ...o,
});
const make = (sales: Row[] = [sale()], snts: Row[] = [snt()]) =>
  fake1C({
    store: { ...baseStore(), Document_РеализацияТоваровУслуг: sales, Document_СНТ: snts },
  });

describe("write.snt.create_draft", () => {
  it("черновик по образцу: шапка и коды — из прошлой СНТ, основание, курс и суммы — из реализации, обмен ИС — пустой", async () => {
    const f = make();
    const r = await f.call("write.snt.create_draft", { basisRef: SALE, date: "2026-11-12" });
    expect(r.isError, text(r)).toBeFalsy();
    const p = sc(r)["payload"] as Row;
    expect(p).toMatchObject({
      Number: "-И-000000000000000000000000016",
      НомерСНТ: "000000000000000000000000016",
      Статус: "Черновик",
      Состояние: "Сформирован",
      ТипСНТ: "Первичная",
      ДокументОснование: SALE,
      ДатаОтгрузкиТовара: "2026-11-12T00:00:00",
      КурсВалюты: 444.76,
      СуммаДокумента: 30600,
      ГрузополучательНаименование: "ООО «Хочи Юсуф»",
      НомерВагона: "BN",
      УникальныйНомерВалютногоКонтроля: "1/397/0051/1065",
      Ошибки: [],
    });
    for (const k of [
      "Идентификатор",
      "РегистрационныйНомерИСЭСФ",
      "ДатаРегистрацииИСЭСФ",
      "ЭЦПЮрЛицаОтпуск",
      "ДатаОтзыва",
      "Причина",
      "Комментарий",
    ])
      expect(p).not.toHaveProperty(k);
    expect((p["ТоварыВС"] as Row[])[0]).toMatchObject({
      Товар: WHEAT,
      КодТНВЭД: "1001990000",
      ЕдиницаИзмеренияКод: "168",
      ПризнакПроисхождения: "4",
      НомерСтрокиСНТ: 1,
      Количество: 136,
      Цена: 225,
      Сумма: 30600,
      СуммаБезНалогов: 30600,
      ОборотПоРеализации: 30600,
    });
    expect(f.posts).toHaveLength(0); // только предпросмотр
  });

  it("живая СНТ по той же реализации — отказ; отозванная — не мешает", async () => {
    const live = snt({
      Ref_Key: id(210),
      Number: "-И-000000000000000000000000016",
      ДокументОснование: SALE,
      Статус: "НеПросмотрен",
    });
    expect(
      text(await make([sale()], [snt(), live]).call("write.snt.create_draft", { basisRef: SALE })),
    ).toMatch(/уже есть СНТ/);
    const revoked = { ...live, Статус: "Отозван" };
    const r = await make([sale()], [snt(), revoked]).call("write.snt.create_draft", {
      basisRef: SALE,
      date: "2026-11-12",
    });
    expect(r.isError, text(r)).toBeFalsy();
    expect((sc(r)["payload"] as Row)["Number"]).toBe("-И-000000000000000000000000017");
  });

  it("товара нет в последней СНТ покупателя — образец берётся из более ранней, где он есть (прод, Ю-Агро № 2)", async () => {
    const older = snt({
      Ref_Key: id(211),
      Number: "-И-000000000000000000000000003",
      Date: "2025-06-24T10:00:00",
      Статус: "НеПросмотрен",
      ТоварыВС: [{ ...(snt()["ТоварыВС"] as Row[])[0], Товар: OTHER, КодТНВЭД: "1003900000" }],
    });
    const other = sale({
      Товары: [
        { LineNumber: "1", Номенклатура_Key: OTHER, Количество: 160, Цена: 280, Сумма: 44800, СуммаНДС: 0 },
      ],
    });
    // Как на проде: нужная СНТ далеко не в первой десятке свежих — перед ней 12 СНТ (2025) без этого товара.
    const newer = Array.from({ length: 12 }, (_, i) =>
      snt({
        Ref_Key: id(220 + i),
        Number: `-И-0000000000000000000000001${String(i).padStart(2, "0")}`,
        Date: `2025-07-${String(i + 1).padStart(2, "0")}T10:00:00`,
        ДокументОснование: id(240 + i),
      }),
    );
    const r = await make([other], [snt(), ...newer, older]).call("write.snt.create_draft", {
      basisRef: SALE,
      date: "2026-11-12",
    });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/образец — СНТ № -И-000000000000000000000000003/);
    expect((sc(r)["payload"] as Row)["ТоварыВС"] as Row[]).toMatchObject([
      { Товар: OTHER, КодТНВЭД: "1003900000", Количество: 160, Сумма: 44800 },
    ]);
    expect((sc(r)["payload"] as Row)["Number"]).toBe("-И-000000000000000000000000016");
  });

  it("нет образца у покупателя или строки товара в образце — отказ с понятной причиной", async () => {
    expect(text(await make([sale()], []).call("write.snt.create_draft", { basisRef: SALE }))).toMatch(
      /нет прошлой СНТ-образца/,
    );
    const other = sale({
      Товары: [{ LineNumber: "1", Номенклатура_Key: OTHER, Количество: 1, Цена: 1, Сумма: 1, СуммаНДС: 0 }],
    });
    expect(text(await make([other]).call("write.snt.create_draft", { basisRef: SALE }))).toMatch(
      /нет строк для товаров реализации/,
    );
    const services = sale({ Товары: [] });
    expect(text(await make([services]).call("write.snt.create_draft", { basisRef: SALE }))).toMatch(
      /нет строк товаров/,
    );
  });
});

describe("sntNumberLike", () => {
  it("формат «Номер СНТ» — как у образца: номер без префикса или короткое число", () => {
    const longNo = { Number: "-И-000000000000000000000000015", НомерСНТ: "000000000000000000000000015" };
    expect(sntNumberLike(longNo, "-И-000000000000000000000000016")).toBe("000000000000000000000000016");
    const shortNo = { Number: "-И-000000000000000000000000008", НомерСНТ: "8" };
    expect(sntNumberLike(shortNo, "-И-000000000000000000000000009")).toBe("9");
    expect(sntNumberLike({ Number: "-И-1", НомерСНТ: "АБВ" }, "-И-2")).toBeUndefined();
  });
});
