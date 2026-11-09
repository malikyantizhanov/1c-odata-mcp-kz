import { describe, expect, it } from "vitest";
import { resolveOrganization } from "../src/odata/orgs.js";

const ORGS = [
  { Ref_Key: "3672801e-f5b7-11f0-8d19-52540077dd78", Description: "ЧК IGS Caspian Ltd", ИдентификационныйНомер: "251240901194" },
  { Ref_Key: "21ff9f9f-eacb-11ef-8459-4ec2857e04d9", Description: "laundromat.kz ТОО", ИдентификационныйНомер: "250140030729" },
  { Ref_Key: "93c96a33-e3e2-11f0-bf54-00e93ac7ecde", Description: "ТОО Альфа", ИдентификационныйНомер: "111111111111" },
  { Ref_Key: "93c96a33-e3e2-11f0-bf54-00e93ac7ecdf", Description: "ТОО Альфа Плюс", ИдентификационныйНомер: "222222222222" },
];

const conn = {
  available: async () => new Set(["Catalog_Организации"]),
  getMetadata: async () => ({
    entities: new Map([["Catalog_Организации", { properties: ["Ref_Key", "Description", "ИдентификационныйНомер"].map((name) => ({ name })) }]]),
  }),
  behavior: { pageSize: 100, maxRows: 1000 },
  client: { getCollection: async () => ({ value: ORGS }) },
};

describe("resolveOrganization", () => {
  it("по Ref_Key (как из list_organizations), в фигурных скобках и в другом регистре", async () => {
    expect((await resolveOrganization(conn as never, "93C96A33-E3E2-11F0-BF54-00E93AC7ECDE")).name).toBe("ТОО Альфа");
    expect((await resolveOrganization(conn as never, "{21ff9f9f-eacb-11ef-8459-4ec2857e04d9}")).name).toBe("laundromat.kz ТОО");
    await expect(resolveOrganization(conn as never, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/Ref_Key .* нет/);
  });

  it("по БИН и по названию: кавычки и регистр не важны, точное совпадение важнее части", async () => {
    expect((await resolveOrganization(conn as never, "251240901194")).name).toBe("ЧК IGS Caspian Ltd");
    expect((await resolveOrganization(conn as never, 'ЧК "IGS Caspian Ltd"')).name).toBe("ЧК IGS Caspian Ltd");
    expect((await resolveOrganization(conn as never, "тоо альфа")).name).toBe("ТОО Альфа");
    expect((await resolveOrganization(conn as never, "laundromat")).name).toBe("laundromat.kz ТОО");
    await expect(resolveOrganization(conn as never, "Альф")).rejects.toThrow(/несколько организаций/);
    await expect(resolveOrganization(conn as never, "Бета")).rejects.toThrow(/не найдена. Доступные/);
  });
});
