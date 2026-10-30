/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в проверках */
import { describe, expect, it } from "vitest";
import { calendarDays, shiftMonth } from "../src/tools/payroll-vacation.js";
import { KZ_WRITE_TOOLS } from "../src/tools/write-kz.js";
import { baseStore, fake1C, id, ORG, type Row } from "./support/fake-1c.js";

/**
 * Отпускные: документ «Начисление зарплаты работникам организаций» с видом расчёта «Оплата отпуска» (как в Aru
 * Market, документ № 16). MCP пишет шапку, сотрудников и период отпуска, «Результат» не пишет — сумму считает 1С.
 */

const ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const KINDS = "ChartOfCalculationTypes_ОсновныеНачисленияОрганизаций";
const P1 = id(501);
const P2 = id(502);
const EMP1 = id(511);
const EMP2 = id(512);
const EMP_GONE = id(513);
const DEPT = id(520);
const SALARY_KIND = id(521);
const VAC = id(522);
const COMP = id(523);
const DISMISS = id(524);
const OWN_VAC = id(525);
const USER = id(541);
const OP = "11111111-2222-4333-8444-555555555555";

const props = (names: string[]) => names.map((name) => ({ name, type: "Edm.String" }));
const entities = {
  [ACCRUAL]: {
    properties: [
      ...props([
        "Ref_Key",
        "Number",
        "Date",
        "Posted",
        "DeletionMark",
        "Организация_Key",
        "Ответственный_Key",
        "ПериодРегистрации",
        "ВидРасчета_Key",
        "Комментарий",
        "РучнаяКорректировка",
      ]),
      { name: "Начисления", type: `Collection(StandardODATA.${ACCRUAL}_Начисления_RowType)` },
    ],
  },
  [`${ACCRUAL}_Начисления`]: {
    properties: props([
      "LineNumber",
      "Сотрудник_Key",
      "Физлицо_Key",
      "ВидРасчета_Key",
      "Размер",
      "Результат",
      "ПодразделениеОрганизации_Key",
      "ОтработаноДней",
      "ДатаНачала",
      "ДатаОкончания",
    ]),
  },
};

const emp = (ref: string, name: string, person: string, extra: Row = {}): Row => ({
  Ref_Key: ref,
  Description: name,
  Физлицо_Key: person,
  Организация_Key: ORG,
  ТекущееПодразделениеОрганизации_Key: DEPT,
  ДатаПриемаНаРаботу: "2026-01-01T00:00:00",
  ДатаУвольнения: "0001-01-01T00:00:00",
  DeletionMark: false,
  IsFolder: false,
  ...extra,
});
const kind = (ref: string, name: string, predefined: string, method: string): Row => ({
  Ref_Key: ref,
  Description: name,
  PredefinedDataName: predefined,
  СпособРасчета: method,
  DeletionMark: false,
});
const vacDoc = (n: number, posted: boolean, line: Row, extra: Row = {}): Row => ({
  Ref_Key: id(600 + n),
  Number: String(n).padStart(11, "0"),
  Date: "2026-10-31T23:59:59",
  Posted: posted,
  DeletionMark: false,
  Организация_Key: ORG,
  ПериодРегистрации: "2026-12-01T00:00:00",
  ВидРасчета_Key: VAC,
  Начисления: [{ LineNumber: "1", Сотрудник_Key: EMP1, Физлицо_Key: P1, ВидРасчета_Key: VAC, ...line }],
  ...extra,
});

