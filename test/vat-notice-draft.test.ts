/* eslint-disable @typescript-eslint/no-explicit-any -- разбор structuredContent в тестах */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildNoticeRows,
  NOTICE_EXCHANGE_FIELDS,
  type DraftCandidate,
} from "../src/tools/vat-notice-draft.js";
import { baseStore, fake1C, id, ORG, type Row } from "./support/fake-1c.js";

/**
 * Черновик извещения об отнесении в зачёт НДС. Образец — проведённое извещение №1 рабочей базы (12 ЭСФ, 12
 * поступлений, 29 строк прихода по ставкам в регистре «Обязательства по зачёту ИС ЭСФ»): суммы, типы ЭСФ и
 * квартал — как в базе; идентификаторы, БИН, номера и наименования обезличены (test/fixtures/vat-notice-1.json).
 */
type Fx = {
  organization: string;
  quarter: string;
  esf: Row[];
  links: Array<{ ЭСФ_Key: string; ПервичныйДокумент: string; ПервичныйДокумент_Type: string }>;
  esfObligations: Row[];
  receiptMovements: Row[];
  expected: { lines: Row[]; details: Row[]; totals: Record<string, number> };
};
const raw = JSON.parse(readFileSync(new URL("./fixtures/vat-notice-1.json", import.meta.url), "utf8")) as Fx;
const fx = JSON.parse(JSON.stringify(raw).split(raw.organization).join(ORG)) as Fx;

const NOTICE = "Document_ИзвещениеОбОтнесенииВЗачетНДС";
const ESF = "Document_ЭСФ";
const REG = "AccumulationRegister_ОбязательстваПоИзвещениямИСЭСФ";
const REG2 = "AccumulationRegister_ОбязательстваПоЗачетуИСЭСФ";
const LINKS = "InformationRegister_АктуальныеЭСФПоПервичнымДокументам";
const RECEIPT = "Document_ПоступлениеТоваровУслуг";
const cents = (v: unknown) => Math.round(Number(v) * 100);
const byEsf = (a: Row, b: Row) => String(a["ЭСФ_Key"]).localeCompare(String(b["ЭСФ_Key"]));
const byDoc = (a: Row, b: Row) =>
  String(a["ПервичныйДокумент"]).localeCompare(String(b["ПервичныйДокумент"]));
const strip = (r: Row) =>
  Object.fromEntries(
    Object.entries(r).filter(([k]) => !["LineNumber", "ПорядковыйНомер", "Валюта_Key"].includes(k)),
  );

const candidates = (): DraftCandidate[] =>
  fx.esf.map((e) => {
    const b = fx.esfObligations.find((o) => o["ЭСФ_Key"] === e["Ref_Key"])!;
    return {
      ref: String(e["Ref_Key"]),
      number: String(e["Number"]),
      registrationNumber: String(e["РегистрационныйНомер"]),
      kind: String(e["Вид"]),
      currencyCode: "KZT",
      balance: { turnover: cents(b["СуммаОборотаПоПриобретениюBalance"]), vat: cents(b["СуммаНДСBalance"]) },
    };
  });
const links = () => fx.links.map((l) => ({ esfRef: l.ЭСФ_Key, ref: l.ПервичныйДокумент, type: RECEIPT }));
const balances = () =>
  fx.receiptMovements.map((m) => ({
    receiptRef: String(m["ДокументПоступления"]),
    type: RECEIPT,
    period: String(m["НалоговыйПериод"]).slice(0, 10),
    turnover: cents(m["СуммаОборотаПоПриобретению"]),
    vat: cents(m["СуммаНДС"]),
    turnoverNoVat: cents(m["СуммаОборотаБезНДС"]),
    vatNotOffset: cents(m["СуммаНДСНеВЗачет"]),
  }));

