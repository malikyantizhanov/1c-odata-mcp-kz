/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в тестах */
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { classifyEsf, indexNotices, lineTotals, periodOf } from "../src/tools/vat-notices.js";

/**
 * Извещения об отнесении в зачёт НДС. Данные — по образцу рабочей базы (структура, типы, знаки сумм),
 * идентификаторы, БИН и наименования обезличены.
 */
type Tool = { handler: (a: Record<string, unknown>, e: Record<string, unknown>) => Promise<CallToolResult> };
const toolsOf = (c: unknown): Record<string, Tool> =>
  (createServer({ db: () => c } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;
const call = async (c: unknown, t: string, a: Record<string, unknown> = {}) =>
  await toolsOf(c)[t]!.handler({ database: "default", ...a }, {});
const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>;
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

const NOTICE = "Document_ИзвещениеОбОтнесенииВЗачетНДС";
const ESF = "Document_ЭСФ";
const REG = "AccumulationRegister_ОбязательстваПоИзвещениямИСЭСФ";
const REG2 = "AccumulationRegister_ОбязательстваПоЗачетуИСЭСФ";
const RECEIPT = "Document_ПоступлениеТоваровУслуг";
const ORG = "00000000-0000-4000-8000-000000000001";
const CP = "00000000-0000-4000-8000-000000000002";
const g = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const N1 = g(101);
const N2 = g(102);
const N3 = g(103);
const NDEL = g(104);
const E = (i: number) => g(200 + i);
const P = (i: number) => g(300 + i);

const line = (esf: string, reg: string, over: Record<string, unknown> = {}) => ({
  LineNumber: "1",
  ПорядковыйНомер: "1",
  РегНомерЭСФ: reg,
  ТипЭСФ: "Обычный",
  ЭСФ_Key: esf,
  ДатаОтнесенияВЗачет: "2026-03-31T00:00:00",
  КварталОтнесенияВЗачет: "2026/1",
  ВалютаКод: "KZT",
  СуммаОборотаПоПриобретению: 100000,
  СуммаНДСВЗачет: 16000,
  ОборотБезНДС: 0,
  СуммаНДСНеВЗачет: 0,
  ...over,
});
const notice = (ref: string, over: Record<string, unknown>) => ({
  Ref_Key: ref,
  Number: "00000000001",
  Date: "2026-04-27T11:58:19",
  DeletionMark: false,
  Posted: true,
  Организация_Key: ORG,
  Идентификатор: "1000",
  РегистрационныйНомер: "ZT-000000000000-20260427-00000001",
  НомерИзвещения: "1",
  ПлательщикИдентификатор: "000000000000",
  ПлательщикНаименование: "ТОО Организация",
  ДатаПоступленияИзвещениеВСистему: "2026-04-27T14:01:12",
  Статус: "Подтверждено",
  Состояние: "Подтверждено",
  ТипСобытия: "Пользователь",
  ТипПодписи: "ЮридическоеЛицо",
  ПричинаАвтоматическогоИзвещения: "",
  Комментарий: "",
  СуммаОборотаПоПриобретению: 0,
  СуммаНДСПринятогоВЗачет: 0,
  ОборотБезНДСИлиСНДСНеВЗачет: 0,
  СуммаНДСНеВЗачет: 0,
  СтрокиИзвещения: [],
  ДетализацияДанныхИзвещения: [],
  Ошибки: [],
  ...over,
});
const esf = (i: number, over: Record<string, unknown> = {}) => ({
  Ref_Key: E(i),
  Number: String(i),
  Date: "2026-03-10T00:00:00",
  Posted: true,
  DeletionMark: false,
  Организация_Key: ORG,
  Контрагент_Key: CP,
  Направление: "Входящий",
  Статус: "Доставленный",
  Состояние: "ПринятОтПоставщика",
  Вид: "Обычный",
  ДатаОборота: "2026-03-05T00:00:00",
  РегистрационныйНомер: `ESF-000000000000-20260310-0000000${i}`,
  СвязанныйЭСФ_Key: "00000000-0000-0000-0000-000000000000",
  СвязанныйЭСФРегистрационныйНомер: "",
  СуммаДокумента: 116000,
  ...over,
});

// Извещение №1 (проведено): две строки, итоги шапки = сумма строк; детализация по поступлениям.
const n1 = notice(N1, {
  СуммаОборотаПоПриобретению: 150000.5,
  СуммаНДСПринятогоВЗачет: 24000.08,
  СтрокиИзвещения: [
    line(E(1), "ESF-000000000000-20260310-00000001", { ТипЭСФ: "Исправленный" }),
    line("00000000-0000-0000-0000-000000000000", "ESF-000000000000-20260310-00000002", {
      LineNumber: "2",
      СуммаОборотаПоПриобретению: 50000.5,
      СуммаНДСВЗачет: 8000.08,
    }),
  ],
  ДетализацияДанныхИзвещения: [
    {
      LineNumber: "1",
      ПервичныйДокумент: P(1),
      ПервичныйДокумент_Type: `StandardODATA.${RECEIPT}`,
      ЭСФ_Key: E(1),
      СуммаОборотаПоПриобретению: 100000,
      СуммаНДСВЗачет: 16000,
      ОборотБезНДС: 0,
      СуммаНДСНеВЗачет: 0,
    },
    {
      LineNumber: "2",
      ПервичныйДокумент: P(2),
      ПервичныйДокумент_Type: `StandardODATA.${RECEIPT}`,
      ЭСФ_Key: E(2),
      СуммаОборотаПоПриобретению: 50000.5,
      СуммаНДСВЗачет: 8000.08,
      ОборотБезНДС: 0,
      СуммаНДСНеВЗачет: 0,
    },
  ],
});
// Извещение №2 (не проведено): уменьшение — отрицательный зачёт, положительное «не в зачёт».
const n2 = notice(N2, {
  Number: "00000000002",
  НомерИзвещения: "2",
  Date: "2026-08-12T00:00:00",
  Posted: false,
  ТипПодписи: "УполномоченноеЛицо",
  СуммаОборотаПоПриобретению: -31034.49,
  СуммаНДСПринятогоВЗачет: -4965.51,
  ОборотБезНДСИлиСНДСНеВЗачет: 31034.49,
  СуммаНДСНеВЗачет: 4965.51,
  СтрокиИзвещения: [
    line(E(3), "ESF-000000000000-20260310-00000003", {
      КварталОтнесенияВЗачет: "2026/2",
      СуммаОборотаПоПриобретению: -31034.49,
      СуммаНДСВЗачет: -4965.51,
      ОборотБезНДС: 31034.49,
      СуммаНДСНеВЗачет: 4965.51,
    }),
  ],
});
// Извещение №3 (проведено) — с исправленным ЭСФ 8 вместо исходного 7.
const n3 = notice(N3, {
  Number: "00000000003",
  НомерИзвещения: "3",
  Date: "2026-08-17T00:00:00",
  СуммаОборотаПоПриобретению: 100000,
  СуммаНДСПринятогоВЗачет: 16000,
  СтрокиИзвещения: [line(E(8), "ESF-000000000000-20260310-00000008", { ТипЭСФ: "Исправленный" })],
});
// Помеченное на удаление — не учитывается (ЭСФ 4 в нём не считается отнесённым).
const nDel = notice(NDEL, {
  Number: "00000000009",
  НомерИзвещения: "9",
  DeletionMark: true,
  СтрокиИзвещения: [line(E(4), "ESF-000000000000-20260310-00000004")],
});

const esfRows = [
  esf(1, { Вид: "Исправленный" }), // в проведённом №1 по ЭСФ_Key
  esf(2), // в №1 только по рег. номеру (ЭСФ_Key в строке пуст)
  esf(3), // только в непроведённом №2
  esf(4), // в извещениях нет (удалённое не в счёт), остаток обязательств — не отнесён
  esf(5), // в извещениях нет и остатка нет — ЭСФ без НДС
  esf(6, { Статус: "Отозванный" }),
  esf(7), // заменён исправленным ЭСФ 8
  esf(8, { Вид: "Исправленный", СвязанныйЭСФ_Key: E(7) }),
  esf(9, { ДатаОборота: "2026-04-02T00:00:00" }), // другой квартал
];
const balance = [
  {
    Организация_Key: ORG,
    ЭСФ_Key: E(3),
    СуммаОборотаПоПриобретениюBalance: 31034.49,
    СуммаНДСBalance: 4965.51,
  },
  { Организация_Key: ORG, ЭСФ_Key: E(4), СуммаОборотаПоПриобретениюBalance: 100000, СуммаНДСBalance: 16000 },
  { Организация_Key: ORG, ЭСФ_Key: E(7), СуммаОборотаПоПриобретениюBalance: 100000, СуммаНДСBalance: 16000 },
];
const movements = Array.from({ length: 2 }, (_, i) => ({
  Recorder: N1,
  RecordType: "Expense",
  ЭСФ_Key: i ? E(2) : E(1),
  СуммаОборотаПоПриобретению: i ? 50000.5 : 100000,
  СуммаНДС: i ? 8000.08 : 16000,
}));

type Route = (path: string) => Array<Record<string, unknown>>;
function connection(routes: Record<string, Route>, opts: { noRegister?: boolean } = {}) {
  const sets = new Set(Object.keys(routes).map((k) => k.split("/")[0]!));
  sets.add("Catalog_Контрагенты");
  if (opts.noRegister) for (const s of [...sets]) if (s.startsWith(REG)) sets.delete(s);
  const calls: string[] = [];
  const route = (path: string) => {
    const p = decodeURIComponent(path);
    calls.push(p);
    const key = Object.keys(routes)
      .filter((k) => p.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? routes[key]!(p) : [];
  };
  return {
    calls,
    cfg: { name: "default" },
    behavior: { pageSize: 100, maxRows: 1000, analyticsMaxRows: 10000 },
    getMetadata: async () => ({ entities: new Map() }),
    available: async () => sets,
    client: {
      getEntity: async (path: string) => route(path)[0] ?? {},
      getCollection: async (path: string) => ({ value: route(path) }),
    },
  };
}
/** Отбор строк по ЭСФ/ДатаОборота/Ref_Key — как сделала бы 1С (для сверки и разбора). */
const esfRoute: Route = (p) => {
  if (p.includes("Вид eq 'Исправленный'")) return esfRows.filter((r) => r.Вид === "Исправленный");
  const refs = [...p.matchAll(/Ref_Key eq guid'([^']+)'/g)].map((m) => m[1]);
  if (refs.length) return esfRows.filter((r) => refs.includes(r.Ref_Key));
  const from = /ДатаОборота ge datetime'([^T]+)/.exec(p)?.[1] ?? "0000";
  const to = /ДатаОборота le datetime'([^T]+)/.exec(p)?.[1] ?? "9999";
  return esfRows.filter((r) => r.ДатаОборота.slice(0, 10) >= from && r.ДатаОборота.slice(0, 10) <= to);
};
const routes = (): Record<string, Route> => ({
  [NOTICE]: (p) => {
    if (p.startsWith(`${NOTICE}(guid'${N1}')`)) return [n1];
    if (p.startsWith(`${NOTICE}(guid'${N2}')`)) return [n2];
    const all = [n1, n2, n3, nDel];
    return p.includes("DeletionMark eq false") ? all.filter((n) => !n.DeletionMark) : all;
  },
  [ESF]: esfRoute,
  [RECEIPT]: () => [
    { Ref_Key: P(1), Number: "00000000028", Date: "2026-03-14T12:00:00", Posted: true },
    { Ref_Key: P(2), Number: "00000000003", Date: "2026-01-21T12:00:00", Posted: true },
  ],
  Catalog_Контрагенты: () => [{ Ref_Key: CP, Description: "ТОО Поставщик" }],
  [`${REG}/Balance`]: () => balance,
  [`${REG}_RecordType`]: () => movements,
  [`${REG2}_RecordType`]: () => movements,
});

describe("periodOf / lineTotals / indexNotices", () => {
  it("квартал «ГГГГ/К» и варианты записи", () => {
    expect(periodOf("2026/1", undefined, undefined)).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
      quarter: "2026/1",
    });
    expect(periodOf("2026-Q2", undefined, undefined).to).toBe("2026-06-30");
    expect(periodOf("2024/1", undefined, undefined).to).toBe("2024-03-31");
    expect(periodOf(undefined, "2026-01-01", "2026-02-15")).toEqual({ from: "2026-01-01", to: "2026-02-15" });
    expect(() => periodOf("2026/5", undefined, undefined)).toThrow(/ГГГГ\/К/);
    expect(() => periodOf(undefined, undefined, undefined)).toThrow(/quarter/);
  });

  it("итоги строк в копейках без ошибок округления; отрицательные суммы сохраняются", () => {
    expect(lineTotals(n1.СтрокиИзвещения)).toEqual({
      turnover: 150000.5,
      vatOffset: 24000.08,
      turnoverNotOffset: 0,
      vatNotOffset: 0,
    });
    expect(lineTotals(n2.СтрокиИзвещения)).toEqual({
      turnover: -31034.49,
      vatOffset: -4965.51,
      turnoverNotOffset: 31034.49,
      vatNotOffset: 4965.51,
    });
  });

  it("индекс извещений: по ЭСФ_Key и рег. номеру, удалённые пропускаются", () => {
    const { byKey, byReg } = indexNotices([n1, n2, nDel]);
    expect(byKey.get(E(1))?.[0]).toMatchObject({ noticeNumber: "1", posted: true, matchedBy: "ЭСФ_Key" });
    expect(byKey.has("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(byReg.get("ESF-000000000000-20260310-00000002")?.[0]?.matchedBy).toBe("РегНомерЭСФ");
    expect(byKey.get(E(3))?.[0]?.posted).toBe(false);
    expect(byKey.has(E(4))).toBe(false);
  });
});

describe("classifyEsf", () => {
  const base = { ref: E(1), number: "1", date: "2026-03-10", posted: true, amount: 1 };
  const use = { noticeRef: N1, noticeNumber: "1", noticeDate: "", vatOffset: 1, vatNotOffset: 0 };
  it("статусы и замена исправленным — excluded", () => {
    expect(
      classifyEsf({ ...base, status: "Аннулированный" }, { uses: [], registerKnown: true }).verdict,
    ).toBe("excluded");
    expect(classifyEsf({ ...base, status: "Отозванный" }, { uses: [], registerKnown: true }).verdict).toBe(
      "excluded",
    );
    expect(classifyEsf(base, { uses: [], supersededBy: "ESF-X", registerKnown: true }).reason).toMatch(
      /исправленным ЭСФ ESF-X/,
    );
  });
  it("в проведённом / только в непроведённом извещении", () => {
    const posted = { ...use, posted: true, matchedBy: "ЭСФ_Key" as const };
    const draft = { ...use, posted: false, matchedBy: "ЭСФ_Key" as const };
    expect(classifyEsf(base, { uses: [draft, posted], registerKnown: true }).verdict).toBe("offset");
    expect(classifyEsf(base, { uses: [draft], registerKnown: true }).verdict).toBe("inUnpostedNotice");
  });
  it("без извещения: остаток обязательств → unoffset, нет остатка → noObligation, нет регистра → unoffset", () => {
    expect(
      classifyEsf(base, { uses: [], balance: { turnover: 100, vat: 16 }, registerKnown: true }).verdict,
    ).toBe("unoffset");
    expect(classifyEsf(base, { uses: [], registerKnown: true }).verdict).toBe("noObligation");
    expect(classifyEsf({ ...base, posted: false }, { uses: [], registerKnown: true }).reason).toMatch(
      /не проведён/,
    );
    expect(classifyEsf(base, { uses: [], registerKnown: false }).reason).toMatch(/не опубликован/);
  });
});

describe("read.vat.* — инструменты", () => {
  it("документа нет в конфигурации — понятный ответ, без запросов к документу", async () => {
    const c = connection({ [ESF]: esfRoute });
    for (const [t, a] of [
      ["read.vat.list_offset_notices", {}],
      ["read.vat.get_offset_notice", { number: "1" }],
      ["read.vat.find_unoffset_esf", { quarter: "2026/1" }],
    ] as const) {
      const r = await call(c, t, a);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/В этой версии 1С документа «Извещение об отнесении в зачёт НДС» нет/);
    }
    expect(c.calls.some((p) => p.startsWith(NOTICE))).toBe(false);
  });

  it("list_offset_notices: шапки, итоги, строки, кварталы; удалённые скрыты", async () => {
    const c = connection(routes());
    const r = sc(await call(c, "read.vat.list_offset_notices", { from: "2026-01-01", to: "2026-12-31" }));
    expect(r.count).toBe(3);
    expect(r.notPosted).toBe(1);
    const first = r.notices.find((n: any) => n.ref === N1);
    expect(first).toMatchObject({
      number: "00000000001",
      noticeNumber: "1",
      registrationNumber: "ZT-000000000000-20260427-00000001",
      status: "Подтверждено",
      state: "Подтверждено",
      eventType: "Пользователь",
      posted: true,
      deletionMark: false,
      lines: 2,
      errors: 0,
      quarters: ["2026/1"],
      totals: { turnover: 150000.5, vatOffset: 24000.08 },
    });
    expect(r.totals.vatOffset).toBe(35034.57); // 24000.08 − 4965.51 + 16000
    expect(r.totals.vatNotOffset).toBe(4965.51);
    const q = c.calls.find((p) => p.startsWith(NOTICE))!;
    expect(q).toContain("DeletionMark eq false");
    expect(q).toContain("Date ge datetime'2026-01-01T00:00:00'");
    expect(q).not.toContain("ЭЦП");
  });

  it("get_offset_notice: строки с найденным ЭСФ, детализация с поступлением, сверка итогов, движения", async () => {
    const r = sc(await call(connection(routes()), "read.vat.get_offset_notice", { ref: N1 }));
    expect(r.totalsMatch).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({
      registrationNumber: "ESF-000000000000-20260310-00000001",
      esfType: "Исправленный",
      quarter: "2026/1",
      offsetDate: "2026-03-31",
      vatOffset: 16000,
      esf: { found: true, number: "1", date: "2026-03-10", counterparty: "ТОО Поставщик" },
    });
    expect(r.lines[1].esf).toBeUndefined(); // ЭСФ_Key пуст — только рег. номер
    expect(r.details[0].primaryDocument).toMatchObject({
      type: RECEIPT,
      number: "00000000028",
      date: "2026-03-14",
      posted: true,
    });
    expect(r.movements).toEqual([
      { register: REG, records: 2, recordTypes: ["Expense"], turnover: 150000.5, vat: 24000.08 },
      { register: REG2, records: 2, recordTypes: ["Expense"], turnover: 150000.5, vat: 24000.08 },
    ]);
    expect(r.notes).toEqual([]);
  });

  it("get_offset_notice: непроведённое с отрицательными суммами — заметки, без движений", async () => {
    const r = sc(await call(connection(routes()), "read.vat.get_offset_notice", { ref: N2 }));
    expect(r.notice.posted).toBe(false);
    expect(r.movements).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/Отрицательные суммы/);
    expect(r.notes.join(" ")).toMatch(/не проведено/);
  });

  it("get_offset_notice по номеру: несколько совпадений — просит ref или year", async () => {
    const r = await call(connection(routes()), "read.vat.get_offset_notice", { number: "1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/несколько извещений/);
  });

  it("find_unoffset_esf: группы, исключения, исправленные, удалённое извещение не в счёт", async () => {
    const c = connection(routes());
    const r = sc(await call(c, "read.vat.find_unoffset_esf", { quarter: "2026/1", includeOffset: true }));
    expect(r.period).toEqual({ from: "2026-01-01", to: "2026-03-31", quarter: "2026/1" });
    expect(r.summary).toEqual({
      checked: 8,
      unoffset: 1,
      unoffsetTurnover: 100000,
      unoffsetVat: 16000,
      inUnpostedNotice: 1,
      noObligation: 1,
      offset: 3,
      excluded: 2,
    });
    expect(r.unoffset[0]).toMatchObject({
      ref: E(4),
      counterparty: "ТОО Поставщик",
      obligation: { vat: 16000 },
    });
    expect(r.inUnpostedNotice[0]).toMatchObject({ ref: E(3), notices: [{ number: "2", posted: false }] });
    expect(r.noObligation[0].ref).toBe(E(5));
    expect(r.excluded.map((x: any) => x.ref).sort()).toEqual([E(6), E(7)]);
    expect(r.excluded.find((x: any) => x.ref === E(7)).reason).toMatch(/исправленным/);
    expect(r.offset.find((x: any) => x.ref === E(2)).notices[0].matchedBy).toBe("РегНомерЭСФ");
    const q = c.calls.find((p) => p.startsWith(ESF) && p.includes("ДатаОборота"))!;
    expect(q).toContain("Направление eq 'Входящий'");
    expect(q).toContain("DeletionMark eq false");
  });

  it("find_unoffset_esf без регистра обязательств: все без извещения — unoffset с заметкой", async () => {
    const r = sc(
      await call(connection(routes(), { noRegister: true }), "read.vat.find_unoffset_esf", {
        from: "2026-01-01",
        to: "2026-03-31",
      }),
    );
    expect(r.sources.obligationRegister).toBe(false);
    expect(r.summary.unoffset).toBe(2); // ЭСФ 4 и 5
    expect(r.summary.unoffsetVat).toBe(0);
    expect(r.notes.join(" ")).toMatch(/не опубликован/);
  });
});
