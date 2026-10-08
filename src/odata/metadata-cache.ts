import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.js";
import type { EntityMeta, MetadataMap } from "../types/odata.js";

/**
 * Дисковый кеш разобранного $metadata. $metadata базы 1С — несколько мегабайт XML (у тестовой базы Fresh — 3,6 МБ,
 * 812 объектов, ~4 с на скачивание): без кеша каждый новый процесс MCP платит эти секунды на первом же вызове.
 *
 * - Файл: `<dir>/metadata-<sha256(baseUrl)[0..32]>.json` — в имени и содержимом нет логина/пароля, только хеш URL.
 * - Запись атомарная: временный файл (0600) в том же каталоге + rename; каталог создаётся с правами 0700.
 * - Битый, чужой или устаревший по формату файл — просто промах кеша: метаданные грузятся из сети и файл
 *   перезаписывается.
 * - Свежесть: TTL (ODATA_METADATA_CACHE_TTL_HOURS) + отпечаток списка опубликованных объектов (служебный документ
 *   OData, ~100 КБ) — см. Connection.
 */

export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "1c-odata-mcp-kz");
export const DEFAULT_METADATA_TTL_HOURS = 24;

const FORMAT = "1c-odata-mcp-kz/metadata";
const VERSION = 1;

export interface MetadataCacheSettings {
  dir: string;
  ttlMs: number;
}

export interface CachedMetadata {
  meta: MetadataMap;
  savedAt: number;
  /** Отпечаток списка EntitySet (см. setsFingerprint). */
  setsHash: string;
  file: string;
}

interface CacheFile {
  format: string;
  version: number;
  baseUrlHash: string;
  savedAt: number;
  setsHash: string;
  odataVersion: string;
  entities: EntityMeta[];
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Нормализованный базовый URL без учётных данных (на случай user:pass@host в URL). */
export function cacheKeyUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    u.username = "";
    u.password = "";
    u.hash = "";
    const s = u.toString();
    return s.endsWith("/") ? s : `${s}/`;
  } catch {
    return baseUrl;
  }
}

export function baseUrlHash(baseUrl: string): string {
  return sha256(cacheKeyUrl(baseUrl));
}

export function cacheFilePath(dir: string, baseUrl: string): string {
  return join(dir, `metadata-${baseUrlHash(baseUrl).slice(0, 32)}.json`);
}

/** Отпечаток набора опубликованных объектов: sha256 отсортированных имён EntitySet. */
export function setsFingerprint(names: Iterable<string>): string {
  return sha256([...names].sort().join("\n"));
}

function isEntityMeta(e: unknown): e is EntityMeta {
  const m = e as EntityMeta;
  return (
    !!m &&
    typeof m.entitySet === "string" &&
    typeof m.entityType === "string" &&
    Array.isArray(m.properties) &&
    Array.isArray(m.navigations) &&
    Array.isArray(m.keys)
  );
}

/** Чтение кеша. Нет файла, битый JSON, чужой URL или формат — undefined (промах), без исключений. */
export async function readMetadataCache(dir: string, baseUrl: string): Promise<CachedMetadata | undefined> {
  const file = cacheFilePath(dir, baseUrl);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      logger.warn({ file, err: (e as Error).message }, "metadata cache unreadable");
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as CacheFile;
    if (
      data.format !== FORMAT ||
      data.version !== VERSION ||
      data.baseUrlHash !== baseUrlHash(baseUrl) ||
      typeof data.savedAt !== "number" ||
      typeof data.setsHash !== "string" ||
      !Array.isArray(data.entities) ||
      !data.entities.length ||
      !data.entities.every(isEntityMeta)
    ) {
      logger.warn({ file }, "metadata cache ignored: unexpected format");
      return undefined;
    }
    const entities = new Map(data.entities.map((e) => [e.entitySet, e]));
    if (setsFingerprint(entities.keys()) !== data.setsHash) {
      logger.warn({ file }, "metadata cache ignored: fingerprint mismatch");
      return undefined;
    }
    return {
      meta: { odataVersion: String(data.odataVersion ?? "3.0"), entities },
      savedAt: data.savedAt,
      setsHash: data.setsHash,
      file,
    };
  } catch (e) {
    logger.warn({ file, err: (e as Error).message }, "metadata cache ignored: corrupt");
    return undefined;
  }
}

/** Атомарная запись кеша (tmp + rename). Ошибку файловой системы возвращает вызывающему — он её только логирует. */
export async function writeMetadataCache(
  dir: string,
  baseUrl: string,
  meta: MetadataMap,
  now = Date.now(),
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = cacheFilePath(dir, baseUrl);
  const entities = [...meta.entities.values()];
  const body: CacheFile = {
    format: FORMAT,
    version: VERSION,
    baseUrlHash: baseUrlHash(baseUrl),
    savedAt: now,
    setsHash: setsFingerprint(meta.entities.keys()),
    odataVersion: meta.odataVersion,
    entities,
  };
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(body), { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  return file;
}
