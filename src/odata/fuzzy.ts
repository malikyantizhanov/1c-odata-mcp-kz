import type { Connection } from "../context.js";
import type { ODataEntity } from "../types/odata.js";
import { fetchAll } from "./pagination.js";
import { and, cmp, contains, odataString, or } from "./query.js";

/**
 * Нечёткий поиск по наименованиям справочников (контрагенты, номенклатура, договоры). Агенты и пользователи пишут
 * «Шнайдер»/«Schneider», а в базе — «Шнейдер Электрик ТОО»: точный substringof такое не находит. Сравнение идёт по
 * «скелету» слова: регистр, ё/е, кавычки и организационно-правовая форма убираются, кириллица и латиница сводятся
 * к одной транслитерации, близкое написание добирается расстоянием Левенштейна. На сервер 1С уходит только
 * отбор-кандидат (substringof по началу и концу слов в обеих азбуках) — оценка считается здесь.
 */

/** Организационно-правовые формы (РК, РФ и латиницей): в сравнении не участвуют. */
const LEGAL_FORMS = [
  "товарищество с ограниченной ответственностью",
  "общество с ограниченной ответственностью",
  "индивидуальный предприниматель",
  "акционерное общество",
  "публичное акционерное общество",
  "закрытое акционерное общество",
  "открытое акционерное общество",
  "крестьянское хозяйство",
  "фермерское хозяйство",
  "тоо",
  "ооо",
  "ип",
  "ао",
  "пао",
  "зао",
  "оао",
  "чп",
  "кх",
  "фх",
  "гу",
  "ргп",
  "гкп",
  "кгу",
  "too",
  "llp",
  "llc",
  "ltd",
  "jsc",
  "inc",
  "gmbh",
  "ip",
  "ao",
  "plc",
  "corp",
  "co",
];
const LEGAL_RE = new RegExp(
  `(^|\\s)(${[...LEGAL_FORMS]
    .sort((a, b) => b.length - a.length)
    .map((f) => f.replace(/ /g, "\\s+"))
    .join("|")})(?=\\s|$)`,
  "gu",
);

/** Наименование для сравнения: регистр, ё/е, кавычки, знаки препинания и ОПФ («ТОО», «LLP») не важны. */
export function normalizeName(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»“”„"'`’‘]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Повторяем: «ТОО «АО Ромашка»» — две формы подряд.
  let out = base;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEGAL_RE, " ").replace(/\s+/g, " ").trim();
    if (next === out) break;
    out = next;
  }
  // Название целиком из ОПФ («ИП») — оставляем как есть, иначе сравнивать нечего.
  return out || base;
}

const CYR_TO_LAT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ъ: "",
  ы: "i",
  ь: "",
  э: "e",
  ю: "iu",
  я: "ia",
  // казахский алфавит
  ә: "a",
  ғ: "g",
  қ: "k",
  ң: "n",
  ө: "o",
  ұ: "u",
  ү: "u",
  һ: "h",
  і: "i",
};

