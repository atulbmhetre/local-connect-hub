import { readFileSync, writeFileSync } from "node:fs";

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const row = [];
    while (i < len) {
      let cell = "";
      if (text[i] === '"') {
        i++;
        while (i < len) {
          if (text[i] === '"' && text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          if (text[i] === '"') {
            i++;
            break;
          }
          cell += text[i++];
        }
      } else {
        while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          cell += text[i++];
        }
      }
      row.push(cell);
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") {
        i++;
        break;
      }
      break;
    }
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
  }
  return rows;
}

function esc(s) {
  const t = String(s).replace(/\r?\n/g, " | ").replace(/"/g, '""');
  return `"${t}"`;
}

const raw = readFileSync("docs/manual-test-matrix.csv", "utf8");
const rows = parseCsv(raw);
writeFileSync(
  "docs/manual-test-matrix.csv",
  rows.map((r) => r.map(esc).join(",")).join("\n") + "\n",
  "utf8",
);
console.log("rows", rows.length);
console.log("sample_prereq", rows[1][2]);