describe("buildNoticeRows — как извещение №1, сформированное в 1С", () => {
  it("12 строк и 12 строк детализации совпадают с образцом; итоги 5 945 664,15 / 951 306,25", () => {
    const r = buildNoticeRows({
      quarter: "2026/1",
      offsetDate: "2026-03-31",
      candidates: candidates(),
      links: links(),
      receiptBalances: balances(),
    });
    expect(r.warnings).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.lines.map(strip).sort(byEsf)).toEqual([...fx.expected.lines].sort(byEsf));
    expect(r.details.map(strip).sort(byDoc)).toEqual([...fx.expected.details].sort(byDoc));
    expect(r.totals).toEqual(fx.expected.totals);
    expect(r.totals).toEqual({
      turnover: 5945664.15,
      vatOffset: 951306.25,
      turnoverNotOffset: 0,
      vatNotOffset: 0,
    });
    expect(r.lines.map((l) => l["LineNumber"])).toEqual(r.lines.map((_, i) => i + 1));
    expect(r.lines.map((l) => l["ПорядковыйНомер"])).toEqual(r.lines.map((_, i) => i + 1));
    for (const l of r.lines)
      for (const k of Object.keys(l)) expect(NOTICE_EXCHANGE_FIELDS.has(k)).toBe(false);
  });

  it("поступление с несколькими ЭСФ, остаток за другой период, нет остатка — предупреждения; строка остаётся", () => {
    const c = candidates().slice(0, 3);
    const l = links().filter((x) => c.some((y) => y.ref === x.esfRef));
    const shared = { ...l[0]!, esfRef: c[1]!.ref };
    const b = [
      ...balances().map((x) => (x.receiptRef === l[2]!.ref ? { ...x, period: "2026-06-30" } : x)),
      // лишний приход по поступлению ЭСФ 2 — детализация расходится с остатком по ЭСФ
      {
        receiptRef: l[1]!.ref,
        type: RECEIPT,
        period: "2026-03-31",
        turnover: 10000,
        vat: 1600,
        turnoverNoVat: 0,
        vatNotOffset: 0,
      },
    ];
    const r = buildNoticeRows({
      quarter: "2026/1",
      offsetDate: "2026-03-31",
      candidates: c,
      links: [...l, shared],
      receiptBalances: b,
    });
    expect(r.lines).toHaveLength(3);
    expect(r.details).toHaveLength(0 + 1); // только у ЭСФ 2 его собственное поступление
    const w = r.warnings.join("\n");
    expect(w).toMatch(/связано с несколькими ЭСФ/);
    expect(w).toMatch(/за другой налоговый период \(2026-06-30\)/);
    expect(w).toMatch(/строка без детализации/);
    expect(w).toMatch(/не совпадает с остатком по ЭСФ/);
  });

  it("без рег. номера и с неположительным остатком — пропуск с причиной", () => {
    const [a, b, c] = candidates();
    const r = buildNoticeRows({
      quarter: "2026/1",
      offsetDate: "2026-03-31",
      candidates: [
        { ...a!, registrationNumber: undefined },
        { ...b!, balance: { turnover: -100, vat: -16 } },
        c!,
      ],
      links: links(),
      receiptBalances: balances(),
    });
    expect(r.lines).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason).join(" ")).toMatch(
      /нет регистрационного номера.*не положительный/s,
    );
  });

  it("регистр по поступлениям не опубликован — строки без детализации и без лишних предупреждений", () => {
    const r = buildNoticeRows({
      quarter: "2026/1",
      offsetDate: "2026-03-31",
      candidates: candidates(),
      links: links(),
      receiptBalances: undefined,
    });
    expect(r.lines).toHaveLength(12);
    expect(r.details).toHaveLength(0);
    expect(r.totals.vatOffset).toBe(951306.25);
  });
});

// ───────────── Инструмент: подбор как в find_unoffset_esf, dry-run, гард записи ─────────────

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

