/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import { exchangeVerdict } from "../src/tools/esf-write.js";
import { fake1C, id, ORG, BUYER, type Row } from "./support/fake-1c.js";
import { ODataError } from "../src/odata/errors.js";

/**
 * write.esf.link_invoice и write.avr.set_basis: проверки допустимости, предпросмотр «было → станет»,
 * запись только перечисленных полей и защита обмена с ИС. 1С — fake1C (PATCH применяется к store).
 */

const OTHER_ORG = id(90);
const OTHER_CP = id(91);
const ESF = id(301);
const INV = id(302);
const INV2 = id(303);
const ESF2 = id(304);
const CTR = id(310);
const CTR_OTHER = id(311);
const AVR = id(401);
const AVR2 = id(402);
const BASIS = id(403);
const BASIS2 = id(404);

const T_INV = "StandardODATA.Document_СчетФактураПолученный";
const T_BASIS = "StandardODATA.Document_ПоступлениеТоваровУслуг";
const EMPTY = "00000000-0000-0000-0000-000000000000";

const esfRow = (o: Row = {}): Row => ({
  Ref_Key: ESF,
  Number: "00000005029",
  Date: "2026-10-13T00:00:00",
  DeletionMark: false,
  Posted: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  Направление: "Входящий",
  Статус: "Доставленный",
  Состояние: "ПринятОтПоставщика",
  РегистрационныйНомер: "ESF-1-20261013-1",
  СуммаДокумента: 613500,
  ДатаОборота: "2026-10-13T00:00:00",
  СчетФактура: "",
  СчетФактура_Type: "StandardODATA.Undefined",
  ДоговорПоставки_Key: EMPTY,
  ДоговорПоставкиНомер: "",
  ДоговорПоставкиДата: "0001-01-01T00:00:00",
  ...o,
});
const invRow = (o: Row = {}): Row => ({
  Ref_Key: INV,
  Number: "00000000259",
  Date: "2026-10-13T00:00:00",
  DeletionMark: false,
  Posted: true,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: CTR,
  СуммаДокумента: 613500,
  ДатаСовершенияОборотаПоРеализации: "2026-10-13T00:00:00",
  ...o,
});
const contract = (ref: string, owner: string, o: Row = {}): Row => ({
  Ref_Key: ref,
  Description: "Договор № 186/2026 от 29.09.2026",
  Owner_Key: owner,
  Организация_Key: ORG,
  DeletionMark: false,
  НомерДоговора: "186/2026",
  ДатаДоговора: "2026-09-29T00:00:00",
  ...o,
});
const avrRow = (o: Row = {}): Row => ({
  Ref_Key: AVR,
  Number: "00000000898",
  Date: "2026-10-14T00:00:00",
  DeletionMark: false,
  Posted: false,
  Организация_Key: ORG,
  Контрагент: BUYER,
  Контрагент_Type: "StandardODATA.Catalog_Контрагенты",
  Направление: "Входящий",
  Статус: "Подтвержденный",
  Состояние: "ПодтвержденПолучателем",
  РегистрационныйНомер: "AVR-1",
  БезДоговора: true,
  Договор_Key: EMPTY,
  НомерДоговора: "",
  ДатаДоговора: "0001-01-01T00:00:00",
  ДокументОснование: "",
  ДокументОснование_Type: "StandardODATA.Undefined",
  ДатаВыполненияРабот: "2026-10-12T00:00:00",
  ИтогоСтоимостьСУчетомКосвенныхНалогов: 500000,
  ИтогоСтоимостьБезУчетаКосвенныхНалогов: 446428.57,
  ...o,
});
const basisRow = (o: Row = {}): Row => ({
  Ref_Key: BASIS,
  Number: "00000000012",
  Date: "2026-10-12T00:00:00",
  DeletionMark: false,
  Posted: true,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: CTR,
  СуммаДокумента: 500000,
  ...o,
});

