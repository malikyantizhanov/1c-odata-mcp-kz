import { describe, expect, it } from "vitest";
import { nomenclatureAccounts } from "../src/odata/accounting.js";
import { baseStore, fake1C, id, ORG } from "./support/fake-1c.js";

/** Регистр «Счета учёта номенклатуры»: поля различаются в российской и казахстанской конфигурациях. */
const REG = "InformationRegister_СчетаУчетаНоменклатуры";
const NOM = id(301);
const a = (n: number) => id(400 + n);

describe("nomenclatureAccounts", () => {
  it("казахстанская конфигурация: счета БУ (СчетУчетаБУ_Key …), без измерения «Вид номенклатуры»", async () => {
    const store = baseStore();
    store["Catalog_Номенклатура"] = [{ Ref_Key: NOM, Description: "Товар" }];
    store[REG] = [
      {
        Организация_Key: ORG,
        Номенклатура_Key: "00000000-0000-0000-0000-000000000000",
        СчетУчетаБУ_Key: a(1),
        СчетУчетаНУ_Key: a(9),
        СчетУчетаНДСПоПриобретению_Key: a(2),
        СчетУчетаНДСПоРеализации_Key: a(3),
        СчетДоходовОтРеализацииБУ_Key: a(4),
        СчетСебестоимостиПриРеализацииБУ_Key: a(5),
      },
      {
        Организация_Key: ORG,
        Номенклатура_Key: NOM,
        СчетУчетаБУ_Key: a(11),
        СчетУчетаНУ_Key: a(19),
        СчетУчетаНДСПоПриобретению_Key: a(12),
        СчетУчетаНДСПоРеализации_Key: a(13),
        СчетДоходовОтРеализацииБУ_Key: a(14),
        СчетСебестоимостиПриРеализацииБУ_Key: a(15),
      },
    ];
    const { conn, gets } = fake1C({ store });
    expect(await nomenclatureAccounts(conn, ORG, NOM)).toEqual({
      goods: a(11),
      incomingVat: a(12),
      outgoingVat: a(13),
      income: a(14),
      expense: a(15),
    });
    // Российские поля и вид номенклатуры не запрашиваются: в KZ их нет, 1С ответила бы 400.
    const q = gets.filter((g) => g.startsWith(REG)).join("\n");
    expect(q).toContain("СчетУчетаБУ_Key");
    expect(q).not.toContain("СчетУчета_Key");
    expect(q).not.toContain("ВидНоменклатуры_Key");
    expect(gets.some((g) => g.startsWith("Catalog_Номенклатура("))).toBe(false);
  });

  it("российская конфигурация — как раньше (СчетУчета_Key, матчинг по виду)", async () => {
    const VID = id(311);
    const store = baseStore();
    store["Catalog_Номенклатура"] = [{ Ref_Key: NOM, Description: "Товар", ВидНоменклатуры_Key: VID }];
    store[REG] = [
      {
        Организация_Key: ORG,
        Номенклатура_Key: "00000000-0000-0000-0000-000000000000",
        ВидНоменклатуры_Key: id(312),
        СчетУчета_Key: a(21),
      },
      {
        Организация_Key: ORG,
        Номенклатура_Key: "00000000-0000-0000-0000-000000000000",
        ВидНоменклатуры_Key: VID,
        СчетУчета_Key: a(22),
        СчетУчетаНДСПоПриобретеннымЦенностям_Key: a(23),
        СчетУчетаНДСПоРеализации_Key: a(24),
        СчетДоходовОтРеализации_Key: a(25),
        СчетРасходовОтРеализации_Key: a(26),
      },
    ];
    const { conn } = fake1C({ store });
    expect(await nomenclatureAccounts(conn, ORG, NOM)).toEqual({
      goods: a(22),
      incomingVat: a(23),
      outgoingVat: a(24),
      income: a(25),
      expense: a(26),
    });
  });
});