function setup(opts: { readOnly?: boolean } = {}) {
  const store = baseStore();
  store["Catalog_ФизическиеЛица"] = [
    { Ref_Key: P1, Description: "Касымова Диана Сериковна." },
    { Ref_Key: P2, Description: "Жумабекова Алина Ерлановна" },
  ];
  store["Catalog_Пользователи"] = [{ Ref_Key: USER, Description: "Бухгалтер" }];
  store["Catalog_СотрудникиОрганизаций"] = [
    emp(EMP1, "Касымова Диана Сериковна.", P1),
    emp(EMP2, "Жумабекова Алина Ерлановна", P2),
    emp(EMP_GONE, "Уволенный Сотрудник", id(503), { ДатаУвольнения: "2026-08-15T00:00:00" }),
  ];
  store[KINDS] = [
    kind(SALARY_KIND, "Оклад по дням", "ОкладПоДням", "ПоМесячнойТарифнойСтавкеПоДням"),
    kind(VAC, "Оплата отпуска", "ОплатаПоСреднемуОтп", "ПоСреднемуЗаработкуДляОтпуска"),
    kind(COMP, "Компенсация отпуска", "КомпенсацияОтпускаБезУвольнения", "ПоСреднемуЗаработкуДляОтпуска"),
    kind(
      DISMISS,
      "Компенсация отпуска при увольнении",
      "КомпенсацияОтпуска",
      "ПоСреднемуЗаработкуДляОтпуска",
    ),
    kind(OWN_VAC, "Отпуск (свой)", "", "ПоСреднемуЗаработкуДляОтпуска"),
  ];
  store[ACCRUAL] = [
    // Оклад за декабрь — другое начисление того же месяца.
    {
      Ref_Key: id(611),
      Number: "00000000011",
      Date: "2026-12-31T00:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: "2026-12-01T00:00:00",
      Начисления: [
        { LineNumber: "1", Сотрудник_Key: EMP2, Физлицо_Key: P2, ВидРасчета_Key: SALARY_KIND, Результат: 1 },
      ],
    },
    // Рассчитанный и проведённый отпуск EMP1 в декабре.
    vacDoc(16, true, {
      ДатаНачала: "2026-12-01T00:00:00",
      ДатаОкончания: "2026-12-20T00:00:00",
      Результат: 50000,
    }),
    // Помеченный на удаление — не мешает и не показывается.
    vacDoc(
      17,
      false,
      { ДатаНачала: "2026-11-01T00:00:00", ДатаОкончания: "2026-11-10T00:00:00", Результат: 0 },
      { DeletionMark: true },
    ),
  ];
  return fake1C({ store, entities, readOnly: opts.readOnly ?? false });
}

type Res = { structuredContent?: any; isError?: boolean; content: Array<{ text?: string }> };
const text = (r: Res) => r.content.map((c) => c.text ?? "").join("\n");
const notes = (r: Res) => ((r.structuredContent?.notes ?? []) as string[]).join("\n");
const T = "write.payroll.create_vacation_accrual";

describe("отпуск: даты", () => {
  it("календарные дни включительно и сдвиг месяца", () => {
    expect(calendarDays("2026-12-01", "2026-12-24")).toBe(24);
    expect(calendarDays("2026-02-27", "2026-03-02")).toBe(4);
    expect(shiftMonth("2026-12-01T00:00:00", 3)).toBe("2027-03-01T00:00:00");
    expect(shiftMonth("2026-02-01T00:00:00", -3)).toBe("2025-11-01T00:00:00");
  });

  it("инструмент записи — в списке казахстанских", () => {
    expect(KZ_WRITE_TOOLS).toContain(T);
  });
});

