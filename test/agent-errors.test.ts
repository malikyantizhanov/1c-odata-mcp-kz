import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { executorSignature } from "../src/print/invoice-pdf.js";
import { isNoNumberQuery, matchContracts } from "../src/odata/contracts.js";
import { shortList } from "../src/tools/_shared.js";
import {
  BANK_ACC,
  BIN,
  BUYER,
  CONTRACT,
  ORG,
  SERVICE,
  SERVICE_NAME,
  baseStore,
  fake1C,
  id,
  type Row,
  type Store,
} from "./support/fake-1c.js";

/**
 * Частые ошибки агентов (журнал прода и претензии бухгалтеров): сообщения должны говорить, что делать дальше,
 * а инструменты — не застревать на составных владельцах, «Без договора», похожих названиях и пустых _Type.
 */

/** Описания инструментов (поле description) — без обращения к 1С. */
const descriptions = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(
      (
        createServer({ db: () => fake1C().conn } as never) as unknown as {
          _registeredTools: Record<string, { description?: string }>;
        }
      )._registeredTools,
    ).map(([k, v]) => [k, v.description ?? ""]),
  );
const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (r: CallToolResult) => r.content.map((c) => ("text" in c ? c.text : "")).join("\n");

const SCHNEIDER = id(601);
const OTHER_BUYER = id(602);
const CONTRACT_12 = id(603);
const SALE = "Document_РеализацияТоваровУслуг";
const SALE_DOC = id(604);
const GROUP = id(605);
const ACC_6010 = id(606);
const KIND_GROUP = id(607);
const KIND_NOM = id(608);

/** Метаданные документа с полями шапки (в пустом наборе store их не вывести). */
const docMeta = (set: string, fields: string[]) => ({
  [set]: {
    entitySet: set,
    properties: [
      "Ref_Key",
      "Number",
      "Date",
      "Posted",
      "DeletionMark",
      "Организация_Key",
      "СуммаДокумента",
      ...fields,
    ].map((name) => ({ name, type: name === "Date" ? "Edm.DateTime" : "Edm.String" })),
  },
});
const SALE_META = docMeta("Document_РеализацияТоваровУслуг", ["Контрагент_Key", "ДоговорКонтрагента_Key"]);

function agentStore(): Store {
  const store = baseStore();
  store["Catalog_Контрагенты"]!.push(
    {
      Ref_Key: SCHNEIDER,
      Description: "Шнейдер Электрик ТОО",
      НаименованиеПолное: "Товарищество с ограниченной ответственностью «Шнейдер Электрик»",
      ИдентификационныйКодЛичности: "990140000483",
      DeletionMark: false,
    },
    {
      Ref_Key: OTHER_BUYER,
      Description: "Ромашка ТОО",
      ИдентификационныйКодЛичности: "010101000001",
      DeletionMark: false,
    },
  );
  return store;
}

describe("1. list_catalog: отбор по владельцу составного типа", () => {
  it("банковские счета организации: Owner + Owner_Type → cast на Catalog_Организации; поле владельца в $select", async () => {
    const f = fake1C({ store: agentStore(), honorSelect: true });
    const res = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_БанковскиеСчета",
      owner: ORG,
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["rows"].map((r: Row) => r["ref"])).toEqual([BANK_ACC]);
    expect(f.gets.some((g) => g.includes(`Owner eq cast(guid'${ORG}', 'Catalog_Организации')`))).toBe(true);
  });

  it("договоры с составным владельцем (Владелец + Владелец_Type): находятся по Ref_Key контрагента", async () => {
    const store = agentStore();
    store["Catalog_ДоговорыКонтрагентов"] = [
      {
        Ref_Key: CONTRACT,
        Description: "Договор б/н",
        НомерДоговора: "б/н",
        Владелец: BUYER,
        Владелец_Type: "StandardODATA.Catalog_Контрагенты",
        Организация_Key: ORG,
        ВидДоговора: "СПокупателем",
        IsFolder: false,
        DeletionMark: false,
      },
    ];
    const f = fake1C({ store, honorSelect: true });
    const res = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_ДоговорыКонтрагентов",
      owner: BUYER,
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["rows"].map((r: Row) => r["name"])).toEqual(["Договор б/н"]);
  });

  it("пусто по владельцу — «у владельца нет элементов», а не «по запросу «» ничего не найдено»", async () => {
    const f = fake1C({ store: agentStore(), honorSelect: true });
    const res = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_ДоговорыКонтрагентов",
      owner: SCHNEIDER,
    });
    const note = String(sc(res)["note"]);
    expect(sc(res)["rows"]).toEqual([]);
    expect(note).toContain(`У владельца ${SCHNEIDER}`);
    expect(note).not.toContain("По запросу «»");

    // Ref_Key не найден ни в одном справочнике-владельце — подсказка, что передан не тот ref.
    const stray = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_БанковскиеСчета",
      owner: id(999),
    });
    expect(String(sc(stray)["note"])).toMatch(/не найден ни в одном справочнике-владельце/);
  });

  it("Владелец_Key в select — подсказка про параметр owner, а не «нет простых полей»", async () => {
    const f = fake1C({ store: agentStore() });
    const res = await f.call("read.catalog.list_catalog", {
      entitySet: "Catalog_БанковскиеСчета",
      select: ["Владелец_Key"],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("owner=<Ref_Key владельца>");
    expect(text(res)).not.toContain("нет простых полей");
  });
});

