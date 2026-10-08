import type { Connection } from "../context.js";
import type { ODataEntity } from "../types/odata.js";
import { buildQuery } from "./query.js";
import { recorderFilter } from "./accounting.js";

/** Наборы записей регистров, подчинённых регистратору: <Класс>Register_<Имя>_RecordType с полем Recorder. */
const RECORD_SET_RE = /^(Accumulation|Information|Accounting)Register_(.+)_RecordType$/;

export interface RegisterMovements {
  register: string;
  count: number;
  truncated: boolean;
  rows: ODataEntity[];
}

export interface DocumentMovements {
  document: string;
  ref: string;
  registersChecked: number;
  withRecords: RegisterMovements[];
  errors: Array<{ register: string; error: string }>;
  note: string;
}

/** Убирает служебные поля регистратора и навигационные ссылки — они одинаковы у всех строк. */
function compactRow(r: ODataEntity): ODataEntity {
  const out: ODataEntity = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "Recorder" || k === "Recorder_Type" || k.includes("@")) continue;
    out[k] = v;
  }
  return out;
}

/** Нормализует имя регистра: «НДС», «AccumulationRegister_НДС» или полное имя набора записей. */
export function matchRegister(entitySet: string, wanted: readonly string[]): boolean {
  const m = RECORD_SET_RE.exec(entitySet);
  if (!m) return false;
  const base = entitySet.replace(/_RecordType$/, "");
  return wanted.some((w) => w === entitySet || w === base || w === m[2]);
}

/**
 * Движения документа по всем регистрам (накопления, сведений, бухгалтерии), опубликованным в OData:
 * отбор по регистратору на стороне 1С (тот же синтаксис, что у проводок). Нужен для документов,
 * которые не делают проводок (счёт-фактура, кадровые документы): проведён ли он «по-настоящему».
 */
export async function getDocumentMovements(
  conn: Connection,
  documentEntity: string,
  ref: string,
  opts: { registers?: string[]; limit?: number; concurrency?: number } = {},
): Promise<DocumentMovements> {
  const meta = await conn.getMetadata();
  const limit = opts.limit ?? 20;
  let sets = [...meta.entities.values()]
    .filter((e) => RECORD_SET_RE.test(e.entitySet) && e.properties.some((p) => p.name === "Recorder"))
    .map((e) => e.entitySet)
    .sort();
  if (opts.registers?.length) sets = sets.filter((s) => matchRegister(s, opts.registers!));
  const filter = recorderFilter(documentEntity, ref);
  const withRecords: RegisterMovements[] = [];
  const errors: Array<{ register: string; error: string }> = [];
  const queue = [...sets];
  const worker = async () => {
    for (let set = queue.shift(); set; set = queue.shift()) {
      try {
        const page = await conn.client.getCollection(`${set}${buildQuery({ filter, top: limit + 1 })}`);
        const rows = page.value ?? [];
        if (rows.length)
          withRecords.push({
            register: set.replace(/_RecordType$/, ""),
            count: Math.min(rows.length, limit),
            truncated: rows.length > limit,
            rows: rows.slice(0, limit).map(compactRow),
          });
      } catch (e) {
        errors.push({
          register: set.replace(/_RecordType$/, ""),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 6) }, worker));
  withRecords.sort((a, b) => a.register.localeCompare(b.register));
  errors.sort((a, b) => a.register.localeCompare(b.register));
  return {
    document: documentEntity,
    ref,
    registersChecked: sets.length,
    withRecords,
    errors,
    note:
      "Проверены только регистры, опубликованные в OData (состав OData базы). Нет записей в опубликованных " +
      "регистрах — не значит, что их нет в неопубликованных (напр. журнал учёта счетов-фактур).",
  };
}
