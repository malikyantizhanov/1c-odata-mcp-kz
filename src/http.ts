#!/usr/bin/env node
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseBehavior } from "./config/env.js";
import { ServerContext } from "./context.js";
import { createServer } from "./mcp/server.js";
import { ConnectionPool, parseConnectionHeader } from "./http/pool.js";
import { logger } from "./logger.js";

/**
 * Общий HTTP-режим: один коннектор на много пользователей. Учётка базы приходит с каждым запросом в заголовке
 * X-OneC-Connection (её присылает бэкенд чата), доступ к самому коннектору — по общему ключу Authorization: Bearer.
 * Streamable HTTP без сессий: на каждый POST /mcp — свой McpServer поверх подключения из пула.
 *
 * Чего нет в общем режиме: шлюза meta.* (инструменты для модели отбирает бэкенд), печатных форм и вложений
 * (файлы пишутся на диск коннектора — пользователю их отсюда не отдать).
 */
export function sharedToolFilter(name: string): boolean {
  return !(
    name.startsWith("meta.") ||
    name.startsWith("read.files.") ||
    name.startsWith("read.document.print_")
  );
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface HttpServerOptions {
  token: string;
  pool: ConnectionPool;
}

/** HTTP-сервер коннектора (без listen): /healthz и POST /mcp. */
export function buildHttpServer(opts: HttpServerOptions): Server & { inflight: () => number } {
  const ver = version();
  let inflight = 0;
  const server = createNodeServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") return json(res, 200, { ok: true, version: ver });
    if (path !== "/mcp") return json(res, 404, { error: "not found" });
    if (!tokenMatches(req.headers.authorization, opts.token))
      return json(res, 401, { error: "unauthorized" });
    // без сессий: потока сервер → клиент (GET) и закрытия сессии (DELETE) нет
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" }, { Allow: "POST" });

    let cfg;
    try {
      cfg = parseConnectionHeader(req.headers["x-onec-connection"] as string | undefined);
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }

    inflight += 1;
    let release: (() => void) | undefined;
    let cleanup: (() => void) | undefined;
    let closed = false;
    // клиент может уйти, пока запрос ждёт место в пуле, — место и счётчик освобождаются в любом случае
    res.on("close", () => {
      closed = true;
      release?.();
      cleanup?.();
      inflight -= 1;
      logger.info({ path, status: res.statusCode, ms: Date.now() - started, base: cfg.name }, "mcp request");
    });
    void (async () => {
      const lease = await opts.pool.acquire(cfg);
      release = lease.release;
      if (closed) return release();
      const mcp = createServer(ServerContext.forConnection(lease.conn), { toolFilter: sharedToolFilter });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      cleanup = () => {
        void transport.close();
        void mcp.close();
      };
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        logger.error({ err: (e as Error).message, base: cfg.name }, "mcp request failed");
        json(res, 500, { error: "internal error" });
      }
    })();
  }) as Server & { inflight: () => number };
  server.inflight = () => inflight;
  return server;
}

async function main(): Promise<void> {
  const token = process.env.MCP_HTTP_TOKEN?.trim();
  if (!token || token.length < 24) throw new Error("задайте MCP_HTTP_TOKEN (не короче 24 символов)");
  const { behavior } = parseBehavior(process.env);
  const pool = new ConnectionPool(behavior);
  const server = buildHttpServer({ token, pool });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, "0.0.0.0", () =>
    logger.info({ port, readOnly: behavior.readOnly }, "1c-odata-mcp запущен (общий HTTP-режим)"),
  );

  // Остановка: новых запросов не берём, текущие (запись в 1С!) дорабатывают — до 60 с.
  const stop = () => {
    server.close();
    const deadline = Date.now() + 60_000;
    const wait = setInterval(() => {
      if (server.inflight() === 0 || Date.now() > deadline) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 200);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`1c-odata-mcp: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
