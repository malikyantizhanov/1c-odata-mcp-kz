import type { Connection } from "../context.js";
import type { EntityMeta } from "../types/odata.js";
import { contractCurrencyRef, currencyByRef, rateForDocument, refOrNone } from "./currency-kz.js";

/**
 * Курс взаиморасчётов в строках документа (РасшифровкаПлатежа платёжек, ПКО/РКО и др.), если он не передан.
 *
 * В форме 1С курс, кратность и сумма взаиморасчётов заполняются при выборе договора; при записи через OData формы нет —
 * поля оставались 0 (прод 09.11.2026: все 19 платёжек по выписке IGS Caspian — курс 0, кратность 0, сумма 0; у
 * бухгалтера в тех же тенговых платёжках — 1, 1, сумма платежа). Здесь — как в форме: валюта взаиморасчётов договора
 * строки (нет договора или валюты — валюта документа), курс строго на дату документа из регистра «Курсы валют» (тенге —
 * 1/1; записи на эту дату нет — курс не подставляется, заметка с последним загруженным),
 * сумма взаиморасчётов — сумма платежа (в другой валюте — пересчёт через курсы обеих валют). Явно переданное не трогаем.
 * Курса валюты в 1С нет — поле остаётся пустым и в заметках об этом сказано (сценарий спрашивает бухгалтера).
 */

const low = (v: unknown): string =>
  String(v ?? "")
    .replace(/[{}']/g, "")
    .toLowerCase();
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function fillSettlementRates(
  conn: Connection,
  em: EntityMeta,
  payload: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; notes: string[] }> {
  const meta = await conn.getMetadata();
  const date = String(payload["Date"] ?? "").slice(0, 10);
  const docCur = refOrNone(payload["ВалютаДокумента_Key"]);
  const notes = new Set<string>();
  let out = payload;
  const contractCur = new Map<string, string | undefined>();
  for (const prop of em.properties) {
    const m = /^Collection\(StandardODATA\.(.+)_RowType\)$/.exec(prop.type ?? "");
    const rows = out[prop.name];
    if (!m || !Array.isArray(rows) || !rows.length) continue;
    const rm = meta.entities.get(m[1]!);
    const types = new Map((rm?.properties ?? []).map((p) => [p.name, p.type ?? ""]));
    if (!types.has("КурсВзаиморасчетов")) continue;
    const contractSet = (
      rm?.navigations?.find((n) => n.name === "ДоговорКонтрагента")?.toType ?? "Catalog_ДоговорыКонтрагентов"
    ).replace(/^StandardODATA\./, "");
    const asType = (name: string, v: number): unknown => (types.get(name) === "Edm.String" ? String(v) : v);
    const next: Array<Record<string, unknown>> = [];
    for (const [i, raw] of (rows as Array<Record<string, unknown>>).entries()) {
      if (Number(raw["КурсВзаиморасчетов"] ?? 0) > 0) {
        next.push(raw);
        continue;
      }
      const contract = refOrNone(raw["ДоговорКонтрагента_Key"] ?? out["ДоговорКонтрагента_Key"]);
      if (contract && !contractCur.has(contract))
        contractCur.set(contract, await contractCurrencyRef(conn, contractSet, contract));
      const curRef = (contract ? contractCur.get(contract) : undefined) ?? docCur;
      const cur = await currencyByRef(conn, curRef);
      if (!cur) {
        next.push(raw);
        continue;
      }
      const rate = await rateForDocument(conn, cur, date);
      const onDate = !rate || cur.isTenge || String(rate.period ?? "").slice(0, 10) === date;
      if (rate && !onDate) {
        // курс только на дату документа: запись от более ранней даты — курс не загрузили (в базах курс есть на каждый
        // календарный день, и на выходные тоже) — не подставляем устаревший молча
        notes.add(
          `Курс взаиморасчётов не заполнен: в 1С нет курса ${cur.name || cur.code} на дату документа ${date} ` +
            `(последний загруженный — ${rate.rate} от ${String(rate.period ?? "").slice(0, 10)}). Загрузите курс на эту ` +
            "дату в 1С или передайте КурсВзаиморасчетов и КратностьВзаиморасчетов в строке.",
        );
        next.push(raw);
        continue;
      }
      if (!rate) {
        notes.add(
          `Курс взаиморасчётов не заполнен: в 1С нет курса ${cur.name || cur.code} на ${date}. Загрузите курсы валют ` +
            "или передайте КурсВзаиморасчетов и КратностьВзаиморасчетов в строке.",
        );
        next.push(raw);
        continue;
      }
      const row: Record<string, unknown> = { ...raw, КурсВзаиморасчетов: rate.rate };
      if (types.has("КратностьВзаиморасчетов"))
        row["КратностьВзаиморасчетов"] = asType("КратностьВзаиморасчетов", rate.multiplier);
      const amount = Number(raw["СуммаПлатежа"] ?? raw["Сумма"] ?? 0);
      if (types.has("СуммаВзаиморасчетов") && !(Number(raw["СуммаВзаиморасчетов"] ?? 0) > 0) && amount > 0) {
        if (!docCur || low(docCur) === low(cur.ref)) row["СуммаВзаиморасчетов"] = amount;
        else {
          const dc = await currencyByRef(conn, docCur);
          const dr = dc ? await rateForDocument(conn, dc, date) : undefined;
          if (dr)
            row["СуммаВзаиморасчетов"] = round2(
              ((amount * dr.rate) / dr.multiplier) * (rate.multiplier / rate.rate),
            );
          else
            notes.add(
              `Сумма взаиморасчётов строки ${i + 1} не пересчитана: нет курса валюты документа на ${date}.`,
            );
        }
      }
      if (!cur.isTenge)
        notes.add(
          `Курс взаиморасчётов: ${cur.name || cur.code} ${rate.rate} за ${rate.multiplier} — курс из 1С на дату документа ` +
            `${date}. Если по договору или в банке другой курс — передайте его явно.`,
        );
      next.push(row);
    }
    out = { ...out, [prop.name]: next };
  }
  return { payload: out, notes: [...notes] };
}
