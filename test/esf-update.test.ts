/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import {
  esfNumberField,
  formatNumber,
  headerDefaults,
  nextNumber,
  splitNumber,
} from "../src/tools/esf-fill.js";
import { draftVerdict } from "../src/tools/esf-update.js";
import { baseStore, fake1C, id, ORG, BUYER, KZT, SERVICE, VAT16, BIN, type Row } from "./support/fake-1c.js";

/**
 * ЭСФ: номер учётной системы, адреса и реквизиты сторон как в форме 1С; правка черновика write.esf.update_draft.
 * Все данные синтетические.
 */

const INV = id(80);
const SALE = id(81);
const OTHER_ORG = id(90);
const KZ = id(91);
const K_ORG_LEGAL = id(92);
const K_ORG_POST = id(93);
const K_CP_LEGAL = id(94);
const K_CP_ACTUAL = id(95);
const DRAFT = id(100);
const ORG_LEGAL = "Казахстан, г. Тестоград, ул. Примерная, д. 1";
const ORG_POST = "Казахстан, г. Тестоград, а/я 10";
const CP_LEGAL = "Казахстан, г. Образцовск, пр. Условный, д. 2";
const CP_ACTUAL = "Казахстан, г. Образцовск, ул. Фактическая, д. 3";

const services = [
  {
    LineNumber: "1",
    Номенклатура_Key: SERVICE,
    Содержание: "",
    Количество: 1,
    Цена: 100000,
    Сумма: 100000,
    СтавкаНДС_Key: VAT16,
    СуммаНДС: 16000,
  },
];
const sale = (): Row => ({
  Ref_Key: SALE,
  Number: "00000000016",
  Date: "2026-10-08T10:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: id(3),
  СуммаВключаетНДС: false,
  СуммаДокумента: 116000,
  Товары: [],
  Услуги: services.map((r) => ({ ...r })),
});
const inv = (o: Row = {}): Row => ({
  Ref_Key: INV,
  Number: "00000000002",
  Date: "2026-10-08T10:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: id(3),
  ДокументОснование: SALE,
  ДокументОснование_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
  СчетОрганизации_Key: id(5),
  ВалютаДокумента_Key: KZT,
  // Валютный договор: курс взаиморасчётов ≠ 1, но ЭСФ в тенге — в 1С курс ЭСФ 1.
  КурсВзаиморасчетов: 451.31,
  ВидСчетаФактуры: "Обычный",
  СпособВыставления: "Электронно",
  СуммаВключаетНДС: false,
  СуммаДокумента: 116000,
  ДатаСовершенияОборотаПоРеализации: "2026-10-08T00:00:00",
  Грузоотправитель: "00000000-0000-0000-0000-000000000000",
  Грузоотправитель_Type: "StandardODATA.Catalog_Организации",
  Грузополучатель_Key: BUYER,
  АдресДоставки: "",
  ПунктНазначения: "Пункт назначения из СФ",
  УсловияПоставки: "XXX",
  СпособОтправленияПоКлассификатору: "99",
  Товары: [],
  Услуги: services.map((r) => ({ ...r })),
  ...o,
});
const esfRow = (n: number, number: string, o: Row = {}): Row => ({
  Ref_Key: id(n),
  Number: number,
  Date: "2026-09-01T10:00:00",
  DeletionMark: false,
  Posted: false,
  Направление: "Исходящий",
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  СчетФактура: id(n + 1000),
  ...o,
});
const ci = (obj: string, set: string, kind: string, text: string): Row => ({
  Объект: obj,
  Объект_Type: `StandardODATA.${set}`,
  Тип: "Адрес",
  Вид: kind,
  Вид_Type: "StandardODATA.Catalog_ВидыКонтактнойИнформации",
  Представление: text,
  ЗначениеПоУмолчанию: false,
});
/** Черновик, созданный старой версией MCP: без номера, адресов, грузоотправителя, с курсом валютного договора. */
const draft = (o: Row = {}): Row => ({
  Ref_Key: DRAFT,
  Number: "",
  Date: "2026-10-08T12:00:00",
  DeletionMark: false,
  Posted: false,
  Направление: "Исходящий",
  Вид: "Обычный",
  Статус: "",
  Состояние: "Сформирован",
  РегистрационныйНомер: "",
  Идентификатор: "",
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  СчетФактура: INV,
  СчетФактура_Type: "StandardODATA.Document_СчетФактураВыданный",
  ВалютаКод: "KZT",
  КурсВалюты: 451.31,
  ТипПодписи: "",
  СпособРасчета: "",
  Грузоотправитель: "",
  Грузоотправитель_Type: "",
  ГрузоотправительИдентификатор: "",
  ГрузоотправительНаименование: "",
  АдресОтправки: "",
  Грузополучатель: "",
  Грузополучатель_Type: "",
  ГрузополучательИдентификатор: "",
  ГрузополучательНаименование: "",
  АдресДоставки: "",
  ГрузополучательКодСтраны: "",
  ДоговорПоставкиУсловияПоставки: "",
  СпособОтправленияПоКлассификатору: "",
  СуммаДокумента: 116000,
  Поставщики: [
    {
      LineNumber: "1",
      Поставщик: ORG,
      Поставщик_Type: "StandardODATA.Catalog_Организации",
      ПоставщикИдентификатор: "123123123123",
      ПоставщикНаименование: "ИП Aru Market",
      Адрес: "",
      КодСтраны: "",
      КБе: "19",
    },
  ],
  Получатели: [
    {
      LineNumber: "1",
      Получатель: BUYER,
      Получатель_Type: "StandardODATA.Catalog_Контрагенты",
      ПолучательИдентификатор: BIN,
      ПолучательНаименование: 'ТОО "TRADESPACE"',
      Адрес: "",
      КодСтраны: "",
    },
  ],
  Товары: [
    {
      LineNumber: "1",
      ТоварНаименование: "Разработка программного обеспечения",
      Количество: 1,
      Цена: 100000,
      СуммаБезНалогов: 100000,
      ОборотПоРеализации: 100000,
      СтавкаНДСЧисло: 16,
      СуммаНДС: 16000,
      Сумма: 116000,
      ПризнакПроисхождения: "6",
    },
  ],
  ТоварыПоПоставщикам: [],
  ТоварыПоПолучателям: [],
  ...o,
});

