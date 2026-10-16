// Ручной релиз: npm run release [patch|minor|major] [-- --push]
// Поднимает версию, синхронизирует manifest.json, коммитит «[skip ci]» и ставит тег v<версия>.
import { execFileSync } from "node:child_process";
import process from "node:process";

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const level = process.argv.slice(2).find((a) => ["patch", "minor", "major"].includes(a)) ?? "patch";
const push = process.argv.includes("--push");

if (run("git", ["status", "--porcelain"]) !== "")
  throw new Error("Есть незакоммиченные изменения — релиз отменён.");
run("npm", ["version", level, "--no-git-tag-version"]);
const version = run("node", ["scripts/sync-version.mjs"]);
run("git", ["add", "package.json", "package-lock.json", "manifest.json", "CHANGELOG.md"]);
run("git", ["commit", "-m", `chore(release): v${version} [skip ci]`]);
run("git", ["tag", `v${version}`]);
process.stdout.write(`Версия ${version}, тег v${version} создан локально.\n`);
if (push) {
  run("git", ["push", "origin", "HEAD", `v${version}`]);
  process.stdout.write("Запушено.\n");
} else {
  process.stdout.write(`Отправьте: git push origin HEAD v${version}\n`);
}
