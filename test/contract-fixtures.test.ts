import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { KZ_WRITE_TOOLS } from "../src/tools/write-kz.js";
import {
  BANK_ACC,
  BIN,
  BUYER,
  CONTRACT,
  KZT,
  ORG,
  RU_BUYER,
  RU_BUY_CONTRACT,
  RU_CASH,
  RU_EDITABLE,
  RU_GOODS,
  RU_INN_SUPPLIER,
  RU_INVENTORY_DOC,
  RU_KPP_SUPPLIER,
  RU_NOMGROUP,
  RU_PURCHASE_BASE,
  RU_SALE_BASE,
  RU_SERVICE,
  RU_SUPPLIER,
  RU_SUP_CONTRACT,
  SERVICE,
  SERVICE_NAME,
  UNIT,
  VAT16,
  VAT_NONE,
  baseStore,
  fake1C,
  id,
  ruStore,
  type Row,
  type Store,
} from "./support/fake-1c.js";

/**
 * Контрактные фикстуры для чата (пакет A3, п. 7): для каждого пишущего инструмента из KZ_WRITE_TOOLS —
 * предпросмотр и запись на фейковой 1С с подготовленным store; для каждого инструмента чтения — один вызов.
 * RECORD_FIXTURES=1 — пишет test/fixtures/contract/<имя>.json ({tool, args, dryRun, confirm} или
 * {tool, args, result}), без неё — сверяет форму ответа с записанной. Копии — в
 * rag-buh/backend/tests/fixtures/onec/contract/ (ветка чата agents/A3).
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "contract");
const RECORD = process.env.RECORD_FIXTURES === "1";

type SC = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sc = (r: CallToolResult) => r.structuredContent as SC;
const failed = (r: CallToolResult) => `isError: ${JSON.stringify(r.content).slice(0, 400)}`;

/**
 * Форма ответа: структура и типы без значений (Ref, даты, суммы от запуска к запуску различаются).
 * Ключи со значением undefined пропускаем, как их пропускает JSON, — иначе запись (JSON без ключа)
 * и живое сравнение (ключ есть) никогда не сойдутся.
 */
const shape = (v: unknown): unknown => {
  if (v === null || v === undefined) return "nil";
  if (Array.isArray(v)) return v.length ? ["list", shape(v[0])] : ["empty-list"];
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return [
      "object",
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, shape(o[k])]),
    ];
  }
  return typeof v;
};

interface WriteCase {
  kind: "write";
  tool: string;
  args: Record<string, unknown>;
  build: () => ReturnType<typeof fake1C>;
}
interface ReadCase {
  kind: "read";
  tool: string;
  args: Record<string, unknown>;
  build: () => ReturnType<typeof fake1C>;
}

