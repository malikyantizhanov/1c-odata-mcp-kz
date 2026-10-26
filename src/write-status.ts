import type { Behavior, ConnectionConfig } from "./config/env.js";

/**
 * Почему нет записи — понятные бухгалтеру тексты для каждого случая: явный READ_ONLY=true, writable: false в
 * файле баз, ODATA_DB_<ИМЯ>_WRITABLE в окружении, флаг базы в командном подключении, инструмент вне списка
 * ODATA_HTTP_WRITE_TOOLS. Каждый текст говорит, кто и как включает запись, и заканчивается одной фразой —
 * «обратитесь к администратору команды»: бухгалтер сам настройки сервера обычно не меняет.
 */

export const ADMIN_HINT =
  "Если запись нужна, а подключение настраивали не вы, обратитесь к администратору команды.";

export type WriteBlockReason =
  | "read_only_env"
  | "writable_false_file"
  | "writable_false_env"
  | "writable_false_header"
  | "writable_false"
  | "shared_no_write_tools";

/** Параметры командного (общего HTTP) режима, нужные для объяснения записи. */
export interface SharedMode {
  /** Пишущие инструменты, опубликованные коннектором (ODATA_HTTP_WRITE_TOOLS). */
  writeTools: readonly string[];
}

/** READ_ONLY=true: запись выключена для всего сервера. */
export function readOnlyMessage(shared?: SharedMode): string {
  return (
    "запись запрещена: сервер 1С запущен в режиме только-чтение — в его настройках задана переменная окружения " +
    "READ_ONLY=true (действует на все базы). Чтение работает как обычно. Включить запись может только тот, кто " +
    (shared
      ? "администрирует командный коннектор 1С: убрать READ_ONLY (или задать READ_ONLY=false) и перезапустить коннектор. "
      : "настраивал подключение 1С: убрать READ_ONLY из настроек сервера (или задать READ_ONLY=false) и перезапустить подключение 1С. ") +
    ADMIN_HINT
  );
}

/** У базы нет writable: true — текст зависит от того, где задан флаг. */
export function notWritableMessage(cfg: Pick<ConnectionConfig, "name" | "writableSource">): string {
  const head = `Запись в базу "${cfg.name}" запрещена: `;
  const src = cfg.writableSource;
  if (src?.kind === "file")
    return (
      head +
      `в файле баз ${src.file} у базы "${src.base}" поле "writable" ${src.set ? "равно false" : "не задано (по умолчанию false)"}. ` +
      `Включить запись: поставить "writable": true у этой базы в ${src.file} и перезапустить подключение 1С — ` +
      "это делает тот, кто настраивал подключение. Предпросмотр (dry-run) работает и без записи. " +
      ADMIN_HINT
    );
  if (src?.kind === "env")
    return (
      head +
      `переменная окружения ${src.variable} ${src.set ? "не равна true" : "не задана (по умолчанию false)"}. ` +
      `Включить запись: задать ${src.variable}=true в настройках (env/.env) сервера 1С и перезапустить подключение 1С — ` +
      "это делает тот, кто настраивал подключение. Предпросмотр (dry-run) работает и без записи. " +
      ADMIN_HINT
    );
  if (src?.kind === "header")
    return (
      head +
      "в командном подключении запись для этой базы выключена (флаг writable в настройках подключения базы у " +
      "бэкенда чата). Включает её администратор команды в настройках подключения 1С; сам бухгалтер из чата этого " +
      "не меняет. Предпросмотр (dry-run) работает и без записи. " +
      ADMIN_HINT
    );
  return (
    head +
    `у базы нет writable: true — задайте "writable": true у базы в файле баз (~/.1c-odata/databases.json) или ` +
    `ODATA_DB_${cfg.name.toUpperCase()}_WRITABLE=true в .env и перезапустите подключение 1С. ` +
    ADMIN_HINT
  );
}

/** Командный режим: пишущий инструмент не входит в ODATA_HTTP_WRITE_TOOLS и потому не опубликован. */
export function sharedToolMessage(name: string, shared: SharedMode): string {
  const list = shared.writeTools.length
    ? `сейчас разрешены: ${shared.writeTools.join(", ")}`
    : "сейчас он пуст — запись в командном подключении выключена полностью";
  return (
    `Инструмент записи «${name}» в командном подключении недоступен: коннектор публикует только пишущие ` +
    `инструменты из списка ODATA_HTTP_WRITE_TOOLS (${list}). Включает администратор коннектора: добавить имя ` +
    `инструмента в ODATA_HTTP_WRITE_TOOLS и перезапустить коннектор. ${ADMIN_HINT}`
  );
}

/** Причина запрета записи в базу (без учёта конкретного инструмента) или undefined — запись разрешена. */
export function writeBlockReason(
  behavior: Pick<Behavior, "readOnly">,
  cfg: Pick<ConnectionConfig, "name" | "writable" | "writableSource">,
  shared?: SharedMode,
): { reason: WriteBlockReason; message: string } | undefined {
  if (behavior.readOnly) return { reason: "read_only_env", message: capitalize(readOnlyMessage(shared)) };
  if (!cfg.writable) {
    const kind = cfg.writableSource?.kind;
    const reason: WriteBlockReason =
      kind === "file"
        ? "writable_false_file"
        : kind === "env"
          ? "writable_false_env"
          : kind === "header"
            ? "writable_false_header"
            : "writable_false";
    return { reason, message: notWritableMessage(cfg) };
  }
  if (shared && shared.writeTools.length === 0)
    return {
      reason: "shared_no_write_tools",
      message:
        "Запись запрещена: в командном подключении не опубликован ни один пишущий инструмент (список " +
        "ODATA_HTTP_WRITE_TOOLS у коннектора пуст). Включает администратор коннектора: перечислить нужные " +
        `инструменты в ODATA_HTTP_WRITE_TOOLS и перезапустить коннектор. ${ADMIN_HINT}`,
    };
  return undefined;
}

/** Текст «запись запрещена» для инструментов (fail) — или undefined, если запись разрешена. */
export function writeBlockedMessage(conn: {
  behavior: Pick<Behavior, "readOnly">;
  cfg: Pick<ConnectionConfig, "name" | "writable" | "writableSource">;
}): string | undefined {
  return writeBlockReason(conn.behavior, conn.cfg)?.message;
}

/** Блок «почему нет записи» для read.system.capabilities / health_check. */
export function writeStatusBlock(
  behavior: Pick<Behavior, "readOnly">,
  cfg: Pick<ConnectionConfig, "name" | "writable" | "writableSource">,
  shared?: SharedMode,
): {
  writeStatus: "enabled" | "disabled";
  reason?: WriteBlockReason;
  message: string;
  mode: "local" | "shared";
  sharedWriteTools?: string[];
} {
  const blocked = writeBlockReason(behavior, cfg, shared);
  const mode = shared ? "shared" : "local";
  const sharedWriteTools = shared ? { sharedWriteTools: [...shared.writeTools] } : {};
  if (blocked)
    return {
      writeStatus: "disabled",
      reason: blocked.reason,
      message: blocked.message,
      mode,
      ...sharedWriteTools,
    };
  return {
    writeStatus: "enabled",
    message: shared
      ? `Запись в базу "${cfg.name}" разрешена только инструментами из ODATA_HTTP_WRITE_TOOLS (см. sharedWriteTools) — всегда через предпросмотр (dry-run) и confirm=true после согласия бухгалтера.`
      : `Запись в базу "${cfg.name}" разрешена — всегда через предпросмотр (dry-run) и confirm=true после согласия бухгалтера.`,
    mode,
    ...sharedWriteTools,
  };
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
