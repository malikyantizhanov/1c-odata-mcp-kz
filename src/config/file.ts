import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Файл со списком баз 1С (env ODATA_CONFIG или ~/.1c-odata/databases.{json,yaml,yml}).
 *
 * Формат — JSON или YAML; либо массив баз, либо объект { default?, databases: [...] }:
 *   { "default": "buh", "databases": [
 *       { "name": "buh", "label": "Бухгалтерия ТОО", "base_url": "https://…/odata/standard.odata/",
 *         "username": "odata", "password_env": "ODATA_PW_BUH", "writable": false } ] }
 * Пароль — либо "password" прямо в файле, либо "password_env" — имя переменной окружения с паролем
 * (тогда в файле секретов нет). Значения полей (особенно пароли) в ошибки и логи не попадают.
 */

/** Пути по умолчанию, если ODATA_CONFIG не задан (первый существующий). */
export const DEFAULT_CONFIG_DIR = ".1c-odata";
const DEFAULT_NAMES = ["databases.json", "databases.yaml", "databases.yml"];

export interface FileBase {
  name: string;
  label?: string | undefined;
  baseUrl: string;
  username: string;
  password: string | undefined;
  writable: boolean;
  /** Поле writable в файле задано явно (иначе — false по умолчанию). */
  writableSet: boolean;
}

export interface LoadedFile {
  path: string;
  defaultName?: string | undefined;
  bases: FileBase[];
  warnings: string[];
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

const EntrySchema = z
  .object({
    name: z.string().regex(NAME_RE, "только латиница, цифры, «_» и «-»"),
    label: z.string().min(1).optional(),
    base_url: z.string().min(1, "обязателен"),
    username: z.string().min(1, "обязателен"),
    password: z.string().min(1).optional(),
    password_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "имя переменной окружения")
      .optional(),
    writable: z.boolean().optional(),
  })
  .strict();

const FileSchema = z.union([
  z.array(z.unknown()),
  z
    .object({
      default: z.string().min(1).optional(),
      databases: z.array(z.unknown()),
    })
    .strict(),
]);

/** «~/x» → домашний каталог; относительный путь — от текущего каталога. */
export function expandHome(p: string, home: string = homedir()): string {
  const t = p.trim();
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(home, t.slice(2));
  return isAbsolute(t) ? t : resolve(t);
}

/** Путь файла баз: ODATA_CONFIG (с «~») или первый существующий из ~/.1c-odata/databases.{json,yaml,yml}. */
export function configPath(env: Record<string, string | undefined>, home?: string): string | undefined {
  const explicit = env.ODATA_CONFIG?.trim();
  if (explicit) return expandHome(explicit, home ?? homedir());
  if (!home) return undefined;
  return DEFAULT_NAMES.map((n) => join(home, DEFAULT_CONFIG_DIR, n)).find((p) => existsSync(p));
}

/** Описание проблемы без значений: путь в файле и сообщение. */
const issueText = (
  where: string,
  i: { path: PropertyKey[]; message: string; code?: string; keys?: string[] },
) => {
  const field = i.path.map(String).join(".");
  const extra =
    i.code === "unrecognized_keys" && i.keys ? `неизвестные поля: ${i.keys.join(", ")}` : i.message;
  return `${where}${field ? ` поле «${field}»` : ""}: ${extra}`;
};

/**
 * Читает и проверяет файл баз. Ошибки собираются в issues (без значений полей), предупреждения —
 * в warnings (права файла, переопределения). explicit — путь задан явно (ODATA_CONFIG): тогда его
 * отсутствие — ошибка.
 */
export function loadConfigFile(
  path: string,
  env: Record<string, string | undefined>,
  issues: string[],
  explicit: boolean,
): LoadedFile | undefined {
  if (!existsSync(path)) {
    if (explicit) issues.push(`файл баз ODATA_CONFIG не найден: ${path}`);
    return undefined;
  }
  const warnings: string[] = [];
  try {
    const st = statSync(path);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
      warnings.push(
        `файл баз ${path} доступен другим пользователям (права ${(st.mode & 0o777).toString(8)}) — ` +
          `выполните: chmod 600 "${path}" (или храните пароли в переменных окружения через password_env)`,
      );
  } catch {
    // права не прочитать — не критично
  }
  let data: unknown;
  try {
    const text = readFileSync(path, "utf8");
    data = /\.ya?ml$/i.test(path) ? parseYaml(text) : JSON.parse(text);
  } catch (e) {
    // Текст ошибки парсера может цитировать строку файла (а в ней — пароль): отдаём только позицию.
    const msg = e instanceof Error ? e.message : String(e);
    const pos = /line (\d+)|position (\d+)|at line (\d+)/i.exec(msg);
    issues.push(
      `файл баз ${path}: не разобран как ${/\.ya?ml$/i.test(path) ? "YAML" : "JSON"}` +
        (pos ? ` (${pos[0]})` : ""),
    );
    return undefined;
  }
  const top = FileSchema.safeParse(data);
  if (!top.success) {
    issues.push(`файл баз ${path}: ожидается массив баз или объект { "default"?, "databases": [...] }`);
    return undefined;
  }
  const list = Array.isArray(top.data) ? top.data : top.data.databases;
  const defaultName = Array.isArray(top.data) ? undefined : top.data.default?.toLowerCase();
  const bases: FileBase[] = [];
  list.forEach((raw, idx) => {
    const r = EntrySchema.safeParse(raw);
    const nm =
      raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
        ? (raw as { name: string }).name
        : undefined;
    const where = `файл баз ${path}, база #${idx + 1}${nm ? ` "${nm}"` : ""}`;
    if (!r.success) {
      for (const i of r.error.issues) issues.push(issueText(where, i as never));
      return;
    }
    const e = r.data;
    if (e.password && e.password_env) {
      issues.push(`${where}: укажите что-то одно — password или password_env`);
      return;
    }
    let password = e.password;
    if (e.password_env) {
      password = env[e.password_env];
      if (!password) {
        issues.push(`${where}: переменная окружения ${e.password_env} (password_env) не задана или пуста`);
        return;
      }
    }
    if (!password) {
      issues.push(`${where}: нужен password или password_env`);
      return;
    }
    bases.push({
      name: e.name.toLowerCase(),
      label: e.label,
      baseUrl: e.base_url,
      username: e.username,
      password,
      writable: e.writable === true,
      writableSet: e.writable !== undefined,
    });
  });
  return { path, defaultName, bases, warnings };
}
