/**
 * Ссылки из читаемого ответа — обратно во вход любого инструмента как есть: объект {guid, name, type?} → guid,
 * КНП {code, name} → код. Интеграция берёт поле из ответа чтения и передаёт его в запись, не выковыривая guid.
 *
 * create_document / update_document разбирают такие объекты сами (там нужен type у составного поля) — их не трогаем.
 */

const OWN = new Set(["write.document.create_document", "write.document.update_document"]);
const REF_KEYS = new Set(["guid", "name", "code", "type"]);
const KNP_KEY = /^(knp|КодНазначенияПлатежа|paymentPurposeCode|purposeCode)$/i;

function isRefObject(v: Record<string, unknown>): boolean {
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => REF_KEYS.has(k)) && typeof v["guid"] === "string";
}

function unwrap(v: unknown, key: string): unknown {
  if (Array.isArray(v)) return v.map((x) => unwrap(x, key));
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (isRefObject(o)) return o["guid"];
  if (KNP_KEY.test(key) && typeof o["code"] === "string" && Object.keys(o).every((k) => REF_KEYS.has(k)))
    return o["code"];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, unwrap(x, k)]));
}

export function unwrapRefs(toolName: string, args: unknown): unknown {
  if (OWN.has(toolName) || !args || typeof args !== "object" || Array.isArray(args)) return args;
  return unwrap(args, "");
}
