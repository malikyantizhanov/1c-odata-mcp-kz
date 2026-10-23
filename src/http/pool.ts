import { createHash } from "node:crypto";
import { z } from "zod";
import type { Behavior, ConnectionConfig } from "../config/env.js";
import { Connection } from "../context.js";

/**
 * Подключение из заголовка X-OneC-Connection: base64url от JSON — его присылает бэкенд чата с каждым запросом
 * (кириллица в логине и пароле не ломает заголовок). Коннектор учётку нигде не хранит, кроме памяти пула.
 */
const HeaderSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "только латиница, цифры, - и _"),
  baseUrl: z
    .string()
    .url("должен быть адресом")
    .refine((u) => u.startsWith("https://"), "только https")
    .transform((u) => (u.endsWith("/") ? u : `${u}/`)),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  writable: z.boolean().default(false),
  label: z.string().max(200).optional(),
});

/** Разбор заголовка; ошибка — с понятным текстом без значений полей. */
export function parseConnectionHeader(raw: string | undefined): ConnectionConfig {
  if (!raw) throw new Error("нет заголовка X-OneC-Connection");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("заголовок X-OneC-Connection — не base64url JSON");
  }
  const parsed = HeaderSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`заголовок X-OneC-Connection: ${fields}`);
  }
  const c = parsed.data;
  return {
    // имя базы — ключ журнала записи и параметра database; ServerContext сравнивает имена в нижнем регистре
    name: `c_${c.id}`.toLowerCase(),
    ...(c.label ? { label: c.label } : {}),
    baseUrl: c.baseUrl,
    username: c.username,
    password: c.password,
    writable: c.writable,
  };
}

interface Entry {
  conn: Connection;
  lastUsed: number;
  active: number;
  waiting: Array<() => void>;
}

/**
 * Пул подключений общего режима. Ключ — хеш всей учётки (адрес, логин, пароль, право записи): один и тот же объект
 * Connection между запросами — значит, кеши $metadata, плана счетов и субконто не собираются заново, а сменивший
 * пароль или право записи пользователь получает новое подключение. На одно подключение — не больше perConnection
 * одновременных запросов (1С не любит параллель), остальные ждут в очереди.
 */
export class ConnectionPool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly behavior: Behavior,
    private readonly opts: { max: number; idleMs: number; perConnection: number } = {
      max: 12,
      idleMs: 30 * 60_000,
      perConnection: 4,
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async acquire(cfg: ConnectionConfig): Promise<{ conn: Connection; release: () => void }> {
    const key = createHash("sha256")
      .update([cfg.name, cfg.baseUrl, cfg.username, cfg.password, String(cfg.writable)].join("\u0000"))
      .digest("hex");
    this.evict();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { conn: new Connection(cfg, this.behavior), lastUsed: Date.now(), active: 0, waiting: [] };
      this.entries.set(key, entry);
    }
    const e = entry;
    if (e.active >= this.opts.perConnection) await new Promise<void>((resume) => e.waiting.push(resume));
    e.active += 1;
    e.lastUsed = Date.now();
    let released = false;
    return {
      conn: e.conn,
      release: () => {
        if (released) return;
        released = true;
        e.active -= 1;
        e.lastUsed = Date.now();
        e.waiting.shift()?.();
      },
    };
  }

  /** Убрать простаивающие подключения: дольше idleMs без запросов, а сверх max — самые давние. */
  private evict(): void {
    const now = Date.now();
    for (const [key, e] of this.entries)
      if (e.active === 0 && !e.waiting.length && now - e.lastUsed > this.opts.idleMs)
        this.entries.delete(key);
    if (this.entries.size < this.opts.max) return;
    const idle = [...this.entries].filter(([, e]) => e.active === 0 && !e.waiting.length);
    idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of idle.slice(0, this.entries.size - this.opts.max + 1)) this.entries.delete(key);
  }
}
