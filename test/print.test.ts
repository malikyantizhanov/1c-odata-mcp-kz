import { afterAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { amountInWords, numberToWords } from "../src/print/amount-words.js";
import {
  beneficiaryId,
  dateWords,
  money,
  partyText,
  quantity,
  renderInvoicePdf,
} from "../src/print/invoice-pdf.js";
import { bankCity, bankTitle, invoicePrintData, sameDocNumber } from "../src/tools/print.js";
import { isInside, resolvePrintDir, safeFileName, saveUnique } from "../src/print/save.js";

const EMPTY_REF = "00000000-0000-4000-8000-000000000001";
const tmpRoots: string[] = [];
const tmp = () => {
  // realpath: на macOS tmpdir() — ссылка /var → /private/var, а сохранение возвращает реальный путь каталога.
  const d = realpathSync(mkdtempSync(join(tmpdir(), "1c-print-test-")));
  tmpRoots.push(d);
  return d;
};
afterAll(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Печать счёта на оплату (Казахстан): форматы как в печатной форме 1С, PDF и сбор данных документа.
 * Сетка макета сверена с PDF, который сформировала 1С: все строки текста совпадают в пределах 1,2 pt.
 */
type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

describe("сумма прописью", () => {
  it.each([
    [0, "ноль"],
    [1, "один"],
    [12, "двенадцать"],
    [1001, "одна тысяча один"],
    [2000, "две тысячи"],
    [5000, "пять тысяч"],
    [11000000, "одиннадцать миллионов"],
    [1550000, "один миллион пятьсот пятьдесят тысяч"],
  ])("%d → %s", (n, words) => expect(numberToWords(n)).toBe(words));

  it("тенге и тиын", () => {
    expect(amountInWords(15000)).toBe("Пятнадцать тысяч тенге 00 тиын");
    expect(amountInWords(1229600.5)).toBe("Один миллион двести двадцать девять тысяч шестьсот тенге 50 тиын");
  });
});

describe("форматы печатной формы 1С", () => {
  it("суммы, количество, дата, стороны и банк — как печатает 1С", () => {
    expect(money(1550000)).toBe("1 550 000,00");
    expect(quantity(1)).toBe("1,000");
    expect(quantity(2.5)).toBe("2,500");
    expect(dateWords("2026-10-07")).toBe("7 октября 2026 г.");
    expect(partyText("ТОО Mybuh.kz", "170240009787")).toBe(" БИН / ИИН 170240009787,ТОО Mybuh.kz");
    expect(partyText("Иванов И.И.")).toBe("Иванов И.И.");
    expect(bankTitle('АО "Народный Банк Казахстана"', "г. Алматы")).toBe(
      'АО "Народный Банк Казахстана" г. Алматы',
    );
  });

  it.each([
    ["г.Алматы", "Алматы"],
    ["г. Алматы", "Алматы"],
    ["Алматы", "Алматы"],
    ["Г. Алматы", "Алматы"],
    ["  г.  Алматы ", "Алматы"],
    ["г Алматы", "Алматы"],
    ["гор. Астана", "Астана"],
    ["город Шымкент", "Шымкент"],
    ["г.\u00a0Алматы", "Алматы"],
    ["Гродно", "Гродно"],
    ["Горно-Алтайск", "Горно-Алтайск"],
    ["", ""],
  ])("город банка «%s» → «%s» (без удвоенного «г.»)", (city, want) => {
    expect(bankCity(city)).toBe(want);
    expect(bankTitle("АО Банк", city)).toBe(want ? `АО Банк г. ${want}` : "АО Банк");
  });
});

describe("сверка с печатной формой 1С (ManagerModule/ОбщегоНазначенияБК)", () => {
  it("номер организации в образце платёжки: ИП (ФизЛицо) — «ИИН:», юрлицо — «БИН:»", () => {
    expect(beneficiaryId("123123123123", true)).toBe("ИИН: 123123123123");
    expect(beneficiaryId("240440007327", false)).toBe("БИН: 240440007327");
    expect(beneficiaryId("240440007327")).toBe("БИН: 240440007327");
  });
  it("номер счёта: «3» = «00000000003» = «АБ-0000003», но не «00000000013»", () => {
    expect(sameDocNumber("00000000003", "3")).toBe(true);
    expect(sameDocNumber("АБ-0000003", "3")).toBe(true);
    expect(sameDocNumber("00000000003", "00000000003")).toBe(true);
    expect(sameDocNumber("00000000013", "3")).toBe(false);
    expect(sameDocNumber("АБ-0000003", "ВГ-0000003")).toBe(false);
  });
});

describe("сохранение PDF на диск", () => {
  it("имя файла: без разделителей пути, управляющих символов, точек по краям; длина ограничена", () => {
    expect(safeFileName("Счет на оплату покупателю № 7 от 07.10.2026.pdf")).toBe(
      "Счет на оплату покупателю № 7 от 07.10.2026.pdf",
    );
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd.pdf");
    expect(safeFileName("..")).toBe("document.pdf");
    expect(safeFileName('a\\b:c*d?e"f<g>h|i')).toBe("a_b_c_d_e_f_g_h_i.pdf");
    expect(safeFileName("счёт\n№\t1\u0000\u202e.pdf")).toBe("счёт № 1.pdf");
    expect(safeFileName("CON")).toBe("_CON.pdf");
    const long = safeFileName("Я".repeat(500));
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith("Я.pdf")).toBe(true);
    expect(safeFileName("😀".repeat(100))).toMatch(/^(😀)+\.pdf$/u);
  });

  it("isInside: сам корень и вложенные — да, «..», соседний префикс и чужой путь — нет", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d")).toBe(true);
    expect(isInside("/a/b", "/a/b/..c")).toBe(true);
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/etc")).toBe(false);
  });

  it("outputDir: подкаталог создаётся, выход за корень («..», абсолютный путь, симлинк) отклоняется", async () => {
    const base = tmp();
    const root = join(base, "счета");
    expect(await resolvePrintDir(root)).toBe(root);
    expect(await resolvePrintDir(root, "2026/10")).toBe(join(root, "2026", "10"));
    expect(await resolvePrintDir(root, join(root, "клиенты"))).toBe(join(root, "клиенты"));
    expect(await resolvePrintDir(root, "a/../b")).toBe(join(root, "b"));
    await expect(resolvePrintDir(root, "..")).rejects.toThrow(/выходит за каталог печати/);
    await expect(resolvePrintDir(root, "../соседний")).rejects.toThrow(/выходит за каталог печати/);
    await expect(resolvePrintDir(root, "a/../../x")).rejects.toThrow(/выходит за каталог печати/);
    await expect(resolvePrintDir(root, "/etc")).rejects.toThrow(/выходит за каталог печати/);
    await expect(resolvePrintDir(root, `${root}-x`)).rejects.toThrow(/выходит за каталог печати/);
    const outside = join(base, "снаружи");
    symlinkSync(base, join(root, "наружу"));
    await expect(resolvePrintDir(root, "наружу/снаружи")).rejects.toThrow(/символическую ссылку/);
    expect(existsSync(outside)).toBe(false);
  });

  it("существующий файл не перезаписывается — новый получает суффикс « (2)», « (3)»", async () => {
    const dir = tmp();
    const a = await saveUnique(dir, "Счет № 1.pdf", Buffer.from("%PDF-1"));
    const b = await saveUnique(dir, "Счет № 1.pdf", Buffer.from("%PDF-2"));
    const c = await saveUnique(dir, "Счет № 1.pdf", Buffer.from("%PDF-3"));
    expect([a, b, c].map((x) => [x.fileName, x.renamed])).toEqual([
      ["Счет № 1.pdf", false],
      ["Счет № 1 (2).pdf", true],
      ["Счет № 1 (3).pdf", true],
    ]);
    expect(readFileSync(a.path, "utf8")).toBe("%PDF-1");
    expect(readFileSync(c.path, "utf8")).toBe("%PDF-3");
    // симлинк на месте имени не перезаписывает цель
    const target = join(tmp(), "цель.txt");
    writeFileSync(target, "не трогать");
    symlinkSync(target, join(dir, "x.pdf"));
    const d = await saveUnique(dir, "x.pdf", Buffer.from("%PDF"));
    expect(d.fileName).toBe("x (2).pdf");
    expect(readFileSync(target, "utf8")).toBe("не трогать");
  });
});

