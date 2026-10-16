// Синхронизирует версию manifest.json и раздел CHANGELOG.md с package.json (единственный источник версии).
// Если в CHANGELOG ещё нет раздела версии, всё накопленное в «Не выпущено» становится разделом
// «## [X.Y.Z] — дата», а «Не выпущено» очищается; ссылки в конце файла обновляются.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== version) {
  manifest.version = version;
  writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
}

let log = readFileSync("CHANGELOG.md", "utf8");
if (!log.includes(`## [${version}]`)) {
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" });
  log = log.replace("## [Не выпущено]\n", `## [Не выпущено]\n\n## [${version}] — ${date}\n`);
  const m = log.match(/^\[Не выпущено\]: (\S+)\/compare\/v(\S+?)\.\.\.HEAD$/m);
  if (m) {
    const [line, base, prev] = m;
    log = log.replace(
      line,
      `[Не выпущено]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/v${prev}...v${version}`,
    );
  }
  writeFileSync("CHANGELOG.md", log);
}
process.stdout.write(`${version}\n`);
