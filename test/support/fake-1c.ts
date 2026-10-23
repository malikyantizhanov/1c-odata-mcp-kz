import { afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Connection } from "../../src/context.js";
import type { Behavior } from "../../src/config/env.js";
import { ODataError } from "../../src/odata/errors.js";
import { createServer } from "../../src/mcp/server.js";

/**
 * «1С в памяти» для тестов инструментов записи: настоящий Connection/ODataClient/журнал записи, подменён только
 * HTTP-запрос (request). Фильтры $filter вычисляются (eq/ge/le/substringof, and/or) — как отбирает 1С.
 */

export const tmpRoots: string[] = [];
export const tmp = () => {
  // realpath: на macOS tmpdir() — ссылка /var → /private/var, а сохранение возвращает реальный путь каталога.
  const d = realpathSync(mkdtempSync(join(tmpdir(), "1c-quick-test-")));
  tmpRoots.push(d);
  return d;
};
afterAll(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ORG = id(1);
export const BUYER = id(2);
export const CONTRACT = id(3);
export const SERVICE = id(4);
export const BANK_ACC = id(5);
export const BANK = id(6);
export const KZT = id(7);
export const UNIT = id(8);
export const VAT16 = id(9);
export const VAT_NONE = id(10);
export const BIN = "240440007327";
export const SERVICE_NAME = "Разработка программного обеспечения";

export type Row = Record<string, unknown>;
export type Store = Record<string, Row[]>;

/** Идентификаторы российской базы (пакет B10): диапазон id(51x–55x), с KZ-базой не пересекаются. */
export const RU_ORG = id(510);
export const RU_BUYER = id(511);
export const RU_SUPPLIER = id(512);
export const RU_BUY_CONTRACT = id(513);
export const RU_SUP_CONTRACT = id(514);
export const RU_GOODS = id(515);
export const RU_SERVICE = id(516);
export const RU_BANK_ACC = id(517);
export const RU_RUB = id(518);
export const RU_UNIT = id(519);
export const RU_WH_MAIN = id(520);
export const RU_WH_SHOP = id(521);
export const RU_CASH = id(522);
export const RU_NOMGROUP = id(523);
export const RU_CASHFLOW = id(524);
export const RU_SALE_BASE = id(525);
export const RU_PURCHASE_BASE = id(526);
export const RU_EDITABLE = id(527);
export const RU_INVENTORY_DOC = id(528);
export const RU_INN_ORG = "7712345678";
export const RU_INN_BUYER = "7723456789";
export const RU_INN_SUPPLIER = "7734567890";
export const RU_KPP_BUYER = "772301001";
export const RU_KPP_SUPPLIER = "773401001";

/**
 * Минимальная база «1С:Бухгалтерия предприятия» (РФ) для инструментов пакета B10.
 * План счетов — «Хозрасчетный» (счета 41/60/62/90/91/94); у контрагентов — ИНН/КПП
 * (поля ИдентификационныйКодЛичности нет — isKazakhstan даёт false). Остальные наборы —
 * только те, что читают/пишут 18 инструментов и правки строк (write.ts).
 */
export function ruStore(): Store {
  const chart = (n: number, code: string): Row => ({
    Ref_Key: id(540 + n),
    Code: code,
    Description: `Счёт ${code}`,
    DeletionMark: false,
  });
  return {
    // План счетов РФ: дефолты goodsAccounts/goodsOnlyAccounts/buildSettlementRow.
    ChartOfAccounts_Хозрасчетный: [
      "41.01",
      "41",
      "60.01",
      "60",
      "60.02",
      "19.03",
      "19",
      "62.01",
      "62",
      "62.02",
      "90.01.1",
      "90.02.1",
      "90.03",
      "91.01",
      "94",
    ].map((code, i) => chart(i, code)),
    Catalog_Организации: [
      {
        Ref_Key: RU_ORG,
        Description: 'ООО "Ромашка"',
        НаименованиеПолное: 'Общество с ограниченной ответственностью "Ромашка"',
        ИНН: RU_INN_ORG,
        КПП: "771201001",
        ОсновнойБанковскийСчет_Key: RU_BANK_ACC,
        DeletionMark: false,
      },
    ],
    Catalog_Контрагенты: [
      {
        Ref_Key: RU_BUYER,
        Description: 'ООО "Покупатель"',
        НаименованиеПолное: 'Общество с ограниченной ответственностью "Покупатель"',
        ИНН: RU_INN_BUYER,
        КПП: RU_KPP_BUYER,
        DeletionMark: false,
      },
      {
        Ref_Key: RU_SUPPLIER,
        Description: 'ООО "Поставщик"',
        НаименованиеПолное: 'Общество с ограниченной ответственностью "Поставщик"',
        ИНН: RU_INN_SUPPLIER,
        КПП: RU_KPP_SUPPLIER,
        DeletionMark: false,
      },
    ],
    Catalog_ДоговорыКонтрагентов: [
      {
        Ref_Key: RU_BUY_CONTRACT,
        Description: "Договор с покупателем № 12",
        НомерДоговора: "12",
        ДатаДоговора: "2026-09-01T00:00:00",
        Owner_Key: RU_BUYER,
        Организация_Key: RU_ORG,
        ВидДоговора: "СПокупателем",
        DeletionMark: false,
      },
      {
        Ref_Key: RU_SUP_CONTRACT,
        Description: "Договор с поставщиком № 34",
        НомерДоговора: "34",
        ДатаДоговора: "2026-09-05T00:00:00",
        Owner_Key: RU_SUPPLIER,
        Организация_Key: RU_ORG,
        ВидДоговора: "СПоставщиком",
        DeletionMark: false,
      },
    ],
    Catalog_Номенклатура: [
      {
        Ref_Key: RU_GOODS,
        Code: "00000000021",
        Description: "Товар тестовый",
        НаименованиеПолное: "Товар тестовый",
        Услуга: false,
        IsFolder: false,
        DeletionMark: false,
      },
      {
        Ref_Key: RU_SERVICE,
        Code: "00000000022",
        Description: "Услуга тестовая",
        НаименованиеПолное: "Услуга тестовая",
        Услуга: true,
        IsFolder: false,
        DeletionMark: false,
      },
    ],
    Catalog_Склады: [
      { Ref_Key: RU_WH_MAIN, Description: "Основной склад", DeletionMark: false },
      { Ref_Key: RU_WH_SHOP, Description: "Розничный склад", DeletionMark: false },
    ],
    Catalog_Кассы: [{ Ref_Key: RU_CASH, Description: "Основная касса", DeletionMark: false }],
    Catalog_БанковскиеСчета: [
      {
        Ref_Key: RU_BANK_ACC,
        Description: "Расчётный в Сбербанке",
        НомерСчета: "40702810900000000001",
        Банк_Key: BANK,
        Owner: RU_ORG,
        Owner_Type: "StandardODATA.Catalog_Организации",
        DeletionMark: false,
      },
    ],
    Catalog_Валюты: [{ Ref_Key: RU_RUB, Code: "643", Description: "руб.", DeletionMark: false }],
    Catalog_НоменклатурныеГруппы: [
      { Ref_Key: RU_NOMGROUP, Description: "Основная номенклатурная группа", DeletionMark: false },
    ],
    Catalog_СтатьиДвиженияДенежныхСредств: [
      { Ref_Key: RU_CASHFLOW, Description: "Оплата от покупателей", DeletionMark: false },
    ],
    // Реализация-основание для счёта-фактуры выданного (НДС в строке — для invoiceBasis).
    Document_РеализацияТоваровУслуг: [
      {
        Ref_Key: RU_SALE_BASE,
        Number: "00000000042",
        Date: "2026-10-08T10:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: RU_ORG,
        Контрагент_Key: RU_BUYER,
        ДоговорКонтрагента_Key: RU_BUY_CONTRACT,
        СуммаДокумента: 1200,
        Товары: [
          {
            LineNumber: 1,
            Номенклатура_Key: RU_GOODS,
            Количество: 1,
            Цена: 1000,
            Сумма: 1000,
            СуммаНДС: 200,
            СтавкаНДС: "НДС20",
          },
        ],
      },
      // Документ для add/remove_document_line (две строки — удаление одной оставляет одну).
      {
        Ref_Key: RU_EDITABLE,
        Number: "00000000043",
        Date: "2026-10-09T10:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: RU_ORG,
        Контрагент_Key: RU_BUYER,
        ДоговорКонтрагента_Key: RU_BUY_CONTRACT,
        СуммаДокумента: 3000,
        Товары: [
          {
            LineNumber: 1,
            Номенклатура_Key: RU_GOODS,
            Количество: 2,
            Цена: 1000,
            Сумма: 2000,
            СуммаНДС: 400,
            СтавкаНДС: "НДС20",
          },
          {
            LineNumber: 2,
            Номенклатура_Key: RU_GOODS,
            Количество: 1,
            Цена: 1000,
            Сумма: 1000,
            СуммаНДС: 200,
            СтавкаНДС: "НДС20",
          },
        ],
      },
    ],
    // Поступление-основание для счёта-фактуры полученного.
    Document_ПоступлениеТоваровУслуг: [
      {
        Ref_Key: RU_PURCHASE_BASE,
        Number: "00000000044",
        Date: "2026-10-07T10:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: RU_ORG,
        Контрагент_Key: RU_SUPPLIER,
        ДоговорКонтрагента_Key: RU_SUP_CONTRACT,
        СуммаДокумента: 1200,
        Товары: [
          {
            LineNumber: 1,
            Номенклатура_Key: RU_GOODS,
            Количество: 1,
            Цена: 1000,
            Сумма: 1000,
            СуммаНДС: 200,
            СтавкаНДС: "НДС20",
          },
        ],
      },
    ],
    // Инвентаризация-основание для оприходования.
    Document_ИнвентаризацияТоваровНаСкладе: [
      {
        Ref_Key: RU_INVENTORY_DOC,
        Number: "00000000045",
        Date: "2026-10-06T10:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: RU_ORG,
        Склад_Key: RU_WH_MAIN,
        Товары: [],
      },
    ],
    Document_СчетНаОплатуПоставщика: [],
    Document_ПоступлениеНаРасчетныйСчет: [],
    Document_СписаниеСРасчетногоСчета: [],
    Document_ПлатежноеПоручение: [],
    Document_ПриходныйКассовыйОрдер: [],
    Document_РасходныйКассовыйОрдер: [],
    Document_СчетФактураВыданный: [],
    Document_СчетФактураПолученный: [],
    Document_АктОбОказанииПроизводственныхУслуг: [],
    Document_ВозвратТоваровОтПокупателя: [],
    Document_ВозвратТоваровПоставщику: [],
    Document_ПеремещениеТоваров: [],
    Document_ОприходованиеТоваров: [],
    Document_СписаниеТоваров: [],
  };
}

export function baseStore(): Store {
  return {
    Catalog_Организации: [
      {
        Ref_Key: ORG,
        Description: "Aru Market ИП",
        НаименованиеПолное: "ИП Aru Market",
        ИдентификационныйНомер: "123123123123",
        КБЕ: "19",
        ЮрФизЛицо: "ФизЛицо",
        ОсновнойБанковскийСчет_Key: BANK_ACC,
        НомерСвидетельстваПоНДС: "",
        СерияСвидетельстваПоНДС: "",
        ДатаПостановкиНаУчетПоНДС: "0001-01-01T00:00:00",
        DeletionMark: false,
      },
    ],
    Catalog_Контрагенты: [
      {
        Ref_Key: BUYER,
        Description: 'ТОО "TRADESPACE"',
        НаименованиеПолное: 'ТОО "TRADESPACE"',
        ИдентификационныйКодЛичности: BIN,
        ОсновнойДоговорКонтрагента_Key: "00000000-0000-0000-0000-000000000000",
        DeletionMark: false,
      },
    ],
    Catalog_ДоговорыКонтрагентов: [
      {
        Ref_Key: CONTRACT,
        Description: "Договор б/н",
        НомерДоговора: "б/н",
        ДатаДоговора: "2026-10-08T00:00:00",
        Owner_Key: BUYER,
        Организация_Key: ORG,
        ВидДоговора: "СПокупателем",
        ДатаНачалаДействияДоговора: "0001-01-01T00:00:00",
        ДатаОкончанияДействияДоговора: "0001-01-01T00:00:00",
        IsFolder: false,
        DeletionMark: false,
      },
    ],
    Catalog_Номенклатура: [
      {
        Ref_Key: SERVICE,
        Code: "00000000013",
        Description: SERVICE_NAME,
        НаименованиеПолное: SERVICE_NAME,
        Услуга: true,
        БазоваяЕдиницаИзмерения_Key: UNIT,
        IsFolder: false,
        DeletionMark: false,
      },
      {
        Ref_Key: id(11),
        Code: "00000000014",
        Description: "Разработка сайта",
        Услуга: true,
        IsFolder: false,
        DeletionMark: false,
      },
    ],
    Catalog_БанковскиеСчета: [
      {
        Ref_Key: BANK_ACC,
        Description: "Основной",
        НомерСчета: "KZ86125KZT1004100100",
        Банк_Key: BANK,
        Owner: ORG,
      },
    ],
    Catalog_Банки: [
      { Ref_Key: BANK, Description: 'АО "Банк ЦентрКредит"', БИК: "KCJBKZKX", Город: "Алматы" },
    ],
    Catalog_Валюты: [
      {
        Ref_Key: KZT,
        Code: "398",
        Description: "KZT",
        ПараметрыПрописиНаРусском: "теңге, теңге, теңге, м, тиын, тиын, тиын, м, 2",
      },
    ],
    Catalog_КлассификаторЕдиницИзмерения: [
      { Ref_Key: UNIT, Code: "796", Description: "шт", НаименованиеПолное: "Штука" },
    ],
    Catalog_СтавкиНДС: [
      { Ref_Key: VAT16, Description: "16%" },
      { Ref_Key: VAT_NONE, Description: "без НДС" },
    ],
    Document_СчетНаОплатуПокупателю: [],
  };
}

/** Вычисляет $filter OData v3 в объёме, который строит MCP: eq/ne/ge/le/gt/lt, substringof, and/or, скобки. */
export function matches(row: Row, filter: string | undefined): boolean {
  if (!filter) return true;
  const f = filter.trim();
  const split = (s: string, sep: string): string[] | undefined => {
    let depth = 0;
    let quote = false;
    const parts: string[] = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "'") quote = !quote;
      if (quote) continue;
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (depth === 0 && s.startsWith(sep, i)) {
        parts.push(s.slice(start, i));
        start = i + sep.length;
      }
    }
    if (!parts.length) return undefined;
    parts.push(s.slice(start));
    return parts;
  };
  const ors = split(f, " or ");
  if (ors) return ors.some((p) => matches(row, p));
  const ands = split(f, " and ");
  if (ands) return ands.every((p) => matches(row, p));
  if (f.startsWith("(") && f.endsWith(")")) return matches(row, f.slice(1, -1));
  // startswith(Поле, 'префикс') — отбор счетов по первым цифрам кода, как в 1С.
  const sw = /^startswith\((\S+),\s*'((?:[^']|'')*)'\)$/.exec(f);
  if (sw) return String(row[sw[1]!] ?? "").startsWith(sw[2]!.replace(/''/g, "'"));
  const sub = /^substringof\('((?:[^']|'')*)',\s*(\S+)\)$/.exec(f);
  if (sub)
    return String(row[sub[2]!] ?? "")
      .toLowerCase()
      .includes(sub[1]!.replace(/''/g, "'").toLowerCase());
  // Составное поле: «Объект eq cast(guid'…', 'Catalog_…')» — ссылка и тип (Объект_Type = StandardODATA.Catalog_…).
  const cast = /^(\S+) eq cast\(guid'([^']*)', '([^']*)'\)$/.exec(f);
  if (cast)
    return row[cast[1]!] === cast[2] && String(row[`${cast[1]!}_Type`] ?? "").endsWith(`.${cast[3]!}`);
  const m = /^(\S+) (eq|ne|ge|le|gt|lt) (?:guid|datetime)?'?((?:[^']|'')*?)'?$/.exec(f);
  if (!m) throw new Error(`Фильтр не поддержан тестом: ${f}`);
  const [, field, op, raw] = m;
  const v = raw!.replace(/''/g, "'");
  const actual = row[field!];
  const a = typeof actual === "boolean" ? String(actual) : String(actual ?? "");
  switch (op) {
    case "eq":
      return a === v;
    case "ne":
      return a !== v;
    case "ge":
      return a >= v;
    case "le":
      return a <= v;
    case "gt":
      return a > v;
    default:
      return a < v;
  }
}

