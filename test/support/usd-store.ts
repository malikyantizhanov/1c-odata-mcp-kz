import { KZT, ORG, baseStore, id, type Store } from "./fake-1c.js";

/** Валюты и курсы для тестов quick_invoice / quick_sale / tax_invoice_from_sale. */
export const USD = id(80);
export const JPY = id(81);
export const USD_ACC = id(82);
export const USD_ACC2 = id(83);

/** База с долларовым договором, курсами USD/JPY и счетами организации в тенге и долларах. */
export function usdStore(): Store {
  const store = baseStore();
  store["Catalog_Валюты"]!.push(
    { Ref_Key: USD, Code: "840", Description: "USD" },
    { Ref_Key: JPY, Code: "392", Description: "JPY" },
  );
  store["InformationRegister_КурсыВалют"] = [
    { Period: "1980-01-01T00:00:00", Валюта_Key: KZT, Курс: 1, Кратность: "1" },
    { Period: "1980-01-01T00:00:00", Валюта_Key: USD, Курс: 1, Кратность: "1" },
    { Period: "2026-10-01T00:00:00", Валюта_Key: USD, Курс: 450.1, Кратность: "1" },
    { Period: "2026-10-07T00:00:00", Валюта_Key: USD, Курс: 453.65, Кратность: "1" },
    { Period: "2026-10-12T00:00:00", Валюта_Key: USD, Курс: 453.93, Кратность: "1" },
    { Period: "2026-10-01T00:00:00", Валюта_Key: JPY, Курс: 298.5, Кратность: "100" },
  ];
  Object.assign(store["Catalog_БанковскиеСчета"]![0]!, {
    ВалютаДенежныхСредств_Key: KZT,
    Owner_Type: "StandardODATA.Catalog_Организации",
    DeletionMark: false,
  });
  store["Catalog_БанковскиеСчета"]!.push({
    Ref_Key: USD_ACC,
    Description: "Bereke USD",
    НомерСчета: "KZ25914002203US00773",
    Owner: ORG,
    Owner_Type: "StandardODATA.Catalog_Организации",
    ВалютаДенежныхСредств_Key: USD,
    ДатаЗакрытия: "0001-01-01T00:00:00",
    DeletionMark: false,
  });
  Object.assign(store["Catalog_ДоговорыКонтрагентов"]![0]!, { ВалютаВзаиморасчетов_Key: USD });
  return store;
}
