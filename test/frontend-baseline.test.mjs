import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, "..");
const css = fs.readFileSync(path.join(projectDir, "styles.css"), "utf8").replace(/\r\n?/gu, "\n");
const main = fs.readFileSync(path.join(projectDir, "main.ts"), "utf8");

const visualBaselineSha256 = "590752dba16a0b7b5c3f4677ccd013a6433a8920016e9a7c5e8678ffc991013b";
assert.equal(
  createHash("sha256").update(css).digest("hex"),
  visualBaselineSha256,
  "styles.css changed outside an explicitly approved frontend baseline update"
);

// Reading view injects CSS from JS, so stylesheet hashes alone miss palette regressions.
const injectedPalette = main.match(/style\.textContent = "([^"\n]*::highlight\(local-ir-reading-highlight\)[^"\n]*)"/u)?.[1];
assert.ok(injectedPalette, "reading highlight styles must be covered by the frontend baseline");
for (const kind of ["highlight", "cloze"]) {
  const baselineBackground = css.match(new RegExp(`\\.markdown-source-view \\.local-ir-virtual-${kind}\\s*\\{\\s*background:\\s*([^;]+);`, "u"))?.[1];
  assert.ok(baselineBackground, `missing original ${kind} palette`);
  const rule = injectedPalette.match(new RegExp(`::highlight\\(local-ir-reading-${kind}\\)\\{([^}]+)\\}`, "u"))?.[1];
  assert.equal(rule, `background-color:${baselineBackground}`, `${kind} reading palette must reuse the original rule without overriding text colors`);
}

for (const selector of [
  ".local-ir-view",
  ".local-ir-card",
  ".local-ir-stat-grid",
  ".local-ir-stat",
  ".local-ir-doc-row",
  '.local-ir-metric input[type="range"]'
]) {
  assert.ok(css.includes(selector), `missing frontend baseline selector: ${selector}`);
}

assert.match(main, /type:\s*"range"[\s\S]*?step:\s*"2\.5"/u, "priority controls must expose the five-level range input");
assert.match(main, /input\.addEventListener\("input",\s*updateMetricControlDisplay\)/u, "range input must update its label immediately");
assert.match(main, /saveSettings\(\{\s*flushDocumentStateSidecars:\s*false\s*\}\)/u, "metric updates must use the lightweight settings save path");
assert.match(main, /for \(const input of metricInputs\.values\(\)\) input\.value = String\(value\)/u, "extreme importance must update all range inputs immediately");
assert.match(main, /record\.status === "done"[\s\S]*?text:\s*"生成导出包"[\s\S]*?archiveRecord\(record\.path\)/u, "pending-package rows must expose a single-record package button");
assert.match(main, /singleArchivePathsInProgress = new Set<string>\(\)/u, "single-record package clicks must be guarded against duplicate execution");
assert.match(main, /class NoRemnoteContentConfirmationModal extends Modal/u, "zero RemNote item packages must require an Obsidian confirmation modal");
assert.match(main, /确认并生成导出包/u, "the confirmation modal must expose an explicit affirmative action");
assert.match(main, /取消，保持待生成/u, "the confirmation modal must expose a non-failure cancel action");
assert.match(main, /archiveLastFailure:\s*ArchiveFailureState \| null/u, "records must persist structured archive failure diagnostics");
assert.match(main, /生产者校验：\$\{validatorErrors\.join\("；"\)\}/u, "the pending list must display exact producer validator errors");
assert.doesNotMatch(main, /console\.error\("Local IR (?:single|batch) archive package generation failed",\s*(?:path|recordPath),\s*error\)/u, "archive diagnostic logs must not retain raw error objects that may contain input content");
console.log("frontend baseline tests passed");
