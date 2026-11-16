/**
 * Время Казахстана для дат документов 1С.
 *
 * 1С хранит дату документа «настенной» (без зоны): «2026-11-16T16:07:51». Коннектор работает в контейнере с UTC,
 * а бухгалтер — по Алматы: `new Date()` давал время на 5 часов раньше (вечером — и вчерашний день), а дата,
 * переданная без времени, превращалась в «…T00:00:00» — все документы дня в 1С стояли на полуночи
 * (16.11.2026, владелец: «необходимо ставить время фактического создания по времени Алматы (+05:00)»).
 *
 * Сдвиг фиксированный: с 01.03.2024 весь Казахстан живёт по UTC+05:00. Базы часовых поясов старше 2024 года
 * для Asia/Almaty дают +06:00 — на них не опираемся.
 */

export const KZ_UTC_OFFSET_MINUTES = 5 * 60;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Сейчас по Алматы: дата «ГГГГ-ММ-ДД», время «ЧЧ:ММ:СС» и вместе — для 1С. */
export function kzNow(now: Date = new Date()): { date: string; time: string; dateTime: string } {
  const t = new Date(now.getTime() + KZ_UTC_OFFSET_MINUTES * 60_000);
  const date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const time = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  return { date, time, dateTime: `${date}T${time}` };
}

const DATE_PART =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Дата документа для 1С: день — как назвал бухгалтер, время — фактическое время создания по Алматы.
 * Без даты — сейчас по Алматы. Дата с настоящим временем («2026-11-06T12:20:05») — как есть; полночь
 * («…T00:00:00») считается «время не задано»: так приходят даты от моделей и форм.
 */
export function docDate(date?: string | null, now: Date = new Date()): string {
  const current = kzNow(now);
  const s = String(date ?? "").trim();
  if (!s) return current.dateTime;
  const m = DATE_PART.exec(s);
  if (!m) return s; // не дата — пусть её отвергнет проверка 1С с понятной ошибкой
  const [, day, hh, mm, ss] = m;
  if (hh !== undefined && !(hh === "00" && mm === "00" && (ss ?? "00") === "00")) {
    return `${day}T${hh}:${mm}:${ss ?? "00"}`;
  }
  return `${day}T${current.time}`;
}
