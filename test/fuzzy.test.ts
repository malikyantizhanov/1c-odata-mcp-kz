import { describe, expect, it } from "vitest";
import {
  FUZZY_MIN,
  FUZZY_SURE,
  nameScore,
  normalizeName,
  probes,
  skeleton,
  soleStrong,
  taxIdFilter,
} from "../src/odata/fuzzy.js";

/** Нечёткое сравнение наименований: «Шнайдер»/«Schneider» → «Шнейдер Электрик ТОО». */
describe("нечёткий поиск: нормализация и оценка", () => {
  it("регистр, ё/е, кавычки и организационно-правовая форма не важны", () => {
    expect(normalizeName("ТОО «Ёлка-Строй»")).toBe("елка строй");
    expect(normalizeName('"Шнейдер Электрик" ТОО')).toBe("шнейдер электрик");
    expect(normalizeName("Schneider Electric LLP")).toBe("schneider electric");
    expect(normalizeName("Товарищество с ограниченной ответственностью Альфа")).toBe("альфа");
    expect(normalizeName("ИП")).toBe("ип");
  });

  it("кириллица и латиница сводятся к одному скелету", () => {
    expect(skeleton("schneider")).toBe(skeleton("шнейдер"));
    expect(skeleton("electric")).toBe(skeleton("электрик"));
  });

  it("«Шнайдер», «Schneider», «шнейдер электрик» находят «Шнейдер Электрик ТОО»", () => {
    const name = "Шнейдер Электрик ТОО";
    expect(nameScore("Schneider", name)).toBeGreaterThanOrEqual(FUZZY_SURE);
    expect(nameScore("Шнайдер", name)).toBeGreaterThanOrEqual(FUZZY_MIN);
    expect(nameScore("Шнайдер", name)).toBeLessThan(FUZZY_SURE);
    expect(nameScore("ТОО «Шнейдер Электрик»", name)).toBe(1);
    expect(nameScore("Schneider Electric LLP", name)).toBeGreaterThanOrEqual(0.95);
    expect(nameScore("шней", name)).toBeGreaterThanOrEqual(0.8);
    expect(nameScore("Ромашка", name)).toBeLessThan(FUZZY_MIN);
  });

  it("подстроки отбора — в обеих азбуках, начало и конец слова", () => {
    expect(probes("Шнайдер")).toEqual(expect.arrayContaining(["шна", "дер", "shn"]));
    expect(probes("Schneider")).toEqual(expect.arrayContaining(["sch", "шне"]));
    expect(probes("ТОО")).toContain("тоо");
  });

  it("БИН/ИИН — точно по 12 цифрам, по части — подстрокой", () => {
    expect(taxIdFilter("ИдентификационныйКодЛичности", "240440007327")).toBe(
      "ИдентификационныйКодЛичности eq '240440007327'",
    );
    expect(taxIdFilter("ИдентификационныйКодЛичности", "0007")).toContain("substringof('0007'");
    expect(taxIdFilter("ИдентификационныйКодЛичности", "12")).toBeUndefined();
  });
});

describe("английское название, записанное на слух кириллицей", () => {
  it("«ТрейдСпейс»/«Трейд Спейс» ~ ТОО «TRADESPACE»: сильный кандидат, но не точное совпадение", () => {
    for (const q of ["ТрейдСпейс", "Трейд Спейс"]) {
      const s = nameScore(q, 'ТОО "TRADESPACE"');
      expect(s).toBeGreaterThanOrEqual(FUZZY_SURE);
      expect(s).toBeLessThan(0.98);
    }
    expect(nameScore("ТрейдСпейс", "Трейд Логистик")).toBeLessThan(FUZZY_SURE);
    // Серверный отбор-кандидат должен зацепить «TRA…».
    expect(probes("ТрейдСпейс")).toContain("tra");
  });

  it("soleStrong: подстановка только при единственном сильном кандидате", () => {
    expect(soleStrong([{ score: 0.9 }, { score: 0.7 }])).toEqual({ score: 0.9 });
    expect(soleStrong([{ score: 0.95 }, { score: 0.9 }])).toBeUndefined();
    expect(soleStrong([{ score: 0.85 }])).toBeUndefined();
    expect(soleStrong([])).toBeUndefined();
  });
});
