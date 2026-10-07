import { describe, expect, it } from "vitest";
import {
  KZ_FLOW,
  KZ_FLOW_BY_SET,
  KZ_KBK,
  candidates,
  enumNotes,
  fillFromSample,
  kzCreateNotes,
  kzFlowPostingWarnings,
  kzGuide,
  paymentCodeNotes,
  resolveAccountCodes,
  rowArithmetic,
  vatRateNotes,
} from "../src/tools/kz-flow.js";
import { kzUpdateEntityCheck } from "../src/tools/capabilities.js";
import { describeBody } from "../src/tools/write.js";
import { loadMetadata } from "../src/odata/metadata.js";
import type { EntityMeta } from "../src/types/odata.js";

/**
 * Флоу бухгалтера (Казахстан): реестр документов, подстановка счетов из образца и по кодам,
 * проверки КНП/КБК, ставок НДС, перечислений 1С и сверка проводок со схемой.
 */

const prop = (name: string, type = "Edm.String") => ({ name, type, nullable: true });
const nav = (name: string, toType = "ChartOfAccounts_Типовой") => ({ name, toType, collection: false });
const meta = (entitySet: string, properties: ReturnType<typeof prop>[], navigations: ReturnType<typeof nav>[] = []) =>
  ({ entitySet, entityType: entitySet, class: "document", shortName: entitySet, keys: ["Ref_Key"], properties, navigations }) as unknown as EntityMeta;

const SALE = "Document_РеализацияТоваровУслуг";
const ROW = `${SALE}_Товары`;
const saleEm = meta(
  SALE,
  [prop("Контрагент_Key", "Edm.Guid"), prop("ДоговорКонтрагента_Key", "Edm.Guid"), prop("СчетУчетаРасчетовСКонтрагентом_Key", "Edm.Guid"), prop("ВидУчетаНУ_Key", "Edm.Guid"), prop("Товары", `Collection(StandardODATA.${ROW}_RowType)`)],
  [nav("СчетУчетаРасчетовСКонтрагентом")],
);
const rowEm = meta(
  ROW,
  [prop("Номенклатура_Key", "Edm.Guid"), prop("Количество", "Edm.Double"), prop("Цена", "Edm.Double"), prop("Сумма", "Edm.Double"), prop("СчетУчетаБУ_Key", "Edm.Guid"), prop("СчетУчетаНУ_Key", "Edm.Guid"), prop("СубконтоБУ1"), prop("СубконтоБУ1_Type")],
  [nav("СчетУчетаБУ"), nav("СчетУчетаНУ", "ChartOfAccounts_Налоговый")],
);
const entities = new Map<string, EntityMeta>([
  [SALE, saleEm],
  [ROW, rowEm],
]);

describe("реестр флоу", () => {
  it("каждый документ имеет схему проводок и норму; entitySet уникальны", () => {
    const sets = KZ_FLOW.map((d) => d.entitySet);
    expect(new Set(sets).size).toBe(sets.length);
    for (const d of KZ_FLOW) {
      expect(d.postings.length).toBeGreaterThan(5);
      expect(d.legal.length).toBeGreaterThan(0);
    }
  });
  it("ЕП: КБК 906101 с КНП 185", () => {
    expect(KZ_KBK["906101"]?.knp).toContain("185");
  });
  it("kzGuide фильтрует по блоку и ругается на неизвестный документ", () => {
    expect(kzGuide({ block: "склад" }).every((d) => d.block === "склад")).toBe(true);
    expect(() => kzGuide({ entitySet: "Document_Нет" })).toThrow(/нет во флоу/);
  });
});

describe("fillFromSample — настройки учёта из проведённого образца", () => {
  const sample = {
    Number: "12",
    Контрагент_Key: "c-sample",
    СчетУчетаРасчетовСКонтрагентом_Key: "acc-1210",
    ВидУчетаНУ_Key: "nu",
    Товары: [
      { Номенклатура_Key: "other", СчетУчетаБУ_Key: "acc-other" },
      { Номенклатура_Key: "item", СчетУчетаБУ_Key: "acc-1330", СчетУчетаНУ_Key: "acc-1330n", СубконтоБУ1: "s1", СубконтоБУ1_Type: "StandardODATA.Catalog_Склады" },
    ],
  };
  it("берёт счета и субконто (с _Type) из строки с той же номенклатурой, не трогает контрагента и суммы", () => {
    const payload = { Контрагент_Key: "c-mine", Товары: [{ Номенклатура_Key: "item", Сумма: 5 }] };
    const { payload: out, filled } = fillFromSample({ entities }, saleEm, payload, sample);
    expect(out["Контрагент_Key"]).toBe("c-mine");
    expect(out["СчетУчетаРасчетовСКонтрагентом_Key"]).toBe("acc-1210");
    const row = (out["Товары"] as Record<string, unknown>[])[0]!;
    expect(row).toMatchObject({ СчетУчетаБУ_Key: "acc-1330", СчетУчетаНУ_Key: "acc-1330n", СубконтоБУ1: "s1", СубконтоБУ1_Type: "StandardODATA.Catalog_Склады", Сумма: 5 });
    expect(filled.join(" ")).toMatch(/Товары: 3 полей/);
  });
  it("явно переданный счёт не перезаписывается", () => {
    const payload = { Товары: [{ Номенклатура_Key: "item", СчетУчетаБУ_Key: "mine" }] };
    const row = (fillFromSample({ entities }, saleEm, payload, sample).payload["Товары"] as Record<string, unknown>[])[0]!;
    expect(row["СчетУчетаБУ_Key"]).toBe("mine");
  });
});

