import { describe, expect, it } from "vitest";
import { ODataError } from "../src/odata/errors.js";
import { catalogOfRef, OWNER_CATALOGS } from "../src/odata/owner.js";

const REF = "00000000-0000-4000-8000-0000000000c1";

function conn(home: string) {
  const asked: string[] = [];
  return {
    asked,
    available: async () => new Set<string>(OWNER_CATALOGS),
    client: {
      getEntity: async (path: string) => {
        asked.push(path.split("(")[0]!);
        if (path.startsWith(`${home}(`)) return { Ref_Key: REF };
        throw new ODataError({ kind: "not_found", status: 404, message: "нет" });
      },
    },
  };
}

describe("catalogOfRef", () => {
  it("контрагент — один запрос, без опроса остальных справочников; повтор — из памяти подключения", async () => {
    const c = conn("Catalog_Контрагенты");
    expect(await catalogOfRef(c as never, REF)).toBe("Catalog_Контрагенты");
    expect(c.asked).toEqual(["Catalog_Контрагенты"]);
    expect(await catalogOfRef(c as never, `{${REF.toUpperCase()}}`)).toBe("Catalog_Контрагенты");
    expect(c.asked).toHaveLength(1);
  });

  it("не контрагент — остальные справочники; нигде нет — undefined и без кеша", async () => {
    const c = conn("Catalog_Организации");
    expect(await catalogOfRef(c as never, REF)).toBe("Catalog_Организации");
    expect(c.asked[0]).toBe("Catalog_Контрагенты");
    const none = conn("Catalog_Нет");
    expect(await catalogOfRef(none as never, REF)).toBeUndefined();
    expect(await catalogOfRef(none as never, REF)).toBeUndefined();
    expect(none.asked).toHaveLength(OWNER_CATALOGS.length * 2);
  });
});
