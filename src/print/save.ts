import { mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { InputError } from "../errors.js";

/** Корень для PDF печатных форм, если не задан ODATA_PRINT_DIR. */
export const DEFAULT_PRINT_DIR = "/workspace/library/счета";

/** Предел длины имени файла в байтах UTF-8 (ext4/APFS — 255; запас под « (N)»). */
const MAX_NAME_BYTES = 200;
/** Сколько копий с суффиксом « (2)…(N)» пробовать, прежде чем сдаться. */
const MAX_COPIES = 999;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** `target` совпадает с `root` или лежит внутри него (по нормализованным путям). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Обрезка строки по байтам UTF-8, не разрывая символы. */
function cutBytes(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > max) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/**
 * Безопасное имя файла из человекочитаемого названия: без разделителей пути и управляющих символов,
 * без символов, запрещённых в Windows, без невидимых символов направления текста (RLO и т. п.), без ведущих/хвостовых точек и пробелов (нет «.», «..» и скрытых
 * файлов), с ограничением длины и расширением `ext`. Кириллица, «№» и пробелы сохраняются.
 */
export function safeFileName(name: string, ext = ".pdf"): string {
  let base = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ") // управляющие, невидимые форматные (в т. ч. RLO), разрывы строк
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
  base = cutBytes(base, MAX_NAME_BYTES - Buffer.byteLength(ext, "utf8"));
  base = base.replace(/^[.\s]+|[.\s]+$/g, "");
  if (!base) base = "document";
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  return `${base}${ext}`;
}

/**
 * Каталог для сохранения внутри корня `root`. `outputDir` — относительный путь от корня или абсолютный путь
 * внутри него; выход за корень («..», абсолютный путь вне корня, символическая ссылка наружу) отклоняется.
 * Недостающие подкаталоги создаются по одному, после проверки каждого шага, поэтому ничего не создаётся
 * за пределами корня даже через символическую ссылку. Возвращает реальный (realpath) путь каталога.
 */
export async function resolvePrintDir(root: string, outputDir?: string): Promise<string> {
  const absRoot = resolve(root);
  const wanted = outputDir?.trim() ? outputDir.trim() : ".";
  if (wanted.includes("\0")) throw new InputError("outputDir содержит нулевой символ.");
  const target = resolve(absRoot, wanted);
  if (!isInside(absRoot, target))
    throw new InputError(
      `outputDir «${outputDir}» выходит за каталог печати ${absRoot}. Укажите подкаталог внутри него ` +
        "(корень меняется переменной окружения ODATA_PRINT_DIR).",
    );
  await mkdir(absRoot, { recursive: true });
  const realRoot = await realpath(absRoot);
  let cur = realRoot;
  for (const part of relative(absRoot, target).split(sep).filter(Boolean)) {
    const next = join(cur, part);
    try {
      await mkdir(next);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    cur = await realpath(next);
    if (!isInside(realRoot, cur))
      throw new InputError(
        `outputDir «${outputDir}» через символическую ссылку ведёт за каталог печати ${realRoot}.`,
      );
  }
  return cur;
}

export interface SavedFile {
  /** Абсолютный путь записанного файла. */
  path: string;
  fileName: string;
  directory: string;
  /** Имя было занято — файл сохранён с суффиксом « (N)», существующий не тронут. */
  renamed: boolean;
}

/**
 * Записывает файл, никогда не перезаписывая существующий: создание эксклюзивное (O_CREAT|O_EXCL, «wx» —
 * в том числе не следует по символической ссылке на месте имени). Если имя занято — «имя (2).pdf»,
 * «имя (3).pdf» … до «(999)».
 */
export async function saveUnique(dir: string, fileName: string, data: Buffer): Promise<SavedFile> {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let i = 1; i <= MAX_COPIES; i++) {
    const candidate = i === 1 ? fileName : `${stem} (${i})${ext}`;
    const path = join(dir, candidate);
    if (basename(path) !== candidate || dirname(path) !== dir || !isInside(dir, path))
      throw new InputError(`Недопустимое имя файла «${candidate}».`);
    let fh;
    try {
      fh = await open(path, "wx", 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      await fh.writeFile(data);
      await fh.close();
    } catch (e) {
      await fh.close().catch(() => undefined);
      await unlink(path).catch(() => undefined); // недописанный файл не оставляем
      throw e;
    }
    return { path, fileName: candidate, directory: dir, renamed: i > 1 };
  }
  throw new InputError(
    `В ${dir} уже ${MAX_COPIES} файлов с именем «${fileName}» — освободите место или задайте outputDir.`,
  );
}