describe("счета по кодам", () => {
  it("candidates: код, код+Н, укрупнённый налоговый", () => {
    expect(candidates("7210")).toEqual(["7210", "7210Н", "7200Н"]);
  });
  it("resolveAccountCodes ищет в своём плане счетов и отдаёт подсказку о замене", async () => {
    const asked: string[] = [];
    const conn = {
      getMetadata: async () => ({ entities }),
      client: {
        getCollection: async (path: string) => {
          asked.push(path);
          return path.startsWith("ChartOfAccounts_Налоговый")
            ? { value: [{ Ref_Key: "n-1330", Code: "1330Н" }] }
            : { value: [{ Ref_Key: "t-1330", Code: "1330" }, { Ref_Key: "t-1210", Code: "1210" }] };
        },
      },
    };
    const { payload, resolved } = await resolveAccountCodes(conn as never, saleEm, {
      СчетУчетаРасчетовСКонтрагентом_Key: "1210",
      Товары: [{ СчетУчетаБУ_Key: "1330", СчетУчетаНУ_Key: "1330" }],
    });
    expect(payload["СчетУчетаРасчетовСКонтрагентом_Key"]).toBe("t-1210");
    expect((payload["Товары"] as Record<string, unknown>[])[0]).toMatchObject({ СчетУчетаБУ_Key: "t-1330", СчетУчетаНУ_Key: "n-1330" });
    expect(resolved).toContain("1330→1330Н (Налоговый)");
    expect(asked.some((p) => p.startsWith("ChartOfAccounts_Налоговый"))).toBe(true);
  });
  it("неизвестный код — ошибка с похожими счетами, GUID не трогается", async () => {
    const conn = {
      getMetadata: async () => ({ entities }),
      client: { getCollection: async (path: string) => ({ value: path.includes("startswith") ? [{ Code: "1200Н", Description: "Дебиторка" }] : [] }) },
    };
    await expect(resolveAccountCodes(conn as never, saleEm, { Товары: [{ СчетУчетаНУ_Key: "1210" }] })).rejects.toThrow(/1200Н/);
    const guid = "693925e9-dfe5-11f0-b945-6c02e065a99a";
    const { payload } = await resolveAccountCodes(conn as never, saleEm, { СчетУчетаРасчетовСКонтрагентом_Key: guid });
    expect(payload["СчетУчетаРасчетовСКонтрагентом_Key"]).toBe(guid);
  });
});

describe("проверки при создании", () => {
  it("КНП не под КБК — предупреждение; ЕП 906101/185 — без замечаний", () => {
    expect(paymentCodeNotes({ КодБК: "101201", КодНазначенияПлатежа: "010" }).join(" ")).toMatch(/911/);
    expect(paymentCodeNotes({ КодБК: "906101", КодНазначенияПлатежа: "185" })).toEqual([]);
  });
  it("ставка НДС 12% в 2026 — предупреждение со ст. 503", () => {
    expect(vatRateNotes("2026-10-08T00:00:00", { СтавкаНДС_Key: "r12" }, saleEm, new Map([["r12", "12%"]])).join(" ")).toMatch(/16%.*503/);
    expect(vatRateNotes("2026-10-08T00:00:00", { СтавкаНДС_Key: "r16" }, saleEm, new Map([["r16", "16%"]]))).toEqual([]);
  });
  it("Сумма ≠ Количество × Цена — предупреждение", () => {
    expect(rowArithmetic(saleEm, { Товары: [{ Количество: 2, Цена: 100, Сумма: 150 }] }).length).toBe(1);
    expect(rowArithmetic(saleEm, { Товары: [{ Количество: 2, Цена: 100, Сумма: 200 }] })).toEqual([]);
  });
  it("перечисления: значение не из списка 1С — предупреждение, в т.ч. в строках", () => {
    expect(enumNotes("Document_ВозвратТоваровПоставщику", { ВидОперации: "Товары" }).join(" ")).toMatch(/Покупка/);
    expect(enumNotes("Document_ВозвратТоваровПоставщику", { ВидОперации: "Покупка" })).toEqual([]);
    expect(
      enumNotes("Document_РасходныйКассовыйОрдер", { ВыдачаВПодотчет: [{ ВидЗадолженностиПодотчетногоЛица: "ХозяйственныеРасходы" }] }).join(" "),
    ).toMatch(/ВыдачаВПодотчет\[1\]/);
  });
  it("ПП без Оплачено — предупреждение; счёт расчётов в строках не считается пустым", async () => {
    const PP = "Document_ПлатежноеПоручениеИсходящее";
    const ppRow = meta(`${PP}_РасшифровкаПлатежа`, [prop("СчетУчетаРасчетовСКонтрагентомБУ_Key", "Edm.Guid")], [nav("СчетУчетаРасчетовСКонтрагентомБУ")]);
    const ppEm = meta(PP, [prop("Контрагент_Key", "Edm.Guid"), prop("СчетУчетаРасчетовСКонтрагентомБУ_Key", "Edm.Guid"), prop("РасшифровкаПлатежа", `Collection(StandardODATA.${PP}_РасшифровкаПлатежа_RowType)`)], [nav("СчетУчетаРасчетовСКонтрагентомБУ")]);
    const conn = { getMetadata: async () => ({ entities: new Map([[PP, ppEm], [`${PP}_РасшифровкаПлатежа`, ppRow]]) }) };
    const notes = await kzCreateNotes(conn as never, ppEm, { Контрагент_Key: "c", РасшифровкаПлатежа: [{ СчетУчетаРасчетовСКонтрагентомБУ_Key: "acc" }] }, { sampleUsed: false });
    expect(notes.join(" ")).toMatch(/Оплачено не установлено/);
    expect(notes.join(" ")).not.toMatch(/Не заполнены счета расчётов/);
  });
});