export type FakeEntityMeta = {
  entitySet?: string | undefined;
  class?: string | undefined;
  properties: Array<{ name: string; type?: string }>;
  navigations?: Array<{ name: string; toType: string; collection: boolean }>;
};

export function fake1C(
  opts: {
    writable?: boolean;
    readOnly?: boolean;
    store?: Store;
    /** Явные метаданные объектов (типы полей, табличные части, связи) поверх выведенных из store. */
    entities?: Record<string, FakeEntityMeta>;
    /**
     * Файл метаданных в формате дискового кеша (src/odata/metadata-cache.ts): сущности, свойства и навигации
     * берутся из него, поверх — выведенные из store наборы (которых нет в файле) и явные entities. В репозиторий
     * файл не копируем — путь приходит из переменной окружения (ONEC_METADATA_FILE).
     */
    metadataFile?: string | undefined;
    /** PUT набора записей: 1С «молча» не сохраняет субконто (ExtDimension…) — для проверки отката. */
    dropSubcontoOnPut?: boolean;
    /** false — общий HTTP-режим: при создании PDF не печатается. */
    printOnCreate?: boolean;
    /** false — общий HTTP-режим: на диск не пишем, PDF/файлы идут только ресурсом. */
    printToDisk?: boolean | undefined;
  } = {},
) {
  const store = opts.store ?? baseStore();
  const behavior: Behavior = {
    timeoutMs: 1000,
    retries: 0,
    pageSize: 100,
    maxRows: 1000,
    analyticsMaxRows: 1000,
    readOnly: opts.readOnly ?? false,
    writeJournalDir: tmp(),
    printDir: tmp(),
    writeOperationMarker: false,
    ...(opts.printOnCreate === false ? { printOnCreate: false } : {}),
    ...(opts.printToDisk === false ? { printToDisk: false } : {}),
  };
  const conn = new Connection(
    {
      name: "default",
      baseUrl: "https://1c.test/odata/",
      username: "u",
      password: "p",
      writable: opts.writable ?? true,
    },
    behavior,
  );
  // Класс объекта выводим из префикса имени — как в настоящей базе (нужен проверкам isDocument и карте объектов).
  const docClass = (set: string): string => {
    if (set.startsWith("Document_")) return "document";
    if (set.startsWith("Catalog_")) return "catalog";
    if (set.startsWith("InformationRegister_")) return "informationRegister";
    if (set.startsWith("AccumulationRegister_")) return "accumulationRegister";
    if (set.startsWith("AccountingRegister_")) return "accountingRegister";
    if (set.startsWith("ChartOfAccounts_")) return "chartOfAccounts";
    if (set.startsWith("ChartOfCharacteristicTypes_")) return "chartOfCharacteristicTypes";
    return "other";
  };
  const props = (set: string) => ({
    entitySet: set.split("/")[0]!,
    class: docClass(set.split("/")[0]!),
    properties: [...new Set((store[set] ?? []).flatMap((r) => Object.keys(r)))].map((name) => ({ name })),
  });
  const fromFile = new Map<string, FakeEntityMeta>();
  if (opts.metadataFile) {
    const raw = readFileSync(opts.metadataFile, "utf8");
    const cached = JSON.parse(raw) as {
      entities?: Array<{
        entitySet?: string;
        properties?: Array<{ name?: string; type?: string }>;
        navigations?: Array<{ name?: string; toType?: string; collection?: boolean }>;
      }>;
    };
    for (const e of cached.entities ?? []) {
      if (!e.entitySet) continue;
      fromFile.set(e.entitySet, {
        entitySet: e.entitySet,
        ...(typeof (e as { class?: unknown }).class === "string"
          ? { class: (e as { class: string }).class }
          : {}),
        properties: (e.properties ?? [])
          .filter((p) => typeof p.name === "string")
          .map((p) => ({ name: p.name as string, ...(p.type ? { type: p.type } : {}) })),
        navigations: (e.navigations ?? [])
          .filter((n) => typeof n.name === "string" && typeof n.toType === "string")
          .map((n) => ({
            name: n.name as string,
            toType: n.toType as string,
            collection: n.collection === true,
          })),
      });
    }
  }
  const entities = new Map<string, FakeEntityMeta>([
    ...fromFile,
    ...Object.keys(store)
      .map((s) => [s, props(s)] as [string, FakeEntityMeta])
      .filter(([s]) => !fromFile.has(s)),
    // Дефолт для баз РК без своего плана счетов в store (baseStore и его наследники):
    // российская база (ruStore) несёт ChartOfAccounts_Хозрасчетный — Типовой ей не публикуем,
    // иначе isKazakhstan всегда давал бы true и по подмене нельзя было бы отличить базы.
    ...(!fromFile.has("ChartOfAccounts_Типовой") &&
    !Object.keys(store).some((s) => s.startsWith("ChartOfAccounts_"))
      ? [["ChartOfAccounts_Типовой", { properties: [] }] as [string, FakeEntityMeta]]
      : []),
    ...Object.entries(opts.entities ?? {}),
  ]);
  vi.spyOn(conn, "getMetadata").mockResolvedValue({ entities } as never);
  // Bound-действия Post/Unpost идут сырым fetch (client.actionRaw → send), мимо мока request — эмулируем здесь:
  // переворачиваем Posted у строки и отвечаем 200, как провела бы 1С.
  const rawSend = conn.client as unknown as {
    send: (url: string, init: RequestInit) => Promise<Response>;
  };
  const origSend = rawSend.send.bind(conn.client);
  vi.spyOn(rawSend, "send").mockImplementation(async (url: string, init?: RequestInit) => {
    const act = /([^/()]+)\(guid'([^']+)'\)\/(Post|Unpost)$/.exec(
      decodeURIComponent(String(url).split("?")[0]),
    );
    if (!act) return origSend(url, init as RequestInit);
    const [, set, ref, actionName] = act;
    const row = (store[set] ?? []).find(
      (r) =>
        String(r["Ref_Key"] ?? "")
          .replace(/[{}]/g, "")
          .toLowerCase() === ref.toLowerCase(),
    );
    if (!row) return { ok: false, status: 404, text: async () => "" } as Response;
    row["Posted"] = actionName === "Post";
    return { ok: true, status: 200, text: async () => "" } as Response;
  });
  const posts: Array<{ set: string; body: Row }> = [];
  const patches: Array<{ set: string; ref: string; body: Row }> = [];
  const gets: string[] = [];
  const puts: Array<{ path: string; body: Row }> = [];
  const actions: string[] = [];
  let failNext: ((set: string) => Error | undefined) | undefined;
  let failGet: ((path: string) => Error | undefined) | undefined;
  let counter = 0;
  vi.spyOn(conn.client, "request").mockImplementation((async (path: string, method = "GET", body?: Row) => {
    const p = decodeURIComponent(path);
    const set = /^[^(?]+/.exec(p)![0];
    // Набор записей регистра по регистратору: AccountingRegister_X(Recorder=guid'…',Recorder_Type='…').
    const recorder = /\(Recorder=guid'([^']+)'/.exec(p)?.[1];
    if (method === "PUT") {
      const err = failNext?.(`${set}/PUT`);
      if (err) throw err;
      puts.push({ path: p, body: body ?? {} });
      const rows = ((body?.["RecordSet"] as Row[] | undefined) ?? []).map((r) =>
        opts.dropSubcontoOnPut
          ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("ExtDimension")))
          : { ...r },
      );
      const ext = `${set}/RecordsWithExtDimensions`;
      store[ext] = [...(store[ext] ?? []).filter((r) => r["Recorder"] !== recorder), ...rows];
      return {};
    }
    const act = /\(guid'([^']+)'\)\/(Post|Unpost)/.exec(p);
    if (method === "POST" && act) {
      const err = failNext?.(`${set}/${act[2]!}`);
      if (err) throw err;
      actions.push(`${set}/${act[2]!}`);
      const row = (store[set] ?? []).find((r) => r["Ref_Key"] === act[1]);
      if (!row)
        throw new ODataError({ kind: "not_found", status: 404, message: `${set}(${act[1]}) не найден` });
      row["Posted"] = act[2] === "Post";
      return {};
    }
    if (method === "POST") {
      const err = failNext?.(set);
      if (err) throw err;
      const ref = (body?.["Ref_Key"] as string) ?? id(900 + ++counter);
      const created: Row = { ...body, Ref_Key: ref };
      if (set.startsWith("Document_")) created["Number"] = String(++counter).padStart(11, "0");
      else created["Code"] = String(++counter).padStart(11, "0");
      created["DeletionMark"] = false;
      created["IsFolder"] = false;
      (store[set] ??= []).push(created);
      posts.push({ set, body: body ?? {} });
      return created;
    }
    if (method === "PATCH") {
      const ref = /\(guid'([^']+)'\)/.exec(p)?.[1];
      const row = (store[set] ?? []).find((r) => r["Ref_Key"] === ref);
      if (!ref || !row)
        throw new ODataError({ kind: "not_found", status: 404, message: `${set}(${ref}) не найден` });
      Object.assign(row, body);
      patches.push({ set, ref, body: body ?? {} });
      return { ...row };
    }
    gets.push(p);
    const getErr = failGet?.(p);
    if (getErr) throw getErr;
    if (recorder) {
      const rows = (store[`${set}/RecordsWithExtDimensions`] ?? []).filter((r) => r["Recorder"] === recorder);
      if (!rows.length)
        throw new ODataError({
          kind: "not_found",
          status: 404,
          message: `${set}(Recorder=${recorder}) не найден`,
        });
      return { Recorder: recorder, RecordSet: rows.map((r) => ({ ...r })) };
    }
    const key = /\(guid'([^']+)'\)/.exec(p)?.[1];
    if (key) {
      const row = (store[set] ?? []).find((r) => r["Ref_Key"] === key);
      if (!row) throw new ODataError({ kind: "not_found", status: 404, message: `${set}(${key}) не найден` });
      return { ...row };
    }
    const q = new URLSearchParams(p.slice(p.indexOf("?") + 1).replace(/\+/g, "%2B"));
    const all = (store[set] ?? []).filter((r) => matches(r, q.get("$filter") ?? undefined));
    const skip = Number(q.get("$skip") ?? 0);
    const top = Number(q.get("$top") ?? all.length);
    return { value: all.slice(skip, skip + top) };
  }) as never);
  const tools = (
    createServer({
      db: () => conn,
      defaultName: "default",
      databases: () => [{ name: "default", isDefault: true }],
    } as never) as unknown as {
      _registeredTools: Record<string, { handler: (a: Row, e: Row) => Promise<CallToolResult> }>;
    }
  )._registeredTools;
  const call = (name: string, args: Row) => tools[name]!.handler({ database: "default", ...args }, {});
  return {
    conn,
    store,
    posts,
    patches,
    gets,
    puts,
    actions,
    call,
    quick: (args: Row) => call("write.sales.quick_invoice", args),
    failOn: (fn: typeof failNext) => (failNext = fn),
    failGetOn: (fn: typeof failGet) => (failGet = fn),
  };
}
