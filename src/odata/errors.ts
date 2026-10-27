/**
 * Классификация ошибок при работе с OData 1С.
 * Нормализуем разнородные сбои (сеть, HTTP, тело ошибки 1С) в один тип
 * с понятным русским сообщением и признаком «можно ли повторить».
 */

export type ODataErrorKind =
  | "auth" // 401/403 — неверные креды или нет прав в «Состав OData»
  | "not_found" // 404 — объект не опубликован или не существует
  | "bad_request" // 400 — кривой $filter/$select
  | "rate_limit" // 429
  | "server" // 5xx (кроме 502/503/504)
  | "unavailable" // 502/503/504 или HTML-страница «сервис (частично) недоступен» — временный сбой площадки
  | "timeout" // прервано по таймауту
  | "network" // DNS/соединение
  | "parse" // не удалось разобрать ответ
  | "unknown";

export class ODataError extends Error {
  readonly kind: ODataErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly url?: string;

  constructor(opts: {
    kind: ODataErrorKind;
    message: string;
    status?: number;
    retryable?: boolean;
    url?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "ODataError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? RETRYABLE_DEFAULT[opts.kind];
    this.url = opts.url;
  }
}

const RETRYABLE_DEFAULT: Record<ODataErrorKind, boolean> = {
  auth: false,
  not_found: false,
  bad_request: false,
  rate_limit: true,
  server: true,
  unavailable: true,
  timeout: true,
  network: true,
  parse: false,
  unknown: false,
};

/** Строит ODataError из HTTP-статуса и (опционально) тела ответа. */
export function fromHttpStatus(status: number, url: string, body?: string): ODataError {
  const detail = extract1cMessage(body);
  const base = (msg: string, kind: ODataErrorKind) =>
    new ODataError({
      kind,
      status,
      url,
      message: detail ? `${msg}: ${detail}` : msg,
    });

  if (status === 401 || status === 403) {
    return base(
      "Ошибка авторизации (401/403). Проверьте логин/пароль и что объект включён в «Состав OData»",
      "auth",
    );
  }
  if (status === 404) {
    return base(
      "Объект не найден (404). Вероятно, не добавлен в «Настройка стандартного интерфейса OData → Состав»",
      "not_found",
    );
  }
  if (status === 400) return base("Некорректный запрос к OData (400)", "bad_request");
  if (status === 429) return base("Слишком много запросов (429)", "rate_limit");
  if (status === 502 || status === 503 || status === 504) {
    const page = body && looksLikeHtml(body) ? htmlText(body, 300) : "";
    return new ODataError({
      kind: "unavailable",
      status,
      url,
      message:
        `${hostOf(url)} временно недоступен: ${UNAVAILABLE_STATUS_TEXT[status]}. Это сбой площадки, а не ошибка в запросе или ` +
        "правах — повторите позже." +
        (detail ? ` Ответ: ${detail}` : page ? ` Текст страницы: «${page}»` : ""),
    });
  }
  if (status >= 500) return base(`Ошибка сервера 1С (${status})`, "server");
  return base(`Неожиданный ответ OData (${status})`, "unknown");
}

const UNAVAILABLE_STATUS_TEXT: Record<number, string> = {
  502: "502 Bad Gateway — веб-сервер публикации не получил ответа от 1С",
  503: "503 Service Unavailable — сервис перегружен или на технических работах",
  504: "504 Gateway Timeout — 1С не ответила веб-серверу публикации вовремя",
};

/** Хост из URL запроса (для текста ошибки), напр. «1cfresh.kz». */
export function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : "Сервис 1С";
  } catch {
    return "Сервис 1С";
  }
}

/** Тело похоже на HTML-страницу (а не на JSON или XML OData). */
export function looksLikeHtml(body: string, contentType?: string | null): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return (
    /^\s*(<!doctype html|<html[\s>])/i.test(body) || /<(body|head|title)[\s>]/i.test(body.slice(0, 2000))
  );
}

/**
 * Страница 1cfresh/веб-сервера «сервис временно (частично) недоступен», «технические работы», 502/503/504 —
 * временный сбой площадки (её обычно отдают с кодом 200). Отличаем от страниц «доступ запрещён» и исключений 1С.
 */
const UNAVAILABLE_PAGE_RE =
  /частично\s+недоступ|временно\s+недоступ|(сервис|сервер|приложение|база)\s+(сейчас\s+)?недоступ|технически[хе]\s+работ|регламентн[а-я]*\s+работ|перегружен|service\s+(is\s+)?(temporarily\s+)?unavailable|temporarily\s+unavailable|bad\s+gateway|gateway\s+time-?out|under\s+maintenance/i;

export function isUnavailablePage(body: string): boolean {
  return UNAVAILABLE_PAGE_RE.test(htmlText(body, 5000));
}

/** HTML-страница «сервис недоступен» с кодом 200 — как 503: для чтения повторяется. */
export function unavailablePageError(status: number, url: string, body: string): ODataError {
  return new ODataError({
    kind: "unavailable",
    status,
    url,
    message:
      `${hostOf(url)} временно недоступен: вместо ответа OData пришла страница «сервис недоступен» (HTTP ${status}). ` +
      `Это сбой площадки, а не нехватка прав или ошибка 1С — повторите позже. Текст страницы: «${htmlText(body, 300)}»`,
  });
}

/**
 * Запись, прерванная недоступностью площадки (502/503/504, страница «сервис недоступен», обрыв): запрос мог дойти
 * до 1С. Не повторяется — исход неизвестен, сначала сверка.
 */
export function writeOutcomeUnknown(err: ODataError): ODataError {
  return new ODataError({
    kind: "unavailable",
    status: err.status,
    url: err.url,
    retryable: false,
    cause: err,
    message:
      `${hostOf(err.url)} временно недоступен; исход записи неизвестен — проверьте write.operation.status / документ ` +
      `перед повтором. Подробности: ${err.message}`,
  });
}

/** Пытается достать человекочитаемое сообщение из тела ошибки OData (JSON или XML). */
function extract1cMessage(body?: string): string | undefined {
  if (!body) return undefined;
  try {
    // OData v3 (1С) кладёт ошибку в ключ "odata.error", v2/v4 — в "error".
    const json = JSON.parse(body) as Record<string, { message?: { value?: string } | string }>;
    const m = (json["odata.error"] ?? json["error"])?.message;
    if (typeof m === "string") return m;
    if (m?.value) return m.value;
  } catch {
    // не JSON — пробуем грубо выдрать <message> из XML
    const match = body.match(/<message[^>]*>([^<]+)<\/message>/i);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/**
 * Текст HTML-страницы без разметки (1cfresh иногда отвечает HTML вместо OData — в ней бывает текст исключения 1С).
 * Скрипты и стили убираются, сущности раскодируются, пробелы схлопываются; результат обрезается до max символов.
 */
export function htmlText(body: string, max = 800): string {
  const text = body
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|title)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, " | ")
    .replace(/^(\s|\|)+|(\s|\|)+$/g, "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
