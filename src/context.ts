import type { Behavior, ConnectionConfig, RuntimeConfig } from "./config/env.js";
import { ODataClient } from "./odata/client.js";
import { loadMetadata } from "./odata/metadata.js";
import { readMetadataCache, setsFingerprint, writeMetadataCache } from "./odata/metadata-cache.js";
import { ODataError } from "./odata/errors.js";
import { logger } from "./logger.js";
import type { MetadataMap } from "./types/odata.js";

/** Откуда взята текущая карта метаданных (для health_check и профилирования). */
export interface MetadataInfo {
  source: "network" | "cache";
  /** Когда карта сохранена в кеш / загружена (мс эпохи). */
  savedAt?: number | undefined;
  cacheFile?: string | undefined;
  /** Фоновая сверка кеша со списком опубликованных объектов. */
  revalidation?: "pending" | "unchanged" | "changed" | "failed" | undefined;
  /** Почему кеш не записан (ошибка файловой системы) — работе не мешает. */
  cacheError?: string | undefined;
}

/**
 * Одно подключение к конкретной базе 1С: клиент + лениво-кешируемая карта
 * метаданных этой базы. У каждой базы свой кеш $metadata.
 */
export class Connection {
  readonly cfg: ConnectionConfig;
  readonly behavior: Behavior;
  readonly client: ODataClient;
  private metaPromise: Promise<MetadataMap> | undefined;
  private metaInfo: MetadataInfo | undefined;
  /** Фоновая сверка кеша (для тестов и корректного завершения). */
  revalidation: Promise<void> | undefined;

  constructor(cfg: ConnectionConfig, behavior: Behavior) {
    this.cfg = cfg;
    this.behavior = behavior;
    this.client = new ODataClient(cfg, behavior);
  }

  getMetadata(): Promise<MetadataMap> {
    if (!this.metaPromise) {
      this.metaPromise = this.loadMeta().catch((e) => {
        this.metaPromise = undefined; // дать следующему вызову повторить
        throw e;
      });
    }
    return this.metaPromise;
  }

  /** Источник текущей карты метаданных; undefined — ещё не загружалась. */
  metadataInfo(): MetadataInfo | undefined {
    return this.metaInfo ? { ...this.metaInfo } : undefined;
  }

  /**
   * Принудительно перечитать $metadata из 1С и перезаписать дисковый кеш (после изменения состава OData или
   * обновления конфигурации). Текущие вызовы, уже получившие карту, доработают со старой.
   */
  refreshMetadata(): Promise<MetadataMap> {
    const p = this.fetchMeta();
    this.metaPromise = p.catch((e) => {
      this.metaPromise = undefined;
      throw e;
    });
    return p;
  }

  /**
   * Кеш свежее TTL — карта с диска сразу, а в фоне — сверка со служебным документом OData (список опубликованных
   * объектов, ~100 КБ вместо мегабайт $metadata): состав изменился — карта перечитывается из 1С. Кеш старше TTL,
   * битый или выключен (TTL = 0) — $metadata из 1С, как раньше, и запись кеша.
   */
  private async loadMeta(): Promise<MetadataMap> {
    const c = this.behavior.metadataCache;
    if (c && c.ttlMs > 0) {
      const hit = await readMetadataCache(c.dir, this.cfg.baseUrl);
      const age = hit ? Date.now() - hit.savedAt : Infinity;
      if (hit && age >= 0 && age < c.ttlMs) {
        this.metaInfo = {
          source: "cache",
          savedAt: hit.savedAt,
          cacheFile: hit.file,
          revalidation: "pending",
        };
        this.revalidation = this.revalidate(hit.setsHash);
        return hit.meta;
      }
    }
    return this.fetchMeta();
  }

  private async fetchMeta(): Promise<MetadataMap> {
    const meta = await loadMetadata(this.client);
    const info: MetadataInfo = { source: "network", savedAt: Date.now() };
    const c = this.behavior.metadataCache;
    if (c && c.ttlMs > 0) {
      try {
        info.cacheFile = await writeMetadataCache(c.dir, this.cfg.baseUrl, meta, info.savedAt);
      } catch (e) {
        info.cacheError = (e as Error).message;
        logger.warn({ dir: c.dir, err: info.cacheError }, "metadata cache not written");
      }
    }
    this.metaInfo = info;
    return meta;
  }

  private async revalidate(cachedHash: string): Promise<void> {
    try {
      const doc = await this.client.getCollection<{ name?: string; url?: string }>("?$format=json");
      const names = (doc.value ?? []).map((v) => String(v.name ?? v.url ?? "")).filter(Boolean);
      if (!names.length) throw new Error("служебный документ OData без списка объектов");
      if (setsFingerprint(names) === cachedHash) {
        if (this.metaInfo?.source === "cache") this.metaInfo.revalidation = "unchanged";
        return;
      }
      logger.info({ base: this.cfg.name }, "metadata cache stale: published objects changed, reloading");
      await this.refreshMetadata();
      if (this.metaInfo) this.metaInfo.revalidation = "changed";
    } catch (e) {
      if (this.metaInfo?.source === "cache") this.metaInfo.revalidation = "failed";
      logger.warn({ base: this.cfg.name, err: (e as Error).message }, "metadata cache revalidation failed");
    }
  }

  async available(): Promise<ReadonlySet<string>> {
    const meta = await this.getMetadata();
    return new Set(meta.entities.keys());
  }
}

/**
 * Реестр всех настроенных баз. Инструменты получают его и выбирают базу
 * методом db(name): без имени — база по умолчанию.
 */
export class ServerContext {
  readonly defaultName: string;
  readonly behavior: Behavior;
  private readonly map = new Map<string, Connection>();

  constructor(rc: RuntimeConfig) {
    this.defaultName = rc.defaultName;
    this.behavior = rc.behavior;
    for (const c of rc.connections) this.map.set(c.name, new Connection(c, rc.behavior));
  }

  /** Подключение по имени; без имени — база по умолчанию. Бросает понятную ошибку. */
  db(name?: string): Connection {
    const key = (name ?? this.defaultName).toLowerCase();
    const conn = this.map.get(key);
    if (!conn) {
      const known = [...this.map.keys()].join(", ");
      throw new ODataError({
        kind: "bad_request",
        message: `База "${name}" не настроена. Доступные базы: ${known}. См. list_databases.`,
      });
    }
    return conn;
  }

  /** Список баз для list_databases. */
  databases(): Array<{ name: string; label?: string; isDefault: boolean }> {
    return [...this.map.values()].map((c) => ({
      name: c.cfg.name,
      ...(c.cfg.label ? { label: c.cfg.label } : {}),
      isDefault: c.cfg.name === this.defaultName,
    }));
  }
}