const make = (extra: Record<string, Row[]> = {}) =>
  fake1C({
    store: {
      Document_ЭСФ: [esfRow()],
      Document_СчетФактураПолученный: [invRow()],
      Document_СчетФактураВыданный: [],
      Catalog_ДоговорыКонтрагентов: [contract(CTR, BUYER), contract(CTR_OTHER, OTHER_CP)],
      InformationRegister_АктуальныеЭСФ: [],
      InformationRegister_ИсторияЭСФ: [],
      InformationRegister_ОчередьОтправкиЭСФ: [],
      InformationRegister_АктуальныеЭСФПоПервичнымДокументам: [],
      Document_ЭлектронныйАктВыполненныхРабот: [avrRow()],
      InformationRegister_АктуальныеЭАВР: [],
      Document_ПоступлениеТоваровУслуг: [basisRow()],
      Document_РеализацияТоваровУслуг: [],
      ...extra,
    },
  });

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");
const link = (f: ReturnType<typeof make>, args: Row = {}) =>
  f.call("write.esf.link_invoice", { esfRef: ESF, invoiceRef: INV, ...args });
const setBasis = (f: ReturnType<typeof make>, args: Row = {}) =>
  f.call("write.avr.set_basis", { avrRef: AVR, basisRef: BASIS, ...args });

describe("exchangeVerdict", () => {
  const base = {
    direction: "Входящий",
    status: "Доставленный",
    state: "ПринятОтПоставщика",
    registrationNumber: "R",
    historyCount: 1,
    queued: false,
    actualState: "ПринятОтПоставщика",
  };
  it("входящий принятый от поставщика — можно, с пояснением", () => {
    const v = exchangeVerdict(base, "ЭСФ");
    expect(v.refuse).toBeUndefined();
    expect(v.warnings.join(" ")).toMatch(/входящий/);
  });
  it("исходящий с рег. номером/историей — отказ «уже отправлен»", () => {
    expect(exchangeVerdict({ ...base, direction: "Исходящий" }, "ЭСФ").refuse).toMatch(
      /уже отправлен\/принят/,
    );
    expect(
      exchangeVerdict(
        { ...base, direction: "Исходящий", registrationNumber: "", historyCount: 0, actualState: "" },
        "ЭСФ",
      ).refuse,
    ).toBeUndefined();
  });
  it("очередь отправки и отозванный — отказ", () => {
    expect(exchangeVerdict({ ...base, queued: true }, "ЭСФ").refuse).toMatch(/очереди отправки/);
    expect(exchangeVerdict({ ...base, status: "Отозванный", state: "Отозван" }, "ЭСФ").refuse).toMatch(
      /отозван/,
    );
  });
});