describe("PDF счёта", () => {
  it("строится PDF, длинный список переносится на следующую страницу", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      name: `Позиция ${i + 1}`,
      quantity: 1,
      price: 100,
      sum: 100,
    }));
    const pdf = await renderInvoicePdf({
      number: "1",
      date: "2026-10-07",
      supplier: { name: "ИП Тест", bin: "123123123123" },
      buyer: { name: "ТОО Покупатель" },
      lines,
      withVat: true,
      vatIncluded: false,
      vatSum: 1280,
      total: 9280,
      currency: "KZT",
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });

  it("инструмент собирает документ, банк и единицы из 1С и отдаёт PDF ресурсом", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
    const entities: Record<string, Record<string, unknown>> = {
      Document_СчетНаОплатуПокупателю: {
        Number: "00000000007",
        Date: "2026-10-07T10:00:00",
        Организация_Key: id(2),
        Контрагент_Key: id(3),
        СтруктурнаяЕдиница: id(8),
        СтруктурнаяЕдиница_Type: "StandardODATA.Catalog_БанковскиеСчета",
        УчитыватьНДС: false,
        СуммаВключаетНДС: false,
        СуммаДокумента: 15300,
        Товары: [
          {
            Номенклатура_Key: id(4),
            ЕдиницаИзмерения_Key: id(6),
            Количество: 3,
            Цена: 100,
            Сумма: 300,
            СуммаНДС: 0,
          },
        ],
        Услуги: [
          {
            Номенклатура_Key: id(5),
            Содержание: "Консультация за октябрь",
            Количество: 1,
            Цена: 15000,
            Сумма: 15000,
            СуммаНДС: 0,
          },
        ],
      },
      Catalog_Организации: {
        НаименованиеПолное: "ИП Тест",
        ИдентификационныйНомер: "123123123123",
        КБЕ: "19",
      },
      Catalog_Контрагенты: { Description: "ТОО Покупатель", ИдентификационныйКодЛичности: "990140000001" },
      Catalog_БанковскиеСчета: { НомерСчета: "KZ86125KZT1004100100", Банк_Key: id(9) },
      Catalog_Банки: { Description: 'АО "Банк ЦентрКредит"', БИК: "KCJBKZKX", Город: "г. Алматы" },
    };
    const collections: Record<string, Array<Record<string, unknown>>> = {
      Catalog_Номенклатура: [
        { Ref_Key: id(4), Code: "001", Description: "Товар" },
        { Ref_Key: id(5), Code: "002", Description: "Консультация", БазоваяЕдиницаИзмерения_Key: id(7) },
      ],
      Catalog_КлассификаторЕдиницИзмерения: [
        { Ref_Key: id(6), Description: "шт" },
        { Ref_Key: id(7), Description: "ч" },
      ],
    };
    const seen: string[] = [];
    const printDir = join(tmp(), "счета");
    const conn = {
      cfg: { name: "default" },
      behavior: { pageSize: 100, maxRows: 1000, printDir },
      getMetadata: async () => ({ entities: new Map([["ChartOfAccounts_Типовой", { properties: [] }]]) }),
      available: async () => new Set(["Document_СчетНаОплатуПокупателю", ...Object.keys(collections)]),
      client: {
        getEntity: async (path: string) => {
          seen.push(path);
          return entities[Object.keys(entities).find((k) => path.startsWith(`${k}(`)) ?? ""] ?? {};
        },
        getCollection: async (path: string) => ({
          value: collections[Object.keys(collections).find((k) => path.startsWith(k)) ?? ""] ?? [],
        }),
      },
    };
    const tool = toolsOf(conn)["read.document.print_invoice"]!;
    const res = await tool.handler({ database: "default", ref: id(1) }, {});
    const fileName = "Счет на оплату покупателю № 7 от 07.10.2026.pdf";
    expect(res.structuredContent).toMatchObject({
      name: fileName,
      mimeType: "application/pdf",
      total: 15300,
      path: join(printDir, fileName),
      fileName,
      directory: printDir,
    });
    expect(res.structuredContent).not.toHaveProperty("note");
    expect(res.structuredContent).not.toHaveProperty("saveError");
    const onDisk = readFileSync(join(printDir, fileName));
    expect(onDisk.subarray(0, 4).toString()).toBe("%PDF");
    expect(onDisk.length).toBe(res.structuredContent!["size"]);

    // повтор — новый файл с суффиксом, прежний не перезаписан
    const again = await tool.handler({ database: "default", ref: id(1) }, {});
    expect(again.structuredContent).toMatchObject({
      fileName: "Счет на оплату покупателю № 7 от 07.10.2026 (2).pdf",
      path: join(printDir, "Счет на оплату покупателю № 7 от 07.10.2026 (2).pdf"),
    });
    expect(String(again.structuredContent!["note"])).toMatch(/прежний не перезаписан/);
    expect(readFileSync(join(printDir, fileName)).equals(onDisk)).toBe(true);

    // outputDir — подкаталог; выход за каталог печати — ошибка до обращения к 1С
    const sub = await tool.handler({ database: "default", ref: id(1), outputDir: "ТОО Покупатель" }, {});
    expect(sub.structuredContent).toMatchObject({ path: join(printDir, "ТОО Покупатель", fileName) });
    const calls = seen.length;
    const bad = await tool.handler({ database: "default", ref: id(1), outputDir: "../../etc" }, {});
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/выходит за каталог печати/);
    expect(seen.length).toBe(calls);
    expect(readdirSync(printDir).sort()).toEqual(
      [fileName, "Счет на оплату покупателю № 7 от 07.10.2026 (2).pdf", "ТОО Покупатель"].sort(),
    );
    expect(seen.some((p) => p.startsWith(`Catalog_БанковскиеСчета(guid'${id(8)}')`))).toBe(true);
    const resource = res.content.find((c) => c.type === "resource") as { resource: { blob: string } };
    expect(Buffer.from(resource.resource.blob, "base64").subarray(0, 4).toString()).toBe("%PDF");

    const data = await invoicePrintData(conn as never, id(1));
    expect(data.bank).toEqual({
      iik: "KZ86125KZT1004100100",
      bankName: 'АО "Банк ЦентрКредит" г. Алматы',
      bik: "KCJBKZKX",
    });
    expect(data.supplier).toEqual({ name: "ИП Тест", bin: "123123123123", kbe: "19", individual: false });
    expect(data.lines.map((l) => [l.code, l.name, l.unit])).toEqual([
      ["001", "Товар", "шт"],
      ["002", "Консультация за октябрь", "ч"],
    ]);
  });
});

describe("печать при недоступном каталоге", () => {
  it("сбой файловой системы не мешает печати: PDF ресурсом, причина — в saveError", async () => {
    const file = join(tmp(), "это-файл");
    writeFileSync(file, "x");
    const conn = {
      cfg: { name: "default" },
      behavior: { pageSize: 100, maxRows: 1000, printDir: file },
      getMetadata: async () => ({ entities: new Map([["ChartOfAccounts_Типовой", { properties: [] }]]) }),
      available: async () => new Set(["Document_СчетНаОплатуПокупателю", "Catalog_Номенклатура"]),
      client: {
        getEntity: async (path: string) =>
          path.startsWith("Document_")
            ? { Number: "00000000009", Date: "2026-10-08T00:00:00", СуммаДокумента: 0 }
            : {},
        getCollection: async () => ({ value: [] }),
      },
    };
    const res = await toolsOf(conn)["read.document.print_invoice"]!.handler(
      { database: "default", ref: EMPTY_REF },
      {},
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toHaveProperty("path");
    expect(String(res.structuredContent!["saveError"])).toMatch(/Каталог для PDF недоступен/);
    expect(res.content.some((c) => c.type === "resource")).toBe(true);
  });
});
