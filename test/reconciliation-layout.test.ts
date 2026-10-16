import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReconciliationPdf, type ReconciliationData } from "../src/print/reconciliation-pdf.js";

/**
 * Раскладка подписного блока акта сверки: длинное наименование переносится, строки БИН/«М.П.» уходят вниз и ничего
 * не перекрывается. Геометрию слов берём из pdftotext -bbox (poppler); без него тесты раскладки пропускаются.
 */
const hasPoppler = spawnSync("pdftotext", ["-v"]).status !== null;

interface Word {
  page: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
function words(pdf: Buffer): Word[] {
  const dir = mkdtempSync(join(tmpdir(), "act-layout-"));
  try {
    const file = join(dir, "a.pdf");
    writeFileSync(file, pdf);
    const html = execFileSync("pdftotext", ["-bbox", file, "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
    const out: Word[] = [];
    let page = 0;
    for (const line of html.split("\n")) {
      if (line.includes("<page ")) page++;
      const m = line.match(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*)<\/word>/);
      if (m) out.push({ page, text: m[5]!, x0: +m[1]!, y0: +m[2]!, x1: +m[3]!, y1: +m[4]! });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** Пары слов на одной странице, у которых прямоугольники заметно пересекаются (наезд строк). */
function overlaps(ws: Word[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i]!;
      const b = ws[j]!;
      if (a.page !== b.page) continue;
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (w > 0.8 && h > 1.5) bad.push(`${a.text} × ${b.text} (стр. ${a.page})`);
    }
  return bad;
}

const base = (name: string, cpName: string): ReconciliationData => ({
  number: "2",
  date: "2026-10-09",
  periodEnd: "2026-09-30",
  organization: { name, id: "ИИН: 123123123123" },
  counterparty: { name: cpName, id: "БИН: 170640024256" },
  contract: "Договор б/н",
  currency: "KZT",
  opening: 0,
  organizationRows: [
    { date: "2026-09-10", document: "Реализация ТМЗ и услуг 19 от 10.09.2026", debit: 1000, credit: 0 },
  ],
  counterpartyRows: [],
  agreed: false,
  amountWords: "Одна тысяча теңге 00 тиын",
});
const SHORT = 'Индивидуальный предприниматель "Aru Market"';
const LONG =
  'Товарищество с ограниченной ответственностью "Almaty Motors Premium Trading and Logistics Central Asia"';
const HUGE =
  'Товарищество с ограниченной ответственностью "Международная производственно-торговая компания по ' +
  'поставкам оборудования, запасных частей и комплектующих для горнодобывающей промышленности Центральной Азии"';

describe.skipIf(!hasPoppler)("акт сверки: подписной блок без наезда строк", () => {
  it("короткие наименования — перекрытий нет", async () => {
    const ws = words(await renderReconciliationPdf(base(SHORT, 'ТОО "TRADESPACE"')));
    expect(overlaps(ws)).toEqual([]);
  });

  it.each([
    ["длинное наименование контрагента", SHORT, LONG],
    ["длинные наименования обеих сторон", LONG, HUGE],
  ])("%s — переносится, строки не перекрываются, БИН ниже «От …»", async (_n, org, cp) => {
    const ws = words(await renderReconciliationPdf(base(org, cp)));
    expect(overlaps(ws)).toEqual([]);
    const bin = ws.find((w) => w.text === "170640024256")!;
    const names = ws.filter((w) => w.page === bin.page && w.x0 > 320 && w.y0 > bin.y0 - 60 && w.y0 < bin.y0);
    expect(names.length).toBeGreaterThan(0);
    // БИН начинается ниже самой нижней строки наименования.
    expect(bin.y0).toBeGreaterThanOrEqual(Math.max(...names.map((w) => w.y1)) - 0.5);
    // «М.П.» ниже БИН и ниже «Сальдо…» таблицы.
    const mp = ws.filter((w) => w.text === "М.П.");
    expect(mp.length).toBe(2);
    expect(Math.min(...mp.map((w) => w.y0))).toBeGreaterThan(bin.y1);
  });

  it("блок итога и подписей не рвётся: при нехватке места целиком уходит на новую страницу", async () => {
    const d = base(LONG, HUGE);
    // подбираем число строк так, чтобы таблица закончилась у самого низа первой страницы
    let moved = 0;
    for (let n = 30; n <= 60; n++) {
      const rows = Array.from({ length: n }, () => d.organizationRows[0]!);
      const ws = words(await renderReconciliationPdf({ ...d, organizationRows: rows }));
      expect(overlaps(ws)).toEqual([]);
      const from = ws.find((w) => w.text === "задолженность" && w.y0 > 0)!;
      const mp = ws.filter((w) => w.text === "М.П.");
      const ot = ws.filter((w) => w.text === "От");
      // «По данным … задолженность», обе «От …» и обе «М.П.» всегда на одной странице.
      const pages = new Set([...mp, ...ot, from].map((w) => w.page));
      expect(pages.size).toBe(1);
      if ([...pages][0]! > 1 && ws.some((w) => w.page === 1 && w.text === "Сальдо")) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  }, 120_000);
});
