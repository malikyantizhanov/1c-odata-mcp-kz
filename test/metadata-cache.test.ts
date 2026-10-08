import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "../src/context.js";
import type { Behavior, ConnectionConfig } from "../src/config/env.js";
import {
  cacheFilePath,
  readMetadataCache,
  setsFingerprint,
  writeMetadataCache,
} from "../src/odata/metadata-cache.js";
import { parseConfig } from "../src/config/env.js";

const edmx = (sets: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
<edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="3.0">
<Schema xmlns="http://schemas.microsoft.com/ado/2009/11/edm" Namespace="StandardODATA">
${sets.map((s) => `<EntityType Name="${s}"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/><Property Name="Description" Type="Edm.String"/></EntityType>`).join("\n")}
<EntityContainer Name="Container" m:IsDefaultEntityContainer="true">
${sets.map((s) => `<EntitySet Name="${s}" EntityType="StandardODATA.${s}"/>`).join("\n")}
</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;

const SETS = ["Catalog_Контрагенты", "Document_РеализацияТоваровУслуг"];
const URL_WITH_CREDS = "https://user:secret@example.test/a/b/odata/standard.odata/";

function make(
  dir: string | undefined,
  ttlHours = 24,
  baseUrl = "https://example.test/base/odata/standard.odata/",
) {
  const cfg: ConnectionConfig = { name: "default", baseUrl, username: "u", password: "p", writable: false };
  const behavior = {
    timeoutMs: 1000,
    retries: 0,
    pageSize: 100,
    maxRows: 1000,
    analyticsMaxRows: 1000,
    readOnly: true,
    writeJournalDir: join(tmpdir(), "unused-journal"),
    printDir: join(tmpdir(), "unused-print"),
    writeOperationMarker: false,
    metadataCache: dir ? { dir, ttlMs: ttlHours * 3_600_000 } : undefined,
  } satisfies Behavior;
  const conn = new Connection(cfg, behavior);
  let sets = SETS;
  const getText = vi.spyOn(conn.client, "getText").mockImplementation(async () => edmx(sets));
  const service = vi
    .spyOn(conn.client, "getCollection")
    .mockImplementation(async () => ({ value: sets.map((name) => ({ name, url: name })) }));
  return { conn, getText, service, setSets: (s: string[]) => (sets = s) };
}

const tmp = () => mkdtempSync(join(tmpdir(), "meta-cache-"));

afterEach(() => vi.restoreAllMocks());

describe("дисковый кеш $metadata", () => {
  it("первый процесс грузит из сети и пишет кеш; второй берёт с диска без $metadata и сверяет состав в фоне", async () => {
    const dir = tmp();
    const a = make(dir);
    const m1 = await a.conn.getMetadata();
    expect(a.getText).toHaveBeenCalledTimes(1);
    expect(a.conn.metadataInfo()).toMatchObject({ source: "network" });
    expect(m1.entities.size).toBe(2);

    const b = make(dir);
    const m2 = await b.conn.getMetadata();
    expect(b.getText).not.toHaveBeenCalled();
    expect([...m2.entities.keys()].sort()).toEqual([...m1.entities.keys()].sort());
    expect(m2.entities.get("Catalog_Контрагенты")?.properties.map((p) => p.name)).toEqual([
      "Ref_Key",
      "Description",
    ]);
    await b.conn.revalidation;
    expect(b.service).toHaveBeenCalledWith("?$format=json");
    expect(b.conn.metadataInfo()).toMatchObject({ source: "cache", revalidation: "unchanged" });
    expect(b.getText).not.toHaveBeenCalled();
  });

  it("состав OData изменился — фоновая сверка перечитывает $metadata и обновляет кеш", async () => {
    const dir = tmp();
    await make(dir).conn.getMetadata();
    const b = make(dir);
    b.setSets([...SETS, "Catalog_Номенклатура"]);
    expect((await b.conn.getMetadata()).entities.size).toBe(2); // сначала — карта с диска
    await b.conn.revalidation;
    expect(b.getText).toHaveBeenCalledTimes(1);
    expect((await b.conn.getMetadata()).entities.has("Catalog_Номенклатура")).toBe(true);
    expect(b.conn.metadataInfo()).toMatchObject({ source: "network", revalidation: "changed" });
    const c = make(dir);
    c.setSets([...SETS, "Catalog_Номенклатура"]);
    expect((await c.conn.getMetadata()).entities.size).toBe(3);
    await c.conn.revalidation;
    expect(c.getText).not.toHaveBeenCalled();
  });

  it("кеш старше TTL — из сети; TTL = 0 — кеш выключен, файл не пишется", async () => {
    const dir = tmp();
    await make(dir).conn.getMetadata();
    const file = readdirSync(dir).find((f) => f.endsWith(".json"))!;
    const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as { savedAt: number };
    data.savedAt -= 25 * 3_600_000;
    writeFileSync(join(dir, file), JSON.stringify(data));
    const old = make(dir);
    await old.conn.getMetadata();
    expect(old.getText).toHaveBeenCalledTimes(1);

    const off = tmp();
    const z = make(off, 0);
    await z.conn.getMetadata();
    expect(readdirSync(off)).toEqual([]);
  });

  it("битый файл — промах кеша, файл перезаписывается; сервер не падает", async () => {
    const dir = tmp();
    const file = cacheFilePath(dir, "https://example.test/base/odata/standard.odata/");
    writeFileSync(file, "{не json");
    const a = make(dir);
    expect((await a.conn.getMetadata()).entities.size).toBe(2);
    expect(a.getText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8")).entities).toHaveLength(2);

    writeFileSync(file, JSON.stringify({ format: "1c-odata-mcp-kz/metadata", version: 1, entities: [{}] }));
    expect(await readMetadataCache(dir, "https://example.test/base/odata/standard.odata/")).toBeUndefined();
  });

  it("каталог недоступен для записи — метаданные работают, причина в metadataInfo().cacheError", async () => {
    const parent = tmp();
    const dir = join(parent, "ro");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    const a = make(dir);
    expect((await a.conn.getMetadata()).entities.size).toBe(2);
    const info = a.conn.metadataInfo();
    if (process.getuid?.() !== 0) expect(info?.cacheError).toBeTruthy();
    chmodSync(dir, 0o700);
  });

  it("refreshMetadata — перечитывает из сети и перезаписывает кеш", async () => {
    const dir = tmp();
    const a = make(dir);
    await a.conn.getMetadata();
    a.setSets(["Catalog_Контрагенты"]);
    const fresh = await a.conn.refreshMetadata();
    expect(fresh.entities.size).toBe(1);
    expect(a.getText).toHaveBeenCalledTimes(2);
    expect((await a.conn.getMetadata()).entities.size).toBe(1);
    expect((await make(dir).conn.getMetadata()).entities.size).toBe(1);
  });

  it("файл: ключ — хеш URL без логина/пароля, права 0600, запись атомарная (нет .tmp)", async () => {
    const dir = tmp();
    const meta = { odataVersion: "3.0", entities: new Map() } as never;
    const f1 = await writeMetadataCache(dir, URL_WITH_CREDS, meta);
    expect(f1).toBe(cacheFilePath(dir, "https://example.test/a/b/odata/standard.odata/"));
    expect(f1).not.toMatch(/user|secret/);
    const body = readFileSync(f1, "utf8");
    expect(body).not.toMatch(/user|secret|example\.test/);
    expect(statSync(f1).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // Пустая карта — не кешируем как валидную (промах).
    expect(await readMetadataCache(dir, URL_WITH_CREDS)).toBeUndefined();
    expect(setsFingerprint(["b", "a"])).toBe(setsFingerprint(["a", "b"]));
  });

  it("env: ODATA_CACHE_DIR и ODATA_METADATA_CACHE_TTL_HOURS; по умолчанию ~/.cache/1c-odata-mcp-kz на 24 ч", () => {
    const base = { ODATA_BASE_URL: "https://x/odata/", ODATA_USERNAME: "u", ODATA_PASSWORD: "p" };
    const d = parseConfig(base).behavior.metadataCache!;
    expect(d.dir).toMatch(/\.cache\/1c-odata-mcp-kz$/);
    expect(d.ttlMs).toBe(24 * 3_600_000);
    expect(
      parseConfig({ ...base, ODATA_CACHE_DIR: "/srv/cache", ODATA_METADATA_CACHE_TTL_HOURS: "2" }).behavior
        .metadataCache,
    ).toEqual({ dir: "/srv/cache", ttlMs: 7_200_000 });
    expect(
      parseConfig({ ...base, ODATA_METADATA_CACHE_TTL_HOURS: "0" }).behavior.metadataCache,
    ).toBeUndefined();
  });
});