describe("write.esf.link_invoice", () => {
  it("предпросмотр: «было → станет», в 1С ничего не пишется", async () => {
    const f = make();
    const r = await link(f, { contractRef: CTR });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent as Record<string, any>;
    expect(d["dryRun"]).toBe(true);
    expect(d["fields"]).toEqual({ СчетФактура: INV, СчетФактура_Type: T_INV, ДоговорПоставки_Key: CTR });
    const ch = d["changes"] as Array<Record<string, any>>;
    expect(ch.find((c) => c["field"] === "СчетФактура")).toMatchObject({ was: "", will: INV });
    expect(ch.find((c) => c["field"] === "СчетФактура")!["willText"]).toMatch(/№ 259 от 2026-10-13/);
    expect(ch.find((c) => c["field"] === "ДоговорПоставки_Key")).toMatchObject({ was: EMPTY, will: CTR });
    expect(d["checks"].join(" ")).toMatch(/контрагент совпадает/);
    expect(f.patches).toHaveLength(0);
  });

  it("confirm=true: пишутся только перечисленные поля, результат проверяется перечитыванием", async () => {
    const f = make();
    const r = await link(f, { contractRef: CTR, confirm: true });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as Row)["verified"]).toBe(true);
    expect(f.patches).toHaveLength(1);
    expect(Object.keys(f.patches[0]!.body).sort()).toEqual(
      ["ДоговорПоставки_Key", "СчетФактура", "СчетФактура_Type"].sort(),
    );
    const esf = f.store["Document_ЭСФ"]![0]!;
    expect(esf["СчетФактура"]).toBe(INV);
    expect(esf["Number"]).toBe("00000005029");
    expect(esf["СуммаДокумента"]).toBe(613500);
    expect(esf["Статус"]).toBe("Доставленный");
  });

  it("не пишет без writable базы (защита клиента)", async () => {
    const f = fake1C({ writable: false, store: make().store });
    const r = await link(f, { confirm: true });
    expect(r.isError).toBe(true);
    expect(f.patches).toHaveLength(0);
  });

  it("поля, которые уже совпадают, в запись не попадают", async () => {
    const f = make();
    f.store["Document_ЭСФ"]![0]!["ДоговорПоставки_Key"] = CTR;
    const d = (await link(f, { contractRef: CTR })).structuredContent as Record<string, any>;
    expect(Object.keys(d["fields"])).toEqual(["СчетФактура", "СчетФактура_Type"]);
  });

  it("contractFromInvoice берёт договор из счёта-фактуры", async () => {
    const d = (await link(make(), { contractFromInvoice: true })).structuredContent as Record<string, any>;
    expect(d["fields"]["ДоговорПоставки_Key"]).toBe(CTR);
  });

  it("отказы: проведён, помечен, организация, контрагент", async () => {
    for (const [patch, re] of [
      [{ Posted: true }, /проведён/],
      [{ DeletionMark: true }, /помечен на удаление/],
    ] as const) {
      const f = make();
      Object.assign(f.store["Document_ЭСФ"]![0]!, patch);
      expect(text(await link(f))).toMatch(re);
    }
    const o = make();
    o.store["Document_СчетФактураПолученный"]![0]!["Организация_Key"] = OTHER_ORG;
    expect(text(await link(o))).toMatch(/Организация счёта-фактуры не совпадает/);
    const c = make();
    c.store["Document_СчетФактураПолученный"]![0]!["Контрагент_Key"] = OTHER_CP;
    expect(text(await link(c))).toMatch(/Контрагент счёта-фактуры не совпадает/);
  });

  it("отказ: исходящий ЭСФ уже отправлен в ИС (рег. номер, история)", async () => {
    const f = make({ Document_СчетФактураВыданный: [invRow()] });
    Object.assign(f.store["Document_ЭСФ"]![0]!, {
      Направление: "Исходящий",
      Состояние: "ДоставленПолучателю",
    });
    f.store["InformationRegister_ИсторияЭСФ"]!.push({
      ЭСФ_Key: ESF,
      НомерЗаписи: "0",
      Состояние: "ДоставленПолучателю",
    });
    const t = text(await link(f));
    expect(t).toMatch(/уже отправлен\/принят в ИС/);
    expect(f.patches).toHaveLength(0);
  });

  it("отказ: ЭСФ в очереди отправки; отозванный", async () => {
    const q = make();
    q.store["InformationRegister_ОчередьОтправкиЭСФ"]!.push({ ЭСФ_Key: ESF });
    expect(text(await link(q))).toMatch(/очереди отправки/);
    const w = make();
    Object.assign(w.store["Document_ЭСФ"]![0]!, { Статус: "Отозванный", Состояние: "Отозван" });
    expect(text(await link(w))).toMatch(/отозван/);
  });

  it("отказ: счёт-фактура уже привязана к другому ЭСФ (документ и регистр) — дубль не создаём", async () => {
    const f = make();
    f.store["Document_ЭСФ"]!.push(
      esfRow({ Ref_Key: ESF2, Number: "7", СчетФактура: INV, СчетФактура_Type: T_INV }),
    );
    expect(text(await link(f))).toMatch(/уже привязана к другому ЭСФ: ЭСФ № 7/);
    const r = make();
    r.store["InformationRegister_АктуальныеЭСФ"]!.push({
      СчетФактура: INV,
      СчетФактура_Type: T_INV,
      ЭСФ_Key: ESF2,
      Состояние: "ПринятОтПоставщика",
    });
    expect(text(await link(r))).toMatch(/регистр АктуальныеЭСФ/);
    const p = make();
    p.store["InformationRegister_АктуальныеЭСФПоПервичнымДокументам"]!.push({
      ЭСФ_Key: ESF2,
      СчетФактура: INV,
    });
    expect(text(await link(p))).toMatch(/по первичным документам/);
  });

  it("уже привязана эта же СФ — менять нечего; другая СФ — отказ, с replaceExisting — план", async () => {
    const f = make({ Document_СчетФактураПолученный: [invRow(), invRow({ Ref_Key: INV2, Number: "260" })] });
    Object.assign(f.store["Document_ЭСФ"]![0]!, { СчетФактура: INV, СчетФактура_Type: T_INV });
    expect(text(await link(f))).toMatch(/уже привязана к ЭСФ/);
    const t = text(await link(f, { invoiceRef: INV2 }));
    expect(t).toMatch(/уже привязана другая счёт-фактура/);
    const r = await link(f, { invoiceRef: INV2, replaceExisting: true });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as Row)["dryRun"]).toBe(true);
  });

  it("договор чужого контрагента — отказ; организация договора — предупреждение", async () => {
    expect(text(await link(make(), { contractRef: CTR_OTHER }))).toMatch(/принадлежит другому контрагенту/);
    const f = make();
    f.store["Catalog_ДоговорыКонтрагентов"]![0]!["Организация_Key"] = OTHER_ORG;
    const d = (await link(f, { contractRef: CTR })).structuredContent as Record<string, any>;
    expect(d["warnings"].join(" ")).toMatch(/Организация в договоре/);
  });

  it("расхождение суммы и даты — предупреждения, не отказ", async () => {
    const f = make();
    Object.assign(f.store["Document_СчетФактураПолученный"]![0]!, {
      СуммаДокумента: 600000,
      Date: "2026-05-01T00:00:00",
      ДатаСовершенияОборотаПоРеализации: "2026-05-01T00:00:00",
    });
    const d = (await link(f)).structuredContent as Record<string, any>;
    expect(d["warnings"].join(" ")).toMatch(/Сумма счёта-фактуры .* не равна сумме ЭСФ/);
    expect(d["warnings"].join(" ")).toMatch(/Даты расходятся/);
  });

  it("регистр недоступен (401) — предупреждение, а не молчаливый пропуск", async () => {
    const f = make();
    f.failGetOn((p) =>
      p.includes("InformationRegister_АктуальныеЭСФПоПервичнымДокументам")
        ? new ODataError({ kind: "auth", status: 401, message: "нет прав" })
        : undefined,
    );
    const d = (await link(f)).structuredContent as Record<string, any>;
    expect(d["warnings"].join(" ")).toMatch(
      /Не удалось проверить регистр «АктуальныеЭСФПоПервичнымДокументам»/,
    );
  });

  it("несуществующие ЭСФ и счёт-фактура — понятная ошибка", async () => {
    expect(text(await link(make(), { esfRef: id(999) }))).toMatch(/ЭСФ .* не найден/);
    expect(text(await link(make(), { invoiceRef: id(998) }))).toMatch(/Счёт-фактура .* не найден/);
  });
});

