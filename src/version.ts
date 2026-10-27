import { readFileSync } from "node:fs";

/**
 * Версия запущенного сервера и подсказка об обновлении. Клиенты MCP запоминают список инструментов при подключении,
 * поэтому после выхода новой версии бухгалтер не видит новых инструментов, пока не перезапустит подключение 1С.
 * health_check и capabilities показывают «запущена vX, доступна vY» — последняя версия берётся из тегов GitHub
 * одним коротким запросом (таймаут ~2 с, результат кешируется; любые ошибки молча игнорируются).
 * Выключить проверку: ODATA_UPDATE_CHECK=false.
 */

export const RELEASES_REPO = "malikyantizhanov/1c-odata-mcp-kz";
const TAGS_URL = `https://api.github.com/repos/${RELEASES_REPO}/tags?per_page=30`;
const OK_TTL_MS = 6 * 3_600_000;
const FAIL_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 2_000;

let runningVersion: string | undefined;

/** Версия из package.json (в собранном пакете — dist/version.js, package.json на уровень выше). */
export function serverVersion(): string {
  if (runningVersion) return runningVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    runningVersion = pkg.version ?? "0.0.0";
  } catch {
    runningVersion = "0.0.0";
  }
  return runningVersion;
}

/** «v0.7.12» / «0.7.12» → [0, 7, 12]; не semver — undefined. */
export function parseSemver(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  return 0;
}

/** Самая новая semver-версия из списка тегов (без «v»). */
export function latestFromTags(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  let best: string | undefined;
  for (const t of tags) {
    const name = t && typeof t === "object" ? (t as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !parseSemver(name)) continue;
    const v = name.replace(/^v/, "");
    if (!best || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let cache: { at: number; latest: string | undefined; ttl: number } | undefined;
let inflight: Promise<string | undefined> | undefined;
let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Для тестов: подменить запрос к GitHub и сбросить кеш. */
export function setUpdateFetcher(f: Fetcher | undefined): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
  cache = undefined;
  inflight = undefined;
}

const checkEnabled = (env: Record<string, string | undefined>) =>
  (env.ODATA_UPDATE_CHECK ?? "true").trim().toLowerCase() !== "false";

/** Последняя версия на GitHub или undefined (проверка выключена, нет сети, лимит API, таймаут). */
export async function latestVersion(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (!checkEnabled(env)) return undefined;
  if (cache && Date.now() - cache.at < cache.ttl) return cache.latest;
  inflight ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetcher(TAGS_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "1c-odata-mcp-kz" },
        signal: controller.signal,
      });
      const latest = res.ok ? latestFromTags(await res.json()) : undefined;
      cache = { at: Date.now(), latest, ttl: latest ? OK_TTL_MS : FAIL_TTL_MS };
      return latest;
    } catch {
      cache = { at: Date.now(), latest: undefined, ttl: FAIL_TTL_MS };
      return undefined;
    } finally {
      clearTimeout(timer);
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Блок «версия сервера» для health_check и capabilities. */
export async function versionInfo(env: Record<string, string | undefined> = process.env): Promise<{
  running: string;
  latest?: string;
  updateAvailable?: boolean;
  hint: string;
}> {
  const running = serverVersion();
  const latest = await latestVersion(env).catch(() => undefined);
  const restart =
    "После обновления новые инструменты появляются только после перезапуска подключения 1С в клиенте; до этого " +
    "их можно найти через meta.list_tools и вызвать через meta.call_tool.";
  if (latest && compareSemver(latest, running) > 0)
    return {
      running,
      latest,
      updateAvailable: true,
      hint: `Запущена v${running}, доступна v${latest} — перезапустите подключение 1С. ${restart}`,
    };
  return {
    running,
    ...(latest ? { latest, updateAvailable: false } : {}),
    hint: latest ? `Запущена последняя версия v${running}. ${restart}` : `Запущена v${running}. ${restart}`,
  };
}
