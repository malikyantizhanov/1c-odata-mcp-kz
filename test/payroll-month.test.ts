/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import { KZ_WRITE_TOOLS } from "../src/tools/write-kz.js";
import { monthLastDay, monthStart, personOf } from "../src/tools/payroll-data.js";
import { baseStore, fake1C, id, ORG, type Row } from "./support/fake-1c.js";

/**
 * Зарплата за месяц: проверка месяца, остатки к перечислению, ведомость и перечисления в фонды. Суммы — только
 * из «регистров 1С» (фейковые остатки Balance и движения _RecordType), MCP их не считает.
 */

const M = "2026-09-01T00:00:00";
const ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const WITHHOLDING = "Document_РасчетУдержанийРаботниковОрганизаций";
const EP = "Document_РасчетЕдиногоПлатежа";
const STATEMENT = "Document_ЗарплатаКВыплатеОрганизаций";
const OPV_T = "Document_ОПВПеречислениеВФонды";
const SO_T = "Document_СОПеречислениеВФонды";
const EP_T = "Document_ЕППеречислениеВФонды";
const SALARY = "AccumulationRegister_ВзаиморасчетыСРаботникамиОрганизаций";
const EP_REG = "AccumulationRegister_ЕПРасчетыСФондами";
const OPV_REG = "AccumulationRegister_ОПВРасчетыСФондами";
const PERSON_T = "StandardODATA.Catalog_ФизическиеЛица";
const P1 = id(501);
const P2 = id(502);
const EMP1 = id(511);
const EMP2 = id(512);
const KIND = id(521);
const FUND = id(531);
const USER = id(541);
const OP = "11111111-2222-4333-8444-555555555555";