function make(o: { esf?: Row[]; contacts?: boolean; readOnly?: boolean; writable?: boolean } = {}) {
  const store = baseStore();
  store["Catalog_Контрагенты"]![0]!["СтранаРезидентства_Key"] = KZ;
  store["Catalog_Организации"]!.push({
    Ref_Key: OTHER_ORG,
    Description: "Другая организация",
    ИдентификационныйНомер: "990000000001",
    DeletionMark: false,
  });
  return fake1C({
    ...(o.readOnly ? { readOnly: true } : {}),
    ...(o.writable !== undefined ? { writable: o.writable } : {}),
    store: {
      ...store,
      Catalog_КлассификаторСтранМира: [
        { Ref_Key: KZ, Code: "398", Description: "КАЗАХСТАН", КодАльфа2: "KZ" },
      ],
      ...(o.contacts === false
        ? {}
        : {
            Catalog_ВидыКонтактнойИнформации: [
              { Ref_Key: K_ORG_LEGAL, PredefinedDataName: "ЮрАдресОрганизации", Description: "Юр. адрес" },
              {
                Ref_Key: K_ORG_POST,
                PredefinedDataName: "АдресОрганизацииПочтовый",
                Description: "Почтовый",
              },
              { Ref_Key: K_CP_LEGAL, PredefinedDataName: "ЮрАдресКонтрагента", Description: "Юр. адрес" },
              {
                Ref_Key: K_CP_ACTUAL,
                PredefinedDataName: "ФактАдресКонтрагента",
                Description: "Факт. адрес",
              },
            ],
            InformationRegister_КонтактнаяИнформация: [
              ci(ORG, "Catalog_Организации", K_ORG_POST, ORG_POST),
              ci(ORG, "Catalog_Организации", K_ORG_LEGAL, ORG_LEGAL),
              ci(BUYER, "Catalog_Контрагенты", K_CP_ACTUAL, CP_ACTUAL),
              ci(BUYER, "Catalog_Контрагенты", K_CP_LEGAL, CP_LEGAL),
            ],
          }),
      Document_ЭСФ: o.esf ?? [],
      Document_СчетФактураВыданный: [inv()],
      Document_РеализацияТоваровУслуг: [sale()],
    },
  });
}
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");
const sc = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;

