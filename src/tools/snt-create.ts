import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Connection, ServerContext } from "../context.js";
import { InputError } from "../errors.js";
import { ODataError } from "../odata/errors.js";
import { fetchAll } from "../odata/pagination.js";
import { requireEntity } from "../odata/publication.js";
import { and, buildQuery, cmp, odataGuid } from "../odata/query.js";
import { createResultSchema } from "../schemas/output.js";
import type { ODataEntity } from "../types/odata.js";
import { databaseField, dateField, guard } from "./_shared.js";
import { fitToMetadata } from "./esf-create.js";
import { checkEsfNumber, planEsfNumber, splitNumber } from "./esf-fill.js";
import { confirmField, createOrPreview, odataDate, stripForCopy } from "./write.js";

/**
 * Черновик исходящей СНТ (сопроводительной накладной на товары) по реализации — по образцу прошлой СНТ этому же
 * покупателю. Создать СНТ «на основании» через OData нельзя (заполнение формы 1С не вызывается), а собрать с нуля
 * все ~230 реквизитов ИС ЭСФ (грузоотправитель/получатель, транспорт, ТН ВЭД, признак происхождения, валютный
 * контроль) — значит наугад: по СНТ баз прода (12.11.2026) отказы ИС ЭСФ — как раз «код ТН ВЭД не соответствует
 * признаку происхождения», «не заполнено поле Нерезидент». Поэтому шапка и строки берутся из образца, а основание,
 * даты, курс, количество и суммы — из реализации. Поля обмена с ИС не переносятся; черновик — как у СНТ, созданной в
 * 1С: Статус «Черновик», Состояние «Сформирован». Подписание и отправка — только в 1С.
 */

