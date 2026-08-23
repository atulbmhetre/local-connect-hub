import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";

const H =
  "Test_ID,Test_Case_Name,Prerequisites,Step_No,What_You_Do,What_Should_Happen,Platform,Priority,Pass_Fail,Notes";

const parts = ["a", "b", "c", "d", "e"].map((p) => {
  const path = `docs/_mtm_rows_${p}.json`;
  return JSON.parse(readFileSync(path, "utf8"));
});

const all = parts.flat();
const ids = new Set(all.map((r) => r.split(",")[0].replaceAll('"', "")));
writeFileSync("docs/manual-test-matrix.csv", [H, ...all].join("\n") + "\n", "utf8");

for (const p of ["a", "b", "c", "d", "e"]) {
  const path = `docs/_mtm_rows_${p}.json`;
  if (existsSync(path)) unlinkSync(path);
}
if (existsSync("docs/_mtm_gen_partial.js")) unlinkSync("docs/_mtm_gen_partial.js");

console.log(
  JSON.stringify(
    {
      rows: all.length,
      unique_test_ids: ids.size,
      ui_cases: [...ids].filter((id) => id.includes("-UI-")).length,
    },
    null,
    2,
  ),
);
