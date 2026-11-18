import type { Connection } from "../context.js";
import { InputError } from "../errors.js";

/**
 * Перечисления базы из $metadata (`<EnumType Name="…"><Member Name="…"/>`): имя → значения.
 *
 * Зачем (прод 16.11.2026, платёжка по КПН у источника): «Вид платежа» в аналитике платёжки — составное поле
 * СубконтоДтБУ2, а «Налог» — значение перечисления ВидыПлатежейВБюджетИФонды. У перечисления нет guid: 1С хранит
 * значение именем и тип в `_Type` (`"Налог"`, `StandardODATA.ВидыПлатежейВБюджетИФонды`). Запись требовала guid —
 * «для СубконтоДтБУ2 не известен справочник — передайте guid», и агент просил бухгалтера ставить вручную.
 */
const CACHE = new WeakMap<object, Promise<Map<string, string[]>>>();

export function enumTypes(conn: Connection): Promise<Map<string, string[]>> {
  const key = conn.client as object;
  let hit = CACHE.get(key);
  if (!hit) {
    hit = conn.client
      .getText("$metadata")
      .then((xml) => {
        const out = new Map<string, string[]>();
        for (const m of xml.matchAll(/<EnumType Name="([^"]+)"[^>]*>([\s\S]*?)<\/EnumType>/g)) {
          out.set(
            m[1]!,
            [...m[2]!.matchAll(/Member Name="([^"]+)"/g)].map((x) => x[1]!),
          );
        }
        return out;
      })
      .catch((e: unknown) => {
        CACHE.delete(key); // не прочитали — в следующий раз заново, без «пустых» перечислений навсегда
        throw e;
      });
    CACHE.set(key, hit);
  }
  return hit;
}

const fold = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/**
 * Значение перечисления для составного поля: `{type, member}` или undefined (не перечисление — дальше справочник).
 * `type` — тип, названный вызывающим (с префиксом StandardODATA. или без); без него — перечисление, где такое
 * значение одно на всю базу. Значение есть в нескольких перечислениях — InputError: назовите тип.
 */
export async function enumValue(
  conn: Connection,
  text: string,
  type: string | undefined,
  where: string,
): Promise<{ type: string; member: string } | undefined> {
  let enums: Map<string, string[]>;
  try {
    enums = await enumTypes(conn);
  } catch {
    return undefined;
  }
  const want = fold(text);
  const given = type?.replace(/^StandardODATA\./, "");
  if (given) {
    const members = enums.get(given);
    if (!members) return undefined; // названный тип — не перечисление (справочник): обычный поиск ссылки
    const member = members.find((m) => fold(m) === want);
    if (!member)
      throw new InputError(
        `${where}: в перечислении ${given} нет значения «${text}». Допустимые: ${members.join(", ")}.`,
      );
    return { type: given, member };
  }
  const hits = [...enums].flatMap(([t, ms]) =>
    ms.filter((m) => fold(m) === want).map((m) => ({ type: t, member: m })),
  );
  if (hits.length > 1) {
    throw new InputError(
      `${where}: «${text}» есть в нескольких перечислениях (${hits.map((h) => h.type).join(", ")}) — ` +
        'передайте {"name": "…", "type": "<перечисление>"}.',
    );
  }
  return hits[0];
}