describe("нумерация ЭСФ", () => {
  it("splitNumber / nextNumber / formatNumber: префикс, длина, максимум", () => {
    expect(splitNumber("00000000012")).toEqual({ prefix: "", value: 12, width: 11 });
    expect(splitNumber("АБ-0007")).toMatchObject({ prefix: "АБ-", value: 7 });
    expect(nextNumber(["00000000002", "00000000010", "00000000001"], { prefix: "", width: 11 }).number).toBe(
      "00000000011",
    );
    expect(formatNumber("", 1, 11)).toBe("00000000001");
    expect(nextNumber(["АБ-0007"], { prefix: "", width: 11 }).number).toBe("АБ-0008");
  });

  it("create_draft: следующий среди исходящих ЭСФ организации за год; входящие, другие организации и годы не в счёт", async () => {
    const f = make({
      esf: [
        esfRow(201, "00000000001"),
        esfRow(202, "00000000002"),
        esfRow(203, "00000000569", { Направление: "Входящий" }),
        esfRow(204, "00000000050", { Организация_Key: OTHER_ORG }),
        esfRow(205, "00000000040", { Date: "2025-12-30T10:00:00" }),
      ],
    });
    const r = await f.call("write.esf.create_draft", { basisRef: INV });
    expect(r.isError, text(r)).toBeFalsy();
    expect(sc(r)["payload"]["Number"]).toBe("00000000003");
    expect(f.posts).toHaveLength(0);
  });

  it("create_draft: number вручную — дубль среди исходящих организации отказ, совпадение с входящим — нет", async () => {
    const esf = [esfRow(201, "00000000001"), esfRow(203, "00000000569", { Направление: "Входящий" })];
    const dup = await make({ esf }).call("write.esf.create_draft", { basisRef: INV, number: "00000000001" });
    expect(dup.isError).toBe(true);
    expect(text(dup)).toMatch(/уже занят исходящим ЭСФ/);
    const okIncoming = await make({ esf }).call("write.esf.create_draft", {
      basisRef: INV,
      number: "00000000569",
    });
    expect(okIncoming.isError, text(okIncoming)).toBeFalsy();
    expect(sc(okIncoming)["payload"]["Number"]).toBe("00000000569");
  });

  it("create_draft: ЭСФ в базе нет — формат как у счетов-фактур выданных, номер 1", async () => {
    const r = await make().call("write.esf.create_draft", { basisRef: INV });
    expect(r.isError, text(r)).toBeFalsy();
    expect(sc(r)["payload"]["Number"]).toBe("00000000001");
  });
});