describe("сверка проводок со схемой", () => {
  it("нет ожидаемого Кт — предупреждение; документ без проводок по природе — норма", () => {
    expect(kzFlowPostingWarnings("Document_ПоступлениеТоваровУслуг", [{ debitAccount: "1330", creditAccount: "3310" }])).toEqual([]);
    expect(kzFlowPostingWarnings("Document_ПоступлениеТоваровУслуг", [{ debitAccount: "1330", creditAccount: "6280" }]).join(" ")).toMatch(/Кт 3310/);
    expect(kzFlowPostingWarnings("Document_АктСверкиВзаиморасчетов", [])).toEqual([]);
    expect(kzFlowPostingWarnings("Document_СписаниеТоваров", []).join(" ")).toMatch(/без бухгалтерских проводок/);
  });
  it("СФ: подсказка на случай отказа 1С в проведении", () => {
    expect(KZ_FLOW_BY_SET.get("Document_СчетФактураВыданный")?.postFailureHint).toMatch(/плательщиком НДС/);
  });
});

describe("update_entity в казахстанской базе", () => {
  it("Posted и DeletionMark не правятся; документ вне флоу отклоняется; справочник можно", () => {
    expect(() => kzUpdateEntityCheck({ entitySet: SALE, fields: { Posted: true } })).toThrow(/post_document/);
    expect(() => kzUpdateEntityCheck({ entitySet: SALE, fields: { DeletionMark: false } })).toThrow(/mark_for_deletion/);
    expect(() => kzUpdateEntityCheck({ entitySet: "Document_ЧекККМ", fields: { Комментарий: "x" } })).toThrow();
    expect(() => kzUpdateEntityCheck({ entitySet: "InformationRegister_X", fields: { a: 1 } })).toThrow(/Catalog_/);
    expect(() => kzUpdateEntityCheck({ entitySet: "Catalog_Номенклатура", fields: { Description: "x" } })).not.toThrow();
    expect(() => kzUpdateEntityCheck({ entitySet: SALE, fields: { Комментарий: "x" } })).not.toThrow();
  });
});

describe("ответы 1cfresh", () => {
  it("HTML-страница вместо OData — короткое объяснение, без простыни", () => {
    const text = describeBody('    <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><head><title>1cfresh.kz</title></head><body>...</body></html>');
    expect(text).toMatch(/HTML-страница сервиса «1cfresh.kz»/);
    expect(text).not.toMatch(/DOCTYPE/);
    expect(describeBody("")).toBe("(пустое тело)");
  });
});

describe("$metadata: тип счёта по Association", () => {
  it("NavigationProperty ToRole=End получает тип плана счетов из Association", async () => {
    const xml = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0"><edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
<Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
<EntityType Name="Document_X"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/><Property Name="Счет_Key" Type="Edm.Guid"/>
<NavigationProperty Name="Счет" Relationship="StandardODATA.Document_X_Счет" FromRole="Begin" ToRole="End"/></EntityType>
<Association Name="Document_X_Счет"><End Role="Begin" Type="StandardODATA.Document_X" Multiplicity="*"/><End Role="End" Type="StandardODATA.ChartOfAccounts_Типовой" Multiplicity="0..1"/></Association>
<EntityContainer Name="EnterpriseV8" m:IsDefaultEntityContainer="true"><EntitySet Name="Document_X" EntityType="StandardODATA.Document_X"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
    const m = await loadMetadata({ getText: async () => xml } as never);
    expect(m.entities.get("Document_X")?.navigations).toEqual([{ name: "Счет", toType: "ChartOfAccounts_Типовой", collection: false }]);
  });
});
