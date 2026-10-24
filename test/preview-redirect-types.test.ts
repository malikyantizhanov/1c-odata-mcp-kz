import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redirectMessage } from "../src/odata/safe-fetch.js";
import { withWriteOperation } from "../src/odata/write-operation-context.js";
import { withTypeNamespace } from "../src/tools/subconto.js";
import { createOrPreview } from "../src/tools/write.js";
import { BUYER, CONTRACT, ORG, SERVICE, VAT_NONE, baseStore, fake1C } from "./support/fake-1c.js";

/**
 * Предпросмотр читает названия ссылок только полями, которые у объекта есть (у справочника нет Date — 1С отвергла бы
 * весь запрос); перенаправление 1С — с кодом и путём, на запись — «повтор не поможет»; тип составной ссылки без
 * «StandardODATA.» дописывается.
 */

describe("названия в предпросмотре", () => {
  it("справочник читается без Date, документ — с датой", async () => {
    const f = fake1C({
      store: baseStore(),
      entities: {
        Document_СчетНаОплатуПокупателю: {
          properties: [
            { name: "Ref_Key", type: "Edm.Guid" },
            { name: "Date", type: "Edm.DateTime" },
            { name: "Организация_Key", type: "Edm.Guid" },
            { name: "Контрагент_Key", type: "Edm.Guid" },
            { name: "ДоговорКонтрагента_Key", type: "Edm.Guid" },
          ],
          navigations: [
            { name: "Организация", toType: "Catalog_Организации", collection: false },
            { name: "Контрагент", toType: "Catalog_Контрагенты", collection: false },
            { name: "ДоговорКонтрагента", toType: "Catalog_ДоговорыКонтрагентов", collection: false },
          ],
        },
      },
    });
    const payload = {
      Date: "2026-10-24T00:00:00",
      Организация_Key: ORG,
      Контрагент_Key: BUYER,
      ДоговорКонтрагента_Key: CONTRACT,
      Услуги: [{ Номенклатура_Key: SERVICE, Количество: 1, Цена: 100, Сумма: 100, СтавкаНДС_Key: VAT_NONE }],
    };
    const res = await withWriteOperation(randomUUID(), "h", () =>
      createOrPreview(f.conn, "Document_СчетНаОплатуПокупателю", payload, false),
    );
    expect(res.isError).toBeFalsy();
    const lookups = f.gets.filter((p) => p.startsWith("Catalog_") && p.includes("$select="));
    expect(lookups.length).toBeGreaterThan(0);
    for (const p of lookups)
      expect(new URLSearchParams(p.split("?")[1]).get("$select")).not.toMatch(/(^|,)Date(,|$)/);
  });
});

describe("перенаправление 1С", () => {
  const url = "https://1cfresh.kz/a/ea20/1/odata/standard.odata/Document_X(guid'1')/Post?$format=json";

  it("на действие — код, путь и «повтор не поможет»", () => {
    const text = redirectMessage(url, 302, "/a/ea20/1/e1cib/login?token=секрет", "POST");
    expect(text).toContain("HTTP 302 → /a/ea20/1/e1cib/login");
    expect(text).toContain("Повтор того же запроса не поможет");
    expect(text).not.toContain("секрет"); // параметры адреса не показываем
  });

  it("на чтение — подсказка про адрес публикации, чужой хост — с хостом", () => {
    const text = redirectMessage(url, 301, "https://login.example.kz/sso", undefined);
    expect(text).toContain("HTTP 301 → login.example.kz/sso");
    expect(text).toContain("Укажите точный адрес");
    expect(redirectMessage(url, 302, null)).toContain("(HTTP 302)");
  });
});

describe("тип составной ссылки", () => {
  it("без пространства имён — дописывается в шапке и строках, прочее не трогается", () => {
    expect(
      withTypeNamespace({
        СубконтоДоходовБУ2_Type: "Catalog_НоменклатурныеГруппы",
        Услуги: [
          { СубконтоДоходовБУ1_Type: " Document_РеализацияТоваровУслуг ", Содержание: "Catalog_текст" },
        ],
        Готовый_Type: "StandardODATA.Catalog_Контрагенты",
        Перечисление_Type: "ВидыДвиженияСтоимостиФА",
      }),
    ).toEqual({
      СубконтоДоходовБУ2_Type: "StandardODATA.Catalog_НоменклатурныеГруппы",
      Услуги: [
        {
          СубконтоДоходовБУ1_Type: "StandardODATA.Document_РеализацияТоваровУслуг",
          Содержание: "Catalog_текст",
        },
      ],
      Готовый_Type: "StandardODATA.Catalog_Контрагенты",
      Перечисление_Type: "ВидыДвиженияСтоимостиФА",
    });
  });
});