describe("write.payroll.create_vacation_accrual", () => {
  it("предпросмотр: шапка с видом «Оплата отпуска», строка с периодом и подразделением, без Результат", async () => {
    const { call, posts } = setup();
    const r = (await call(T, {
      employees: [{ employee: "Жумабекова", startDate: "2026-12-07", endDate: "2026-12-30" }],
      date: "2026-12-01",
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(0);
    const p = r.structuredContent.payload;
    expect(p).toMatchObject({
      Организация_Key: ORG,
      ПериодРегистрации: "2026-12-01T00:00:00",
      ВидРасчета_Key: VAC,
      Posted: false,
    });
    expect(p.Начисления).toEqual([
      expect.objectContaining({
        Сотрудник_Key: EMP2,
        Физлицо_Key: P2,
        ВидРасчета_Key: VAC,
        ДатаНачала: "2026-12-07T00:00:00",
        ДатаОкончания: "2026-12-30T00:00:00",
        ПодразделениеОрганизации_Key: DEPT,
      }),
    ]);
    expect(p.Начисления[0]).not.toHaveProperty("Результат");
    expect(notes(r)).toContain("Жумабекова Алина Ерлановна — 07.12.2026–30.12.2026 (24 календ. дн.)");
    expect(notes(r)).toContain("MCP не считает");
    expect(notes(r)).toContain("дни отпуска не оплачены окладом");
    expect(notes(r)).not.toContain("Оклад повторно не начисляйте");
    expect(notes(r)).toContain("Ответственный не передан");
  });

  it("компенсация, свой вид, период и ответственный; чужой вид — отказ", async () => {
    const { call } = setup();
    const comp = (await call(T, {
      employees: [{ employee: EMP2, startDate: "2027-01-05", endDate: "2027-01-09" }],
      kind: "compensation",
      period: "2027-01",
      responsibleRef: USER,
      comment: "ZZ",
    })) as Res;
    expect(comp.isError, text(comp)).toBeFalsy();
    expect(comp.structuredContent.payload).toMatchObject({
      ВидРасчета_Key: COMP,
      ПериодРегистрации: "2027-01-01T00:00:00",
      Ответственный_Key: USER,
      Комментарий: "ZZ",
    });
    const own = (await call(T, {
      employees: [{ employee: EMP2, startDate: "2027-01-05", endDate: "2027-01-09" }],
      calculationTypeRef: OWN_VAC,
    })) as Res;
    expect(own.structuredContent.payload.ВидРасчета_Key).toBe(OWN_VAC);
    const bad = (await call(T, {
      employees: [{ employee: EMP2, startDate: "2027-01-05", endDate: "2027-01-09" }],
      calculationTypeRef: SALARY_KIND,
    })) as Res;
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("это не вид расчёта отпуска");
  });

  it("пересечение с начисленным отпуском — отказ; allowDuplicate — предупреждение; помеченный не мешает", async () => {
    const { call } = setup();
    const dup = (await call(T, {
      employees: [{ employee: "Касымова", startDate: "2026-12-15", endDate: "2026-12-28" }],
    })) as Res;
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain(
      "№ 00000000016 от 2026-10-31 (Оплата отпуска 01.12.2026–20.12.2026, проведён)",
    );
    const forced = (await call(T, {
      employees: [{ employee: "Касымова", startDate: "2026-12-15", endDate: "2026-12-28" }],
      allowDuplicate: true,
    })) as Res;
    expect(forced.isError, text(forced)).toBeFalsy();
    expect(notes(forced)).toContain("Внимание: на эти даты отпуск уже начислен");
    const nov = (await call(T, {
      employees: [{ employee: "Касымова", startDate: "2026-11-01", endDate: "2026-11-10" }],
    })) as Res;
    expect(nov.isError, text(nov)).toBeFalsy();
  });

  it("проверки входа: даты наоборот, уволенный, нет сотрудника, несколько, пересечение в запросе", async () => {
    const { call } = setup();
    const swap = (await call(T, {
      employees: [{ employee: EMP2, startDate: "2026-12-10", endDate: "2026-12-01" }],
    })) as Res;
    expect(text(swap)).toContain("раньше первого");
    const gone = (await call(T, {
      employees: [{ employee: EMP_GONE, startDate: "2026-09-01", endDate: "2026-09-10" }],
    })) as Res;
    expect(text(gone)).toContain("уволен 15.08.2026");
    const dismissal = (await call(T, {
      employees: [{ employee: EMP_GONE, startDate: "2026-09-01", endDate: "2026-09-10" }],
      kind: "dismissal",
    })) as Res;
    expect(dismissal.isError, text(dismissal)).toBeFalsy();
    expect(dismissal.structuredContent.payload.ВидРасчета_Key).toBe(DISMISS);
    const none = (await call(T, {
      employees: [{ employee: "Нетакого", startDate: "2026-12-01", endDate: "2026-12-02" }],
    })) as Res;
    expect(text(none)).toContain("не найден");
    const many = (await call(T, {
      employees: [{ employee: "а", startDate: "2026-12-01", endDate: "2026-12-02" }],
    })) as Res;
    expect(text(many)).toContain("несколько сотрудников");
    const self = (await call(T, {
      employees: [
        { employee: EMP2, startDate: "2027-02-01", endDate: "2027-02-10" },
        { employee: EMP2, startDate: "2027-02-05", endDate: "2027-02-12" },
      ],
    })) as Res;
    expect(text(self)).toContain("пересекаются");
  });

  it("журнал: confirm без предпросмотра — отказ; dry-run → confirm создаёт; READ_ONLY не пишет", async () => {
    const args = { employees: [{ employee: EMP2, startDate: "2027-02-01", endDate: "2027-02-14" }] };
    const { call, posts } = setup();
    const blind = (await call(T, { ...args, confirm: true, operationId: OP })) as Res;
    expect(blind.isError).toBe(true);
    const plan = (await call(T, args)) as Res;
    const r = (await call(T, {
      ...args,
      confirm: true,
      operationId: plan.structuredContent.operationId,
    })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.set).toBe(ACCRUAL);
    expect(posts[0]!.body["Posted"]).toBe(false);
    const ro = setup({ readOnly: true });
    const p2 = (await ro.call(T, args)) as Res;
    const denied = (await ro.call(T, {
      ...args,
      confirm: true,
      operationId: p2.structuredContent?.operationId ?? OP,
    })) as Res;
    expect(denied.isError).toBe(true);
    expect(ro.posts).toHaveLength(0);
  });

  it("созданный нерассчитанный отпуск post_document не проводит (Результат 0)", async () => {
    const args = { employees: [{ employee: EMP2, startDate: "2027-02-01", endDate: "2027-02-14" }] };
    const { call, store, actions } = setup();
    const plan = (await call(T, args)) as Res;
    const r = (await call(T, {
      ...args,
      confirm: true,
      operationId: plan.structuredContent.operationId,
    })) as Res;
    const ref = r.structuredContent.ref ?? r.structuredContent.created?.Ref_Key;
    expect(ref, text(r)).toBeTruthy();
    const preview = (await call("write.document.post_document", {
      entitySet: ACCRUAL,
      ref,
      post: true,
    })) as Res;
    expect(notes(preview)).toMatch(/Результат/);
    const post = (await call("write.document.post_document", {
      entitySet: ACCRUAL,
      ref,
      post: true,
      confirm: true,
    })) as Res;
    expect(post.isError, text(post)).toBe(true);
    expect(actions).toHaveLength(0);
    expect(store[ACCRUAL]!.find((d) => d["Ref_Key"] === ref)!["Posted"]).toBe(false);
  });
});

describe("read.payroll.get_vacations", () => {
  it("строки отпуска с периодом, днями, суммой и статусом; оклад и помеченные — нет", async () => {
    const { call, store } = setup();
    store[ACCRUAL]!.push(
      vacDoc(
        18,
        false,
        {
          Сотрудник_Key: EMP2,
          Физлицо_Key: P2,
          ДатаНачала: "2026-12-21T00:00:00",
          ДатаОкончания: "2026-12-25T00:00:00",
        },
        { Date: "2026-12-01T00:00:00" },
      ),
    );
    const r = (await call("read.payroll.get_vacations", { from: "2026-11-01", to: "2026-12-31" })) as Res;
    expect(r.isError, text(r)).toBeFalsy();
    const sc = r.structuredContent;
    expect(sc.count).toBe(2);
    expect(sc.totalPosted).toBe(50000);
    expect(sc.vacations[0]).toMatchObject({
      employee: "Касымова Диана Сериковна",
      document: "00000000016",
      kind: "Оплата отпуска",
      startDate: "2026-12-01",
      endDate: "2026-12-20",
      calendarDays: 20,
      amount: 50000,
      status: "posted",
    });
    expect(sc.vacations[1]).toMatchObject({
      employee: "Жумабекова Алина Ерлановна",
      status: "not_calculated",
    });
    expect(sc.note).toContain("с суммой 0");
    const one = (await call("read.payroll.get_vacations", {
      from: "2026-12-01",
      to: "2026-12-31",
      employee: "жумаб",
    })) as Res;
    expect(one.structuredContent.count).toBe(1);
    const none = (await call("read.payroll.get_vacations", { from: "2027-03-01", to: "2027-03-31" })) as Res;
    expect(none.structuredContent.count).toBe(0);
  });
});
