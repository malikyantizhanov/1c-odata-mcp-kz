/**
 * Дательный падеж для строки «Выдана» доверенности («Бухгалтеру, Касымовой Диане Сериковне.»). 1С склоняет ФИО и
 * должность своим сервисом склонения, а его результат через OData не опубликован — здесь те же правила русской
 * грамматики для ФИО (фамилия, имя, отчество с учётом пола) и для должности (прилагательные до первого
 * существительного и само существительное). Несклоняемое (Ким, Ли, Айгерим, казахские «-ұлы / -қызы») — как есть.
 */

export type Gender = "male" | "female" | undefined;

const VOWELS = "аеёиоуыэюя";
const isConsonant = (c: string | undefined): boolean => !!c && /[а-яё]/.test(c) && !VOWELS.includes(c);
/** Регистр первой буквы исходного слова переносится на результат. */
const keepCase = (src: string, out: string): string =>
  src.charAt(0) === src.charAt(0).toUpperCase() ? out.charAt(0).toUpperCase() + out.slice(1) : out;

/** Пол по отчеству или фамилии, если в карточке не указан. */
export function guessGender(full: string): Gender {
  const parts = full.trim().toLowerCase().split(/\s+/);
  const patronymic = parts[2] ?? "";
  if (/(вна|чна|кызы|қызы)$/.test(patronymic)) return "female";
  if (/(вич|ич|улы|ұлы)$/.test(patronymic)) return "male";
  const last = parts[0] ?? "";
  if (/(ова|ева|ёва|ина|ына|ская|цкая)$/.test(last)) return "female";
  if (/(ов|ев|ёв|ин|ын|ский|цкий)$/.test(last)) return "male";
  return undefined;
}

function surnameDative(w: string, g: Gender): string {
  const s = w.toLowerCase();
  let out = s;
  if (g === "female") {
    if (/(ова|ева|ёва|ина|ына)$/.test(s)) out = `${s.slice(0, -1)}ой`;
    else if (/(ская|цкая|ая)$/.test(s)) out = `${s.slice(0, -2)}ой`;
    else if (/яя$/.test(s)) out = `${s.slice(0, -2)}ей`;
  } else {
    if (/(ов|ев|ёв|ин|ын)$/.test(s)) out = `${s}у`;
    else if (/(ский|цкий)$/.test(s)) out = `${s.slice(0, -2)}ому`;
    else if (/(ый|ой)$/.test(s)) out = `${s.slice(0, -2)}ому`;
    else if (/ий$/.test(s)) out = `${s.slice(0, -2)}ему`;
    else if (/[^и]я$/.test(s) || /а$/.test(s)) out = `${s.slice(0, -1)}е`;
    else if (/й$/.test(s)) out = `${s.slice(0, -1)}ю`;
    else if (/ь$/.test(s)) out = `${s.slice(0, -1)}ю`;
    else if (isConsonant(s.at(-1)) && !/(их|ых)$/.test(s)) out = `${s}у`;
  }
  return keepCase(w, out);
}

function nameDative(w: string, g: Gender): string {
  const s = w.toLowerCase();
  let out = s;
  if (/ия$/.test(s)) out = `${s.slice(0, -1)}и`;
  else if (/[ая]$/.test(s)) out = `${s.slice(0, -1)}е`;
  else if (g === "female") {
    if (/ь$/.test(s)) out = `${s.slice(0, -1)}и`;
  } else if (/ий$/.test(s)) out = `${s.slice(0, -1)}ю`;
  else if (/[йь]$/.test(s)) out = `${s.slice(0, -1)}ю`;
  else if (isConsonant(s.at(-1))) out = `${s}у`;
  return keepCase(w, out);
}

function patronymicDative(w: string): string {
  const s = w.toLowerCase();
  let out = s;
  if (/(вна|чна|шна)$/.test(s)) out = `${s.slice(0, -1)}е`;
  else if (/ич$/.test(s)) out = `${s}у`;
  return keepCase(w, out);
}

/** «Касымова Диана Сериковна.» → «Касымовой Диане Сериковне.» (знаки в конце сохраняются). */
export function fioDative(full: string, gender?: Gender): string {
  const trail = /[.\s]*$/.exec(full)?.[0] ?? "";
  const core = full.slice(0, full.length - trail.length).trim();
  const parts = core.split(/\s+/);
  if (!core || parts.length < 2) return full;
  const g = gender ?? guessGender(core);
  const [last, first, ...rest] = parts;
  const patronymic = rest.join(" ");
  const kazakh = /(ұлы|улы|қызы|кызы)$/i.test(patronymic);
  return (
    [
      surnameDative(last!, g),
      nameDative(first!, g),
      ...(patronymic ? [kazakh ? patronymic : patronymicDative(patronymic)] : []),
    ].join(" ") + trail.trim()
  );
}

function adjectiveDative(w: string): string | undefined {
  const s = w.toLowerCase();
  if (/(ый|ой)$/.test(s)) return keepCase(w, `${s.slice(0, -2)}ому`);
  if (/[кгх]ий$/.test(s)) return keepCase(w, `${s.slice(0, -2)}ому`);
  if (/ий$/.test(s)) return keepCase(w, `${s.slice(0, -2)}ему`);
  return undefined;
}

function nounDative(w: string): string {
  const s = w.toLowerCase();
  let out = s;
  if (/ия$/.test(s)) out = `${s.slice(0, -1)}и`;
  else if (/[ая]$/.test(s)) out = `${s.slice(0, -1)}е`;
  else if (/[йь]$/.test(s)) out = `${s.slice(0, -1)}ю`;
  else if (isConsonant(s.at(-1))) out = `${s}у`;
  return keepCase(w, out);
}

/** «Главный бухгалтер» → «Главному бухгалтеру», «Менеджер по продажам» → «Менеджеру по продажам». */
export function positionDative(position: string): string {
  const words = position.trim().split(/\s+/);
  const out: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    const adj = adjectiveDative(words[i]!);
    if (!adj) break;
    out.push(adj);
  }
  // «Водитель-экспедитор» → «Водителю-экспедитору»: обе части составного существительного.
  if (i < words.length) out.push(words[i]!.split("-").map(nounDative).join("-"), ...words.slice(i + 1));
  return out.join(" ");
}