/** Непроведённое извещение (загруженное из ИС ЭСФ) с ЭСФ №1 образца — этот ЭСФ в черновик не попадает. */
const unposted = (): Row => ({
  Ref_Key: id(501),
  Number: "00000000002",
  Date: "2026-04-10T00:00:00",
  DeletionMark: false,
  Posted: false,
  Организация_Key: ORG,
  НомерИзвещения: "2",
  СтрокиИзвещения: [
    { ЭСФ_Key: fx.esf[0]!["Ref_Key"], РегНомерЭСФ: fx.esf[0]!["РегистрационныйНомер"], СуммаНДСВЗачет: 1 },
  ],
});
function make(
  o: { readOnly?: boolean; writable?: boolean; noNotice?: boolean; noReg?: boolean; notices?: Row[] } = {},
) {
  const store = baseStore();
  return fake1C({
    ...(o.readOnly ? { readOnly: true } : {}),
    ...(o.writable !== undefined ? { writable: o.writable } : {}),
    store: {
      ...store,
      ...(o.noNotice
        ? {}
        : {
            [NOTICE]: o.notices ?? [
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
          }),
      [ESF]: fx.esf.map((e) => ({ ...e })),
      ...(o.noReg ? {} : { [REG]: [], [`${REG}/Balance`]: fx.esfObligations.map((b) => ({ ...b })) }),
      [REG2]: [],
      [`${REG2}/Balance`]: fx.receiptMovements.map((m) => ({
        Организация_Key: m["Организация_Key"],
        ДокументПоступления: m["ДокументПоступления"],
        ДокументПоступления_Type: m["ДокументПоступления_Type"],
        НалоговыйПериод: m["НалоговыйПериод"],
        СуммаОборотаПоПриобретениюBalance: m["СуммаОборотаПоПриобретению"],
        СуммаНДСBalance: m["СуммаНДС"],
        СуммаОборотаБезНДСBalance: m["СуммаОборотаБезНДС"],
        СуммаНДСНеВЗачетBalance: m["СуммаНДСНеВЗачет"],
      })),
      [LINKS]: fx.links.map((l) => ({ ...l })),
      [RECEIPT]: fx.links.map((l, i) => ({
        Ref_Key: l.ПервичныйДокумент,
        Number: String(i + 10).padStart(11, "0"),
        Date: "2026-03-14T12:00:00",
        Posted: true,
      })),
    },
    entities: o.noNotice ? {} : { [NOTICE]: { properties: NOTICE_PROPS } },
  });
}
const sc = (r: any) => r.structuredContent as Record<string, any>;
const text = (r: any) => (r.content[0] as { text: string }).text;
const TOOL = "write.vat.create_offset_notice_draft";

describe("write.vat.create_offset_notice_draft", () => {
  it("dry-run за 2026/1: шапка, 12 строк, детализация, итоги; поля обмена с ИС не заполнены; ничего не записано", async () => {
    const f = make();
    const r = sc(await f.call(TOOL, { quarter: "2026/1" }));
    expect(r.dryRun).toBe(true);
    expect(r.willCreate).toBe(NOTICE);
    const p = r.payload;
    expect(p).toMatchObject({
      Number: "00000000002",
      Организация_Key: ORG,
      Плательщик_Key: ORG,
      ПлательщикИдентификатор: "123123123123",
      ПлательщикНаименование: "ИП Aru Market",
      ТипСобытия: "Пользователь",
      СуммаОборотаПоПриобретению: 5945664.15,
      СуммаНДСПринятогоВЗачет: 951306.25,
      ОборотБезНДСИлиСНДСНеВЗачет: 0,
      СуммаНДСНеВЗачет: 0,
    });
    for (const k of NOTICE_EXCHANGE_FIELDS) expect(p).not.toHaveProperty(k);
    expect(p.СтрокиИзвещения).toHaveLength(12);
    expect(p.ДетализацияДанныхИзвещения).toHaveLength(12);
    expect(p.СтрокиИзвещения.map(strip).sort(byEsf)).toEqual([...fx.expected.lines].sort(byEsf));
    expect(r.preview.reconciliation).toMatchObject({ checked: 12, unoffset: 12 });
    expect(r.preview.details[0].primaryDocument.number).toMatch(/^\d+$/);
    expect(r.preview.posting).toMatch(/Не проводится/);
    expect(r.notes.join(" ")).toMatch(/не проведён и не отправлен/);
    expect(f.posts).toHaveLength(0);
    expect(f.actions).toHaveLength(0);
  });

  it("ЭСФ из непроведённого извещения не берётся; по поставщику и списку ЭСФ — отбор и пропуски с причиной", async () => {
    const f = make({ notices: [unposted()] });
    const r = sc(await f.call(TOOL, { quarter: "2026/1" }));
    expect(r.payload.СтрокиИзвещения).toHaveLength(11);
    expect(r.notes.join(" ")).toMatch(/1 ЭСФ квартала уже есть в непроведённых извещениях/);
    expect(r.payload.Number).toBe("00000000003");
    const one = String(fx.esf[3]!["Ref_Key"]);
    const r2 = sc(
      await f.call(TOOL, { quarter: "2026/1", esfRefs: [one, String(fx.esf[0]!["Ref_Key"]), id(777)] }),
    );
    expect(r2.payload.СтрокиИзвещения.map((l: Row) => l["ЭСФ_Key"])).toEqual([one]);
    expect(r2.preview.skipped).toHaveLength(2);
    expect(r2.preview.skipped.find((s: any) => s.verdict === "inUnpostedNotice").reason).toMatch(
      /непроведённом/,
    );
    const cp = String(fx.esf[3]!["Контрагент_Key"]);
    const r3 = sc(await f.call(TOOL, { quarter: "2026/1", counterpartyRef: cp }));
    expect(
      r3.payload.СтрокиИзвещения.every(
        (l: Row) => fx.esf.find((e) => e["Ref_Key"] === l["ЭСФ_Key"])!["Контрагент_Key"] === cp,
      ),
    ).toBe(true);
  });

  it("номер вручную: занятый — отказ", async () => {
    const r = await make().call(TOOL, { quarter: "2026/1", number: "00000000001" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/уже занят/);
  });

  it("нечего относить — понятный отказ; нет документа или регистра — отказ без записи", async () => {
    const none = await make().call(TOOL, { quarter: "2026/2" });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/нет входящих ЭСФ, которые 1С ждёт в извещении/);
    const noDoc = await make({ noNotice: true }).call(TOOL, { quarter: "2026/1" });
    expect(text(noDoc)).toMatch(/документа «Извещение об отнесении в зачёт НДС» нет/);
    const noReg = await make({ noReg: true }).call(TOOL, { quarter: "2026/1" });
    expect(text(noReg)).toMatch(/не опубликован/);
  });

  it("confirm без operationId — отказ; с operationId — один POST без поля Posted; READ_ONLY — запись запрещена", async () => {
    const f = make();
    const noOp = await f.call(TOOL, { quarter: "2026/1", confirm: true });
    expect(noOp.isError).toBe(true);
    const dry = sc(await f.call(TOOL, { quarter: "2026/1" }));
    const done = sc(await f.call(TOOL, { quarter: "2026/1", confirm: true, operationId: dry.operationId }));
    expect(done.created).toBe(true);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.set).toBe(NOTICE);
    expect(f.posts[0]!.body).not.toHaveProperty("Posted");
    expect(f.actions).toEqual([]); // не проводится
    const ro = make({ readOnly: true });
    const roDry = sc(await ro.call(TOOL, { quarter: "2026/1" }));
    expect(roDry.dryRun).toBe(true);
    const roDo = await ro.call(TOOL, { quarter: "2026/1", confirm: true, operationId: roDry.operationId });
    expect(roDo.isError).toBe(true);
    expect(text(roDo)).toMatch(/READ_ONLY/);
    expect(ro.posts).toHaveLength(0);
  });
});
