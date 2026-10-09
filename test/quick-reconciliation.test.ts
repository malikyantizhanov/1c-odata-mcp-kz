import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { BIN, BUYER, CONTRACT, ORG, baseStore, fake1C, id, type Row, type Store } from "./support/fake-1c.js";
import { reconciliationFromRegister, settlementAccounts } from "../src/tools/quick-reconciliation.js";

/**
 * Акт сверки «в один вызов»: расчёт как кнопка «Заполнить» 1С (счета с субконто «Контрагенты» и «Договоры», движения по
 * документам, без внутренних оборотов, сальдо на начало), план → создание без проведения → PDF, повтор без дубля.
 * На живой базе 1С:Fresh.kz созданный так акт совпал с актом, заполненным 1С, во всех реквизитах и табличных частях.
 */
const T_CP = id(500);
const T_CONTRACT = id(501);
const A1210 = id(510);
const A3510 = id(511);
const A6010 = id(512);
const A1030 = id(513);
const A5010 = id(514);
const SALE = id(520);
const PAY = id(521);
const OTHER = id(530);
const TOOL = "write.counterparty.quick_reconciliation";
const cpType = "StandardODATA.Catalog_Контрагенты";
const contractType = "StandardODATA.Catalog_ДоговорыКонтрагентов";

function store(): Store {
  const s = baseStore();
  const both = [{ ExtDimensionType_Key: T_CP }, { ExtDimensionType_Key: T_CONTRACT }];
  const rec = (r: Row): Row => ({ Организация_Key: ORG, Active: true, ...r });
  return {
    ...s,
    ChartOfCharacteristicTypes_ВидыСубконтоТиповые: [
      { Ref_Key: T_CP, PredefinedDataName: "Контрагенты" },
      { Ref_Key: T_CONTRACT, PredefinedDataName: "Договоры" },
    ],
    ChartOfAccounts_Типовой: [
      { Ref_Key: A1210, Code: "1210", ExtDimensionTypes: both },
      { Ref_Key: A3510, Code: "3510", ExtDimensionTypes: both },
      { Ref_Key: A6010, Code: "6010", ExtDimensionTypes: [] },
      { Ref_Key: A1030, Code: "1030", ExtDimensionTypes: [] },
      { Ref_Key: A5010, Code: "5010", ExtDimensionTypes: [{ ExtDimensionType_Key: T_CP }] },
    ],
    "AccountingRegister_Типовой/RecordsWithExtDimensions": [
      // Реализация: Дт 1210 (покупатель, договор) Кт 6010 — дебет акта.
      rec({
        Period: "2026-10-05T10:00:00",
        Recorder: SALE,
        Recorder_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
        AccountDr_Key: A1210,
        ExtDimensionDr1: BUYER,
        ExtDimensionDr1_Type: cpType,
        ExtDimensionDr2: CONTRACT,
        ExtDimensionDr2_Type: contractType,
        AccountCr_Key: A6010,
        Сумма: 1000,
      }),
      // Зачёт аванса той же реализацией: Дт 3510 Кт 1210 — внутренний оборот, в акт не идёт.
      rec({
        Period: "2026-10-05T10:00:00",
        Recorder: SALE,
        Recorder_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
        AccountDr_Key: A3510,
        ExtDimensionDr1: BUYER,
        ExtDimensionDr1_Type: cpType,
        ExtDimensionDr2: CONTRACT,
        ExtDimensionDr2_Type: contractType,
        AccountCr_Key: A1210,
        ExtDimensionCr1: BUYER,
        ExtDimensionCr1_Type: cpType,
        ExtDimensionCr2: CONTRACT,
        ExtDimensionCr2_Type: contractType,
        Сумма: 100,
      }),
      // Оплата: Дт 1030 Кт 1210 — кредит акта.
      rec({
        Period: "2026-10-07T09:00:00",
        Recorder: PAY,
        Recorder_Type: "StandardODATA.Document_ПлатежноеПоручениеВходящее",
        AccountDr_Key: A1030,
        AccountCr_Key: A1210,
        ExtDimensionCr1: BUYER,
        ExtDimensionCr1_Type: cpType,
        ExtDimensionCr2: CONTRACT,
        ExtDimensionCr2_Type: contractType,
        Сумма: 400,
      }),
      // Не попадают: счёт без субконто «Договоры», неактивная запись, другой контрагент.
      rec({
        Period: "2026-10-06T00:00:00",
        Recorder: id(522),
        Recorder_Type: "StandardODATA.Document_ОперацияБух",
        AccountDr_Key: A5010,
        ExtDimensionDr1: BUYER,
        ExtDimensionDr1_Type: cpType,
        AccountCr_Key: A1030,
        Сумма: 999,
      }),
      rec({
        Period: "2026-10-06T00:00:00",
        Recorder: id(523),
        Recorder_Type: "StandardODATA.Document_ОперацияБух",
        AccountDr_Key: A1210,
        ExtDimensionDr1: BUYER,
        ExtDimensionDr1_Type: cpType,
        AccountCr_Key: A6010,
        Сумма: 777,
        Active: false,
      }),
      rec({
        Period: "2026-10-06T00:00:00",
        Recorder: id(524),
        Recorder_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
        AccountDr_Key: A1210,
        ExtDimensionDr1: OTHER,
        ExtDimensionDr1_Type: cpType,
        AccountCr_Key: A6010,
        Сумма: 555,
      }),
    ],
    "AccountingRegister_Типовой/Balance": [
      {
        Account_Key: A1210,
        ExtDimension1: BUYER,
        ExtDimension1_Type: cpType,
        ExtDimension2: CONTRACT,
        ExtDimension2_Type: contractType,
        Организация_Key: ORG,
        СуммаBalance: 250,
      },
    ],
    Document_РеализацияТоваровУслуг: [{ Ref_Key: SALE, Number: "00000000019", Date: "2026-10-05T10:00:00" }],
    Document_ПлатежноеПоручениеВходящее: [
      { Ref_Key: PAY, Number: "00000000007", Date: "2026-10-07T09:00:00" },
    ],
    Document_АктСверкиВзаиморасчетов: [],
  };
}

