import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp/server.js";
import { fioDative, positionDative } from "../src/print/declension.js";
import { quantityText, renderPowerOfAttorneyPdf } from "../src/print/power-of-attorney-pdf.js";
import { issuedToText, powerOfAttorneyPrintData } from "../src/tools/print-power-of-attorney.js";

/**
 * Доверенность (Д-1, Казахстан): склонение «Выдана», данные как в печатной форме 1С (образец из 1С:Fresh.kz —
 * доверенность № 1 ИП «Aru Market» на получение ТМЗ от ТОО «TRADESPACE»), PDF и сохранение без перезаписи.
 */
type Tool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};
const toolsOf = (connection: unknown): Record<string, Tool> =>
  (createServer({ db: () => connection } as never) as unknown as { _registeredTools: Record<string, Tool> })
    ._registeredTools;

const roots: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "1c-poa-test-")));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POA = id(1);
const ORG = id(2);
const ACCOUNT = id(3);
const BANK = id(4);
const PERSON = id(5);
const IP = id(6);
const NOM = id(7);
const UNIT = id(8);
const POSITION = id(9);
const POA_SET = "Document_Доверенность";

function connection(printDir?: string) {
  const entities: Record<string, Record<string, unknown>> = {
    [`${POA_SET}(guid'${POA}')`]: {
      Number: "00000000001",
      Date: "2026-10-09T15:05:25",
      ДатаДействия: "2026-10-19T00:00:00",
      Организация_Key: ORG,
      СтруктурнаяЕдиница_Key: ACCOUNT,
      ФизЛицо_Key: PERSON,
      Контрагент_Key: id(10),
      НаПолучениеОт: 'Товарищество с ограниченной ответственностью "TRADESPACE"',
      ПоДокументу: "Счет на оплату от поставщика №                от                      г.",
      Товары: [
        {
          LineNumber: "1",
          НаименованиеТовара: NOM,
          НаименованиеТовара_Type: "StandardODATA.Catalog_Номенклатура",
          ЕдиницаПоКлассификатору_Key: UNIT,
          Количество: 1,
        },
        {
          LineNumber: "2",
          НаименованиеТовара: "Бумага А4",
          НаименованиеТовара_Type: "Edm.String",
          Количество: 2.5,
        },
      ],
    },
    [`Catalog_Организации(guid'${ORG}')`]: {
      Description: "Aru Market",
      НаименованиеПолное: 'Индивидуальный предприниматель "Aru Market"',
      ИдентификационныйНомер: "123123123123",
      ЮрФизЛицо: "ФизЛицо",
      ИндивидуальныйПредприниматель_Key: IP,
    },
    [`Catalog_БанковскиеСчета(guid'${ACCOUNT}')`]: { НомерСчета: "KZ86125KZT1004100100", Банк_Key: BANK },
    [`Catalog_Банки(guid'${BANK}')`]: { Description: 'АО "Банк ЦентрКредит"' },
    [`Catalog_ФизическиеЛица(guid'${PERSON}')`]: { Description: "Касымова Диана Сериковна.", Пол: "Женский" },
    [`Catalog_ФизическиеЛица(guid'${IP}')`]: { Description: "Жумабекова Алина Ерлановна" },
    [`Catalog_ДолжностиОрганизаций(guid'${POSITION}')`]: { Description: "Бухгалтер" },
  };
  const collections: Record<string, Array<Record<string, unknown>>> = {
    Catalog_Номенклатура: [{ Ref_Key: NOM, Description: "Одежда" }],
    Catalog_КлассификаторЕдиницИзмерения: [{ Ref_Key: UNIT, Description: "шт" }],
    Catalog_СотрудникиОрганизаций: [
      { Ref_Key: id(11), ТекущаяДолжностьОрганизации_Key: POSITION, Актуальность: true },
    ],
    [POA_SET]: [{ Ref_Key: POA, Number: "00000000001", Date: "2026-10-09T15:05:25", Posted: false }],
  };
  const props = (...names: string[]) => ({ properties: names.map((name) => ({ name, type: "Edm.String" })) });
  return {
    cfg: { name: "default" },
    behavior: { pageSize: 100, maxRows: 1000, ...(printDir ? { printDir } : {}) },
    getMetadata: async () => ({
      entities: new Map([
        ["ChartOfAccounts_Типовой", props()],
        [POA_SET, props("Ref_Key", "Number", "Date", "Posted", "DeletionMark")],
      ]),
    }),
    available: async () =>
      new Set([
        POA_SET,
        "Catalog_Номенклатура",
        "Catalog_КлассификаторЕдиницИзмерения",
        "Catalog_СотрудникиОрганизаций",
        "Catalog_ДолжностиОрганизаций",
      ]),
    client: {
      getEntity: async (path: string) =>
        entities[Object.keys(entities).find((k) => path.startsWith(k)) ?? ""] ?? {},
      getCollection: async (path: string) => ({
        value: collections[Object.keys(collections).find((k) => path.startsWith(k)) ?? ""] ?? [],
      }),
    },
  };
}