const props = (names: string[]) => names.map((name) => ({ name, type: "Edm.String" }));
const head = ["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "Ответственный_Key"];
const doc = (set: string, fields: string[], table: string, rowFields: string[]) => ({
  [set]: {
    properties: [
      ...props([...head, ...fields]),
      { name: table, type: `Collection(StandardODATA.${set}_${table}_RowType)` },
    ],
  },
  [`${set}_${table}`]: { properties: props(["LineNumber", ...rowFields]) },
});
const entities = {
  ...doc(
    STATEMENT,
    [
      "ПериодНачисленияЗарплаты",
      "СпособВыплаты",
      "СпособРасчетаСуммКВыплате",
      "ПроцентВыплаты",
      "РазмерОкругления",
      "СуммаДокумента",
      "Комментарий",
    ],
    "Зарплата",
    ["Физлицо_Key", "Сумма", "СуммаКВыплате", "ДепонированнаяСумма", "ВыплаченностьЗарплаты", "Авторасчет"],
  ),
  ...doc(
    OPV_T,
    [
      "ПериодРегистрации",
      "ВидПлатежа",
      "СпособРасчетаСуммКПеречислению",
      "ВидОперации",
      "Контрагент_Key",
      "СуммаДокумента",
      "Комментарий",
    ],
    "ПенсионныеВзносы",
    ["ФизЛицо", "ФизЛицо_Type", "Сумма"],
  ),
  ...doc(
    SO_T,
    [
      "ПериодРегистрации",
      "ВидПлатежа",
      "СпособРасчетаСуммКПеречислению",
      "ВидОперации",
      "Контрагент_Key",
      "СуммаДокумента",
      "Комментарий",
    ],
    "СоциальныеОтчисления",
    ["ФизЛицо", "ФизЛицо_Type", "Сумма", "МесяцПериода"],
  ),
  ...doc(
    EP_T,
    [
      "ПериодРегистрации",
      "ВидПлатежа",
      "СпособРасчетаСуммКПеречислению",
      "Контрагент_Key",
      "СуммаДокумента",
      "Комментарий",
    ],
    "ЕдиныеПлатежи",
    [
      "ФизЛицо_Key",
      "МесяцНалоговогоПериода",
      "Сумма",
      "СуммаПлатежа",
      "ВключаетОПВ",
      "ВключаетВОСМС",
      "ВключаетИПН",
      "ВключаетСО",
      "ВключаетООСМС",
      "ВключаетОПВР",
    ],
  ),
};

const accrual = (n: number, posted: boolean, result: number, extra: Row = {}) => ({
  Ref_Key: id(600 + n),
  Number: String(n).padStart(11, "0"),
  Date: "2026-09-30T00:00:00",
  Posted: posted,
  DeletionMark: false,
  Организация_Key: ORG,
  ПериодРегистрации: M,
  Начисления: [
    { LineNumber: "1", Сотрудник_Key: EMP1, Физлицо_Key: P1, ВидРасчета_Key: KIND, Результат: result },
  ],
  ...extra,
});
const ep = (n: number, rows: Row[]) => ({
  Ref_Key: id(700 + n),
  Number: String(n).padStart(11, "0"),
  Date: "2026-09-30T00:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  ПериодРегистрации: M,
  ИсчисленныйЕП: rows,
  Удержания: [],
});

function setup(opts: { readOnly?: boolean; extra?: (s: Record<string, Row[]>) => void } = {}) {
  const store = baseStore();
  store["Catalog_ФизическиеЛица"] = [
    { Ref_Key: P1, Description: "Касымова Диана Сериковна." },
    { Ref_Key: P2, Description: "Жумабекова Алина Ерлановна" },
  ];
  store["Catalog_Пользователи"] = [{ Ref_Key: USER, Description: "Бухгалтер" }];
  store["Catalog_СотрудникиОрганизаций"] = [
    {
      Ref_Key: EMP1,
      Description: "Касымова Д.С.",
      Физлицо_Key: P1,
      Организация_Key: ORG,
      ДатаПриемаНаРаботу: "2026-01-01T00:00:00",
      ДатаУвольнения: "0001-01-01T00:00:00",
      DeletionMark: false,
      IsFolder: false,
    },
    {
      Ref_Key: EMP2,
      Description: "Жумабекова А.Е.",
      Физлицо_Key: P2,
      Организация_Key: ORG,
      ДатаПриемаНаРаботу: "2026-01-01T00:00:00",
      ДатаУвольнения: "0001-01-01T00:00:00",
      DeletionMark: false,
      IsFolder: false,
    },
    {
      Ref_Key: id(513),
      Description: "Уволенный",
      Физлицо_Key: id(503),
      Организация_Key: ORG,
      ДатаПриемаНаРаботу: "2025-01-01T00:00:00",
      ДатаУвольнения: "2026-08-15T00:00:00",
      DeletionMark: false,
      IsFolder: false,
    },
  ];
  store[ACCRUAL] = [accrual(11, true, 600000), accrual(12, true, 600000), accrual(9, false, 4333472)];
  store[WITHHOLDING] = [
    {
      Ref_Key: id(651),
      Number: "00000000003",
      Date: "2026-09-30T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: M,
      ИсчисленныйОПВ: [{ ФизЛицо: P1, ФизЛицо_Type: PERSON_T, Взнос: 60000 }],
      ИсчисленныеВОСМС: [],
      ИсчисленныйИПН: [],
      Удержания: [],
    },
  ];
  store[EP] = [
    ep(9, [{ ФизЛицо_Key: P1, МесяцНалоговогоПериода: M, ОблагаемаяБаза: 600000, СуммаПлатежа: 148642.2 }]),
    ep(13, []),
  ];
  store[STATEMENT] = [];
  store[OPV_T] = [];
  store[SO_T] = [];
  store[EP_T] = [
    {
      Ref_Key: id(801),
      Number: "00000000001",
      Date: "2026-08-31T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: "2026-08-01T00:00:00",
      Контрагент_Key: FUND,
      ЕдиныеПлатежи: [{ ФизЛицо_Key: P1, Сумма: 1 }],
    },
  ];
  store["Document_ОтражениеЗарплатыВРеглУчете"] = [];
  store["Document_РасчетСНиСО"] = [];
  // Остатки регистров 1С (виртуальная таблица Balance) и движения документов (_RecordType).
  store[SALARY] = [];
  store[`${SALARY}/Balance`] = [
    { Физлицо_Key: P1, ПериодВзаиморасчетов: M, Организация_Key: ORG, СуммаВзаиморасчетовBalance: 517118.4 },
    { Физлицо_Key: P2, ПериодВзаиморасчетов: M, Организация_Key: ORG, СуммаВзаиморасчетовBalance: -100 },
    {
      Физлицо_Key: P1,
      ПериодВзаиморасчетов: "2026-10-01T00:00:00",
      Организация_Key: ORG,
      СуммаВзаиморасчетовBalance: 1,
    },
  ];
  store[EP_REG] = [];
  store[`${EP_REG}/Balance`] = [
    {
      ФизЛицо_Key: P1,
      МесяцНалоговогоПериода: M,
      ВидПлатежа: "Налог",
      Организация_Key: ORG,
      СуммаПлатежаBalance: 148642.2,
    },
    {
      ФизЛицо_Key: P1,
      МесяцНалоговогоПериода: M,
      ВидПлатежа: "ПениСам",
      Организация_Key: ORG,
      СуммаПлатежаBalance: 15,
    },
  ];
  store[OPV_REG] = [];
  store[`${OPV_REG}/Balance`] = [
    {
      ФизЛицо: P2,
      ФизЛицо_Type: PERSON_T,
      МесяцНалоговогоПериода: M,
      ВидПлатежа: "Налог",
      Организация_Key: ORG,
      ВзносBalance: 35000,
    },
  ];
  store[`${SALARY}_RecordType`] = [
    { Recorder: id(611), Recorder_Type: `StandardODATA.${ACCRUAL}`, СуммаВзаиморасчетов: 600000 },
    { Recorder: id(612), Recorder_Type: `StandardODATA.${ACCRUAL}`, СуммаВзаиморасчетов: 600000 },
  ];
  store[`${OPV_REG}_RecordType`] = [
    { Recorder: id(651), Recorder_Type: `StandardODATA.${WITHHOLDING}`, Взнос: 50000 },
  ];
  store[`${EP_REG}_RecordType`] = [
    { Recorder: id(709), Recorder_Type: `StandardODATA.${EP}`, СуммаПлатежа: 148642.2 },
  ];
  store["AccumulationRegister_ЕПСведенияОДоходах_RecordType"] = [
    { ФизЛицо_Key: P1, ПериодРегистрации: M, Организация_Key: ORG, СуммаДохода: 600000, Active: true },
    { ФизЛицо_Key: P1, ПериодРегистрации: M, Организация_Key: ORG, СуммаДохода: 600000, Active: true },
  ];
  opts.extra?.(store);
  return fake1C({ store, entities, readOnly: opts.readOnly ?? false });
}

type Res = { structuredContent?: any; isError?: boolean; content: Array<{ text?: string }> };
const text = (r: Res) => r.content.map((c) => c.text ?? "").join("\n");
const notes = (r: Res) => ((r.structuredContent?.notes ?? []) as string[]).join("\n");
const codes = (r: Res) => (r.structuredContent.issues as Array<{ code: string }>).map((i) => i.code);

describe("payroll-data", () => {
  it("месяц и физлицо строки (в т. ч. составное ФизЛицо)", () => {
    expect(monthStart("2026-09")).toBe(M);
    expect(monthStart("2026-09-17")).toBe(M);
    expect(monthLastDay("2026-02")).toBe("2026-02-28");
    expect(() => monthStart("09.2026")).toThrow("YYYY-MM");
    expect(personOf({ ФизЛицо: P1, ФизЛицо_Type: PERSON_T })).toBe(P1);
    expect(personOf({ ФизЛицо: P1, ФизЛицо_Type: "StandardODATA.Catalog_Контрагенты" })).toBeUndefined();
    expect(personOf({ Физлицо_Key: P2 })).toBe(P2);
  });
});

describe("read.payroll.check_month", () => {
  it("находит нули, дубли, сотрудника без начисления, ЕП+классика, базу ЕП, строки ↔ движения; остатки", async () => {
    const { call, posts, patches } = setup();
    const r = (await call("read.payroll.check_month", { period: "2026-09" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    const sc = r.structuredContent;
    expect(sc.status).toBe("error");
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "not_posted",
        "posted_zero",
        "duplicate_period",
        "employee_without_accrual",
        "ep_and_classic",
        "ep_base",
        "lines_vs_movements",
        "overpaid",
      ]),
    );
    const msg = (code: string) => sc.issues.find((i: any) => i.code === code).message as string;
    expect(msg("posted_zero")).toContain("№ 13");
    expect(msg("duplicate_period")).toContain("№ 11 и № 12");
    expect(msg("employee_without_accrual")).toContain("Жумабекова А.Е.");
    expect(msg("employee_without_accrual")).not.toContain("Уволенный");
    expect(msg("ep_base")).toContain("доход из начисления 1200000, облагаемая база в расчёте ЕП 600000");
    expect(msg("lines_vs_movements")).toContain("в строках 60000, в движениях 50000");
    expect(sc.toPay).toMatchObject({
      total: 517118.4,
      people: [{ person: "Касымова Диана Сериковна", amount: 517118.4 }],
    });
    expect(sc.toTransfer).toEqual(
      expect.arrayContaining([
        { fund: "ep", title: "ЕП", amount: 148657.2 },
        { fund: "opv", title: "ОПВ", amount: 35000 },
      ]),
    );
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("чистый месяц — status ok", async () => {
    const { call } = setup({
      extra: (s) => {
        s[ACCRUAL] = [accrual(11, true, 600000)];
        s[WITHHOLDING] = [];
        s[EP] = [ep(9, [{ ФизЛицо_Key: P1, ОблагаемаяБаза: 600000, СуммаПлатежа: 148642.2 }])];
        s["AccumulationRegister_ЕПСведенияОДоходах_RecordType"] = [
          { ФизЛицо_Key: P1, ПериодРегистрации: M, Организация_Key: ORG, СуммаДохода: 600000 },
        ];
        s["Catalog_СотрудникиОрганизаций"] = s["Catalog_СотрудникиОрганизаций"]!.filter(
          (e) => e["Ref_Key"] !== EMP2,
        );
        s[`${SALARY}/Balance`] = [];
        s[`${EP_REG}/Balance`] = [];
        s[`${OPV_REG}/Balance`] = [];
        s[`${SALARY}_RecordType`] = [
          { Recorder: id(611), Recorder_Type: `StandardODATA.${ACCRUAL}`, СуммаВзаиморасчетов: 600000 },
        ];
      },
    });
    const r = (await call("read.payroll.check_month", { period: "2026-09" })) as Res;
    expect(r.structuredContent.status, JSON.stringify(r.structuredContent.issues)).toBe("ok");
    expect(r.structuredContent.toPay.total).toBe(0);
  });
});

describe("read.payroll.get_fund_debts", () => {
  it("по фондам и месяцам; пени отдельно и не в итоге", async () => {
    const { call } = setup();
    const r = (await call("read.payroll.get_fund_debts", { period: "2026-09" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    const sc = r.structuredContent;
    expect(sc.totalOwed).toBe(183642.2);
    const epFund = sc.funds.find((f: any) => f.fund === "ep");
    expect(epFund).toMatchObject({ total: 148642.2, other: [{ kind: "ПениСам", amount: 15 }] });
    expect(epFund.people[0]).toMatchObject({ person: "Касымова Диана Сериковна", month: "09.2026" });
    const only = (await call("read.payroll.get_fund_debts", { fund: "opv", byPerson: false })) as Res;
    expect(only.structuredContent.funds).toEqual([
      { fund: "opv", title: "ОПВ", total: 35000, months: [{ month: "09.2026", amount: 35000 }] },
    ]);
  });
});

describe("write.payroll.create_payroll_statement", () => {
  it("предпросмотр: строки и итог из остатка к выплате, переплата не попадает, ничего не пишет", async () => {
    const { call, posts } = setup();
    const r = (await call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      date: "2026-09-30",
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(0);
    const p = r.structuredContent.payload;
    expect(p).toMatchObject({
      Организация_Key: ORG,
      ПериодНачисленияЗарплаты: M,
      СпособВыплаты: "ЧерезКассу",
      СпособРасчетаСуммКВыплате: "ЗарплатаЗаМесяц",
      СуммаДокумента: 517118.4,
      Posted: false,
    });
    expect(p.Зарплата).toEqual([
      expect.objectContaining({
        Физлицо_Key: P1,
        Сумма: 517118.4,
        СуммаКВыплате: 517118.4,
        Авторасчет: false,
      }),
    ]);
    expect(p).not.toHaveProperty("Ответственный_Key");
    expect(notes(r)).toContain("Касымова Диана Сериковна — 517");
    expect(notes(r)).toContain("Ответственный не передан");
  });

  it("ответственный явно; неизвестный пользователь — отказ", async () => {
    const { call } = setup();
    const r = (await call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      responsibleRef: USER,
      paymentMethod: "bank",
    })) as Res;
    expect(r.structuredContent.payload).toMatchObject({
      Ответственный_Key: USER,
      СпособВыплаты: "ЧерезБанк",
    });
    expect(notes(r)).toContain("Ответственный: Бухгалтер");
    const bad = (await call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      responsibleRef: id(999),
    })) as Res;
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("не найден");
  });

  it("нечего выплачивать — отказ; ведомость за месяц уже есть — отказ, allowDuplicate — предупреждение", async () => {
    const { call, store } = setup();
    const none = (await call("write.payroll.create_payroll_statement", { period: "2026-11" })) as Res;
    expect(none.isError).toBe(true);
    expect(text(none)).toContain("Нечего выплачивать за 11.2026");
    store[STATEMENT]!.push({
      Ref_Key: id(901),
      Number: "00000000002",
      Date: "2026-09-30T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодНачисленияЗарплаты: M,
      Зарплата: [{ Физлицо_Key: P1, Сумма: 517118.4 }],
    });
    const dup = (await call("write.payroll.create_payroll_statement", { period: "2026-09" })) as Res;
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("№ 00000000002 от 2026-09-30 (проведён)");
    const forced = (await call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      allowDuplicate: true,
    })) as Res;
    expect(forced.isError, text(forced)).toBeFalsy();
    expect(notes(forced)).toContain("Внимание: Ведомость");
  });

  it("журнал: confirm без operationId — отказ; dry-run → confirm создаёт; READ_ONLY не пишет", async () => {
    const { call, posts } = setup();
    const blind = (await call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      confirm: true,
      operationId: OP,
    })) as Res;
    expect(blind.isError).toBe(true);
    const plan = (await call("write.payroll.create_payroll_statement", { period: "2026-09" })) as Res;
    const operationId = plan.structuredContent.operationId as string;
    const r = (await call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      confirm: true,
      operationId,
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.set).toBe(STATEMENT);
    const ro = setup({ readOnly: true });
    const p2 = (await ro.call("write.payroll.create_payroll_statement", { period: "2026-09" })) as Res;
    const denied = (await ro.call("write.payroll.create_payroll_statement", {
      period: "2026-09",
      confirm: true,
      operationId: p2.structuredContent?.operationId ?? OP,
    })) as Res;
    expect(denied.isError).toBe(true);
    expect(ro.posts).toHaveLength(0);
  });
});

