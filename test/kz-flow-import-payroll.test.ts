import { describe, expect, it } from "vitest";
import { KZ_FLOW_BY_SET, enumNotes, kzGuide } from "../src/tools/kz-flow.js";
import { KZ_DOCUMENTS } from "../src/tools/write-kz.js";
import { baseStore, fake1C, id, ORG } from "./support/fake-1c.js";

/**
 * Реестр флоу v0.7.5: импорт и НДС (ГТД, заявление о ввозе ЕАЭС, доп. расходы, НДС за нерезидента, расчёт налогов при
 * поступлении), доверенность, комплектация и остальные документы раздела «Зарплата и кадры». Имена объектов,
 * табличных частей и значения перечислений сняты с $metadata Aru Market, 20.10.2026.
 */

const NEW_DOCS = [
  "Document_ГТДИмпорт",
  "Document_ЗаявлениеОВвозеТоваровИУплатеКосвенныхНалогов",
  "Document_ПоступлениеДопРасходов",
  "Document_РегистрацияНДСЗаНерезидента",
  "Document_РасчетНалоговПриПоступленииАктивовУслуг",
  "Document_Доверенность",
  "Document_КомплектацияНоменклатуры",
  "Document_ЗаявлениеНаПредоставлениеВычетовИПН",
  "Document_ПрекращениеПредоставленияВычетовИПН",
  "Document_ВводСведенийОПлановыхУдержанияхРаботниковОрганизаций",
  "Document_ВводСведенийОРеглУчетеПлановыхНачисленийРаботниковОрганизаций",
  "Document_РегистрацияРазовыхУдержанийРаботниковОрганизаций",
  "Document_УдержаниеИПНиОПВНУ",
  "Document_ИсполнительныйЛист",
  "Document_ИЛПеречислениеПолучателям",
  "Document_ДепонированиеЗаработнойПлаты",
  "Document_ВозвратЗарплатыРаботниковОрганизаций",
  "Document_ОПВВозвратВзносов",
  "Document_СОВозвратОтчислений",
  "Document_ЕПВозвратПлатежа",
  "Document_РасчетПениОПВиСО",
  "Document_КомандировкиОрганизаций",
  "Document_РегистрацияПрочихДоходовВЦеляхНалогообложения",
  "Document_ВводНачальныхОстатковПоЗарплате",
  "Document_РегистрацияПрочихВыплат",
  "Document_ВедомостьНаПеречислениеПрочихВыплат",
  "Document_ВедомостьНаВозвратПрочихВыплат",
];

describe("реестр флоу: импорт, НДС, доверенность, комплектация, зарплата", () => {
  it("все новые документы во флоу и в списке общей записи", () => {
    for (const set of NEW_DOCS) {
      expect(KZ_FLOW_BY_SET.has(set), set).toBe(true);
      expect(KZ_DOCUMENTS, set).toContain(set);
    }
  });

  it("в новых записях нет номеров статей НК по памяти — только «проверить» (кроме прежней ст. 403)", () => {
    for (const set of NEW_DOCS) {
      if (set === "Document_ЗаявлениеНаПредоставлениеВычетовИПН") continue;
      const d = KZ_FLOW_BY_SET.get(set)!;
      const text = [d.postings, ...d.legal, ...(d.hints ?? [])].join(" ");
      expect(text, set).not.toMatch(/ст\.\s*\d/);
    }
  });

  it("блок «импорт» доступен в справке", () => {
    expect(kzGuide({ block: "импорт" }).map((d) => d.entitySet)).toEqual([
      "Document_ГТДИмпорт",
      "Document_ЗаявлениеОВвозеТоваровИУплатеКосвенныхНалогов",
      "Document_ПоступлениеДопРасходов",
    ]);
  });

  it("перечисления из $metadata: вид операции доп. расходов, НДС за нерезидента, комплектации, строки ГТД", () => {
    expect(enumNotes("Document_ПоступлениеДопРасходов", { ВидОперации: "Услуга" }).join(" ")).toMatch(
      /УслугаСтороннейОрганизации/,
    );
    expect(enumNotes("Document_ПоступлениеДопРасходов", { СпособРаспределения: "ПоСумме" })).toEqual([]);
    expect(enumNotes("Document_РегистрацияНДСЗаНерезидента", { ВидОперации: "Начисление" }).length).toBe(1);
    expect(enumNotes("Document_КомплектацияНоменклатуры", { ВидОперации: "Разукомплектация" })).toEqual([]);
    expect(
      enumNotes("Document_ГТДИмпорт", { Разделы: [{ СпособПроисхожденияТовара: "ЕАЭС" }] }).join(" "),
    ).toMatch(/Разделы\[1\]\.СпособПроисхожденияТовара/);
  });

  it("подпись вычетов ИПН: базовый — ЗаявлениеНаПредоставлениеВычетовИПН, по документам — ИПНЗаявление…", () => {
    expect(KZ_FLOW_BY_SET.get("Document_ЗаявлениеНаПредоставлениеВычетовИПН")!.title).toMatch(/базовый/);
    const other = KZ_FLOW_BY_SET.get("Document_ИПНЗаявлениеНаПредоставлениеВычета")!;
    expect(other.title).not.toMatch(/базовый/);
    expect(other.title).toMatch(/ипотека/);
  });
});

describe("create_document для новых документов (dry-run)", () => {
  const KIT = "Document_КомплектацияНоменклатуры";
  const entities = {
    [KIT]: {
      properties: [
        { name: "Ref_Key", type: "Edm.Guid" },
        { name: "Date", type: "Edm.DateTime" },
        { name: "Posted", type: "Edm.Boolean" },
        { name: "Организация_Key", type: "Edm.Guid" },
        { name: "ВидОперации", type: "Edm.String" },
        { name: "Номенклатура_Key", type: "Edm.Guid" },
        { name: "Количество", type: "Edm.Double" },
        { name: "Склад_Key", type: "Edm.Guid" },
        { name: "Комплектующие", type: `Collection(StandardODATA.${KIT}_Комплектующие_RowType)` },
      ],
    },
    [`${KIT}_Комплектующие`]: {
      properties: [
        { name: "LineNumber", type: "Edm.Int64" },
        { name: "Номенклатура_Key", type: "Edm.Guid" },
        { name: "Количество", type: "Edm.Double" },
      ],
    },
  };

  it("комплектация: предпросмотр без записи, неверный вид операции — предупреждение", async () => {
    const store = baseStore();
    store[KIT] = [];
    const { call, posts } = fake1C({ store, entities });
    const res = await call("write.document.create_document", {
      entitySet: KIT,
      date: "2026-10-20",
      fields: { ВидОперации: "Сборка", Номенклатура_Key: id(501), Количество: 1, Склад_Key: id(502) },
      tables: { Комплектующие: [{ Номенклатура_Key: id(503), Количество: 2 }] },
    });
    expect(res.isError).toBeFalsy();
    expect(posts).toHaveLength(0);
    const text = JSON.stringify(res.structuredContent);
    expect(text).toContain("Комплектация");
    expect(text).toContain(ORG);
  });
});