describe("дательный падеж для «Выдана»", () => {
  it("ФИО по полу; точка в конце сохраняется; несклоняемое — как есть", () => {
    expect(fioDative("Касымова Диана Сериковна.", "female")).toBe("Касымовой Диане Сериковне.");
    expect(fioDative("Иванов Иван Иванович")).toBe("Иванову Ивану Ивановичу");
    expect(fioDative("Толстая Ольга Сергеевна")).toBe("Толстой Ольге Сергеевне");
    expect(fioDative("Достоевский Фёдор Михайлович")).toBe("Достоевскому Фёдору Михайловичу");
    expect(fioDative("Ильина Любовь Петровна")).toBe("Ильиной Любови Петровне");
    expect(fioDative("Гарипов Илья Ринатович")).toBe("Гарипову Илье Ринатовичу");
    expect(fioDative("Ковальчук Мария Ивановна")).toBe("Ковальчук Марии Ивановне");
    expect(fioDative("Шевченко Василий Петрович")).toBe("Шевченко Василию Петровичу");
    expect(fioDative("Сейткали Айгерим Нурлановна")).toBe("Сейткали Айгерим Нурлановне");
    expect(fioDative("Абенов Ерлан Нурланұлы")).toBe("Абенову Ерлану Нурланұлы");
  });

  it("должность: прилагательные и первое существительное", () => {
    expect(positionDative("Бухгалтер")).toBe("Бухгалтеру");
    expect(positionDative("Главный бухгалтер")).toBe("Главному бухгалтеру");
    expect(positionDative("Менеджер по продажам")).toBe("Менеджеру по продажам");
    expect(positionDative("Коммерческий директор")).toBe("Коммерческому директору");
    expect(positionDative("Старший кассир")).toBe("Старшему кассиру");
    expect(positionDative("Заместитель директора")).toBe("Заместителю директора");
    expect(positionDative("Водитель-экспедитор")).toBe("Водителю-экспедитору");
    expect(issuedToText("Касымова Диана Сериковна.", "Женский", "Бухгалтер")).toBe(
      "Бухгалтеру, Касымовой Диане Сериковне.",
    );
    expect(issuedToText("Иванов Иван Иванович", "Мужской")).toBe("Иванову Ивану Ивановичу");
  });
});

describe("доверенность: данные как в печатной форме 1С", () => {
  it("организация, счёт, «Выдана», поставщик, основание, ТМЗ (ссылка и строка), руководитель ИП", async () => {
    const d = await powerOfAttorneyPrintData(connection() as never, POA);
    expect(d.form).toMatchObject({
      number: "1",
      date: "2026-10-09",
      validUntil: "2026-10-19",
      organization: 'Индивидуальный предприниматель "Aru Market"',
      organizationId: "123123123123",
      recipient: 'Индивидуальный предприниматель "Aru Market", БИН / ИИН 123123123123',
      payer: 'Индивидуальный предприниматель "Aru Market", БИН / ИИН 123123123123',
      account: "KZ86125KZT1004100100",
      bank: 'АО "Банк ЦентрКредит"',
      issuedTo: "Бухгалтеру, Касымовой Диане Сериковне.",
      supplier: 'Товарищество с ограниченной ответственностью "TRADESPACE"',
      basis: "Счет на оплату от поставщика №                от                      г.",
      head: "Жумабекова А. Е.",
      lines: [
        { name: "Одежда", unit: "шт", quantity: 1 },
        { name: "Бумага А4", unit: undefined, quantity: 2.5 },
      ],
    });
    expect(d.notes.join(" ")).toMatch(/Паспортные данные/);
    expect(quantityText(1)).toBe("1 (Один)");
    expect(quantityText(3.5)).toBe("3,5 (Три целых пять десятых)");
  });
});

describe("read.document.print_power_of_attorney", () => {
  it("по номеру, с паспортом: PDF в «доверенности», повтор — « (2)»", async () => {
    const root = tmp();
    const tool = toolsOf(connection(root))["read.document.print_power_of_attorney"]!;
    const passport = { number: "111", date: "2026-10-16", issuedBy: "МВД РЕСПУБЛИКИ КАЗАХСТАН" };
    const res = await tool.handler({ database: "default", number: "1", year: 2026, passport }, {});
    const name = "Доверенность № 1 от 09.10.2026.pdf";
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      number: "00000000001",
      path: join(root, "доверенности", name),
      files: [{ form: "Д-1", name }],
    });
    expect(String(res.structuredContent!["note"] ?? "")).not.toMatch(/Паспортные данные/);
    expect(
      readFileSync(join(root, "доверенности", name))
        .subarray(0, 4)
        .toString(),
    ).toBe("%PDF");
    const again = await tool.handler({ database: "default", number: "1", year: 2026 }, {});
    expect(again.structuredContent!["path"]).toBe(
      join(root, "доверенности", "Доверенность № 1 от 09.10.2026 (2).pdf"),
    );
  });

  it("много строк ТМЗ — таблица переносится на следующую страницу", async () => {
    const { form } = await powerOfAttorneyPrintData(connection() as never, POA);
    const pdf = await renderPowerOfAttorneyPdf({
      ...form,
      lines: Array.from({ length: 60 }, () => form.lines[0]!),
    });
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