/** Латиница → кириллица (для отбора-кандидата на сервере): сначала сочетания, потом буквы. */
const LAT_TO_CYR: Array<[string, string]> = [
  ["shch", "щ"],
  ["sch", "ш"],
  ["tsch", "ч"],
  ["sh", "ш"],
  ["ch", "ч"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ts", "ц"],
  ["tz", "ц"],
  ["ya", "я"],
  ["ja", "я"],
  ["yu", "ю"],
  ["ju", "ю"],
  ["yo", "е"],
  ["ei", "ей"],
  ["ey", "ей"],
  ["ai", "ай"],
  ["ay", "ай"],
  ["oi", "ой"],
  ["oy", "ой"],
  ["ck", "к"],
  ["ph", "ф"],
  ["th", "т"],
  ["ee", "и"],
  ["oo", "у"],
  ["a", "а"],
  ["b", "б"],
  ["c", "к"],
  ["d", "д"],
  ["e", "е"],
  ["f", "ф"],
  ["g", "г"],
  ["h", "х"],
  ["i", "и"],
  ["j", "дж"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["q", "к"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["v", "в"],
  ["w", "в"],
  ["x", "кс"],
  ["y", "и"],
  ["z", "з"],
];

/** Кириллица (в т.ч. казахская) → латиница; латиница остаётся. */
export function toLatin(s: string): string {
  return [...s.toLowerCase()].map((c) => CYR_TO_LAT[c] ?? c).join("");
}

/** Латиница → кириллица; кириллица остаётся. */
export function toCyrillic(s: string): string {
  let out = "";
  const t = s.toLowerCase();
  for (let i = 0; i < t.length;) {
    const hit = LAT_TO_CYR.find(([lat]) => t.startsWith(lat, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
    } else {
      out += t[i];
      i++;
    }
  }
  return out;
}

/**
 * «Скелет» слова для сравнения кириллицы с латиницей: транслитерация и сведение близких написаний
 * (sch/sh, c/k, w/v, ph/f, y/i, удвоенные буквы). «Schneider» и «Шнейдер» дают один скелет.
 */
export function skeleton(word: string): string {
  return (
    toLatin(word)
      .replace(/tsch/g, "ch")
      .replace(/sch/g, "sh")
      .replace(/ck/g, "k")
      .replace(/ph/g, "f")
      .replace(/kh/g, "h")
      .replace(/tz/g, "ts")
      .replace(/x/g, "ks")
      .replace(/w/g, "v")
      .replace(/q/g, "k")
      // Мягкая c латиницы перед e/i/y — «s»: «Space» ~ «Спейс».
      .replace(/c(?=[eiy])/g, "s")
      .replace(/c(?!h)/g, "k")
      .replace(/y/g, "i")
      .replace(/j/g, "i")
      .replace(/(.)\1+/g, "$1")
  );
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Похожесть слова запроса на слово названия, 0..1: совпадение, начало слова, близкое написание. */
function wordScore(q: string, w: string): number {
  if (q === w) return 1;
  if (q.length >= 3 && w.startsWith(q)) return 0.9;
  if (q.length >= 4 && w.includes(q)) return 0.8;
  const len = Math.max(q.length, w.length);
  // Близкое написание: сравниваем и с началом слова той же длины («Шнайд» ~ «Шнейдер»).
  const full = 1 - levenshtein(q, w) / len;
  const head = q.length >= 4 && w.length > q.length ? 1 - levenshtein(q, w.slice(0, q.length)) / q.length : 0;
  return Math.max(full, head * 0.85);
}

const tokens = (s: string): string[] => normalizeName(s).split(" ").filter(Boolean);

/**
 * Оценка совпадения запроса с наименованием, 0..1. 1 — то же название (без учёта ОПФ, регистра, кавычек и азбуки),
 * ≥ 0.85 — все слова запроса есть в названии в близком написании, меньше — частичное сходство.
 */
export function nameScore(query: string, name: string): number {
  const qn = normalizeName(query);
  const nn = normalizeName(name);
  if (!qn || !nn) return 0;
  if (qn === nn) return 1;
  const qs = tokens(query).map(skeleton);
  const ns = tokens(name).map(skeleton);
  if (qs.join(" ") === ns.join(" ")) return 0.98;
  if (` ${nn} `.includes(` ${qn} `) || ` ${ns.join(" ")} `.includes(` ${qs.join(" ")} `)) return 0.95;
  if (!qs.length || !ns.length) return 0;
  // Английское слово, записанное кириллицей на слух («ТрейдСпейс» ~ «TRADESPACE»): гласные передаются по-разному,
  // согласные — нет. Совпадают согласные всего названия (от 4) — почти то же название.
  const cons = (xs: string[]) => xs.join("").replace(/[aeiou]/g, "");
  if (cons(qs).length >= 4 && cons(qs) === cons(ns)) return 0.9;
  const per = qs.map((q) => Math.max(...ns.map((w) => wordScore(q, w))));
  const avg = per.reduce((s, x) => s + x, 0) / per.length;
  return Math.round(avg * 0.95 * 100) / 100;
}

/** Порог «похоже»: ниже кандидаты не показываются. */
export const FUZZY_MIN = 0.6;
/** Порог «то же самое»: выше — можно считать совпадением, если кандидат один. */
export const FUZZY_SURE = 0.9;

/**
 * Подстроки для серверного отбора-кандидата: начало и конец значимых слов — как ввели, кириллицей и латиницей.
 * «Шнайдер» → «шна», «дер», «shn», «der»; «Schneider» → «sch», «der», «шне», «дер».
 */
export function probes(query: string): string[] {
  const words = tokens(query)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  const out = new Set<string>();
  for (const w of words)
    // «ей» на слух — английская «a» («Трейд» ~ «Trade»): ещё вариант латиницей с «a».
    for (const v of [w, toCyrillic(w), toLatin(w), toLatin(w).replace(/ei/g, "a")]) {
      if (v.length < 3) continue;
      out.add(v.slice(0, 3));
      if (v.length >= 5) out.add(v.slice(-3));
    }
  return [...out];
}

/**
 * Нечёткая подстановка: кандидат подставляется сам, только если он единственный сильный (оценка ≥ FUZZY_SURE,
 * у остальных ниже). Иначе — варианты на выбор.
 */
export function soleStrong<T extends { score: number }>(hits: T[]): T | undefined {
  const strong = hits.filter((h) => h.score >= FUZZY_SURE);
  return strong.length === 1 ? strong[0] : undefined;
}

/** Контрагент подставлен не по точному совпадению — структурное поле плана для карточки. */
export interface CounterpartyMatch {
  query: string;
  matched: { ref: string; name: string; bin?: string | undefined };
  exact: false;
  score: number;
}

export const counterpartyMatchNote = (m: CounterpartyMatch): string =>
  `Точного совпадения нет, беру ближайшее: «${m.matched.name}»${m.matched.bin ? ` (БИН ${m.matched.bin})` : ""} ` +
  `для «${m.query}», оценка ${m.score}. Проверьте с пользователем.`;

export interface FuzzyHit {
  row: ODataEntity;
  score: number;
}

/**
 * Кандидаты из справочника по нечёткому совпадению названия: отбор substringof по подстрокам из probes(),
 * оценка nameScore по всем nameFields, сортировка по убыванию оценки. Пустой список — похожих нет.
 */
export async function fuzzyCandidates(
  conn: Connection,
  set: string,
  query: string,
  opts: {
    nameFields: string[];
    select: string[];
    filter?: string | undefined;
    limit?: number;
    /** Сколько строк-кандидатов читать с сервера (по умолчанию 300). */
    scan?: number;
  },
): Promise<FuzzyHit[]> {
  const parts = probes(query);
  if (!parts.length) return [];
  // Подстроки ищем только в основном наименовании — короче URL; полное наименование участвует в оценке.
  const field = opts.nameFields[0]!;
  const { rows } = await fetchAll(
    conn.client,
    set,
    {
      filter: and(opts.filter, or(...parts.map((p) => contains(field, p)))) || undefined,
      select: [...new Set(opts.select)],
    },
    100,
    opts.scan ?? 300,
  );
  return rows
    .map((row) => ({
      row,
      score: Math.max(...opts.nameFields.map((f) => nameScore(query, String(row[f] ?? "")))),
    }))
    .filter((h) => h.score >= FUZZY_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10);
}

/** БИН/ИИН целиком (12 цифр) или его часть (от 4 цифр) — отбор по полю налогового номера. */
export function taxIdFilter(field: string, query: string): string | undefined {
  const digits = query.replace(/\s+/g, "");
  if (!field || !/^\d{4,12}$/.test(digits)) return undefined;
  return digits.length === 12 ? cmp(field, "eq", odataString(digits)) : contains(field, digits);
}