describe("write.avr.set_basis", () => {
  it("предпросмотр: основание + договор, БезДоговора → false", async () => {
    const f = make();
    const r = await setBasis(f, { contractRef: CTR });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent as Record<string, any>;
    expect(d["fields"]).toEqual({
      ДокументОснование: BASIS,
      ДокументОснование_Type: T_BASIS,
      Договор_Key: CTR,
      БезДоговора: false,
    });
    expect(d["changes"].find((c: Row) => c["field"] === "БезДоговора")).toMatchObject({
      was: true,
      will: false,
    });
    expect(f.patches).toHaveLength(0);
  });

  it("confirm=true: только перечисленные поля; реквизиты ИС не меняются", async () => {
    const f = make();
    const r = await setBasis(f, { contractFromBasis: true, confirm: true });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as Row)["verified"]).toBe(true);
    const avr = f.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!;
    expect(avr["ДокументОснование"]).toBe(BASIS);
    expect(avr["Договор_Key"]).toBe(CTR);
    expect(avr["РегистрационныйНомер"]).toBe("AVR-1");
    expect(avr["Статус"]).toBe("Подтвержденный");
    expect(Object.keys(f.patches[0]!.body).sort()).toEqual(
      ["БезДоговора", "ДокументОснование", "ДокументОснование_Type", "Договор_Key"].sort(),
    );
  });

  it("withoutContract ставит «Без договора», договор взаимоисключающий", async () => {
    const f = make();
    f.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!["БезДоговора"] = false;
    f.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!["Договор_Key"] = CTR;
    const d = (await setBasis(f, { withoutContract: true })).structuredContent as Record<string, any>;
    expect(d["fields"]["БезДоговора"]).toBe(true);
    expect(d["fields"]["Договор_Key"]).toBe(EMPTY);
    expect(text(await setBasis(f, { withoutContract: true, contractRef: CTR }))).toMatch(/что-то одно/);
  });

  it("отказы: организация, контрагент, нет контрагента ЭАВР, основание помечено", async () => {
    const o = make();
    o.store["Document_ПоступлениеТоваровУслуг"]![0]!["Организация_Key"] = OTHER_ORG;
    expect(text(await setBasis(o))).toMatch(/Организация основания не совпадает/);
    const c = make();
    c.store["Document_ПоступлениеТоваровУслуг"]![0]!["Контрагент_Key"] = OTHER_CP;
    expect(text(await setBasis(c))).toMatch(/Контрагент основания не совпадает/);
    const n = make();
    Object.assign(n.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!, {
      Контрагент: "",
      Контрагент_Type: "StandardODATA.Undefined",
    });
    expect(text(await setBasis(n))).toMatch(/Контрагент ЭАВР не определён/);
    const d = make();
    d.store["Document_ПоступлениеТоваровУслуг"]![0]!["DeletionMark"] = true;
    expect(text(await setBasis(d))).toMatch(/Документ-основание помечен на удаление/);
  });

  it("отказ: основание занято другим ЭАВР (документ и регистр) — дубль не создаём", async () => {
    const f = make();
    f.store["Document_ЭлектронныйАктВыполненныхРабот"]!.push(
      avrRow({ Ref_Key: AVR2, Number: "9", ДокументОснование: BASIS, ДокументОснование_Type: T_BASIS }),
    );
    expect(text(await setBasis(f))).toMatch(/уже привязано к другому ЭАВР: ЭАВР № 9/);
    const r = make();
    r.store["InformationRegister_АктуальныеЭАВР"]!.push({
      ПервичныеДокументыЭАВР: BASIS,
      ПервичныеДокументыЭАВР_Type: T_BASIS,
      ЭАВР_Key: AVR2,
      СостоянияЭАВР: "ПодтвержденПолучателем",
    });
    expect(text(await setBasis(r))).toMatch(/регистр АктуальныеЭАВР/);
  });

  it("то же основание — менять нечего; другое — отказ, replaceExisting — план", async () => {
    const f = make({
      Document_ПоступлениеТоваровУслуг: [basisRow(), basisRow({ Ref_Key: BASIS2, Number: "13" })],
    });
    Object.assign(f.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!, {
      ДокументОснование: BASIS,
      ДокументОснование_Type: T_BASIS,
    });
    expect(text(await setBasis(f))).toMatch(/уже привязано к ЭАВР/);
    expect(text(await setBasis(f, { basisRef: BASIS2 }))).toMatch(/уже задано другое основание/);
    const r = await setBasis(f, { basisRef: BASIS2, replaceExisting: true });
    expect(r.isError).toBeFalsy();
  });

  it("исходящий ЭАВР уже отправлен в ИС — отказ; отозванный входящий — отказ", async () => {
    const f = make({ Document_РеализацияТоваровУслуг: [basisRow()] });
    Object.assign(f.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!, { Направление: "Исходящий" });
    expect(text(await setBasis(f))).toMatch(/уже отправлен\/принят в ИС/);
    const w = make();
    Object.assign(w.store["Document_ЭлектронныйАктВыполненныхРабот"]![0]!, {
      Статус: "Отозванный",
      Состояние: "Отозван",
    });
    expect(text(await setBasis(w))).toMatch(/отозван/);
  });

  it("сумма и дата — предупреждения; договор другого контрагента — отказ", async () => {
    const f = make();
    Object.assign(f.store["Document_ПоступлениеТоваровУслуг"]![0]!, {
      СуммаДокумента: 1,
      Date: "2025-01-01T00:00:00",
    });
    const d = (await setBasis(f)).structuredContent as Record<string, any>;
    expect(d["warnings"].join(" ")).toMatch(/Сумма основания/);
    expect(d["warnings"].join(" ")).toMatch(/Даты расходятся/);
    expect(text(await setBasis(make(), { contractRef: CTR_OTHER }))).toMatch(
      /принадлежит другому контрагенту/,
    );
  });
});