export const SNT = "Document_СНТ";
const SALE = "Document_РеализацияТоваровУслуг";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const GUID = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "Ref_Key — GUID");
const guidOf = (s: string) => s.replace(/[{}']/g, "").toLowerCase();
const isRef = (v: unknown): v is string => typeof v === "string" && v !== "" && v !== EMPTY_GUID;
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const day = (v: unknown) => str(v).slice(0, 10);

/** СНТ, по которым новую по тому же основанию не создаём (живые): всё, кроме отозванных, аннулированных и ошибочных. */
const DEAD_STATUSES = new Set(["Отозван", "Аннулирован", "Ошибочный"]);
/** Образец — исходящая СНТ, принятая ИС или черновик: её реквизиты проверены (ошибочная — нет). */
const SAMPLE_STATUSES = new Set(["Подтвержден", "НеПросмотрен", "Доставленный", "Черновик"]);
/** Поля обмена с ИС ЭСФ и прошлого состояния — в новый черновик не переносим. */
export const SNT_EXCHANGE_FIELDS = [
  "Идентификатор",
  "РегистрационныйНомерИСЭСФ",
  "ДатаРегистрацииИСЭСФ",
  "ДатаОтзыва",
  "Причина",
  "НомерСНТ",
  "Статус",
  "Состояние",
  "Комментарий",
];
const EXCHANGE_PREFIXES = ["ЭЦП", "ДатаПодпис", "ДатаПодтвержд"];

async function getDoc(conn: Connection, set: string, ref: string, label: string): Promise<ODataEntity> {
  try {
    return await conn.client.getEntity(`${set}(guid'${guidOf(ref)}')${buildQuery({})}`);
  } catch (e) {
    if (e instanceof ODataError && e.kind === "not_found")
      throw new InputError(`${label} ${ref} не найден в базе.`);
    throw e;
  }
}

/** НомерСНТ нового черновика — в формате образца: как номер документа без префикса или коротким числом. */
export function sntNumberLike(sample: ODataEntity, number: string): string | undefined {
  const was = str(sample["НомерСНТ"]);
  const sampleNo = splitNumber(sample["Number"]);
  const next = splitNumber(number);
  if (!was || !sampleNo || !next) return undefined;
  const sampleDigits = str(sample["Number"]).slice(sampleNo.prefix.length);
  if (was === sampleDigits) return number.slice(next.prefix.length);
  if (/^\d+$/.test(was) && Number(was) === sampleNo.value) return String(next.value);
  return undefined;
}

export function registerSntCreateTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "write.snt.create_draft",
    {
      title: "Черновик исходящей СНТ по реализации",
      description:
        "Создаёт НЕпроведённый черновик исходящей СНТ (Document_СНТ) по реализации товаров (basisRef) — по образцу " +
        "прошлой СНТ этому же покупателю (sampleRef или последняя принятая ИС ЭСФ): из образца — грузоотправитель и " +
        "грузополучатель, адреса, транспорт, договор поставки, валютный контроль, а в строках — код ТН ВЭД, единица, " +
        "признак происхождения; из реализации — основание, дата отгрузки, курс, количество, цена и суммы. Номер — " +
        "следующий по нумератору СНТ организации (формат НомерСНТ — как у образца). Поля обмена с ИС ЭСФ (рег. номер, " +
        "идентификатор, ЭЦП, статусы) не переносятся: Статус «Черновик», Состояние «Сформирован». Отказ: в реализации " +
        "нет товаров; по ней уже есть живая СНТ; у покупателя нет прошлой СНТ-образца (первую оформите в 1С «на " +
        "основании»); в образце нет строки для товара реализации. Подписание ЭЦП и отправка — только в 1С. " +
        "Предпросмотр по умолчанию; создание — confirm=true с operationId после согласия бухгалтера.",
      inputSchema: {
        database: databaseField,
        basisRef: GUID.describe("Ref_Key реализации товаров и услуг"),
        sampleRef: GUID.describe(
          "Ref_Key СНТ-образца (по умолчанию — последняя СНТ этому покупателю)",
        ).optional(),
        date: dateField("Дата СНТ (по умолчанию — сегодня)").optional(),
        shipmentDate: dateField("Дата отгрузки (по умолчанию — дата реализации)").optional(),
        confirm: confirmField,
      },
      outputSchema: createResultSchema,
    },
    ({ database, basisRef, sampleRef, date, shipmentDate, confirm }) =>
      guard("write.snt.create_draft", async () => {
        const conn = ctx.db(database);
        const set = await requireEntity(conn, [SNT], "Документ «СНТ» (сопроводительная накладная на товары)");
        const saleSet = await requireEntity(conn, [SALE], "Документ «Реализация товаров и услуг»");
        const warnings: string[] = [];
        const checks: string[] = [];
        const refuse: string[] = [];
        const sale = await getDoc(conn, saleSet, basisRef, "Реализация");
        if (sale["DeletionMark"] === true) refuse.push("Реализация помечена на удаление.");
        if (sale["Posted"] !== true) warnings.push("Реализация не проведена — проведите её до отправки СНТ.");
        const org = isRef(sale["Организация_Key"]) ? String(sale["Организация_Key"]) : undefined;
        const cp = isRef(sale["Контрагент_Key"]) ? String(sale["Контрагент_Key"]) : undefined;
        if (!org) refuse.push("В реализации не указана организация.");
        if (!cp) refuse.push("В реализации не указан контрагент.");
        const goods = ((sale["Товары"] as ODataEntity[] | undefined) ?? []).filter((r) =>
          isRef(r["Номенклатура_Key"]),
        );
        if (!goods.length) refuse.push("В реализации нет строк товаров — СНТ оформляют на товары.");
        if (refuse.length)
          throw new InputError(`СНТ не создана — проверки не пройдены:\n- ${refuse.join("\n- ")}`);

        const { rows: ofBuyer, truncated } = await fetchAll(
          conn.client,
          set,
          {
            filter: and(
              cmp("DeletionMark", "eq", "false"),
              cmp("Контрагент_Key", "eq", odataGuid(guidOf(cp!))),
            ),
            // Без $select: строки ТоварыВС нужны, чтобы выбрать образец со всеми товарами реализации.
          },
          conn.behavior.pageSize,
          conn.behavior.maxRows,
        );
        if (truncated) warnings.push("СНТ покупателя больше лимита строк — проверка на дубль неполная.");
        const live = ofBuyer.filter(
          (r) => same(r["ДокументОснование"], basisRef) && !DEAD_STATUSES.has(str(r["Статус"])),
        );
        if (live.length)
          throw new InputError(
            `По реализации уже есть СНТ: ${live
              .map(
                (r) =>
                  `№ ${str(r["Number"])} от ${day(r["Date"])} (${str(r["Статус"]) || "без статуса"}, Ref_Key ${str(r["Ref_Key"])})`,
              )
              .join("; ")}. Дубль не создаём.`,
          );
        checks.push("по реализации живой СНТ ещё нет");

        let sample: ODataEntity | undefined;
        if (sampleRef) sample = await getDoc(conn, set, sampleRef, "СНТ-образец");
        else {
          // Образец — самая свежая подходящая СНТ покупателя, где есть строки на все товары реализации; иначе
          // самая свежая (отказ ниже назовёт недостающие товары). Прод 12.11.2026, Ю-Агро: товар был только в СНТ № 3
          // от 2025-06-24 — 23-й по свежести из 25 СНТ покупателя, поэтому смотрим все, а не первые N.
          const picks = ofBuyer
            .filter((r) => str(r["Направление"]) === "Исходящий" && SAMPLE_STATUSES.has(str(r["Статус"])))
            .sort((a, b) => str(b["Date"]).localeCompare(str(a["Date"])));
          const need = goods.map((g) => guidOf(str(g["Номенклатура_Key"])));
          const covers = (r: ODataEntity): boolean => {
            const has = new Set(
              ((r["ТоварыВС"] as ODataEntity[] | undefined) ?? []).map((x) => guidOf(str(x["Товар"]))),
            );
            return need.every((n) => has.has(n));
          };
          const pick = picks.find(covers) ?? picks[0];
          if (pick) sample = await getDoc(conn, set, str(pick["Ref_Key"]), "СНТ-образец");
        }
        if (!sample)
          throw new InputError(
            "СНТ не создана: у покупателя нет прошлой СНТ-образца — коды ТН ВЭД, признак происхождения, транспорт и " +
              "валютный контроль взять негде. Первую СНТ этому покупателю оформите в 1С («Создать на основании» " +
              "реализации), дальше черновики — по её образцу.",
          );
        checks.push(`образец — СНТ № ${str(sample["Number"])} от ${day(sample["Date"])}`);

        const docDay = date ?? odataDate(new Date()).slice(0, 10);
        const planned = await planEsfNumber(conn, set, docDay, org!);
        const busy = await checkEsfNumber(conn, set, planned.number, docDay, org!);
        if (busy.refuse) throw new InputError(busy.refuse.replace("исходящим ЭСФ", "исходящей СНТ"));
        checks.push(`номер ${planned.number} — ${planned.how.replace(/ЭСФ/g, "СНТ")}`);

        const payload = stripForCopy(sample);
        for (const k of Object.keys(payload))
          if (SNT_EXCHANGE_FIELDS.includes(k) || EXCHANGE_PREFIXES.some((p) => k.startsWith(p)))
            delete payload[k];
        if (Array.isArray(payload["Ошибки"])) payload["Ошибки"] = [];
        const sntNo = sntNumberLike(sample, planned.number);
        if (!sntNo)
          warnings.push(
            "Номер СНТ (поле «Номер СНТ») не заполнен: формат образца не распознан — впишите в 1С.",
          );

        const baseRows = new Map(
          ((sample["ТоварыВС"] as ODataEntity[] | undefined) ?? []).map(
            (r) => [guidOf(str(r["Товар"])), r] as const,
          ),
        );
        const includesVat = sale["СуммаВключаетНДС"] === true;
        const missing: string[] = [];
        const rows = goods.map((g, i) => {
          const base = baseRows.get(guidOf(str(g["Номенклатура_Key"])));
          if (!base) {
            missing.push(`строка ${i + 1} (Номенклатура_Key ${str(g["Номенклатура_Key"])})`);
            return {};
          }
          const qty = Number(g["Количество"] ?? 0);
          const vat = money(g["СуммаНДС"]);
          const sum = money(g["Сумма"]);
          const without = money(includesVat ? sum - vat : sum);
          const row: Record<string, unknown> = {
            ...Object.fromEntries(
              Object.entries(base).filter(
                ([k]) => !["Ref_Key", "LineNumber"].includes(k) && !k.includes("@"),
              ),
            ),
            LineNumber: i + 1,
            НомерСтрокиСНТ: i + 1,
            Товар: guidOf(str(g["Номенклатура_Key"])),
            Количество: qty,
            Цена: qty ? money(without / qty) : money(g["Цена"]),
            СуммаБезНалогов: without,
            ОборотПоРеализации: without,
            Сумма: money(without + vat),
          };
          if (isRef(g["СтавкаНДС_Key"])) row["СтавкаНДС_Key"] = g["СтавкаНДС_Key"];
          if ("СуммаНДС" in base) row["СуммаНДС"] = vat;
          return row;
        });
        if (missing.length)
          throw new InputError(
            `СНТ не создана: в образце (СНТ № ${str(sample["Number"])}) нет строк для товаров реализации — ${missing.join(
              "; ",
            )}. Код ТН ВЭД, единицу и признак происхождения взять негде: добавьте товар в СНТ в 1С или выберите другой образец (sampleRef).`,
          );
        const total = money(rows.reduce((s, r) => s + Number(r["Сумма"] ?? 0), 0));

        const contractRef = isRef(sale["ДоговорКонтрагента_Key"])
          ? String(sale["ДоговорКонтрагента_Key"])
          : undefined;
        if (contractRef && !same(contractRef, payload["ДоговорПоставки_Key"])) {
          const contract = await conn.client
            .getEntity<ODataEntity>(
              `Catalog_ДоговорыКонтрагентов(guid'${guidOf(contractRef)}')${buildQuery({})}`,
            )
            .catch(() => undefined);
          payload["ДоговорПоставки_Key"] = guidOf(contractRef);
          if (contract) {
            payload["ДоговорПоставкиНомер"] = str(contract["НомерДоговора"]) || str(contract["Description"]);
            if (day(contract["ДатаДоговора"]) && !day(contract["ДатаДоговора"]).startsWith("0001"))
              payload["ДоговорПоставкиДата"] = contract["ДатаДоговора"];
          }
          warnings.push(
            "Договор поставки — из реализации (в образце был другой): проверьте условия поставки и оплаты.",
          );
        }
        for (const [k, v] of Object.entries(payload))
          if (Array.isArray(v) && v.length && !["ТоварыВС", "Ошибки"].includes(k))
            warnings.push(
              `Таблица «${k}» скопирована из образца (${v.length} стр.) — проверьте, что она верна для этой отгрузки.`,
            );

        Object.assign(payload, {
          Number: planned.number,
          Date: `${docDay}T${odataDate(new Date()).slice(11)}`,
          Статус: "Черновик",
          Состояние: "Сформирован",
          ТипСНТ: "Первичная",
          ...(sntNo ? { НомерСНТ: sntNo } : {}),
          Организация_Key: guidOf(org!),
          Контрагент_Key: guidOf(cp!),
          ДокументОснование: guidOf(basisRef),
          ДокументОснование_Type: `StandardODATA.${SALE}`,
          ДатаОтгрузкиТовара: `${shipmentDate ?? day(sale["Date"])}T00:00:00`,
          КурсВалюты: Number(sale["КурсВзаиморасчетов"] ?? 1) || 1,
          ТоварыВС: rows,
          СуммаДокумента: total,
        });
        warnings.push(
          "Черновик не проведён и не отправлен: проверьте в 1С грузоотправителя/получателя, транспорт и вагон, " +
            "подпишите ЭЦП и отправьте в ИС ЭСФ из 1С.",
        );
        delete payload["Posted"]; // создаётся непроведённой
        const fitted = await fitToMetadata(conn, set, payload, warnings, new Set(["Состояние"]));
        return createOrPreview(conn, set, fitted, confirm, [
          ...checks.map((c) => `Проверено: ${c}`),
          ...warnings,
        ]);
      }),
  );
}
