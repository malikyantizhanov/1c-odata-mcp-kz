import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, startupSummary } from "../src/config/env.js";
import { expandHome } from "../src/config/file.js";

/** Файл баз ODATA_CONFIG (JSON/YAML), слияние с переменными окружения, ошибки без паролей. */

const SECRET = "Sup3r-Secret-Pa$$";
const URL1 = "https://1cfresh.kz/a/ea20/000000/odata/standard.odata/";
const URL2 = "https://1cfresh.kz/a/ea20/111111/odata/standard.odata";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "odata-cfg-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const write = (name: string, text: string, mode = 0o600): string => {
  const p = join(home, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
};
const json = (v: unknown) => JSON.stringify(v, null, 2);
const errorOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("ожидалась ошибка конфигурации");
};

describe("файл баз ODATA_CONFIG", () => {
  it("JSON: несколько баз, ~ в пути, default из файла, writable, label; пароль — из password_env", () => {
    write(
      ".1c-odata/databases.json",
      json({
        default: "ip",
        databases: [
          { name: "Buh", label: "ТОО", base_url: URL1, username: "u1", password: SECRET, writable: true },
          { name: "ip", base_url: URL2, username: "u2", password_env: "ODATA_PW_IP" },
        ],
      }),
    );
    const c = parseConfig({ ODATA_CONFIG: "~/.1c-odata/databases.json", ODATA_PW_IP: "pw-ip" }, { home });
    const file = join(home, ".1c-odata", "databases.json");
    expect(c.connections).toEqual([
      {
        name: "buh",
        label: "ТОО",
        baseUrl: URL1,
        username: "u1",
        password: SECRET,
        writable: true,
        writableSource: { kind: "file", file, base: "buh", set: true },
      },
      {
        name: "ip",
        baseUrl: `${URL2}/`,
        username: "u2",
        password: "pw-ip",
        writable: false,
        writableSource: { kind: "file", file, base: "ip", set: false },
      },
    ]);
    expect(c.defaultName).toBe("ip");
    expect(c.configFile).toBe(join(home, ".1c-odata", "databases.json"));
    expect(c.warnings).toEqual([]);
  });

  it("YAML (массив баз) и путь по умолчанию ~/.1c-odata/databases.yaml без ODATA_CONFIG", () => {
    write(
      ".1c-odata/databases.yaml",
      `- name: torg\n  base_url: ${URL1}\n  username: u\n  password: "${SECRET}"\n`,
    );
    const c = parseConfig({}, { home });
    expect(c.connections.map((x) => [x.name, x.password])).toEqual([["torg", SECRET]]);
    expect(c.defaultName).toBe("torg");
    // Без home (чистый разбор) путь по умолчанию не читается.
    expect(errorOf(() => parseConfig({}))).toMatch(/не задана ни одна база/);
  });

  it("слияние с переменными окружения: ODATA_DB_<ИМЯ> добавляет базу и переопределяет одноимённую из файла", () => {
    const path = write(
      "bases.json",
      json([
        { name: "buh", base_url: URL1, username: "file-user", password: SECRET },
        { name: "ip", base_url: URL2, username: "u", password: "p" },
      ]),
    );
    const c = parseConfig({
      ODATA_CONFIG: path,
      ODATA_DB_BUH_BASE_URL: URL2,
      ODATA_DB_BUH_USERNAME: "env-user",
      ODATA_DB_BUH_PASSWORD: "env-pw",
      ODATA_DB_TORG_BASE_URL: URL1,
      ODATA_DB_TORG_USERNAME: "t",
      ODATA_DB_TORG_PASSWORD: "t",
      ODATA_DEFAULT_DB: "torg",
    });
    expect(c.connections.map((x) => [x.name, x.username]).sort()).toEqual([
      ["buh", "env-user"],
      ["ip", "u"],
      ["torg", "t"],
    ]);
    expect(c.defaultName).toBe("torg");
    expect(c.warnings!.join(" ")).toMatch(/"buh" из файла .* переопределена переменными окружения/);
  });

  it("одиночная база ODATA_BASE_URL (как раньше) складывается с базами файла", () => {
    const path = write("b.json", json([{ name: "ip", base_url: URL2, username: "u", password: "p" }]));
    const c = parseConfig({
      ODATA_CONFIG: path,
      ODATA_BASE_URL: URL1,
      ODATA_USERNAME: "u",
      ODATA_PASSWORD: "p",
    });
    expect(c.connections.map((x) => x.name).sort()).toEqual(["default", "ip"]);
  });

  it("без файла — прежнее поведение переменных окружения", () => {
    const c = parseConfig({ ODATA_BASE_URL: URL1, ODATA_USERNAME: "u", ODATA_PASSWORD: "p" }, { home });
    expect(c.connections.map((x) => x.name)).toEqual(["default"]);
    expect(c.configFile).toBeUndefined();
  });

  it("права файла: доступен другим — предупреждение; 600 — тихо", () => {
    if (process.platform === "win32") return;
    const open = write(
      "open.json",
      json([{ name: "a", base_url: URL1, username: "u", password: SECRET }]),
      0o644,
    );
    const c = parseConfig({ ODATA_CONFIG: open });
    expect(c.warnings!.join(" ")).toMatch(/chmod 600/);
    expect(c.warnings!.join(" ")).not.toContain(SECRET);
  });

  it("ошибки понятны и без паролей: битый JSON, лишние поля, нет пароля, нет файла, неверный URL", () => {
    const broken = write("broken.json", `{ "databases": [ { "name": "a", "password": "${SECRET}", } ] `);
    const e1 = errorOf(() => parseConfig({ ODATA_CONFIG: broken }));
    expect(e1).toMatch(/не разобран как JSON/);
    expect(e1).not.toContain(SECRET);

    const brokenYaml = write("broken.yaml", `- name: a\n  password: "${SECRET}\n  base_url: [\n`);
    const e2 = errorOf(() => parseConfig({ ODATA_CONFIG: brokenYaml }));
    expect(e2).toMatch(/не разобран как YAML/);
    expect(e2).not.toContain(SECRET);

    const bad = write(
      "bad.json",
      json([
        { name: "a", base_url: "not a url", username: "u", password: SECRET },
        { name: "b", base_url: URL1, username: "u", pasword: SECRET },
        { name: "c", base_url: URL1, username: "u", password_env: "NOPE_PW" },
        { name: "d", base_url: URL1, password: SECRET },
      ]),
    );
    const e3 = errorOf(() => parseConfig({ ODATA_CONFIG: bad }));
    expect(e3).toMatch(/база "a": baseUrl должен быть валидным URL/);
    expect(e3).toMatch(/база #2 "b".*неизвестные поля: pasword/);
    expect(e3).toMatch(/база #3 "c".*NOPE_PW .*не задана/);
    expect(e3).toMatch(/база #4 "d" поле «username»/);
    expect(e3).not.toContain(SECRET);
    expect(e3).not.toContain("not a url");

    expect(errorOf(() => parseConfig({ ODATA_CONFIG: join(home, "nope.json") }))).toMatch(
      /файл баз ODATA_CONFIG не найден/,
    );
    const dup = write(
      "dup.json",
      json([
        { name: "a", base_url: URL1, username: "u", password: SECRET },
        { name: "A", base_url: URL1, username: "u", password: SECRET },
      ]),
    );
    const e4 = errorOf(() => parseConfig({ ODATA_CONFIG: dup }));
    expect(e4).toMatch(/дублирующееся имя базы: "a"/);
    expect(e4).not.toContain(SECRET);
  });

  it("пароли не попадают в предупреждения и сериализацию служебных полей конфигурации", () => {
    const p = write("ok.json", json([{ name: "a", base_url: URL1, username: "u", password: SECRET }]), 0o666);
    const c = parseConfig({ ODATA_CONFIG: p, ODATA_DEFAULT_DB: "zzz" });
    const { connections, ...rest } = c;
    expect(JSON.stringify(rest)).not.toContain(SECRET);
    // Лог старта (index.ts) — только сводка без логинов и паролей.
    expect(JSON.stringify(startupSummary(c))).not.toContain(SECRET);
    expect(startupSummary(c)).toMatchObject({ databases: ["a"], configFile: p });
    expect(connections[0]!.password).toBe(SECRET);
  });

  it("~ раскрывается в домашний каталог", () => {
    expect(expandHome("~/x/y.json", "/h")).toBe(join("/h", "x/y.json"));
    expect(expandHome("/abs.json", "/h")).toBe("/abs.json");
  });
});
