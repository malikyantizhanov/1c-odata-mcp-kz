import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { ODataError } from "./errors.js";

/**
 * Сетевой доступ общего HTTP-коннектора (src/http.ts): адрес базы присылает пользователь, поэтому запрос не должен
 * уйти во внутреннюю сеть сервера (соседние сервисы, метаданные облака). Адрес проверяется в момент соединения —
 * по всем адресам, которые вернул DNS (подмена записи между проверкой и запросом не поможет), — а перенаправления
 * запрещены: 3xx — ошибка с подсказкой указать точный адрес OData.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** IPv4 внутри IPv6 (::ffff:10.0.0.1 или ::ffff:a00:1) — проверяется как IPv4. */
function mappedIPv4(address: string): string | undefined {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (!m) return undefined;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16);
  const lo = parseInt(m[3]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Внутренний, служебный или локальный адрес (или вовсе не IP) — туда коннектор не ходит. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blocked.check(address, "ipv4");
  if (version === 6) {
    const v4 = mappedIPv4(address);
    return v4 ? blocked.check(v4, "ipv4") : blocked.check(address, "ipv6");
  }
  return true;
}

const BLOCKED_MESSAGE = (host: string) =>
  `Адрес «${host}» ведёт во внутреннюю сеть — подключаться к таким адресам коннектор не будет.`;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** DNS с проверкой: хоть один адрес из ответа внутренний — соединения нет. */
export function guardedLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
      const e: NodeJS.ErrnoException = Object.assign(new Error(BLOCKED_MESSAGE(hostname)), {
        code: "EBLOCKED",
      });
      return callback(e, "");
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

let agent: Agent | undefined;

/** fetch для запросов к 1С в общем режиме: проверка адреса при соединении, без перенаправлений. */
export async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) {
    throw new ODataError({ kind: "network", url, retryable: false, message: BLOCKED_MESSAGE(host) });
  }
  agent ??= new Agent({ connect: { lookup: guardedLookup as never } });
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, { ...(init as object), dispatcher: agent, redirect: "manual" } as never);
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "EBLOCKED") {
      throw new ODataError({
        kind: "network",
        url,
        retryable: false,
        message: cause.message ?? BLOCKED_MESSAGE(host),
      });
    }
    throw e;
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new ODataError({
      kind: "bad_request",
      status: res.status,
      url,
      retryable: false,
      message:
        "Публикация 1С перенаправляет запрос на другой адрес. Укажите точный адрес стандартного интерфейса OData " +
        "(…/odata/standard.odata/).",
    });
  }
  return res as unknown as Response;
}