describe("расчёт акта по регистру — как «Заполнить» в 1С", () => {
  it("счета расчётов — с субконто «Контрагенты» и «Договоры»", async () => {
    const accounts = await settlementAccounts(fake1C({ store: store() }).conn);
    expect([...accounts.values()].sort()).toEqual(["1210", "3510"]);
  });

  it("строки по документам, без внутренних оборотов и чужих счетов; сальдо на начало", async () => {
    const r = await reconciliationFromRegister(fake1C({ store: store() }).conn, {
      org: ORG,
      counterparty: BUYER,
      contract: CONTRACT,
      from: "2026-10-01",
      to: "2026-10-09",
    });
    expect(r.opening).toBe(250);
    expect(r.rows).toEqual([
      {
        date: "2026-10-05",
        documentRef: SALE,
        documentType: "StandardODATA.Document_РеализацияТоваровУслуг",
        debit: 1000,
        credit: 0,
      },
      {
        date: "2026-10-07",
        documentRef: PAY,
        documentType: "StandardODATA.Document_ПлатежноеПоручениеВходящее",
        debit: 0,
        credit: 400,
      },
    ]);
  });
});

describe("write.counterparty.quick_reconciliation", () => {
  it("план → акт без проведения с заполненными таблицами и PDF; повтор не создаёт второй акт", async () => {
    const f = fake1C({ store: store() });
    const args = { counterparty: BIN, contract: "б/н", from: "2026-10-01", to: "2026-10-09" };
    const plan = (await f.call(TOOL, args)).structuredContent!;
    expect(plan).toMatchObject({
      dryRun: true,
      ready: true,
      opening: 250,
      closing: 850,
      rows: [
        { date: "2026-10-05", document: "Реализация ТМЗ и услуг 19 от 05.10.2026", debit: 1000, credit: 0 },
        {
          date: "2026-10-07",
          document: "Платежное поручение входящее 7 от 07.10.2026",
          debit: 0,
          credit: 400,
        },
      ],
      possibleDuplicates: [],
    });
    expect(String(plan["debt"])).toMatch(/в пользу ИП Aru Market {2}850,00 {2}KZT/);
    expect(f.posts).toHaveLength(0);

    const done = (await f.call(TOOL, { ...args, confirm: true, operationId: plan["operationId"] }))
      .structuredContent!;
    expect(done).toMatchObject({ created: true, act: { closing: 850, posted: false } });
    expect(existsSync(String((done["pdf"] as Row)["path"]))).toBe(true);
    expect(f.posts).toHaveLength(1);
    const body = f.posts[0]!.body;
    expect(body).toMatchObject({
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ДатаНачала: "2026-10-01T00:00:00",
      ДатаОкончания: "2026-10-09T00:00:00",
      ОстатокНаНачало: 250,
      Posted: false,
      ПоДаннымОрганизации: [
        { LineNumber: 1, Дата: "2026-10-05T00:00:00", Документ: SALE, Дебет: 1000, Кредит: 0 },
        { LineNumber: 2, Дата: "2026-10-07T00:00:00", Документ: PAY, Дебет: 0, Кредит: 400 },
      ],
      ПоДаннымКонтрагента: [
        { LineNumber: 1, Дата: "2026-10-05T00:00:00", Дебет: 0, Кредит: 1000 },
        { LineNumber: 2, Дата: "2026-10-07T00:00:00", Дебет: 400, Кредит: 0 },
      ],
    });
    expect((body["СписокСчетов"] as Row[]).map((r) => r["Счет_Key"]).sort()).toEqual([A1210, A3510].sort());

    const again = (await f.call(TOOL, { ...args, confirm: true, operationId: plan["operationId"] }))
      .structuredContent!;
    expect(again).toMatchObject({ created: true, replayed: true });
    expect(f.posts).toHaveLength(1);

    // Теперь акт с тем же контрагентом, договором и концом периода есть — новый план предупреждает.
    const next = (await f.call(TOOL, args)).structuredContent!;
    expect((next["possibleDuplicates"] as Row[]).length).toBe(1);
  });

  it("один похожий контрагент по части имени — берётся с пометкой; без контрагента в базе — ошибка", async () => {
    const f = fake1C({ store: store() });
    const plan = (await f.call(TOOL, { counterparty: "TRADESPACE", to: "2026-10-09" })).structuredContent!;
    expect(plan).toMatchObject({ ready: true, counterparty: { ref: BUYER } });
    expect((plan["notes"] as string[]).join(" ")).toMatch(/по части наименования/);
    const missing = await f.call(TOOL, { counterparty: "Нет такого", to: "2026-10-09" });
    expect(missing.isError).toBe(true);
  });
});