function checkOrRecord(
  tool: string,
  actual: { args: Record<string, unknown>; dryRun?: unknown; confirm?: unknown; result?: unknown },
): void {
  const path = join(DIR, `${tool}.json`);
  if (RECORD) {
    mkdirSync(DIR, { recursive: true });
    // Временные пути (каталог печати в mkdtemp) от запуска к запуску различаются — маскируем.
    const body = JSON.stringify({ tool, ...actual }, null, 2)
      .split(tmpdir())
      .join("<tmp>");
    writeFileSync(path, `${body}\n`);
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Нет фикстуры ${tool}.json — запишите: RECORD_FIXTURES=1 npm test -- contract-fixtures`);
  }
  const recorded = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ["dryRun", "confirm", "result"] as const) {
    if (actual[key] !== undefined || recorded[key] !== undefined)
      expect(shape(actual[key]), `${tool}.${key}`).toEqual(shape(recorded[key]));
  }
}

async function runWrite(c: WriteCase): Promise<void> {
  const f = c.build();
  const pre = await f.call(c.tool, c.args);
  expect(pre.isError, `${c.tool} preview: ${failed(pre)}`).toBeFalsy();
  const opId = sc(pre)["operationId"] as string | undefined;
  const post = await f.call(
    c.tool,
    opId ? { ...c.args, confirm: true, operationId: opId } : { ...c.args, confirm: true },
  );
  expect(post.isError, `${c.tool} confirm: ${failed(post)}`).toBeFalsy();
  checkOrRecord(c.tool, { args: c.args, dryRun: sc(pre), confirm: sc(post) });
}

async function runRead(c: ReadCase): Promise<void> {
  const f = c.build();
  const res = await f.call(c.tool, c.args);
  if (c.tool === "read.analytics.get_taxes_paid") {
    // На казахстанской базе инструмент отказывает по design'у — фиксируем отказ как контракт.
    expect(res.isError).toBe(true);
    checkOrRecord(c.tool, { args: c.args, result: { isError: true, text: JSON.stringify(res.content) } });
    return;
  }
  expect(res.isError, `${c.tool}: ${failed(res)}`).toBeFalsy();
  checkOrRecord(c.tool, { args: c.args, result: sc(res) });
}

// ─── Общие store ───

const INVOICE = id(100);
const SALE = id(101);
const FILE = id(102);
const SF = id(103);
const ACT = id(104);
const PRINT_POA = id(105);
const PDF = Buffer.from("%PDF-1.4\n%фикстура\n");

/** Счёт на оплату в памяти: шапка + строки, чтобы печать собрала PDF без живой 1С. */
function invoiceRow(ref: string): Row {
  return {
    Ref_Key: ref,
    Number: "00000000007",
    Date: "2026-10-07T10:00:00",
    Posted: false,
    DeletionMark: false,
    Организация_Key: ORG,
    Контрагент_Key: BUYER,
    ДоговорКонтрагента_Key: CONTRACT,
    ВалютаДокумента_Key: KZT,
    УчитыватьНДС: false,
    СуммаВключаетНДС: false,
    СуммаДокумента: 100,
    Услуги: [
      {
        LineNumber: 1,
        Номенклатура_Key: SERVICE,
        Содержание: SERVICE_NAME,
        Количество: 1,
        Цена: 100,
        Сумма: 100,
        СуммаНДС: 0,
      },
    ],
    Товары: [],
  };
}

const p = (name: string, type = "Edm.String") => ({ name, type });
const INVOICE_SET = "Document_СчетНаОплатуПокупателю";
const invoiceEntities = {
  [INVOICE_SET]: {
    properties: [
      p("Ref_Key", "Edm.Guid"),
      p("Date", "Edm.DateTime"),
      p("Posted", "Edm.Boolean"),
      p("Организация_Key", "Edm.Guid"),
      p("Контрагент_Key", "Edm.Guid"),
      p("ДоговорКонтрагента_Key", "Edm.Guid"),
      p("СуммаДокумента", "Edm.Double"),
      p("Комментарий"),
      { name: "Товары", type: `Collection(StandardODATA.${INVOICE_SET}_Товары_RowType)` },
      { name: "Услуги", type: `Collection(StandardODATA.${INVOICE_SET}_Услуги_RowType)` },
    ],
    navigations: [
      { name: "Организация", toType: "Catalog_Организации", collection: false },
      { name: "Контрагент", toType: "Catalog_Контрагенты", collection: false },
      { name: "ДоговорКонтрагента", toType: "Catalog_ДоговорыКонтрагентов", collection: false },
    ],
  },
  [`${INVOICE_SET}_Услуги`]: {
    properties: ["Номенклатура_Key", "Содержание", "Количество", "Цена", "Сумма", "СуммаНДС"].map((n) =>
      p(n),
    ),
    navigations: [{ name: "Номенклатура", toType: "Catalog_Номенклатура", collection: false }],
  },
  [`${INVOICE_SET}_Товары`]: {
    properties: ["Номенклатура_Key", "Количество", "Сумма", "СуммаНДС"].map((n) => p(n)),
    navigations: [{ name: "Номенклатура", toType: "Catalog_Номенклатура", collection: false }],
  },
};

// ─── Богатый store: счета, валюта и курсы, ценные бумаги, операция, ЭСФ/ЭАВР ───

const K_BANK = id(210);
const K_CP = id(211);
const K_ANY = id(212);
const KIND_ART = id(213);
const KIND_DEP = id(214);
const A1030 = id(220);
const A3310 = id(221);
const A7210 = id(222);
const A1610 = id(223);
const ART_PROCHIE = id(224);
const DEP_ADM = id(225);
const USD = id(226);
const OP = id(227);
const ESF = id(230);
const SF_INV = id(231);
const AVR = id(232);
const AVR_BASIS = id(233);

const acc = (Ref_Key: string, Code: string, dims: string[] = []): Row => ({
  Ref_Key,
  Code,
  Description: `Счёт ${Code}`,
  Забалансовый: false,
  Количественный: false,
  Валютный: Code === "1030",
  ExtDimensionTypes: dims.map((ExtDimensionType_Key, i) => ({
    LineNumber: String(i + 1),
    ExtDimensionType_Key,
  })),
});

function richStore(): Store {
  const store = baseStore();
  store["Catalog_Организации"] = store["Catalog_Организации"]!.map((r) =>
    r["Ref_Key"] === ORG ? { ...r, ПрефиксацияОбъектов: "АА" } : r,
  );
  store["ChartOfCharacteristicTypes_ВидыСубконтоТиповые"] = [
    { Ref_Key: K_BANK, Description: "Денежные средства", ValueType: "CatalogRef.БанковскиеСчета" },
    { Ref_Key: K_CP, Description: "Контрагенты", ValueType: "CatalogRef.Контрагенты" },
    { Ref_Key: K_ANY, Description: "Прочее", ValueType: "Edm.String" },
    { Ref_Key: KIND_ART, Description: "Статьи затрат", ValueType: "CatalogRef.СтатьиЗатрат" },
    { Ref_Key: KIND_DEP, Description: "Подразделения", ValueType: "CatalogRef.ПодразделенияОрганизаций" },
  ];
  store["ChartOfAccounts_Типовой"] = [
    acc(A1030, "1030", [K_BANK]),
    acc(A3310, "3310", [K_CP, K_ANY]),
    acc(A7210, "7210", [KIND_ART, KIND_DEP]),
    acc(A1610, "1610", [KIND_ART, KIND_DEP]),
    acc(id(229), "1330"),
  ];
  store["ChartOfAccounts_Налоговый"] = [{ Ref_Key: id(234), Code: "7210Н", Description: "Счёт 7210Н" }];
  store["Catalog_СтатьиЗатрат"] = [{ Ref_Key: ART_PROCHIE, Description: "Прочие расходы", Code: "00001" }];
  store["Catalog_ПодразделенияОрганизаций"] = [{ Ref_Key: DEP_ADM, Description: "Администрация" }];
  store["Catalog_Валюты"] = [
    ...store["Catalog_Валюты"]!,
    { Ref_Key: USD, Code: "840", Description: "Доллар США", DeletionMark: false },
  ];
  const rate = (Валюта_Key: string, Курс: number, Кратность: number): Row => ({
    Period: "2026-10-01T00:00:00",
    Recorder: `Г${Курс}`,
    Валюта_Key,
    Курс,
    Кратность,
  });
  store["InformationRegister_КурсыВалют"] = [rate(USD, 470, 1), rate(KZT, 1, 1)];
  store["InformationRegister_КурсыВалют/SliceLast"] = [
    { Валюта_Key: USD, Курс: 470, Кратность: 1 },
    { Валюта_Key: KZT, Курс: 1, Кратность: 1 },
  ];
  store["Catalog_ЦенныеБумаги"] = [{ Ref_Key: id(235), Description: "Облигации КЕГОК" }];
  store["Document_ОперацияБух"] = [
    {
      Ref_Key: OP,
      Number: "00000000001",
      Date: "2026-09-30T23:59:59",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
    },
  ];
  // ЭСФ, счёт-фактура и ЭАВР с основанием — для link/set_basis/draft и чтений ЭСФ/НДС.
  store["Document_ЭСФ"] = [
    {
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
      РегистрационныйНомер: "",
      СчетФактура: "",
      СчетФактура_Type: "StandardODATA.Undefined",
      ДоговорПоставки_Key: "00000000-0000-0000-0000-000000000000",
    },
  ];
  store["Document_СчетФактураПолученный"] = [
    {
      Ref_Key: SF_INV,
      Number: "00000000259",
      Date: "2026-10-13T00:00:00",
      DeletionMark: false,
      Posted: true,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      СуммаДокумента: 100,
    },
  ];
  store["Document_ЭлектронныйАктВыполненныхРабот"] = [
    {
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
      Договор_Key: P_EMPTY,
      НомерДоговора: "",
      ДатаДоговора: "0001-01-01T00:00:00",
      ДокументОснование: "",
      ДокументОснование_Type: "StandardODATA.Undefined",
      ДатаВыполненияРабот: "2026-10-12T00:00:00",
      ИтогоСтоимостьСУчетомКосвенныхНалогов: 500000,
      ИтогоСтоимостьБезУчетаКосвенныхНалогов: 446428.57,
    },
  ];
  store["Document_ПоступлениеТоваровУслуг"] = [
    {
      Ref_Key: AVR_BASIS,
      Number: "00000000012",
      Date: "2026-10-12T00:00:00",
      DeletionMark: false,
      Posted: true,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      СуммаДокумента: 500000,
    },
  ];
  store["InformationRegister_АктуальныеЭСФ"] = [];
  store["InformationRegister_ИсторияЭСФ"] = [];
  store["InformationRegister_ОчередьОтправкиЭСФ"] = [];
  store["InformationRegister_АктуальныеЭСФПоПервичнымДокументам"] = [];
  store["Document_СчетНаОплатуПокупателю"] = [invoiceRow(INVOICE)];
  store["Document_РеализацияТоваровУслуг"] = [
    {
      Ref_Key: SALE,
      Number: "00000000018",
      Date: "2026-10-08T10:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      БанковскийСчетОрганизации_Key: BANK_ACC,
      СуммаВключаетНДС: false,
      СуммаДокумента: 116000,
      Товары: [],
      Услуги: [
        {
          LineNumber: "1",
          Номенклатура_Key: SERVICE,
          Содержание: SERVICE_NAME,
          Количество: 1,
          Цена: 100000,
          Сумма: 100000,
          СтавкаНДС_Key: VAT16,
          СуммаНДС: 16000,
        },
      ],
    },
  ];
  // Документы для печатных форм.
  store["Document_СчетФактураВыданный"] = [
    {
      Ref_Key: SF,
      Number: "00000000007",
      Date: "2026-10-07T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      СуммаВключаетНДС: false,
      СуммаДокумента: 116,
      ВидСчетаФактуры: "Обычный",
      Товары: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Количество: 1,
          Цена: 100,
          Сумма: 100,
          СтавкаНДС_Key: VAT16,
          СуммаНДС: 16,
          ЕдиницаИзмерения_Key: UNIT,
        },
      ],
      Услуги: [],
    },
  ];
  store["Document_АктСверкиВзаиморасчетов"] = [
    {
      Ref_Key: ACT,
      Number: "5",
      Date: "2026-10-09T00:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      ВалютаДокумента_Key: KZT,
      ОстатокНаНачало: 0,
      ДатаНачала: "2026-10-01T00:00:00",
      ДатаОкончания: "2026-10-09T00:00:00",
      СверкаСогласована: true,
      ПоДаннымОрганизации: [
        { LineNumber: 1, Дата: "2026-10-08T00:00:00", Документ: SALE, Дебет: 116000, Кредит: 0 },
      ],
      ПоДаннымКонтрагента: [
        { LineNumber: 1, Дата: "2026-10-08T00:00:00", Документ: SALE, Дебет: 0, Кредит: 116000 },
      ],
    },
  ];
  store["Catalog_ФизическиеЛица"] = [
    { Ref_Key: id(910), Description: "Иванова Анна Сергеевна", Пол: "Женский" },
  ];
  store["Document_Доверенность"] = [
    {
      Ref_Key: PRINT_POA,
      Number: "15",
      Date: "2026-10-07T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ФизЛицо_Key: id(910),
      ДатаДействия: "2026-10-15T00:00:00",
      Контрагент_Key: BUYER,
      НаПолучениеОт: "ТОО",
      ПоДокументу: "счёт",
      СтруктурнаяЕдиница_Key: BANK_ACC,
      Товары: [
        {
          LineNumber: 1,
          НаименованиеТовара: SERVICE,
          НаименованиеТовара_Type: "StandardODATA.Catalog_Номенклатура",
          ЕдиницаПоКлассификатору_Key: UNIT,
          Количество: 2,
        },
      ],
    },
  ];
  store["Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы"] = [
    {
      Ref_Key: FILE,
      Description: "Счёт 1",
      Расширение: "pdf",
      ТипХраненияФайла: "ВИнформационнойБазе",
      ФайлХранилище_Base64Data: PDF.toString("base64"),
    },
  ];
  store["InformationRegister_ЦеныНоменклатуры"] = [];
  store["InformationRegister_ЦеныНоменклатуры/SliceLast"] = [
    { Номенклатура_Key: SERVICE, ВидЦен_Key: P_EMPTY, Валюта_Key: KZT, Цена: 100 },
  ];
  store["Document_ИзвещениеОбОтнесенииВЗачетНДС"] = [];
  // Банковские и кассовые документы — для get_cashflow/get_payments_breakdown (пустые: нулевые обороты).
  store["Document_ПоступлениеНаРасчетныйСчет"] = [];
  store["Document_ПлатежноеПоручениеВходящее"] = [];
  store["Document_ПлатежныйОрдерПоступлениеДенежныхСредств"] = [];
  store["Document_СписаниеСРасчетногоСчета"] = [];
  store["Document_ПлатежноеПоручениеИсходящее"] = [];
  store["Document_ПлатежныйОрдерСписаниеДенежныхСредств"] = [];
  store["Document_ПриходныйКассовыйОрдер"] = [];
  store["Document_РасходныйКассовыйОрдер"] = [];
  // Пустая, но с полями проводки — метаданные регистра нужны get_document_postings; чужой регистратор отсеется.
  store["AccountingRegister_Типовой"] = [
    {
      Recorder: id(600),
      Recorder_Type: "StandardODATA.Document_СчетНаОплатуПокупателю",
      Period: "2026-10-01T00:00:00",
      AccountDr_Key: A1030,
      AccountCr_Key: A3310,
      Сумма: 1,
    },
  ];
  store["AccountingRegister_Типовой/RecordsWithExtDimensions"] = [];
  return store;
}

// ─── Продажи и сверка (усечённые копии сетапов quick-тестов) ───

const QS_SALE = id(240);
const QS_INV = id(241);

/** Реализация на основании счёта + метаданные строк — для quick_sale. */
function saleStore(): Store {
  const store = richStore();
  store["Document_СчетНаОплатуПокупателю"] = [invoiceRow(QS_INV)];
  store["Document_РеализацияТоваровУслуг"] = [
    {
      Ref_Key: QS_SALE,
      Number: "00000000018",
      Date: "2026-10-08T15:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      БанковскийСчетОрганизации_Key: BANK_ACC,
      СуммаВключаетНДС: false,
      УчитыватьНДС: true,
      СуммаДокумента: 116,
      ВидОперации: "ПродажаТоваровУслуг",
      Услуги: [
        {
          LineNumber: 1,
          Номенклатура_Key: SERVICE,
          Содержание: SERVICE_NAME,
          Количество: 1,
          Цена: 100,
          Сумма: 100,
          СуммаНДС: 16,
          СтавкаНДС_Key: VAT16,
          СчетДоходовБУ_Key: id(242),
          СубконтоБУ_Key: id(243),
          СчетНДСБУ_Key: id(244),
        },
      ],
      Товары: [],
    },
  ];
  store["Catalog_СтавкиНДС"] = [
    ...(store["Catalog_СтавкиНДС"] ?? []),
    { Ref_Key: VAT16, Description: "НДС 16%", Ставка: 16, DeletionMark: false },
    { Ref_Key: VAT_NONE, Description: "без НДС", Ставка: 0, DeletionMark: false },
  ];
  return store;
}

const saleRowMeta = {
  Catalog_Номенклатура: { properties: ["Ref_Key", "НаименованиеПолное", "Description"].map((n) => p(n)) },
};

function saleBuild() {
  return fake1C({
    store: saleStore(),
    entities: {
      Catalog_Пользователи: { properties: ["Ref_Key", "Description"].map((n) => p(n)) },
      Catalog_ФизическиеЛица: { properties: ["Ref_Key", "Description"].map((n) => p(n)) },
      Catalog_Склады: { properties: ["Ref_Key", "Description"].map((n) => p(n)) },
      Catalog_СтатьиДвиженияНаличных: { properties: ["Ref_Key", "Description"].map((n) => p(n)) },
      ...saleRowMeta,
    },
  });
}

// ─── Акт сверки: копия store() из quick-reconciliation.test.ts ───

const R_T_CP = id(500);
const R_T_CONTRACT = id(501);
const R_A1210 = id(510);
const R_A3510 = id(511);
const R_A6010 = id(512);
const R_A1030 = id(513);
const R_A5010 = id(514);
const R_SALE = id(520);
const R_PAY = id(521);
const R_CP = "StandardODATA.Catalog_Контрагенты";
const R_CTR = "StandardODATA.Catalog_ДоговорыКонтрагентов";

function reconStore(): Store {
  const s = baseStore();
  const both = [{ ExtDimensionType_Key: R_T_CP }, { ExtDimensionType_Key: R_T_CONTRACT }];
  const rec = (r: Row): Row => ({ Организация_Key: ORG, Active: true, ...r });
  return {
    ...s,
    ChartOfCharacteristicTypes_ВидыСубконтоТиповые: [
      { Ref_Key: R_T_CP, PredefinedDataName: "Контрагенты" },
      { Ref_Key: R_T_CONTRACT, PredefinedDataName: "Договоры" },
    ],
    ChartOfAccounts_Типовой: [
      { Ref_Key: R_A1210, Code: "1210", ExtDimensionTypes: both },
      { Ref_Key: R_A3510, Code: "3510", ExtDimensionTypes: both },
      { Ref_Key: R_A6010, Code: "6010", ExtDimensionTypes: [] },
      { Ref_Key: R_A1030, Code: "1030", ExtDimensionTypes: [] },
      { Ref_Key: R_A5010, Code: "5010", ExtDimensionTypes: [{ ExtDimensionType_Key: R_T_CP }] },
    ],
    "AccountingRegister_Типовой/RecordsWithExtDimensions": [
      rec({
        Period: "2026-10-05T10:00:00",
        Recorder: R_SALE,
        Recorder_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
        AccountDr_Key: R_A1210,
        ExtDimensionDr1: BUYER,
        ExtDimensionDr1_Type: R_CP,
        ExtDimensionDr2: CONTRACT,
        ExtDimensionDr2_Type: R_CTR,
        AccountCr_Key: R_A6010,
        Сумма: 1000,
      }),
      rec({
        Period: "2026-10-07T09:00:00",
        Recorder: R_PAY,
        Recorder_Type: "StandardODATA.Document_ПлатежноеПоручениеВходящее",
        AccountDr_Key: R_A1030,
        AccountCr_Key: R_A1210,
        ExtDimensionCr1: BUYER,
        ExtDimensionCr1_Type: R_CP,
        ExtDimensionCr2: CONTRACT,
        ExtDimensionCr2_Type: R_CTR,
        Сумма: 400,
      }),
    ],
    "AccountingRegister_Типовой/Balance": [
      {
        Account_Key: R_A1210,
        ExtDimension1: BUYER,
        ExtDimension1_Type: R_CP,
        ExtDimension2: CONTRACT,
        ExtDimension2_Type: R_CTR,
        Организация_Key: ORG,
        СуммаBalance: 250,
      },
    ],
    Document_РеализацияТоваровУслуг: [
      { Ref_Key: R_SALE, Number: "00000000019", Date: "2026-10-05T10:00:00" },
    ],
    Document_ПлатежноеПоручениеВходящее: [
      { Ref_Key: R_PAY, Number: "00000000007", Date: "2026-10-07T09:00:00" },
    ],
    Document_АктСверкиВзаиморасчетов: [],
  };
}

// ─── Доверенности и комплектация: усечённая копия сетапа poa-kitting.test.ts ───

const POA = "Document_Доверенность";
const KIT = "Document_КомплектацияНоменклатуры";
const P_PERSON = id(301);
const P_SUPPLIER = id(302);
const P_NOM = id(303);
const P_WAREHOUSE = id(311);
const P_KIT_NOM = id(312);
const P_PART1 = id(313);
const P_PART2 = id(314);
const P_GROUP = id(315);
const ACC_1330 = id(321);
const ACC_1310 = id(322);
const ACC_1330N = id(323);
const ACC_1310N = id(324);
const P_SHT = id(331);
const P_KG = id(332);
const P_TAX_NU = id(341);
const P_EMPTY = "00000000-0000-0000-0000-000000000000";

const poaNav = (name: string) => ({ name, toType: "ChartOfAccounts_Типовой", collection: false });
const poaEntities = {
  [POA]: {
    properties: [
      p("Ref_Key", "Edm.String"),
      ...["Number", "Date", "Posted", "DeletionMark", "Организация_Key", "ФизЛицо_Key"].map((n) => p(n)),
      ...["ДатаДействия", "Контрагент_Key", "ДоговорКонтрагента_Key", "НаПолучениеОт", "ПоДокументу"].map(
        (n) => p(n),
      ),
      ...["ДокументОснование_Key", "Комментарий"].map((n) => p(n)),
      { name: "Товары", type: `Collection(StandardODATA.${POA}_Товары_RowType)` },
    ],
  },
  [`${POA}_Товары`]: {
    properties: [
      "LineNumber",
      "НаименованиеТовара",
      "НаименованиеТовара_Type",
      "ЕдиницаПоКлассификатору_Key",
      "Количество",
    ].map((n) => p(n)),
  },
  [KIT]: {
    properties: [
      ...["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "ВидОперации"].map((n) =>
        p(n),
      ),
      ...["Склад_Key", "Номенклатура_Key", "Количество", "ЕдиницаИзмерения_Key", "Коэффициент"].map((n) =>
        p(n),
      ),
      ...["СчетУчетаБУ_Key", "СчетУчетаНУ_Key", "ВидУчетаНУ_Key", "Комментарий"].map((n) => p(n)),
      { name: "Комплектующие", type: `Collection(StandardODATA.${KIT}_Комплектующие_RowType)` },
    ],
    navigations: [poaNav("СчетУчетаБУ")],
  },
  [`${KIT}_Комплектующие`]: {
    properties: [
      "LineNumber",
      "Номенклатура_Key",
      "Количество",
      "Коэффициент",
      "ЕдиницаИзмерения_Key",
      "ДоляСтоимости",
      "СчетУчетаБУ_Key",
      "СчетУчетаНУ_Key",
    ].map((n) => p(n)),
    navigations: [poaNav("СчетУчетаБУ")],
  },
};

function poaStore(): Store {
  const store = baseStore();
  store[POA] = [
    { Ref_Key: id(401), Number: "1", Date: "2026-10-01T00:00:00", Posted: false, DeletionMark: false },
    { Ref_Key: id(402), Number: "2", Date: "2026-10-01T00:00:00", Posted: false, DeletionMark: true },
  ];
  store[KIT] = [
    {
      Ref_Key: id(411),
      Number: "1",
      Date: "2026-10-01T00:00:00",
      Posted: false,
      DeletionMark: false,
      Организация_Key: ORG,
    },
    {
      Ref_Key: id(412),
      Number: "2",
      Date: "2026-10-01T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
    },
  ];
  store["ChartOfAccounts_Типовой"] = [{ Ref_Key: ACC_1330, Code: "1330", ExtDimensionTypes: [] }];
  store["Catalog_Контрагенты"] = [
    ...store["Catalog_Контрагенты"]!,
    { Ref_Key: P_SUPPLIER, Description: "ТОО «Поставщик»", DeletionMark: false },
  ];
  store["Catalog_ФизическиеЛица"] = [{ Ref_Key: P_PERSON, Description: "Иванова Анна Сергеевна" }];
  store["Catalog_Номенклатура"] = [
    ...(store["Catalog_Номенклатура"] ?? []),
    ...[P_NOM, P_KIT_NOM].map((Ref_Key) => ({
      Ref_Key,
      БазоваяЕдиницаИзмерения_Key: UNIT,
      Parent_Key: P_EMPTY,
    })),
    { Ref_Key: P_PART1, БазоваяЕдиницаИзмерения_Key: UNIT, Parent_Key: P_GROUP },
    { Ref_Key: P_PART2, БазоваяЕдиницаИзмерения_Key: P_EMPTY, Parent_Key: P_EMPTY },
    { Ref_Key: P_GROUP, БазоваяЕдиницаИзмерения_Key: P_EMPTY, Parent_Key: P_EMPTY },
  ];
  store["Catalog_КлассификаторЕдиницИзмерения"] = [
    ...(store["Catalog_КлассификаторЕдиницИзмерения"] ?? []),
    { Ref_Key: P_KG, Code: "166      ", Description: "кг", DeletionMark: false },
    { Ref_Key: P_SHT, Code: "796      ", Description: "шт", DeletionMark: false },
  ];
  store["InformationRegister_СчетаУчетаНоменклатуры"] = [
    {
      Организация_Key: P_EMPTY,
      Номенклатура_Key: P_EMPTY,
      СчетУчетаБУ_Key: ACC_1310,
      СчетУчетаНУ_Key: ACC_1310N,
    },
    {
      Организация_Key: ORG,
      Номенклатура_Key: P_GROUP,
      СчетУчетаБУ_Key: ACC_1330,
      СчетУчетаНУ_Key: ACC_1330N,
    },
  ];
  store["Catalog_ВидыУчетаНУ"] = [{ Ref_Key: P_TAX_NU, PredefinedDataName: "НУ", DeletionMark: false }];
  store["Catalog_Склады"] = [{ Ref_Key: P_WAREHOUSE, Description: "Основной склад", DeletionMark: false }];
  return store;
}

/** Метаданные поступления услуг — для create_services_receipt и update_document_lines (analytics). */
const SR_ES = "Document_ПоступлениеТоваровУслуг";
const SR_ROW = `${SR_ES}_Услуги`;
const SR_TYPE = (e: string) => `StandardODATA.${e}`;
const srRowProps = [
  "Ref_Key",
  "LineNumber",
  "Номенклатура_Key",
  "Содержание",
  "Количество",
  "Цена",
  "Сумма",
  "СтавкаНДС_Key",
  "СуммаНДС",
  "СчетЗатратБУ_Key",
  "СчетЗатратНУ_Key",
  ...["БУ", "НУ"].flatMap((s) =>
    [1, 2, 3].flatMap((n) => [`СубконтоЗатрат${s}${n}`, `СубконтоЗатрат${s}${n}_Type`]),
  ),
];
const srDocProps = [
  "Ref_Key",
  "Number",
  "Date",
  "Posted",
  "Организация_Key",
  "Контрагент_Key",
  "ДоговорКонтрагента_Key",
  "ВидОперации",
  "ВалютаДокумента_Key",
  "КурсВзаиморасчетов",
  "КратностьВзаиморасчетов",
  "Комментарий",
  "СуммаДокумента",
  "СуммаВключаетНДС",
  "НомерВходящегоДокумента",
  "ДатаВходящегоДокумента",
  "СчетУчетаРасчетовСКонтрагентом_Key",
  "СчетУчетаРасчетовПоАвансам_Key",
];
const srNav = (name: string, to: string) => ({ name, toType: to, collection: false });
const servicesEntities = {
  [SR_ES]: {
    properties: [
      ...srDocProps.map((n) => p(n)),
      { name: "Услуги", type: `Collection(${SR_TYPE(SR_ROW)}_RowType)` },
    ],
    navigations: [
      srNav("СчетУчетаРасчетовСКонтрагентом", "ChartOfAccounts_Типовой"),
      srNav("СчетУчетаРасчетовПоАвансам", "ChartOfAccounts_Типовой"),
    ],
  },
  [SR_ROW]: {
    properties: srRowProps.map((n) => p(n)),
    navigations: [
      srNav("СчетЗатратБУ", "ChartOfAccounts_Типовой"),
      srNav("СчетЗатратНУ", "ChartOfAccounts_Налоговый"),
    ],
  },
};

const poaArgs = {
  date: "2026-10-20",
  personRef: P_PERSON,
  validUntil: "2026-10-31",
  counterpartyRef: P_SUPPLIER,
  receiveFrom: "ТОО «Поставщик»",
  byDocument: "Счёт на оплату № 15 от 01.10.2026",
  lines: [{ nomenclatureRef: P_NOM, quantity: 2 }],
};

const kitArgs = {
  date: "2026-10-20",
  operation: "Комплектация",
  warehouseRef: P_WAREHOUSE,
  nomenclatureRef: P_KIT_NOM,
  quantity: 5,
  account: "1330",
  components: [
    { nomenclatureRef: P_PART1, quantity: 10, account: "1330" },
    { nomenclatureRef: P_PART2, quantity: 5, account: "1330" },
  ],
};

// ─── ЭСФ: усечённая копия сетапа esf-update.test.ts ───

const E_INV = id(80);
const E_SALE = id(81);
const E_KZ = id(91);
const E_ORG_LEGAL = id(92);
const E_ORG_POST = id(93);
const E_CP_LEGAL = id(94);
const E_CP_ACTUAL = id(95);
const E_DRAFT = id(100);
const E_ORG_LEGAL_T = "Казахстан, г. Тестоград, ул. Примерная, д. 1";
const E_ORG_POST_T = "Казахстан, г. Тестоград, а/я 10";
const E_CP_LEGAL_T = "Казахстан, г. Образцовск, пр. Условный, д. 2";
const E_CP_ACTUAL_T = "Казахстан, г. Образцовск, ул. Фактическая, д. 3";

const eServices = [
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
const eSale = (): Row => ({
  Ref_Key: E_SALE,
  Number: "00000000016",
  Date: "2026-10-08T10:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: CONTRACT,
  СуммаВключаетНДС: false,
  СуммаДокумента: 116000,
  Товары: [],
  Услуги: eServices.map((r) => ({ ...r })),
});
const eInv = (): Row => ({
  Ref_Key: E_INV,
  Number: "00000000002",
  Date: "2026-10-08T10:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: BUYER,
  ДоговорКонтрагента_Key: CONTRACT,
  ДокументОснование: E_SALE,
  ДокументОснование_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
  СчетОрганизации_Key: BANK_ACC,
  ВалютаДокумента_Key: KZT,
  КурсВзаиморасчетов: 1,
  ВидСчетаФактуры: "Обычный",
  СпособВыставления: "Электронно",
  СуммаВключаетНДС: false,
  СуммаДокумента: 116000,
  ДатаСовершенияОборотаПоРеализации: "2026-10-08T00:00:00",
  Грузоотправитель: P_EMPTY,
  Грузоотправитель_Type: "StandardODATA.Catalog_Организации",
  Грузополучатель_Key: BUYER,
  АдресДоставки: "",
  ПунктНазначения: "Пункт назначения из СФ",
  УсловияПоставки: "XXX",
  СпособОтправленияПоКлассификатору: "99",
  Товары: [],
  Услуги: eServices.map((r) => ({ ...r })),
});
const eEsfRow = (n: number, number: string, o: Row = {}): Row => ({
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
const eCi = (obj: string, set: string, kind: string, text: string): Row => ({
  Объект: obj,
  Объект_Type: `StandardODATA.${set}`,
  Тип: "Адрес",
  Вид: kind,
  Вид_Type: "StandardODATA.Catalog_ВидыКонтактнойИнформации",
  Представление: text,
  ЗначениеПоУмолчанию: false,
});
const eDraft = (): Row => ({
  Ref_Key: E_DRAFT,
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
  СчетФактура: E_INV,
  СчетФактура_Type: "StandardODATA.Document_СчетФактураВыданный",
  ВалютаКод: "KZT",
  КурсВалюты: 1,
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
  Товары: [],
  Услуги: [],
});

function esfStore(esf: Row[]): Store {
  const store = baseStore();
  store["Catalog_Контрагенты"]![0]!["СтранаРезидентства_Key"] = E_KZ;
  store["Catalog_КлассификаторСтранМира"] = [
    { Ref_Key: E_KZ, Code: "398", Description: "КАЗАХСТАН", КодАльфа2: "KZ" },
  ];
  store["Catalog_ВидыКонтактнойИнформации"] = [
    { Ref_Key: E_ORG_LEGAL, PredefinedDataName: "ЮрАдресОрганизации", Description: "Юр. адрес" },
    { Ref_Key: E_ORG_POST, PredefinedDataName: "АдресОрганизацииПочтовый", Description: "Почтовый" },
    { Ref_Key: E_CP_LEGAL, PredefinedDataName: "ЮрАдресКонтрагента", Description: "Юр. адрес" },
    { Ref_Key: E_CP_ACTUAL, PredefinedDataName: "ФактАдресКонтрагента", Description: "Факт. адрес" },
  ];
  store["InformationRegister_КонтактнаяИнформация"] = [
    eCi(ORG, "Catalog_Организации", E_ORG_POST, E_ORG_POST_T),
    eCi(ORG, "Catalog_Организации", E_ORG_LEGAL, E_ORG_LEGAL_T),
    eCi(BUYER, "Catalog_Контрагенты", E_CP_ACTUAL, E_CP_ACTUAL_T),
    eCi(BUYER, "Catalog_Контрагенты", E_CP_LEGAL, E_CP_LEGAL_T),
  ];
  store["Document_ЭСФ"] = esf;
  store["Document_СчетФактураВыданный"] = [eInv()];
  store["Document_РеализацияТоваровУслуг"] = [eSale()];
  store["Document_ЭлектронныйАктВыполненныхРабот"] = [];
  return store;
}

// ─── Извещение НДС: образец из test/fixtures/vat-notice-1.json ───

const VAT_NOTICE = "Document_ИзвещениеОбОтнесенииВЗачетНДС";
const VAT_REG = "AccumulationRegister_ОбязательстваПоИзвещениямИСЭСФ";
const VAT_REG2 = "AccumulationRegister_ОбязательстваПоЗачетуИСЭСФ";
const VAT_LINKS = "InformationRegister_АктуальныеЭСФПоПервичнымДокументам";
const VAT_RECEIPT = "Document_ПоступлениеТоваровУслуг";

const NOTICE_PROPS = [
  "Ref_Key",
  "Number",
  "Date",
  "DeletionMark",
  "Posted",
  "Идентификатор",
  "РегистрационныйНомер",
  "НомерИзвещения",
  "Плательщик_Key",
  "ПлательщикИдентификатор",
  "ПлательщикНаименование",
  "Статус",
  "ТипСобытия",
  "Организация_Key",
  "Состояние",
  "ЭЦП",
  "ТипПодписи",
  "Комментарий",
  "СуммаОборотаПоПриобретению",
  "СуммаНДСПринятогоВЗачет",
  "ОборотБезНДСИлиСНДСНеВЗачет",
  "СуммаНДСНеВЗачет",
  "СтрокиИзвещения",
  "ДетализацияДанныхИзвещения",
  "Ошибки",
].map((name) => ({ name }));

function vatNoticeStore(): Store {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/vat-notice-1.json", import.meta.url), "utf8")) as {
    organization: string;
    esf: Row[];
    links: Row[];
    esfObligations: Row[];
    receiptMovements: Row[];
  };
  const store = baseStore();
  const sub = (r: Row): Row => JSON.parse(JSON.stringify(r).split(raw.organization).join(ORG)) as Row;
  return {
    ...store,
    [VAT_NOTICE]: [
      {
        Ref_Key: id(500),
        Number: "00000000001",
        Date: "2026-01-05T00:00:00",
        DeletionMark: false,
        Posted: true,
        Организация_Key: ORG,
        СтрокиИзвещения: [],
      },
    ],
    Document_ЭСФ: raw.esf.map(sub),
    [VAT_REG]: [],
    [`${VAT_REG}/Balance`]: raw.esfObligations.map(sub),
    [VAT_REG2]: [],
    [`${VAT_REG2}/Balance`]: raw.receiptMovements.map((m) => ({
      Организация_Key: m["Организация_Key"],
      ДокументПоступления: m["ДокументПоступления"],
      ДокументПоступления_Type: m["ДокументПоступления_Type"],
      НалоговыйПериод: m["НалоговыйПериод"],
      СуммаОборотаПоПриобретениюBalance: m["СуммаОборотаПоПриобретению"],
      СуммаНДСBalance: m["СуммаНДС"],
      СуммаОборотаБезНДСBalance: m["СуммаОборотаБезНДС"],
      СуммаНДСНеВЗачетBalance: m["СуммаНДСНеВЗачет"],
    })),
    [VAT_LINKS]: raw.links.map(sub),
    [VAT_RECEIPT]: raw.links.map((l, i) => ({
      Ref_Key: l["ПервичныйДокумент"],
      Number: String(i + 10).padStart(11, "0"),
      Date: "2026-03-14T12:00:00",
      Posted: true,
    })),
  };
}

// ─── Кейсы ───

const servicesArgs = {
  counterpartyRef: BUYER,
  contractRef: CONTRACT,
  date: "2026-10-15",
  expenseAccount: "7210",
  lines: [{ nomenclatureRef: SERVICE, content: "Вознаграждение по займу", price: 125000 }],
};

const writeCases: WriteCase[] = [
  {
    kind: "write",
    tool: "write.counterparty.create_counterparty",
    args: { name: "ТОО Фикстура", inn: "990140000001", legalType: "ЮридическоеЛицо", kbe: "17" },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.counterparty.create_bank_account",
    args: { ownerRef: BUYER, accountNumber: "KZ000000000000000001", bik: "KCJBKZKX" },
    build: () => {
      // Отбор банков требует IsFolder=false, как в настоящей базе.
      const store = baseStore();
      store["Catalog_Банки"] = (store["Catalog_Банки"] ?? []).map((r) => ({ ...r, IsFolder: false }));
      return fake1C({ store });
    },
  },
  {
    kind: "write",
    tool: "write.catalog.create_nomenclature",
    args: { name: "Услуга фикстура", isService: true },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.catalog.create_contract",
    args: { counterpartyRef: BUYER, kind: "СПокупателем", number: "999", date: "2026-10-01" },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.sales.create_invoice",
    args: {
      counterpartyRef: BUYER,
      contractRef: CONTRACT,
      date: "2026-10-08",
      lines: [{ nomenclatureRef: SERVICE, quantity: 1, price: 100, vatRate: "без НДС" }],
    },
    build: () => fake1C({ store: richStore(), entities: invoiceEntities }),
  },
  {
    kind: "write",
    tool: "write.sales.quick_invoice",
    args: {
      buyer: BIN,
      date: "2026-10-08",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 100, kind: "service" as const }],
    },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.sales.quick_sale",
    args: { basis: QS_INV, date: "2026-10-09" },
    build: saleBuild,
  },
  {
    kind: "write",
    tool: "write.counterparty.quick_reconciliation",
    args: { counterparty: BIN, contract: "б/н", from: "2026-10-01", to: "2026-10-09" },
    build: () => fake1C({ store: reconStore() }),
  },
  {
    kind: "write",
    tool: "write.entity.mark_for_deletion",
    args: { entitySet: "Catalog_Номенклатура", ref: SERVICE },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.entity.update_entity",
    args: { entitySet: "Catalog_Контрагенты", ref: BUYER, fields: { Description: "ТОО Фикстура" } },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.counterparty.update_counterparty",
    args: { ref: BUYER, name: "ТОО Фикстура" },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.catalog.update_nomenclature",
    args: { ref: SERVICE, name: "Услуга фикстура" },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.counterparty.create_contact_person",
    args: { ownerRef: BUYER, name: "Иванов Иван", position: "Директор" },
    build: () => {
      const store = baseStore();
      store["Catalog_КонтактныеЛица"] = [];
      return fake1C({ store });
    },
  },
  {
    kind: "write",
    tool: "write.document.copy_document",
    args: { entitySet: INVOICE_SET, ref: INVOICE },
    build: () => fake1C({ store: richStore(), entities: invoiceEntities }),
  },
  {
    kind: "write",
    tool: "write.entity.create_folder",
    args: { entitySet: "Catalog_Контрагенты", name: "Папка фикстура" },
    build: () => fake1C({ store: baseStore() }),
  },
  {
    kind: "write",
    tool: "write.entity.move_to_folder",
    args: { entitySet: "Catalog_Контрагенты", ref: BUYER, folder: "Папка фикстура" },
    build: () => {
      const store = baseStore();
      store["Catalog_Контрагенты"] = [
        ...(store["Catalog_Контрагенты"] ?? []),
        { Ref_Key: id(951), Description: "Папка фикстура", IsFolder: true, DeletionMark: false },
      ];
      return fake1C({ store });
    },
  },
  {
    kind: "write",
    tool: "write.purchase.create_services_receipt",
    args: servicesArgs,
    build: () => fake1C({ store: richStore(), entities: servicesEntities }),
  },
  {
    kind: "write",
    tool: "write.document.create_power_of_attorney",
    args: poaArgs,
    build: () => fake1C({ store: poaStore(), entities: poaEntities }),
  },
  {
    kind: "write",
    tool: "write.document.update_power_of_attorney",
    args: { ref: id(401), validUntil: "2026-11-15", lines: [{ name: "Тонер", quantity: 1 }] },
    build: () => fake1C({ store: poaStore(), entities: poaEntities }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_kitting",
    args: kitArgs,
    build: () => fake1C({ store: poaStore(), entities: poaEntities }),
  },
  {
    kind: "write",
    tool: "write.warehouse.update_kitting",
    args: { ref: id(411), quantity: 7 },
    build: () => fake1C({ store: poaStore(), entities: poaEntities }),
  },
  {
    kind: "write",
    tool: "write.payroll.create_payroll_statement",
    args: { period: "2026-09" },
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  {
    kind: "write",
    tool: "write.payroll.create_fund_transfer",
    args: { fund: "ep", period: "2026-09" },
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  {
    kind: "write",
    tool: "write.document.create_document",
    args: {
      entitySet: INVOICE_SET,
      fields: { Комментарий: "фикстура" },
      tables: {
        Услуги: [
          {
            Номенклатура_Key: SERVICE,
            Содержание: SERVICE_NAME,
            Количество: 1,
            Цена: 100,
            Сумма: 100,
            СуммаНДС: 0,
          },
        ],
      },
    },
    build: () => fake1C({ store: richStore(), entities: invoiceEntities }),
  },
  {
    kind: "write",
    tool: "write.document.update_document",
    args: { entitySet: INVOICE_SET, ref: INVOICE, fields: { Комментарий: "фикстура" } },
    build: () => fake1C({ store: richStore(), entities: invoiceEntities }),
  },
  {
    kind: "write",
    tool: "write.document.post_document",
    // post — со значением по умолчанию SDK (true): прямой вызов в обход SDK дефолт не подставляет.
    args: { entitySet: INVOICE_SET, ref: INVOICE, post: true },
    build: () => fake1C({ store: richStore(), entities: invoiceEntities }),
  },
  {
    kind: "write",
    tool: "write.avr.set_basis",
    args: { avrRef: AVR, basisRef: AVR_BASIS },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "write",
    tool: "write.esf.link_invoice",
    args: { esfRef: ESF, invoiceRef: SF_INV },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "write",
    tool: "write.catalog.create_security",
    args: { name: "Облигации Фикстура" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "write",
    tool: "write.accounting.set_operation_entries",
    args: {
      documentRef: OP,
      entries: [
        { debit: "1030", credit: "3310", amount: 1000, counterpartyRef: BUYER, contractRef: CONTRACT },
      ],
    },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "write",
    tool: "write.esf.create_draft",
    args: { basisRef: E_INV },
    build: () => fake1C({ store: esfStore([]) }),
  },
  {
    kind: "write",
    tool: "write.esf.update_draft",
    args: { esfRef: E_DRAFT, assignNumber: true, refreshParties: true },
    build: () =>
      fake1C({ store: esfStore([eEsfRow(201, "00000000001"), eEsfRow(202, "00000000002"), eDraft()]) }),
  },
  {
    kind: "write",
    tool: "write.avr.create_draft",
    args: { basisRef: E_SALE },
    build: () => fake1C({ store: esfStore([]) }),
  },
  {
    kind: "write",
    tool: "write.vat.create_offset_notice_draft",
    args: { quarter: "2026/1" },
    build: () =>
      fake1C({ store: vatNoticeStore(), entities: { [VAT_NOTICE]: { properties: NOTICE_PROPS } } }),
  },
];

const readCases: ReadCase[] = [
  {
    kind: "read",
    tool: "read.nomenclature.list_nomenclature",
    args: { query: "" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.catalog.list_catalog",
    args: { entitySet: "Catalog_Номенклатура" },
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.system.capabilities", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.system.kz_document_guide",
    args: {},
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.system.list_databases", args: {}, build: () => fake1C({ store: richStore() }) },
  { kind: "read", tool: "read.system.health_check", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.system.list_organizations",
    args: {},
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.schema.list_entities", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.schema.describe_entity",
    args: { entitySet: "Catalog_Контрагенты" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.counterparty.find_counterparty",
    args: { query: "TRADESPACE" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.counterparty.get_counterparty",
    args: { ref: BUYER },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.counterparty.get_customer_history",
    args: { ref: BUYER },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.counterparty.get_supplier_history",
    args: { ref: BUYER },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.search_documents",
    args: { entitySet: "Document_СчетНаОплатуПокупателю" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.get_document",
    args: { entitySet: "Document_СчетНаОплатуПокупателю", ref: INVOICE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_sales",
    args: { from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_cashflow",
    args: { from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.analytics.get_debtors", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.accounting.get_account_turnover",
    args: { account: "1030", from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.accounting.get_document_postings",
    args: { documentEntity: "Document_СчетНаОплатуПокупателю", documentRef: INVOICE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.get_document_movements",
    args: { documentEntity: "Document_СчетНаОплатуПокупателю", documentRef: INVOICE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_inventory",
    args: {},
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_payments_breakdown",
    args: { from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_deal_history",
    args: { contractRef: CONTRACT },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_taxes_paid",
    args: { from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_sales_breakdown",
    args: { from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.analytics.get_purchases_breakdown",
    args: { from: "2026-10-01", to: "2026-10-31" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.organization.get_organization_card",
    args: {},
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.audit.get_document_history",
    args: { documentEntity: "Document_СчетНаОплатуПокупателю", documentRef: INVOICE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.payroll.list_employees",
    args: {},
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  {
    kind: "read",
    tool: "read.payroll.get_salary_debts",
    args: {},
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  {
    kind: "read",
    tool: "read.payroll.get_accruals",
    args: { from: "2026-09-01", to: "2026-09-30" },
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  {
    kind: "read",
    tool: "read.payroll.check_month",
    args: { period: "2026-09" },
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  {
    kind: "read",
    tool: "read.payroll.get_fund_debts",
    args: {},
    build: () => fake1C({ store: payrollStore(), entities: pmEntities }),
  },
  { kind: "read", tool: "read.esf.list_esf", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.nomenclature.get_prices",
    args: { nomenclatureRefs: [SERVICE] },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.files.list_attachments",
    args: { entitySet: "Document_СчетНаОплатуПокупателю", ref: INVOICE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.files.get_attachment",
    args: { filesCatalog: "Catalog_СчетНаОплатуПокупателюПрисоединенныеФайлы", ref: FILE },
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.esf.list_avr", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.esf.find_avr_basis",
    args: { avrRef: AVR },
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.esf.find_esf_invoice", args: {}, build: () => fake1C({ store: esfStore([]) }) },
  {
    kind: "read",
    tool: "read.vat.list_offset_notices",
    args: {},
    build: () => fake1C({ store: vatNoticeStore() }),
  },
  {
    kind: "read",
    tool: "read.vat.get_offset_notice",
    args: { ref: id(500) },
    build: () =>
      fake1C({ store: vatNoticeStore(), entities: { [VAT_NOTICE]: { properties: NOTICE_PROPS } } }),
  },
  {
    kind: "read",
    tool: "read.vat.find_unoffset_esf",
    args: { quarter: "2026/1" },
    build: () =>
      fake1C({ store: vatNoticeStore(), entities: { [VAT_NOTICE]: { properties: NOTICE_PROPS } } }),
  },
  {
    kind: "read",
    tool: "read.accounting.get_chart_of_accounts",
    args: {},
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.accounting.get_account",
    args: { account: "1030" },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.register.get_information_register",
    args: { register: "КурсыВалют" },
    build: () => fake1C({ store: richStore() }),
  },
  { kind: "read", tool: "read.currency.get_rates", args: {}, build: () => fake1C({ store: richStore() }) },
  {
    kind: "read",
    tool: "read.document.print_invoice",
    args: { ref: INVOICE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.print_sale",
    args: { ref: SALE },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.print_tax_invoice",
    args: { ref: SF },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.print_reconciliation",
    args: { ref: ACT },
    build: () => fake1C({ store: richStore() }),
  },
  {
    kind: "read",
    tool: "read.document.print_power_of_attorney",
    args: { ref: PRINT_POA },
    build: () => fake1C({ store: richStore() }),
  },
];

describe("контрактные фикстуры: запись", () => {
  it("покрыты все пишущие инструменты KZ-базы", () => {
    // update_document_lines и operation.status идут отдельными тестами ниже (цепочки из двух вызовов).
    expect(
      [
        ...writeCases.map((c) => c.tool),
        "write.operation.status",
        "write.document.update_document_lines",
      ].sort(),
    ).toEqual([...KZ_WRITE_TOOLS].sort());
  });
  for (const c of writeCases) {
    it(
      c.tool,
      async () => {
        await runWrite(c);
      },
      30000,
    );
  }
  it("write.operation.status — сверка после сбоя", async () => {
    const f = fake1C({ store: baseStore() });
    const pre = sc(await f.call("write.catalog.create_nomenclature", { name: "Сверка", isService: true }));
    expect(pre).toMatchObject({ dryRun: true });
    const res = await f.call("write.operation.status", { operationId: pre["operationId"] as string });
    expect(res.isError).toBeFalsy();
    checkOrRecord("write.operation.status", {
      args: { operationId: "<из предпросмотра>" },
      result: sc(res),
    });
  });
  it("write.document.update_document_lines — точечная правка аналитики", async () => {
    const f = fake1C({ store: richStore(), entities: servicesEntities });
    const created = sc(
      await f.call("write.purchase.create_services_receipt", {
        ...servicesArgs,
        confirm: true,
        operationId: sc(await f.call("write.purchase.create_services_receipt", servicesArgs))["operationId"],
      }),
    );
    const ref = String(created["ref"]);
    const args = {
      entitySet: "Document_ПоступлениеТоваровУслуг",
      ref,
      analytics: [{ lineNumber: 1, costArticle: "00001" }],
    };
    const pre = await f.call("write.document.update_document_lines", args);
    expect(pre.isError, failed(pre)).toBeFalsy();
    const opId = sc(pre)["operationId"] as string | undefined;
    const post = await f.call(
      "write.document.update_document_lines",
      opId ? { ...args, confirm: true, operationId: opId } : { ...args, confirm: true },
    );
    expect(post.isError, failed(post)).toBeFalsy();
    checkOrRecord("write.document.update_document_lines", { args, dryRun: sc(pre), confirm: sc(post) });
  });
});

// ─── Пакет B10: российская база (БП РФ) — предпросмотр и запись ───
//
// Все 18 «российских» инструментов (profile non_kz, на базе РК коннектор отказывает)
// плюс правки строк add/remove_document_line. База — ruStore() (план счетов «Хозрасчетный»,
// у контрагентов ИНН/КПП). isKazakhstan на ней даёт false — проверяет первый тест.
const RU_DATE = "2026-10-10";
const RU_LINE = { nomenclatureRef: RU_GOODS, quantity: 2, price: 1000, vatRate: "НДС20" };
const RU_SVC_LINE = {
  nomenclatureRef: RU_SERVICE,
  quantity: 1,
  price: 5000,
  vatRate: "НДС20",
  content: "Услуги по договору № 12 за октябрь 2026 г.",
};

const ruWriteCases: WriteCase[] = [
  {
    kind: "write",
    tool: "write.money.create_payout_order",
    args: {
      counterpartyRef: RU_SUPPLIER,
      contractRef: RU_SUP_CONTRACT,
      amount: 15000,
      number: "77",
      date: RU_DATE,
      purposeText: "Оплата по договору № 34",
      recipientText: 'ООО "Поставщик"',
      recipientInn: RU_INN_SUPPLIER,
      recipientKpp: RU_KPP_SUPPLIER,
      operationKind: "ОплатаПоставщику",
      vatRate: "БезНДС",
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.money.create_payment",
    args: {
      counterpartyRef: RU_BUYER,
      contractRef: RU_BUY_CONTRACT,
      amount: 24000,
      date: RU_DATE,
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.money.create_bank_writeoff",
    args: {
      operationKind: "ОплатаПоставщику",
      amount: 15000,
      counterpartyRef: RU_SUPPLIER,
      contractRef: RU_SUP_CONTRACT,
      purposeText: "Оплата по договору № 34",
      date: RU_DATE,
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.money.create_cash_receipt",
    args: {
      operationKind: "ОплатаПокупателя",
      amount: 12000,
      cashRef: RU_CASH,
      counterpartyRef: RU_BUYER,
      contractRef: RU_BUY_CONTRACT,
      date: RU_DATE,
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.money.create_cash_payment",
    args: {
      operationKind: "ОплатаПоставщику",
      amount: 8000,
      cashRef: RU_CASH,
      counterpartyRef: RU_SUPPLIER,
      contractRef: RU_SUP_CONTRACT,
      date: RU_DATE,
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.sales.create_shipment",
    args: {
      counterpartyRef: RU_BUYER,
      contractRef: RU_BUY_CONTRACT,
      warehouse: "Основной склад",
      date: RU_DATE,
      sumIncludesVat: true,
      lines: [RU_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.sales.create_act",
    args: {
      counterpartyRef: RU_BUYER,
      contractRef: RU_BUY_CONTRACT,
      date: RU_DATE,
      sumIncludesVat: true,
      lines: [RU_SVC_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.sales.create_services_act",
    args: {
      counterpartyRef: RU_BUYER,
      contractRef: RU_BUY_CONTRACT,
      nomenclatureGroupRef: RU_NOMGROUP,
      date: RU_DATE,
      sumIncludesVat: true,
      lines: [RU_SVC_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.sales.create_issued_invoice",
    args: { baseDocumentRef: RU_SALE_BASE, date: RU_DATE },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.purchase.create_purchase",
    args: {
      counterpartyRef: RU_SUPPLIER,
      contractRef: RU_SUP_CONTRACT,
      warehouse: "Основной склад",
      date: RU_DATE,
      sumIncludesVat: true,
      lines: [RU_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.purchase.create_supplier_invoice",
    args: {
      counterpartyRef: RU_SUPPLIER,
      contractRef: RU_SUP_CONTRACT,
      incomingNumber: "СЧ-101",
      incomingDate: RU_DATE,
      date: RU_DATE,
      sumIncludesVat: true,
      lines: [RU_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.purchase.create_received_invoice",
    args: { baseDocumentRef: RU_PURCHASE_BASE, incomingDate: RU_DATE, date: RU_DATE },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_transfer",
    args: {
      fromWarehouse: "Основной склад",
      toWarehouse: "Розничный склад",
      date: RU_DATE,
      lines: [{ nomenclatureRef: RU_GOODS, quantity: 3, price: 1000 }],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_surplus",
    args: {
      warehouse: "Основной склад",
      inventoryRef: RU_INVENTORY_DOC,
      date: RU_DATE,
      lines: [{ nomenclatureRef: RU_GOODS, quantity: 1, price: 1000 }],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_writeoff",
    args: {
      warehouse: "Основной склад",
      date: RU_DATE,
      lines: [{ nomenclatureRef: RU_GOODS, quantity: 1, price: 1000 }],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_inventory",
    args: {
      warehouse: "Основной склад",
      date: RU_DATE,
      lines: [{ nomenclatureRef: RU_GOODS, factQuantity: 5, accountingQuantity: 4, price: 1000 }],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_return_from_customer",
    args: {
      counterpartyRef: RU_BUYER,
      contractRef: RU_BUY_CONTRACT,
      warehouse: "Основной склад",
      date: RU_DATE,
      lines: [RU_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.warehouse.create_return_to_supplier",
    args: {
      counterpartyRef: RU_SUPPLIER,
      contractRef: RU_SUP_CONTRACT,
      warehouse: "Основной склад",
      date: RU_DATE,
      lines: [RU_LINE],
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.document.add_document_line",
    args: {
      entitySet: "Document_РеализацияТоваровУслуг",
      ref: RU_EDITABLE,
      line: { nomenclatureRef: RU_SERVICE, quantity: 1, price: 5000, vatRate: "НДС20" },
    },
    build: () => fake1C({ store: ruStore() }),
  },
  {
    kind: "write",
    tool: "write.document.remove_document_line",
    args: { entitySet: "Document_РеализацияТоваровУслуг", ref: RU_EDITABLE, lineNumber: 2 },
    build: () => fake1C({ store: ruStore() }),
  },
];

describe("контрактные фикстуры: российская база B10", () => {
  it("ruStore — не Казахстан: нет Типового плана счетов и ИдентификационныйКодЛичности", async () => {
    const f = fake1C({ store: ruStore() });
    const { isKazakhstan } = await import("../src/tools/write-kz.js");
    expect(await isKazakhstan(f.conn)).toBe(false);
    expect(await isKazakhstan(fake1C({ store: baseStore() }).conn)).toBe(true);
  });
  for (const c of ruWriteCases) {
    it(
      c.tool,
      async () => {
        await runWrite(c);
      },
      30000,
    );
  }
});

describe("контрактные фикстуры: чтение", () => {
  for (const c of readCases) {
    it(
      c.tool,
      async () => {
        await runRead(c);
      },
      30000,
    );
  }
});

// ─── Зарплата: усечённая копия сетапа payroll-month.test.ts ───

const PM_M = "2026-09-01T00:00:00";
const PM_ACCRUAL = "Document_НачислениеЗарплатыРаботникамОрганизаций";
const PM_STATEMENT = "Document_ЗарплатаКВыплатеОрганизаций";
const PM_EP = "Document_РасчетЕдиногоПлатежа";
const PM_SALARY = "AccumulationRegister_ВзаиморасчетыСРаботникамиОрганизаций";
const PM_EP_REG = "AccumulationRegister_ЕПРасчетыСФондами";
const PM_P1 = id(501);
const PM_EMP1 = id(511);
const PM_KIND = id(521);
const PM_FUND = id(531);

const pmDoc = (set: string, fields: string[], table: string, rowFields: string[]) => ({
  [set]: {
    properties: [
      ...["Ref_Key", "Number", "Date", "Posted", "DeletionMark", "Организация_Key", "Ответственный_Key"].map(
        (n) => p(n),
      ),
      ...fields.map((n) => p(n)),
      { name: table, type: `Collection(StandardODATA.${set}_${table}_RowType)` },
    ],
  },
  [`${set}_${table}`]: { properties: ["LineNumber", ...rowFields].map((n) => p(n)) },
});

const pmEntities = {
  ...pmDoc(
    PM_STATEMENT,
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
  ...pmDoc(
    "Document_ЕППеречислениеВФонды",
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

function payrollStore(): Store {
  const store = baseStore();
  store["Catalog_ФизическиеЛица"] = [{ Ref_Key: PM_P1, Description: "Касымова Диана Сериковна." }];
  store["Catalog_СотрудникиОрганизаций"] = [
    {
      Ref_Key: PM_EMP1,
      Description: "Касымова Д.С.",
      Физлицо_Key: PM_P1,
      Организация_Key: ORG,
      ДатаПриемаНаРаботу: "2026-01-01T00:00:00",
      ДатаУвольнения: "0001-01-01T00:00:00",
      DeletionMark: false,
      IsFolder: false,
    },
  ];
  store[PM_ACCRUAL] = [
    {
      Ref_Key: id(611),
      Number: "00000000011",
      Date: "2026-09-30T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: PM_M,
      Начисления: [
        {
          LineNumber: "1",
          Сотрудник_Key: PM_EMP1,
          Физлицо_Key: PM_P1,
          ВидРасчета_Key: PM_KIND,
          Результат: 600000,
        },
      ],
    },
  ];
  store[PM_EP] = [
    {
      Ref_Key: id(709),
      Number: "00000000009",
      Date: "2026-09-30T00:00:00",
      Posted: true,
      DeletionMark: false,
      Организация_Key: ORG,
      ПериодРегистрации: PM_M,
      ИсчисленныйЕП: [
        { ФизЛицо_Key: PM_P1, МесяцНалоговогоПериода: PM_M, ОблагаемаяБаза: 600000, СуммаПлатежа: 148642.2 },
      ],
      Удержания: [],
    },
  ];
  store[PM_STATEMENT] = [];
  store["Document_ЕППеречислениеВФонды"] = [];
  store[PM_SALARY] = [];
  store[`${PM_SALARY}/Balance`] = [
    {
      Физлицо_Key: PM_P1,
      ПериодВзаиморасчетов: PM_M,
      Организация_Key: ORG,
      СуммаВзаиморасчетовBalance: 517118.4,
    },
  ];
  store[PM_EP_REG] = [];
  store[`${PM_EP_REG}/Balance`] = [
    {
      ФизЛицо_Key: PM_P1,
      МесяцНалоговогоПериода: PM_M,
      ВидПлатежа: "Налог",
      Организация_Key: ORG,
      СуммаПлатежаBalance: 148642.2,
    },
  ];
  store["Catalog_Контрагенты"] = [
    ...store["Catalog_Контрагенты"]!,
    {
      Ref_Key: PM_FUND,
      Code: "000000003",
      Description: "НАО ГК Правительство для граждан",
      DeletionMark: false,
    },
  ];
  return store;
}
