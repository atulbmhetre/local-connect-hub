import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = execSync("git show HEAD:src/lib/strings.ts", { cwd: root, encoding: "utf8" });
const lines = source.split(/\r?\n/);

function makeLocale(name, openLine, closeLine) {
  const body = lines.slice(openLine + 1, closeLine);
  return `export const ${name} = {\n${body.join("\n")}\n} as const;\n`;
}

const outDir = path.join(root, "src/lib/strings");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "en.ts"), makeLocale("en", 9, 1996));
fs.writeFileSync(path.join(outDir, "hi.ts"), makeLocale("hi", 1997, 3978));
fs.writeFileSync(path.join(outDir, "mr.ts"), makeLocale("mr", 3979, 5960));
console.log("split ok from git HEAD");