describe("ЭСФ: адреса и реквизиты как в форме 1С", () => {
  it("адреса из контактной информации, грузоотправитель/грузополучатель для услуг, тип подписи, способ расчёта, курс 1", async () => {
    const r = await make().call("write.esf.create_draft", { basisRef: INV });
    expect(r.isError, text(r)).toBeFalsy();
    const p = sc(r)["payload"];
    expect(p.Поставщики[0].Адрес).toBe(ORG_LEGAL); // юридический раньше почтового
    expect(p.Поставщики[0].КодСтраны).toBeUndefined(); // у резидента не заполняется
    expect(p.Получатели[0]).toMatchObject({ Адрес: CP_LEGAL, КодСтраны: "KZ" }); // юридический раньше фактического
    expect(p).toMatchObject({
      Грузоотправитель: ORG,
      Грузоотправитель_Type: "StandardODATA.Catalog_Организации",
      ГрузоотправительИдентификатор: "123123123123",
      АдресОтправки: ORG_LEGAL,
      Грузополучатель: BUYER,
      ГрузополучательИдентификатор: BIN,
      АдресДоставки: CP_LEGAL,
      ГрузополучательКодСтраны: "KZ",
      ДоговорПоставкиУсловияПоставки: "XXX",
      СпособОтправленияПоКлассификатору: "99",
      ТипПодписи: "ЮридическоеЛицо",
      СпособРасчета: "Безналичный",
      КурсВалюты: 1,
    });
    expect(p).not.toHaveProperty("ПунктНазначения");
    for (const k of ["РегистрационныйНомер", "Идентификатор", "Состояние"]) expect(p).not.toHaveProperty(k);
    expect(p["Статус"]).toBe("Черновик");
  });

  it("регистр контактной информации не опубликован — адреса пустые, предупреждение", async () => {
    const r = await make({ contacts: false }).call("write.esf.create_draft", { basisRef: INV });
    expect(r.isError, text(r)).toBeFalsy();
    expect(sc(r)["payload"].Поставщики[0].Адрес ?? "").toBe("");
    expect(text(r)).toMatch(/Контактная информация» не опубликован/);
  });

  it("headerDefaults: курс 1 для тенге, курс сохраняется для валюты", () => {
    expect(headerDefaults("KZT", 451.31)["КурсВалюты"]).toBe(1);
    expect(headerDefaults("USD", 451.31)["КурсВалюты"]).toBe(451.31);
  });
});