describe("2. нечёткий поиск контрагентов и элементов справочников", () => {
  it("find_counterparty: «Шнайдер» и «Schneider» находят «Шнейдер Электрик ТОО» с оценкой", async () => {
    const f = fake1C({ store: agentStore() });
    for (const query of ["Шнайдер", "Schneider", "schneider electric llp"]) {
      const res = await f.call("read.counterparty.find_counterparty", { query });
      expect(res.isError, text(res)).toBeFalsy();
      const rows = sc(res)["rows"] as Row[];
      expect(rows[0], query).toMatchObject({ ref: SCHNEIDER, matchedBy: "fuzzy" });
      expect(rows[0]!["score"]).toBeGreaterThanOrEqual(0.6);
      expect(rows.some((r) => r["ref"] === OTHER_BUYER)).toBe(false);
      expect(String(sc(res)["note"])).toMatch(/показаны похожие/);
    }
  });

  it("find_counterparty: по части БИН/ИИН и по точному вхождению — без нечёткого режима", async () => {
    const f = fake1C({ store: agentStore() });
    const byBin = sc(await f.call("read.counterparty.find_counterparty", { query: "0140000" }));
    expect(byBin["rows"].map((r: Row) => r["ref"])).toEqual([SCHNEIDER]);
    const plain = sc(await f.call("read.counterparty.find_counterparty", { query: "Шнейдер" }));
    expect(plain["rows"][0]).not.toHaveProperty("matchedBy");
  });

  it("list_catalog с query: нет вхождения — похожие с score; совсем не похоже — честное «не найдено»", async () => {
    const f = fake1C({ store: agentStore() });
    const res = sc(
      await f.call("read.catalog.list_catalog", { entitySet: "Catalog_Контрагенты", query: "Schneider" }),
    );
    expect(res["rows"][0]).toMatchObject({ ref: SCHNEIDER, matchedBy: "fuzzy" });
    const none = sc(
      await f.call("read.catalog.list_catalog", { entitySet: "Catalog_Контрагенты", query: "Жасмин" }),
    );
    expect(none["rows"]).toEqual([]);
    expect(String(none["note"])).toMatch(/похожих по написанию тоже нет/);
  });

  it("quick_invoice: «Schneider» — единственный сильный кандидат подставлен, с counterpartyMatch и note", async () => {
    const f = fake1C({ store: agentStore() });
    const res = await f.quick({
      buyer: "Schneider",
      date: "2026-10-08",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({
      buyer: { ref: SCHNEIDER },
      counterpartyMatch: {
        query: "Schneider",
        matched: { ref: SCHNEIDER, name: "Шнейдер Электрик ТОО", bin: "990140000483" },
        exact: false,
      },
    });
    expect(sc(res)["counterpartyMatch"]["score"]).toBeLessThan(0.98);
    expect((sc(res)["notes"] as string[]).join(" ")).toContain(
      "Точного совпадения нет, беру ближайшее: «Шнейдер Электрик ТОО» (БИН 990140000483)",
    );
  });

  it("quick_invoice: «ТрейдСпейс» (на слух) → ТОО «TRADESPACE» с пометкой", async () => {
    const res = await fake1C({ store: agentStore() }).quick({
      buyer: "ТрейдСпейс",
      date: "2026-10-08",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({
      ready: true,
      buyer: { ref: BUYER },
      counterpartyMatch: { query: "ТрейдСпейс", matched: { ref: BUYER, bin: BIN }, exact: false },
    });
    expect((sc(res)["notes"] as string[]).join(" ")).toContain(
      `Точного совпадения нет, беру ближайшее: «ТОО "TRADESPACE"» (БИН ${BIN})`,
    );
  });

  it("quick_invoice: слабый кандидат («Шнайдер») — варианты с оценкой, без подстановки", async () => {
    const res = await fake1C({ store: agentStore() }).quick({
      buyer: "Шнайдер",
      date: "2026-10-08",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({ ready: false });
    expect(sc(res)).not.toHaveProperty("counterpartyMatch");
    const best = (sc(res)["choices"] as Array<{ field: string; options: Row[] }>).find(
      (c) => c.field === "buyer",
    )!.options[0]!;
    expect(best).toMatchObject({ ref: SCHNEIDER });
    expect(Number(best["score"])).toBeGreaterThan(0.6);
  });

  it("quick_invoice: два сильных кандидата — варианты, без подстановки", async () => {
    const store = agentStore();
    store["Catalog_Контрагенты"]!.push({
      Ref_Key: id(609),
      Description: "TradeSpace",
      НаименованиеПолное: "TradeSpace",
      ИдентификационныйКодЛичности: "123456789012",
      DeletionMark: false,
    });
    const res = await fake1C({ store }).quick({
      buyer: "ТрейдСпейс",
      date: "2026-10-08",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({ ready: false });
    expect(sc(res)).not.toHaveProperty("counterpartyMatch");
    const buyer = (sc(res)["choices"] as Array<{ field: string; options: Row[] }>).find(
      (c) => c.field === "buyer",
    )!;
    expect(buyer.options.map((o) => o["ref"]).sort()).toEqual([BUYER, id(609)].sort());
  });

  it("quick_invoice: номенклатура «разработка программного обеспечения» в другом регистре/с ё — та же позиция", async () => {
    const f = fake1C({ store: agentStore() });
    const res = await f.quick({
      buyer: BIN,
      date: "2026-10-08",
      lines: [{ name: "«Разработка» программного обеспечения", quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["lines"][0]).toMatchObject({ action: "найдена", ref: SERVICE });
  });
});

describe("3. договор: «Без договора», «б/н» и автоподстановка", () => {
  it("«Без договора»/«б/н» сопоставляются с договором без номера", () => {
    expect(isNoNumberQuery("Без договора")).toBe(true);
    expect(isNoNumberQuery("б/н")).toBe(true);
    expect(isNoNumberQuery("Договор № 5")).toBe(false);
    const rows = [
      { Ref_Key: CONTRACT, Description: "Договор б/н", НомерДоговора: "б/н" },
      { Ref_Key: CONTRACT_12, Description: "Договор № 12", НомерДоговора: "12" },
    ];
    expect(matchContracts(rows, "Без договора").map((r) => r["Ref_Key"])).toEqual([CONTRACT]);
    expect(matchContracts(rows, "№ 12").map((r) => r["Ref_Key"])).toEqual([CONTRACT_12]);
  });

  it("quick_invoice: contract «Без договора» → «Договор б/н»", async () => {
    const f = fake1C();
    const res = await f.quick({
      buyer: BIN,
      date: "2026-10-08",
      contract: "Без договора",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["contract"]).toMatchObject({ action: "найден", ref: CONTRACT });
  });

  it("quick_invoice: указанного договора нет, подходящий один — подставлен автоматически, с пометкой в плане", async () => {
    const f = fake1C();
    const res = await f.quick({
      buyer: BIN,
      date: "2026-10-08",
      contract: "Договор поставки № 77",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["contract"]).toMatchObject({ action: "подставлен автоматически", ref: CONTRACT });
    expect((sc(res)["notes"] as string[]).join(" ")).toMatch(/договор подставлен автоматически/);
  });

  it("quick_invoice: указанного нет, подходящих несколько — последний договор с contractAutoSelected", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"]!.push({
      ...store["Catalog_ДоговорыКонтрагентов"]![0]!,
      Ref_Key: CONTRACT_12,
      Description: "Договор № 12",
      НомерДоговора: "12",
      ДатаДоговора: "2026-01-15T00:00:00",
    });
    const res = await fake1C({ store }).quick({
      buyer: BIN,
      date: "2026-10-08",
      contract: "Договор поставки № 77",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({
      ready: true,
      contract: { action: "подставлен автоматически", ref: CONTRACT },
      contractAutoSelected: {
        ref: CONTRACT,
        reason: "последний договор вида «С покупателем»",
        alternatives: [{ ref: CONTRACT_12, name: "Договор № 12" }],
      },
    });
    expect((sc(res)["notes"] as string[]).join(" ")).toContain(
      "Договор «Договор поставки № 77» у покупателя не найден",
    );
  });

  it("quick_invoice: указанного нет и подходящих нет вовсе — ошибка", async () => {
    const store = baseStore();
    store["Catalog_ДоговорыКонтрагентов"]![0]!["ВидДоговора"] = "СПоставщиком";
    const res = await fake1C({ store }).quick({
      buyer: BIN,
      date: "2026-10-08",
      contract: "Договор поставки № 77",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`«Договор б/н» (ref ${CONTRACT}`);
  });

  it("quick_sale: два договора — основной договор, contractAutoSelected в плане", async () => {
    const store = baseStore();
    store[SALE] = [];
    store["Catalog_ДоговорыКонтрагентов"]!.push({
      ...store["Catalog_ДоговорыКонтрагентов"]![0]!,
      Ref_Key: CONTRACT_12,
      Description: "Договор № 12",
      НомерДоговора: "12",
      ДатаДоговора: "2026-01-15T00:00:00",
    });
    store["Catalog_Контрагенты"]![0]!["ОсновнойДоговорКонтрагента_Key"] = CONTRACT_12;
    const res = await fake1C({ store }).call("write.sales.quick_sale", {
      buyer: BIN,
      date: "2026-10-08",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({
      ready: true,
      contract: { ref: CONTRACT_12 },
      contractAutoSelected: {
        ref: CONTRACT_12,
        reason: "основной договор",
        alternatives: [{ ref: CONTRACT, name: "Договор б/н" }],
      },
    });
  });

  it("quick_sale: contract «Без договора» → «Договор б/н»", async () => {
    const store = baseStore();
    store[SALE] = [];
    const res = await fake1C({ store }).call("write.sales.quick_sale", {
      buyer: BIN,
      date: "2026-10-08",
      contract: "Без договора",
      lines: [{ name: SERVICE_NAME, quantity: 1, price: 1000, kind: "service" }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["contract"]).toMatchObject({ ref: CONTRACT });
  });

  it("create_document: ДоговорКонтрагента_Key «Без договора» → ref договора без номера", async () => {
    const store = baseStore();
    store[SALE] = [];
    const res = await fake1C({ store, entities: SALE_META }).call("write.document.create_document", {
      entitySet: SALE,
      fields: { Контрагент_Key: BUYER, ДоговорКонтрагента_Key: "Без договора" },
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["payload"]["ДоговорКонтрагента_Key"]).toBe(CONTRACT);
    expect((sc(res)["notes"] as string[]).join(" ")).toMatch(/сопоставлен с «Договор б\/н»/);
  });
});

describe("4. договор перед проведением — варианты прямо в сообщении", () => {
  const store = () => {
    const s = baseStore();
    s[SALE] = [
      {
        Ref_Key: SALE_DOC,
        Number: "00000000018",
        Date: "2026-10-08T15:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        ДоговорКонтрагента_Key: "00000000-0000-0000-0000-000000000000",
        СуммаДокумента: 1000,
        Услуги: [],
      },
    ];
    return s;
  };

  it("dry-run post_document: в notes — договоры контрагента (ref + название)", async () => {
    const res = await fake1C({ store: store() }).call("write.document.post_document", {
      entitySet: SALE,
      ref: SALE_DOC,
      post: true,
    });
    expect(res.isError, text(res)).toBeFalsy();
    const notes = (sc(res)["notes"] as string[]).join(" ");
    expect(notes).toContain("не заполнен договор");
    expect(notes).toContain(`«Договор б/н» (ref ${CONTRACT}, СПокупателем)`);
  });

  it("confirm: ошибка до вызова 1С, с вариантами и инструментом для исправления", async () => {
    const f = fake1C({ store: store() });
    const res = await f.call("write.document.post_document", {
      entitySet: SALE,
      ref: SALE_DOC,
      post: true,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`ref ${CONTRACT}`);
    expect(text(res)).toContain("write.document.update_document");
    expect(f.store[SALE]![0]!["Posted"]).toBe(false);
  });

  it("create_document без договора, договоров несколько — последний договор, contractAutoSelected", async () => {
    const s = baseStore();
    s[SALE] = [];
    s["Catalog_ДоговорыКонтрагентов"]!.push({
      ...s["Catalog_ДоговорыКонтрагентов"]![0]!,
      Ref_Key: CONTRACT_12,
      Description: "Договор № 12",
      ДатаДоговора: "2026-10-20T00:00:00",
    });
    const res = await fake1C({ store: s, entities: SALE_META }).call("write.document.create_document", {
      entitySet: SALE,
      fields: { Контрагент_Key: BUYER },
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["payload"]["ДоговорКонтрагента_Key"]).toBe(CONTRACT_12);
    expect(sc(res)["contractAutoSelected"]).toEqual({
      ref: CONTRACT_12,
      name: "Договор № 12",
      reason: "последний договор вида «С покупателем»",
      alternatives: [{ ref: CONTRACT, name: "Договор б/н" }],
    });
    expect((sc(res)["notes"] as string[]).join(" ")).toContain("можно сменить");
  });

  it("create_document: основной договор контрагента — он, с пометкой «основной договор»", async () => {
    const s = baseStore();
    s[SALE] = [];
    s["Catalog_ДоговорыКонтрагентов"]!.push({
      ...s["Catalog_ДоговорыКонтрагентов"]![0]!,
      Ref_Key: CONTRACT_12,
      Description: "Договор № 12",
      ДатаДоговора: "2026-10-20T00:00:00",
    });
    s["Catalog_Контрагенты"]![0]!["ОсновнойДоговорКонтрагента_Key"] = CONTRACT;
    const res = await fake1C({ store: s, entities: SALE_META }).call("write.document.create_document", {
      entitySet: SALE,
      fields: { Контрагент_Key: BUYER },
    });
    expect(sc(res)["payload"]["ДоговорКонтрагента_Key"]).toBe(CONTRACT);
    expect(sc(res)["contractAutoSelected"]).toMatchObject({ ref: CONTRACT, reason: "основной договор" });
  });
});

describe("5. составные поля: _Type дописывается сам", () => {
  const ROW = `${SALE}_Услуги`;
  const setup = (extra: Row = {}) => {
    const store = baseStore();
    store["Catalog_НоменклатурныеГруппы"] = [{ Ref_Key: GROUP, Description: "Услуги", DeletionMark: false }];
    store["ChartOfCharacteristicTypes_ВидыСубконтоТиповые"] = [
      { Ref_Key: KIND_GROUP, Description: "Номенклатурные группы" },
      { Ref_Key: KIND_NOM, Description: "Номенклатура" },
    ];
    store["ChartOfAccounts_Типовой"] = [
      {
        Ref_Key: ACC_6010,
        Code: "6010",
        ExtDimensionTypes: [
          { LineNumber: "1", ExtDimensionType_Key: KIND_NOM },
          { LineNumber: "2", ExtDimensionType_Key: KIND_GROUP },
        ],
      },
    ];
    store[SALE] = [
      {
        Ref_Key: SALE_DOC,
        Number: "00000000018",
        Date: "2026-10-08T15:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        ДоговорКонтрагента_Key: CONTRACT,
        СуммаДокумента: 1000,
        Товары: [],
        Услуги: [
          { LineNumber: "1", Номенклатура_Key: SERVICE, Количество: 1, Цена: 1000, Сумма: 1000, ...extra },
        ],
      },
    ];
    const subconto = [1, 2, 3].flatMap((n) => [`СубконтоДоходовБУ${n}`, `СубконтоДоходовБУ${n}_Type`]);
    return fake1C({
      store,
      entities: {
        ChartOfAccounts_Типовой: { properties: [{ name: "Ref_Key" }, { name: "Code" }] },
        [SALE]: {
          properties: [
            ...[
              "Ref_Key",
              "Number",
              "Date",
              "Posted",
              "DeletionMark",
              "Организация_Key",
              "Контрагент_Key",
            ].map((name) => ({ name, type: "Edm.String" })),
            { name: "ДоговорКонтрагента_Key", type: "Edm.Guid" },
            { name: "СуммаДокумента", type: "Edm.Double" },
            { name: "Услуги", type: `Collection(StandardODATA.${ROW}_RowType)` },
            { name: "Товары", type: `Collection(StandardODATA.${SALE}_Товары_RowType)` },
          ],
        },
        [ROW]: {
          properties: [
            "LineNumber",
            "Номенклатура_Key",
            "Количество",
            "Цена",
            "Сумма",
            "СчетДоходовБУ_Key",
            ...subconto,
          ].map((name) => ({ name, type: "Edm.String" })),
          navigations: [{ name: "СчетДоходовБУ", toType: "ChartOfAccounts_Типовой", collection: false }],
        },
      },
    });
  };

  it("update_document: СубконтоДоходовБУ2 по субконто счёта 6010 → _Type номенклатурной группы", async () => {
    const f = setup();
    const res = await f.call("write.document.update_document", {
      entitySet: SALE,
      ref: SALE_DOC,
      tables: {
        Услуги: [
          {
            Номенклатура_Key: SERVICE,
            Количество: 1,
            Цена: 1000,
            Сумма: 1000,
            СчетДоходовБУ_Key: ACC_6010,
            СубконтоДоходовБУ1: SERVICE,
            СубконтоДоходовБУ2: GROUP,
          },
        ],
      },
    });
    expect(res.isError, text(res)).toBeFalsy();
    const row = sc(res)["fields"]["Услуги"][0];
    expect(row["СубконтоДоходовБУ1_Type"]).toBe("StandardODATA.Catalog_Номенклатура");
    expect(row["СубконтоДоходовБУ2_Type"]).toBe("StandardODATA.Catalog_НоменклатурныеГруппы");
  });

  it("без счёта — тип по справочнику, где найден ref; ref нигде не найден — короткий список типов", async () => {
    const f = setup();
    const ok = await f.call("write.document.update_document", {
      entitySet: SALE,
      ref: SALE_DOC,
      tables: { Услуги: [{ Номенклатура_Key: SERVICE, СубконтоДоходовБУ1: GROUP }] },
    });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(sc(ok)["fields"]["Услуги"][0]["СубконтоДоходовБУ1_Type"]).toBe(
      "StandardODATA.Catalog_НоменклатурныеГруппы",
    );
    const bad = await f.call("write.document.update_document", {
      entitySet: SALE,
      ref: SALE_DOC,
      tables: { Услуги: [{ Номенклатура_Key: SERVICE, СубконтоДоходовБУ1: id(777) }] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("СубконтоДоходовБУ1_Type");
    expect(text(bad)).toContain("Допустимые типы: StandardODATA.Catalog_");
  });

  it("update_document_lines: явный слот СубконтоДоходовБУ2 без _Type — тип по субконто счёта строки", async () => {
    const f = setup({ СчетДоходовБУ_Key: ACC_6010 });
    const res = await f.call("write.document.update_document_lines", {
      entitySet: SALE,
      ref: SALE_DOC,
      analytics: [{ lineNumber: 1, subconto: { СубконтоДоходовБУ2: GROUP } }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)["fields"]["Услуги"][0]["СубконтоДоходовБУ2_Type"]).toBe(
      "StandardODATA.Catalog_НоменклатурныеГруппы",
    );
  });

  it("список типов в ошибке — первые 10 и «и ещё N»", () => {
    const items = Array.from({ length: 14 }, (_, i) => `T${i + 1}`);
    expect(shortList(items, 10, ", ")).toBe("T1, T2, T3, T4, T5, T6, T7, T8, T9, T10 и ещё 4");
    expect(shortList(["a", "b"])).toBe("a; b");
  });
});

describe("6. post_document без ref", () => {
  const store = () => {
    const s = baseStore();
    s[SALE] = [
      {
        Ref_Key: SALE_DOC,
        Number: "00000000018",
        Date: "2026-10-08T15:00:00",
        Posted: false,
        DeletionMark: false,
        Организация_Key: ORG,
        Контрагент_Key: BUYER,
        ДоговорКонтрагента_Key: CONTRACT,
        СуммаДокумента: 1000,
      },
    ];
    return s;
  };

  it("нет ни ref, ни номера — понятная подсказка, а не ошибка валидации MCP", async () => {
    const res = await fake1C({ store: store() }).call("write.document.post_document", { entitySet: SALE });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Укажите ref документа");
    expect(text(res)).toContain("read.document.search_documents");
  });

  it("номер + дата — документ находится, в предпросмотре его ref", async () => {
    const res = await fake1C({ store: store() }).call("write.document.post_document", {
      entitySet: SALE,
      number: "18",
      date: "2026-10-08",
      post: true,
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(sc(res)).toMatchObject({ dryRun: true, ref: SALE_DOC, foundByNumber: { date: "2026-10-08" } });
  });

  it("ref не GUID — подсказка передать номер в number", async () => {
    const res = await fake1C({ store: store() }).call("write.document.post_document", {
      entitySet: SALE,
      ref: "18",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("number");
  });
});

describe("7. неподдерживаемый документ — сразу подходящий путь", () => {
  it("Акт об оказании производственных услуг в базе РК → quick_sale / реализация (Услуги)", async () => {
    const res = await fake1C().call("write.document.create_document", {
      entitySet: "Document_АктОбОказанииПроизводственныхУслуг",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("write.sales.quick_sale");
    expect(text(res)).toContain("Document_РеализацияТоваровУслуг");
    // Вместо простыни из 70 документов — похожие и ссылка на полный список.
    expect(text(res)).toContain("read.system.capabilities");
    expect(text(res)).not.toContain("Document_ВедомостьНаВозвратПрочихВыплат");
  });
});

describe("8. ЭСФ и счёт-фактура полученный", () => {
  it("входящий номер СФ полученного не похож на номер ЭСФ — предупреждение с инструментом", async () => {
    const store = baseStore();
    store["Document_СчетФактураПолученный"] = [];
    const entities = docMeta("Document_СчетФактураПолученный", ["НомерВходящегоДокумента", "Поставщик_Key"]);
    const res = await fake1C({ store, entities }).call("write.document.create_document", {
      entitySet: "Document_СчетФактураПолученный",
      fields: { НомерВходящегоДокумента: "15" },
    });
    expect(res.isError, text(res)).toBeFalsy();
    const notes = (sc(res)["notes"] as string[]).join(" ");
    expect(notes).toMatch(/не похож на регистрационный номер ЭСФ/);
    expect(notes).toContain("read.esf.list_esf");

    const esf = await fake1C({ store, entities }).call("write.document.create_document", {
      entitySet: "Document_СчетФактураПолученный",
      fields: { НомерВходящегоДокумента: "ESF-990140000483-20261008-1234567-890" },
    });
    expect((sc(esf)["notes"] as string[]).join(" ")).not.toMatch(/регистрационный номер ЭСФ/);
  });

  it("описание create_draft говорит про статус «Черновик»", () => {
    expect(descriptions()["write.esf.create_draft"]).toContain("Статус — «Черновик»");
  });
});

describe("9. печать счёта: пустой исполнитель", () => {
  it("без исполнителя плейсхолдер «<Не указан>» не печатается", () => {
    expect(executorSignature(undefined)).toBeUndefined();
    expect(executorSignature("  ")).toBeUndefined();
    expect(executorSignature("<Не указан>")).toBeUndefined();
    expect(executorSignature("Иванов И. И.")).toBe("/Иванов И. И./");
  });
});
