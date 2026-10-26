import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { fail } from "./_shared.js";
import { sharedToolMessage, type SharedMode } from "../write-status.js";

/**
 * Шлюз для клиентов, которые запоминают tools/list в начале разговора и не видят инструменты, появившиеся
 * после обновления сервера: meta.list_tools показывает актуальный реестр, meta.call_tool вызывает инструмент
 * из него. Имена и схемы этих двух инструментов после релиза не меняются.
 *
 * Оба работают через те же обработчики запросов SDK, что и протокол: tools/list (тот же реестр, без ручного
 * списка) и tools/call (та же zod-валидация входа и выхода, префлайт, READ_ONLY/writable, dry-run/confirm,
 * operationId и журнал записи, логирование) — ответ целевого инструмента возвращается без изменений.
 */

export const META_LIST = "meta.list_tools";
export const META_CALL = "meta.call_tool";

/** Имена всех пишущих инструментов сервера (запоминает createServer до фильтра инструментов). */
const KNOWN_WRITE_TOOLS = new Set<string>();
export function registerKnownWriteTool(name: string): void {
  if (name.startsWith("write.")) KNOWN_WRITE_TOOLS.add(name);
}
const knownWriteTool = (name: string) => KNOWN_WRITE_TOOLS.has(name);

type RequestHandler = (
  request: { method: string; params: Record<string, unknown> },
  extra: unknown,
) => Promise<unknown>;

/** Обработчик запроса, установленный McpServer (tools/list, tools/call). */
function sdkHandler(server: McpServer, method: "tools/list" | "tools/call"): RequestHandler {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })
    ._requestHandlers;
  const h = handlers?.get(method);
  if (!h)
    throw new Error(`Внутренняя ошибка: обработчик ${method} не найден (несовместимая версия MCP SDK).`);
  return h;
}

async function listRegistered(server: McpServer, extra: unknown): Promise<Tool[]> {
  const res = (await sdkHandler(server, "tools/list")({ method: "tools/list", params: {} }, extra)) as {
    tools: Tool[];
  };
  return res.tools;
}

/** Расстояние Левенштейна — для подсказки похожих имён. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export function similarNames(name: string, names: readonly string[], max = 5): string[] {
  const q = name.trim().toLowerCase();
  const tail = q.split(".").pop() ?? q;
  return names
    .map((n) => {
      const l = n.toLowerCase();
      const t = l.split(".").pop() ?? l;
      const score =
        l.includes(q) || (tail.length >= 3 && t.includes(tail))
          ? 0
          : Math.min(distance(q, l), distance(tail, t) + 2);
      return { n, score };
    })
    .filter((x) => x.score <= Math.max(3, Math.floor(q.length / 3)))
    .sort((a, b) => a.score - b.score || a.n.localeCompare(b.n))
    .slice(0, max)
    .map((x) => x.n);
}

const toolInfo = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.object({}).passthrough().optional(),
    annotations: z.object({}).passthrough().optional(),
  })
  .passthrough();

type Register = (
  name: string,
  config: Record<string, unknown>,
  cb: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>,
) => unknown;

/** Регистрирует meta.list_tools и meta.call_tool напрямую (без префлайта базы: целевой вызов пройдёт его сам). */
export function registerGatewayTools(
  server: McpServer,
  register: Register,
  version: string,
  shared?: SharedMode,
): void {
  register(
    META_LIST,
    {
      title: "Актуальный список инструментов",
      description:
        "Список инструментов сервера прямо сейчас — из того же реестра, что tools/list. Нужен, если клиент " +
        "запомнил список инструментов в начале разговора и не видит новых: найдите инструмент здесь и вызовите " +
        "через meta.call_tool. Фильтры: prefix (начало имени), search (часть имени или описания, без учёта " +
        'регистра), includeSchema=false — без схем входа. Пример: {"prefix": "read.currency", "includeSchema": true}.',
      inputSchema: {
        prefix: z.string().trim().max(100).optional().describe("Начало имени, напр. write.esf или read."),
        search: z
          .string()
          .trim()
          .max(100)
          .optional()
          .describe("Часть имени или описания (без учёта регистра)"),
        includeSchema: z
          .boolean()
          .default(true)
          .describe("Включать inputSchema (JSON Schema, как в tools/list)"),
      },
      outputSchema: z
        .object({
          version: z.string(),
          total: z.number(),
          count: z.number(),
          tools: z.array(toolInfo),
        })
        .passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const search = typeof args.search === "string" ? args.search.toLowerCase() : "";
      const includeSchema = args.includeSchema !== false;
      const all = await listRegistered(server, extra);
      const tools = all
        .filter(
          (t) =>
            (!prefix || t.name.startsWith(prefix)) &&
            (!search ||
              t.name.toLowerCase().includes(search) ||
              (t.description ?? "").toLowerCase().includes(search) ||
              (t.title ?? "").toLowerCase().includes(search)),
        )
        .map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          ...(t.description ? { description: t.description } : {}),
          ...(includeSchema ? { inputSchema: t.inputSchema } : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }));
      const structuredContent = { version, total: all.length, count: tools.length, tools };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );

  register(
    META_CALL,
    {
      title: "Вызвать инструмент по имени",
      description:
        "Вызывает инструмент сервера по имени — тем же путём, что прямой вызов, и возвращает его ответ без " +
        "изменений (включая ошибки). Для инструментов, которых клиент не видит в своём списке (см. meta.list_tools). " +
        "Для write.* действуют те же ограничения: dry-run по умолчанию, confirm=true и operationId из предпросмотра, " +
        "READ_ONLY и writable базы, согласие бухгалтера; в командном подключении — только инструменты из ODATA_HTTP_WRITE_TOOLS " +
        "(обхода нет: шлюз видит тот же список, что и клиент). meta.* через шлюз не вызываются. " +
        'Пример: {"name": "read.currency.get_rates", "arguments": {"currencies": ["USD"]}}.',
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(150)
          .describe("Полное имя инструмента, напр. read.system.health_check"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Аргументы инструмента (как при прямом вызове)"),
      },
      outputSchema: z.object({}).passthrough(),
      // Шлюз может вызвать write.* (в т.ч. проведение и пометку на удаление) — помечен как способный писать.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      const name = String(args.name ?? "").trim();
      if (name.startsWith("meta."))
        return fail(
          `${name} через meta.call_tool не вызывается: шлюз не вызывает meta.* (в том числе сам себя).`,
        );
      const names = (await listRegistered(server, extra)).map((t) => t.name);
      if (!names.includes(name)) {
        // Командный режим: пишущий инструмент существует, но коннектор его не опубликовал — объясняем, а не «нет такого».
        if (shared && name.startsWith("write.") && !shared.writeTools.includes(name) && knownWriteTool(name))
          return fail(sharedToolMessage(name, shared));
        const hint = similarNames(name, names);
        return fail(
          `Инструмента «${name}» нет на сервере.` +
            (hint.length ? ` Похожие: ${hint.join(", ")}.` : "") +
            " Полный список — meta.list_tools.",
        );
      }
      logger.info({ tool: META_CALL, target: name }, "gateway call");
      const params: Record<string, unknown> = { name };
      if (args.arguments !== undefined) params["arguments"] = args.arguments;
      return (await sdkHandler(server, "tools/call")(
        { method: "tools/call", params },
        extra,
      )) as CallToolResult;
    },
  );
}