describe("write.esf.update_draft", () => {
  it("assignNumber + refreshParties: предпросмотр «было → станет», запись только с operationId", async () => {
    const f = make({ esf: [esfRow(201, "00000000001"), esfRow(202, "00000000002"), draft()] });
    const r = await f.call("write.esf.update_draft", {
      esfRef: DRAFT,
      assignNumber: true,
      refreshParties: true,
    });
    expect(r.isError, text(r)).toBeFalsy();
    const s = sc(r);
    expect(s["dryRun"]).toBe(true);
    expect(s["fields"]).toMatchObject({
      Number: "00000000003",
      АдресОтправки: ORG_LEGAL,
      АдресДоставки: CP_LEGAL,
      Грузоотправитель: ORG,
      ГрузополучательКодСтраны: "KZ",
      ТипПодписи: "ЮридическоеЛицо",
      СпособРасчета: "Безналичный",
      КурсВалюты: 1,
    });
    expect(s["fields"].Поставщики[0].Адрес).toBe(ORG_LEGAL);
    expect(s["fields"].Получатели[0]).toMatchObject({ Адрес: CP_LEGAL, КодСтраны: "KZ" });
    for (const k of ["РегистрационныйНомер", "Идентификатор", "Статус", "Состояние"])
      expect(s["fields"]).not.toHaveProperty(k);
    expect(s["changes"].some((c: any) => c.field === "Number")).toBe(true);
    expect(f.patches).toHaveLength(0);

    const noOp = await f.call("write.esf.update_draft", {
      esfRef: DRAFT,
      assignNumber: true,
      refreshParties: true,
      confirm: true,
    });
    expect(noOp.isError).toBe(true);
    expect(f.patches).toHaveLength(0);

    const c = await f.call("write.esf.update_draft", {
      esfRef: DRAFT,
      assignNumber: true,
      refreshParties: true,
      confirm: true,
      operationId: s["operationId"],
    });
    expect(c.isError, text(c)).toBeFalsy();
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0]!.body).toMatchObject({ Number: "00000000003", АдресОтправки: ORG_LEGAL });
    expect(sc(c)["verified"]).toBe(true);
  });

  it("отказ: зарегистрирован в ИС, входящий, отправлен, дубль номера, поле обмена или вне списка в header", async () => {
    const cases: Array<[Row, Record<string, unknown>, RegExp]> = [
      [{ РегистрационныйНомер: "ESF-000000000000-2026-0000001" }, { assignNumber: true }, /регистрационн/i],
      [{ Направление: "Входящий" }, { assignNumber: true }, /исходящ/i],
      [{ Статус: "Доставленный", Состояние: "ДоставленПолучателю" }, { assignNumber: true }, /Статус|статус/],
      [{}, { number: "00000000001" }, /уже занят/],
      [{}, { header: { РегистрационныйНомер: "x" } }, /не меняется/],
      [{}, { header: { СуммаДокумента: 1 } }, /не входит в список изменяемых/],
    ];
    for (const [o, args, re] of cases) {
      const f = make({ esf: [esfRow(201, "00000000001"), draft(o)] });
      const r = await f.call("write.esf.update_draft", { esfRef: DRAFT, ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toMatch(re);
      expect(f.patches).toHaveLength(0);
    }
  });

  it("строки: количество и цена — пересчёт НДС, итога строки и суммы документа", async () => {
    const f = make({ esf: [draft()] });
    const r = await f.call("write.esf.update_draft", {
      esfRef: DRAFT,
      lines: [{ lineNumber: 1, quantity: 2, price: 50000, name: "Разработка ПО (этап 1)" }],
    });
    expect(r.isError, text(r)).toBeFalsy();
    const row = sc(r)["fields"].Товары[0];
    expect(row).toMatchObject({
      ТоварНаименование: "Разработка ПО (этап 1)",
      СуммаБезНалогов: 100000,
      Количество: 2,
      Цена: 50000,
      СуммаНДС: 16000,
    });
    expect(row.Сумма).toBe(116000);
    expect(sc(r)["fields"]).not.toHaveProperty("СуммаДокумента"); // итог не изменился — в правку не попадает
  });

  it("проведённый — только с repost; READ_ONLY и writable=false запрещают запись", async () => {
    const posted = await make({ esf: [draft({ Posted: true })] }).call("write.esf.update_draft", {
      esfRef: DRAFT,
      assignNumber: true,
    });
    expect(posted.isError).toBe(true);
    expect(text(posted)).toMatch(/repost=true/);

    for (const o of [{ readOnly: true }, { writable: false }]) {
      const f = make({ esf: [draft()], ...o });
      const p = await f.call("write.esf.update_draft", { esfRef: DRAFT, assignNumber: true });
      const c = await f.call("write.esf.update_draft", {
        esfRef: DRAFT,
        assignNumber: true,
        confirm: true,
        operationId: sc(p)?.["operationId"] ?? "x",
      });
      expect(c.isError).toBe(true);
      expect(f.patches).toHaveLength(0);
    }
  });

  it("draftVerdict: черновик проходит, отправленный — нет", () => {
    expect(
      draftVerdict({
        direction: "Исходящий",
        status: "",
        state: "Сформирован",
        registrationNumber: "",
        identifier: "",
      }),
    ).toEqual([]);
    expect(
      draftVerdict({
        direction: "Исходящий",
        status: "Черновик",
        state: "",
        registrationNumber: "",
        identifier: "",
        queued: 1,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("ЭСФ не найден — понятная ошибка", async () => {
    const r = await make().call("write.esf.update_draft", { esfRef: id(999), assignNumber: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/не найден/);
  });
});

describe("номер ЭСФ: формат", () => {
  it("номер вручную: цифры, префикс без пробелов", () => {
    for (const ok of ["00000000012", "АБ-0007", "12"])
      expect(esfNumberField.safeParse(ok).success).toBe(true);
    for (const bad of ["x", "А Б 1", "12-", ""]) expect(esfNumberField.safeParse(bad).success).toBe(false);
  });
});
