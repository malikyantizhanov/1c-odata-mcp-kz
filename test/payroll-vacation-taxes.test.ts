/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import { daysByMonth } from "../src/tools/payroll-vacation-taxes.js";
import { KZ_WRITE_TOOLS } from "../src/tools/write-kz.js";
import { baseStore, fake1C, id, ORG, type Row } from "./support/fake-1c.js";

/**
 * Удержания и налоги с отпускных — как при зарплате: по рассчитанному в 1С начислению с отпуском MCP создаёт
 * непроведённые «Расчёт удержаний» и «Расчёт СН и СО» месяца (шапка + «Физические лица»), суммы считает 1С.
 */

const ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const WH = "Document_РасчетУдержанийРаботниковОрганизаций";
const ER = "Document_РасчетСНиСО";
const KINDS = "ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций";
const P1 = id(501);
const P2 = id(502);
const EMP1 = id(511);
const EMP2 = id(512);
const SALARY_KIND = id(521);
const VAC = id(522);
const USER = id(541);
const T = "write.payroll.create_vacation_taxes";

const props = (names: string[]) => names.map((name) => ({ name, type: "Edm.String" }));
const head = ["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "Ответственный_Key"];
const coll = (set: string, t: string) => ({ name: t, type: `Collection(StandardODATA.${set}_${t}_RowType)` });
const entities = {
  [ACCRUAL]: {
    properties: [
      ...props([...head, "ПериодРегистрации", "ВидРасчета_Key", "Комментарий"]),
      coll(ACCRUAL, "Начисления"),
    ],
  },
  [`${ACCRUAL}_Начисления`]: {
    properties: props([
      "LineNumber",
      "Сотрудник_Key",
      "Физлицо_Key",
      "ВидРасчета_Key",
      "Результат",
      "ДатаНачала",
      "ДатаОкончания",
    ]),
  },
  [WH]: {
    properties: [
      ...props([...head, "ПериодРегистрации", "ВидРасчета_Key", "Комментарий"]),
      ...["ИсчисленныйИПН", "ИсчисленныйОПВ", "ИсчисленныеВОСМС", "Удержания", "ФизическиеЛица"].map((t) =>
        coll(WH, t),
      ),
    ],
  },
  [`${WH}_ФизическиеЛица`]: { properties: props(["LineNumber", "ФизическоеЛицо_Key"]) },
  [`${WH}_ИсчисленныйИПН`]: { properties: props(["LineNumber", "ФизЛицо", "ФизЛицо_Type", "Налог"]) },
  [`${WH}_ИсчисленныйОПВ`]: { properties: props(["LineNumber", "ФизЛицо", "ФизЛицо_Type", "Взнос"]) },
  [`${WH}_ИсчисленныеВОСМС`]: { properties: props(["LineNumber", "ФизЛицо", "ФизЛицо_Type", "Взнос"]) },
  [`${WH}_Удержания`]: { properties: props(["LineNumber", "ФизЛицо_Key", "Результат"]) },
  [ER]: {
    properties: [
      ...props([...head, "ПериодРегистрации", "Комментарий"]),
      ...[
        "ИсчисленныйСН",
        "ИсчисленныеСО",
        "ИсчисленныйОППВ",
        "ИсчисленныеООСМС",
        "ИсчисленныйОПВР",
        "ФизическиеЛица",
      ].map((t) => coll(ER, t)),
    ],
  },
  [`${ER}_ФизическиеЛица`]: { properties: props(["LineNumber", "ФизическоеЛицо_Key"]) },
  [`${ER}_ИсчисленныйСН`]: { properties: props(["LineNumber", "ФизЛицо_Key", "Налог"]) },
};

const doc = (n: number, posted: boolean, lines: Row[], extra: Row = {}): Row => ({
  Ref_Key: id(600 + n),
  Number: String(n).padStart(11, "0"),
  Date: "2026-10-31T23:59:59",
  Posted: posted,
  DeletionMark: false,
  Организация_Key: ORG,
  Ответственный_Key: USER,
  ПериодРегистрации: "2026-12-01T00:00:00",
  ВидРасчета_Key: VAC,
  Начисления: lines.map((l, i) => ({ LineNumber: String(i + 1), ВидРасчета_Key: VAC, ...l })),
  ...extra,
});

function setup(opts: { readOnly?: boolean } = {}) {
  const store = baseStore();
  store["Catalog_ФизическиеЛица"] = [
    { Ref_Key: P1, Description: "Кот Котович" },
    { Ref_Key: P2, Description: "Жумабекова Алина Ерлановна" },
  ];
  store["Catalog_Пользователи"] = [{ Ref_Key: USER, Description: "Бухгалтер" }];
  store[KINDS] = [
    {
      Ref_Key: SALARY_KIND,
      Description: "Оклад по дням",
      PredefinedDataName: "ОкладПоДням",
      СпособРасчета: "ПоМесячнойТарифнойСтавкеПоДням",
      DeletionMark: false,
    },
    {
      Ref_Key: VAC,
      Description: "Оплата отпуска",
      PredefinedDataName: "ОплатаПоСреднемуОтп",
      СпособРасчета: "ПоСреднемуЗаработкуДляОтпуска",
      DeletionMark: false,
    },
  ];
  store[ACCRUAL] = [
    // № 16: рассчитанный (Результат 50 000), проведённый отпуск 01–20.12.2026.
    doc(16, true, [
      {
        Сотрудник_Key: EMP1,
        Физлицо_Key: P1,
        Результат: 50000,
        ДатаНачала: "2026-12-01T00:00:00",
        ДатаОкончания: "2026-12-20T00:00:00",
      },
    ]),
    // № 17: не рассчитан (Результат 0), не проведён.
    doc(17, false, [
      {
        Сотрудник_Key: EMP2,
        Физлицо_Key: P2,
        Результат: 0,
        ДатаНачала: "2026-12-21T00:00:00",
        ДатаОкончания: "2026-12-25T00:00:00",
      },
    ]),
    // № 18: оклад — строк отпуска нет.
    doc(18, false, [{ Сотрудник_Key: EMP2, Физлицо_Key: P2, ВидРасчета_Key: SALARY_KIND, Результат: 1 }]),
    // № 19: отпуск 28.12.2026–10.01.2027, рассчитан, не проведён.
    doc(19, false, [
      {
        Сотрудник_Key: EMP2,
        Физлицо_Key: P2,
        Результат: 70000,
        ДатаНачала: "2026-12-28T00:00:00",
        ДатаОкончания: "2027-01-10T00:00:00",
      },
    ]),
    // № 20: помечен на удаление.
    doc(20, false, [{ Сотрудник_Key: EMP1, Физлицо_Key: P1, Результат: 1 }], { DeletionMark: true }),
  ];
  store[WH] = [];
  store[ER] = [];
  return { ...fake1C({ store, entities, readOnly: opts.readOnly ?? false }), store };
}

type Res = { structuredContent?: any; isError?: boolean; content: Array<{ text?: string }> };
const text = (r: Res) => r.content.map((c) => c.text ?? "").join("\n");
const notes = (r: Res) =>
  ((r.structuredContent?.notes ?? []) as string[]).join("\n").replace(/[\u00a0\u202f]/g, " ");

describe("отпускные → удержания и налоги: даты по месяцам", () => {
  it("дни отпуска по месяцам", () => {
    expect(daysByMonth("2026-12-01", "2026-12-20")).toEqual([{ month: "2026-12", days: 20 }]);
    expect(daysByMonth("2026-12-28", "2027-01-10")).toEqual([
      { month: "2026-12", days: 4 },
      { month: "2027-01", days: 10 },
    ]);
    expect(daysByMonth("2026-02-27", "2026-03-02")).toEqual([
      { month: "2026-02", days: 2 },
      { month: "2026-03", days: 2 },
    ]);
  });

  it("инструмент — в списке казахстанских", () => {
    expect(KZ_WRITE_TOOLS).toContain(T);
  });
});

describe("write.payroll.create_vacation_taxes", () => {
  it("предпросмотр удержаний: шапка месяца начисления, физлица из отпуска, сумм нет", async () => {
    const { call, posts } = setup();
    const r = (await call(T, { accrual: id(616) })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(0);
    expect(r.structuredContent.willCreate).toBe(WH);
    const p = r.structuredContent.payload;
    expect(p).toMatchObject({
      Организация_Key: ORG,
      ПериодРегистрации: "2026-12-01T00:00:00",
      Ответственный_Key: USER,
      Date: "2026-10-31T23:59:59",
      Posted: false,
    });
    expect(p.ФизическиеЛица).toEqual([{ ФизическоеЛицо_Key: P1, LineNumber: 1 }]);
    for (const t of ["ИсчисленныйИПН", "ИсчисленныйОПВ", "ИсчисленныеВОСМС", "Удержания"])
      expect(p).not.toHaveProperty(t);
    expect(notes(r)).toContain("Кот Котович — 50 000,00 тенге (Оплата отпуска 01.12.2026–20.12.2026)");
    expect(notes(r)).toContain("MCP не считает");
    expect(notes(r)).toContain("Ответственный — как в начислении");
    expect(notes(r)).not.toContain("не проведено");
    expect(notes(r)).not.toContain("переходит");
  });

  it("расчёт СН и СО по номеру документа; ответственный из параметра", async () => {
    const { call } = setup();
    const r = (await call(T, {
      accrual: "16",
      document: "employer",
      responsibleRef: USER,
      comment: "ZZ",
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent.willCreate).toBe(ER);
    expect(r.structuredContent.payload).toMatchObject({ Комментарий: "ZZ", Ответственный_Key: USER });
    expect(r.structuredContent.payload).not.toHaveProperty("ИсчисленныйСН");
  });

  it("отказ: сумма отпуска 0, нет строк отпуска, помечен на удаление, нет документа", async () => {
    const { call } = setup();
    const zero = (await call(T, { accrual: "17" })) as Res;
    expect(zero.isError).toBe(true);
    expect(text(zero)).toContain("сумма отпускных 0");
    expect(text(zero)).toContain("«Рассчитать»");
    const salary = (await call(T, { accrual: id(618) })) as Res;
    expect(text(salary)).toContain("нет строк с видом расчёта отпуска");
    const del = (await call(T, { accrual: id(620) })) as Res;
    expect(text(del)).toContain("помечено на удаление");
    const none = (await call(T, { accrual: "99" })) as Res;
    expect(text(none)).toContain("не найдено");
  });

  it("отпуск на два месяца и непроведённое начисление — предупреждения в предпросмотре", async () => {
    const { call } = setup();
    const r = (await call(T, { accrual: "19" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(notes(r)).toContain("переходит на 2 мес. (декабрь 2026 — 4 дн., январь 2027 — 10 дн.)");
    expect(notes(r)).toContain("пропорционально дням");
    expect(notes(r)).toContain("MCP суммы по месяцам не делит");
    expect(notes(r)).toContain("не проведено");
  });

  it("за месяц уже есть расчёт с этим сотрудником — отказ; allowDuplicate — предупреждение; другой вид не мешает", async () => {
    const { call, store } = setup();
    store[WH]!.push({
      Ref_Key: id(700),
      Number: "00000000004",
      Date: "2026-12-31T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: "2026-12-01T00:00:00",
      ФизическиеЛица: [],
      ИсчисленныйИПН: [
        { LineNumber: "1", ФизЛицо: P1, ФизЛицо_Type: "StandardODATA.Catalog_ФизическиеЛица", Налог: 5 },
      ],
    });
    const dup = (await call(T, { accrual: "16" })) as Res;
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("№ 00000000004 от 2026-12-31 (проведён)");
    const forced = (await call(T, { accrual: "16", allowDuplicate: true })) as Res;
    expect(forced.isError, text(forced)).toBeFalsy();
    expect(notes(forced)).toContain("Внимание: За 12.2026 уже есть");
    const er = (await call(T, { accrual: "16", document: "employer" })) as Res;
    expect(er.isError, text(er)).toBeFalsy();
  });

  it("пустой расчёт за месяц (1С очистила «Физические лица» при записи) — тоже дубль; помеченный — не мешает", async () => {
    const { call, store } = setup();
    store[ER]!.push({
      Ref_Key: id(701),
      Number: "00000000018",
      Date: "2026-12-21T00:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: "2026-12-01T00:00:00",
      ФизическиеЛица: [],
    });
    const dup = (await call(T, { accrual: "16", document: "employer" })) as Res;
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("№ 00000000018 от 2026-12-21 — пустой, ещё не заполнен");
    store[ER]![store[ER]!.length - 1]!["DeletionMark"] = true;
    const ok = (await call(T, { accrual: "16", document: "employer" })) as Res;
    expect(ok.isError, text(ok)).toBeFalsy();
  });

  it("dry-run → confirm создаёт непроведённый расчёт; post_document пустой не проводит; READ_ONLY не пишет", async () => {
    const { call, posts, store, actions } = setup();
    const blind = (await call(T, {
      accrual: "16",
      confirm: true,
      operationId: "11111111-2222-4333-8444-555555555555",
    })) as Res;
    expect(blind.isError).toBe(true);
    const plan = (await call(T, { accrual: "16" })) as Res;
    const r = (await call(T, {
      accrual: "16",
      confirm: true,
      operationId: plan.structuredContent.operationId,
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.set).toBe(WH);
    expect(posts[0]!.body["Posted"]).toBe(false);
    const ref = r.structuredContent.ref;
    const post = (await call("write.document.post_document", {
      entitySet: WH,
      ref,
      post: true,
      confirm: true,
    })) as Res;
    expect(post.isError, text(post)).toBe(true);
    expect(text(post)).toContain("суммы пустые");
    expect(actions).toHaveLength(0);
    expect(store[WH]!.find((d) => d["Ref_Key"] === ref)!["Posted"]).toBe(false);
    const ro = setup({ readOnly: true });
    const p2 = (await ro.call(T, { accrual: "16" })) as Res;
    const denied = (await ro.call(T, {
      accrual: "16",
      confirm: true,
      operationId: p2.structuredContent?.operationId ?? "11111111-2222-4333-8444-555555555555",
    })) as Res;
    expect(denied.isError).toBe(true);
    expect(ro.posts).toHaveLength(0);
  });
});
