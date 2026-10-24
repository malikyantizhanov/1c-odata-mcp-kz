import type { Connection } from "../context.js";
import { InputError } from "../errors.js";
import { catalogFields } from "../odata/catalog-fields.js";
import { ODataError } from "../odata/errors.js";
import { fuzzyCandidates } from "../odata/fuzzy.js";
import { fetchAll } from "../odata/pagination.js";
import { ensurePublished } from "../odata/publication.js";
import { and, buildQuery, cmp, contains, or, odataString } from "../odata/query.js";
import { codeFilterValues, noAccessMessage } from "./catalog-read.js";
import { isGuid } from "./subconto.js";

/**
 * Элемент справочника по Ref_Key, по коду (только цифры: точный код с нормализацией нулей) или по названию: точное совпадение, иначе по части названия. Группы и помеченные на
 * удаление не берутся. Не найден или неоднозначен — InputError с вариантами (модель уточняет у пользователя).
 */
export async function resolveCatalogItem(
  conn: Connection,
  entity: string,
  value: string,
  label: string,
): Promise<{ ref: string; name: string }> {
  const text = value.trim();
  ensurePublished(await conn.available(), entity, `Справочник «${label}»`);
  const fields = await catalogFields(conn, entity);
  const props = (await conn.getMetadata()).entities.get(entity)?.properties ?? [];
  const has = (n: string) => props.some((p) => p.name === n);
  const live = and(
    fields.isFolder ? cmp(fields.isFolder, "eq", "false") : undefined,
    has("DeletionMark") ? cmp("DeletionMark", "eq", "false") : undefined,
  );
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ODataError && e.kind === "auth")
        throw new InputError(noAccessMessage(entity, e.status));
      throw e;
    }
  };
  if (isGuid(text)) {
    const guid = text.replace(/[{}']/g, "");
    const row = await guard(() =>
      conn.client
        .getEntity(`${entity}(guid'${guid}')${buildQuery({ select: [fields.ref, fields.name] })}`)
        .catch((e: unknown) => {
          if (e instanceof ODataError && e.kind === "not_found")
            throw new InputError(`${label}: элемента ${guid} нет в ${entity}.`);
          throw e;
        }),
    );
    return { ref: guid, name: String(row[fields.name] ?? "") };
  }
  const find = (filter: string | undefined) =>
    guard(() =>
      fetchAll(
        conn.client,
        entity,
        {
          select: [fields.ref, fields.name],
          filter: and(filter, live) || undefined,
          orderby: `${fields.name},${fields.ref}`,
        },
        50,
        11,
      ),
    );
  // Только цифры — это может быть код справочника («000000104», «104»): точное совпадение с нормализацией нулей.
  if (/^\d+$/.test(text) && fields.code) {
    let length: number | undefined;
    try {
      const sample = await conn.client.getCollection(entity + buildQuery({ select: [fields.code], top: 1 }));
      const first = sample.value?.[0]?.[fields.code];
      length = typeof first === "string" && first ? first.length : undefined;
    } catch {
      // образец кода не прочитан — ищем по введённым вариантам
    }
    const byCode = (
      await find(or(...codeFilterValues(text, length).map((c) => cmp(fields.code, "eq", odataString(c)))))
    ).rows;
    if (byCode.length === 1)
      return { ref: String(byCode[0]![fields.ref]), name: String(byCode[0]![fields.name]) };
    if (byCode.length > 1)
      throw new InputError(
        `${label} с кодом «${text}» неоднозначна: ${byCode.map((r) => `«${String(r[fields.name])}» (${String(r[fields.ref])})`).join("; ")}. Передайте Ref_Key.`,
      );
  }
  const exact = (await find(cmp(fields.name, "eq", odataString(text)))).rows;
  const hits = exact.length ? exact : (await find(contains(fields.name, text))).rows;
  const list = (rows: typeof hits) =>
    rows.map((r) => `«${String(r[fields.name])}» (${String(r[fields.ref])})`).join("; ");
  if (hits.length === 1) return { ref: String(hits[0]![fields.ref]), name: String(hits[0]![fields.name]) };
  if (!hits.length) {
    // Вхождения нет — похожие по написанию (ё/е, кавычки, латиница ↔ кириллица, опечатки): кандидаты с оценкой.
    const similar = await guard(() =>
      fuzzyCandidates(conn, entity, text, {
        nameFields: [fields.name, fields.fullName].filter(Boolean),
        select: [fields.ref, fields.name, fields.fullName].filter(Boolean),
        filter: live || undefined,
        limit: 10,
      }),
    ).catch((e: unknown) => {
      if (e instanceof InputError) throw e;
      return [];
    });
    // Тот же текст с точностью до регистра, ё/е и кавычек — это он и есть.
    const same = similar.filter((h) => h.score >= 0.98);
    if (same.length === 1)
      return { ref: String(same[0]!.row[fields.ref]), name: String(same[0]!.row[fields.name]) };
    throw new InputError(
      similar.length
        ? `${label} «${text}» не найдена в ${entity} точно; похожие (score 0..1): ` +
            similar
              .map((h) => `«${String(h.row[fields.name])}» (${String(h.row[fields.ref])}, score ${h.score})`)
              .join("; ") +
            ". Передайте Ref_Key нужной (уточните у пользователя)."
        : `${label} «${text}» не найдена в ${entity} ни по вхождению, ни по похожему написанию. Посмотрите список: ` +
            `read.catalog.list_catalog (entitySet=${entity}), затем передайте Ref_Key или точное название. ` +
            "Нужного элемента может не быть — тогда его заводят в 1С.",
    );
  }
  throw new InputError(
    `${label} «${text}» неоднозначна: ${list(hits.slice(0, 10))}${hits.length > 10 ? " и другие" : ""}. Передайте Ref_Key или точное название.`,
  );
}
