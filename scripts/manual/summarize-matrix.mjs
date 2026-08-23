import { readFileSync } from "node:fs";

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
        while (
          i < len &&
          text[i] !== "," &&
          text[i] !== "\n" &&
          text[i] !== "\r"
        )
          cell += text[i++];
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
    if (row.length > 1 || row[0]) rows.push(row);
  }
  return rows;
}

const rows = parseCsv(readFileSync("docs/manual-test-matrix.csv", "utf8")).slice(
  1,
);
const by = {};
for (const r of rows) {
  const id = r[0];
  const a = id.split("-")[0];
  if (!by[a]) by[a] = new Set();
  by[a].add(id);
}
const lines = Object.entries(by)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([a, s]) => `${a}\t${s.size}`);
console.log(lines.join("\n"));
console.log("TOTAL_CASES", Object.values(by).reduce((n, s) => n + s.size, 0));
console.log("TOTAL_STEPS", rows.length);