describe("write.payroll.create_fund_transfer", () => {
  it("ЕП из остатка: строки, Включает*, получатель из прошлого перечисления, пени не включены, про платёжку", async () => {
    const { call, posts } = setup();
    const r = (await call("write.payroll.create_fund_transfer", { fund: "ep", period: "2026-09" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(0);
    const p = r.structuredContent.payload;
    expect(p).toMatchObject({
      ПериодРегистрации: M,
      ВидПлатежа: "Налог",
      Контрагент_Key: FUND,
      СуммаДокумента: 148642.2,
    });
    expect(p.ЕдиныеПлатежи).toEqual([
      expect.objectContaining({
        ФизЛицо_Key: P1,
        МесяцНалоговогоПериода: M,
        Сумма: 148642.2,
        ВключаетОПВ: true,
      }),
    ]);
    expect(notes(r)).toContain("Пени/штрафы (ПениСам) не включены");
    expect(notes(r)).toContain(
      "Document_ПлатежноеПоручениеИсходящее, ВидОперации «ПеречислениеЕдиногоПлатежа»",
    );
  });

  it("ОПВ: составное ФизЛицо и ВидОперации; kind не того фонда — отказ; нет получателя — подсказка", async () => {
    const { call } = setup();
    const r = (await call("write.payroll.create_fund_transfer", { fund: "opv", period: "2026-09" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    const p = r.structuredContent.payload;
    expect(p.ВидОперации).toBe("ПеречислениеОбязательныхПенсионныхВзносов");
    expect(p.ПенсионныеВзносы).toEqual([
      expect.objectContaining({ ФизЛицо: P2, ФизЛицо_Type: PERSON_T, Сумма: 35000 }),
    ]);
    expect(notes(r)).toContain("передайте counterpartyRef");
    const bad = (await call("write.payroll.create_fund_transfer", {
      fund: "opv",
      kind: "so",
      period: "2026-09",
    })) as Res;
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("kind=so не относится к fund=opv");
  });

  it("из проведённого расчёта ЕП (basisRef): строки расчёта; непроведённое основание — отказ; повтор — отказ", async () => {
    const { call, store } = setup();
    const r = (await call("write.payroll.create_fund_transfer", { fund: "ep", basisRef: id(709) })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent.payload.ЕдиныеПлатежи[0]).toMatchObject({ ФизЛицо_Key: P1, Сумма: 148642.2 });
    expect(r.structuredContent.payload).not.toHaveProperty("ДокументОснование_Key");
    expect(notes(r)).toContain("«Расчёт единого платежа» № 00000000009");
    store[EP]![0]!["Posted"] = false;
    const unposted = (await call("write.payroll.create_fund_transfer", {
      fund: "ep",
      basisRef: id(709),
    })) as Res;
    expect(unposted.isError).toBe(true);
    store[EP]![0]!["Posted"] = true;
    store[EP_T]!.push({
      Ref_Key: id(802),
      Number: "00000000002",
      Date: "2026-09-30T00:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: M,
      ЕдиныеПлатежи: [{ ФизЛицо_Key: P1, Сумма: 148642.2 }],
    });
    const dup = (await call("write.payroll.create_fund_transfer", { fund: "ep", period: "2026-09" })) as Res;
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("№ 00000000002");
  });

  it("нечего перечислять — отказ; в KZ_WRITE_TOOLS", async () => {
    const { call } = setup();
    const none = (await call("write.payroll.create_fund_transfer", { fund: "so", period: "2026-09" })) as Res;
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/не опубликован|Нечего перечислять/);
    expect(KZ_WRITE_TOOLS as readonly string[]).toEqual(
      expect.arrayContaining([
        "write.payroll.create_payroll_statement",
        "write.payroll.create_fund_transfer",
      ]),
    );
  });
});

describe("kz_document_guide: блок «зарплата»", () => {
  it("сценарий и инструменты в справке", async () => {
    const { call } = setup();
    const r = (await call("read.system.kz_document_guide", { block: "зарплата" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    const g = r.structuredContent.payroll;
    const tools = JSON.stringify(g.tools);
    for (const t of [
      "read.payroll.check_month",
      "read.payroll.get_fund_debts",
      "write.payroll.create_payroll_statement",
      "write.payroll.create_fund_transfer",
    ])
      expect(tools).toContain(t);
    expect(JSON.stringify(g.scenario)).toContain("Рассчитать");
  });
});
