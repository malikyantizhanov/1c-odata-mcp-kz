/** Сумма прописью по-русски: «Двадцать тысяч тенге 00 тиын». Тысячи — женского рода, остальное — мужского. */

const ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const TENS = [
  "",
  "",
  "двадцать",
  "тридцать",
  "сорок",
  "пятьдесят",
  "шестьдесят",
  "семьдесят",
  "восемьдесят",
  "девяносто",
];
const HUNDREDS = [
  "",
  "сто",
  "двести",
  "триста",
  "четыреста",
  "пятьсот",
  "шестьсот",
  "семьсот",
  "восемьсот",
  "девятьсот",
];
const SCALES: Array<{ forms: [string, string, string]; feminine: boolean }> = [
  { forms: ["", "", ""], feminine: false },
  { forms: ["тысяча", "тысячи", "тысяч"], feminine: true },
  { forms: ["миллион", "миллиона", "миллионов"], feminine: false },
  { forms: ["миллиард", "миллиарда", "миллиардов"], feminine: false },
];

/** Форма слова для числа: 1 тысяча, 2 тысячи, 5 тысяч, 11 тысяч. */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const n100 = n % 100;
  const n10 = n % 10;
  if (n100 >= 11 && n100 <= 14) return many;
  if (n10 === 1) return one;
  if (n10 >= 2 && n10 <= 4) return few;
  return many;
}

function triad(n: number, feminine: boolean): string[] {
  const words = [HUNDREDS[Math.floor(n / 100)]!];
  const rest = n % 100;
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]!);
  else words.push(TENS[Math.floor(rest / 10)]!, (feminine ? ONES_F : ONES_M)[rest % 10]!);
  return words.filter(Boolean);
}

/** Целое число прописью (до триллиона). */
export function numberToWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "ноль";
  const parts: string[] = [];
  for (let scale = 0; n > 0 && scale < SCALES.length; scale++, n = Math.floor(n / 1000)) {
    const t = n % 1000;
    if (!t) continue;
    const { forms, feminine } = SCALES[scale]!;
    parts.unshift([...triad(t, feminine), plural(t, forms)].filter(Boolean).join(" "));
  }
  return parts.join(" ");
}

/** «Двадцать тысяч тенге 00 тиын»; для другой валюты — её наименование и «00». */
export function amountInWords(amount: number, currency = "KZT"): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(cents / 100);
  const minor = String(cents % 100).padStart(2, "0");
  const words = numberToWords(whole);
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return currency === "KZT" ? `${text} тенге ${minor} тиын` : `${text} ${currency} ${minor}`;
}
