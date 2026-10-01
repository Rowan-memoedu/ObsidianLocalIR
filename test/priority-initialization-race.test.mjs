import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, "..");
const build = await esbuild.build({
  entryPoints: [path.join(projectDir, "metric-presets.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString("base64")}`;
const {
  inferMetricsEditedByUser,
  parseReadingMetricPreset,
  reconcileReadingMetricPreset
} = await import(moduleUrl);

const defaults = { importance: 5, urgency: 5, difficulty: 5, interest: 5 };
const finalMarkdown = `
## 阅读前置卡

- 价值判断：极高。合成测试。
- 信息密度判断：高。合成测试。
`;
const preset = parseReadingMetricPreset(finalMarkdown);
const initialState = () => ({
  metrics: { ...defaults },
  metricsEditedByUser: false,
  metricPresetCheckedMtime: null
});

const createFirst = reconcileReadingMetricPreset(initialState(), preset, 200);
assert.deepEqual(createFirst.state.metrics, { importance: 10, urgency: 7.5, difficulty: 5, interest: 5 });
assert.equal(createFirst.presetApplied, true);

const sidecarFirstRecord = initialState();
const sidecarThenMarkdown = reconcileReadingMetricPreset(sidecarFirstRecord, preset, 200);
assert.deepEqual(sidecarThenMarkdown.state.metrics, createFirst.state.metrics);

const legacyDefault = {
  ...initialState(),
  metricsEditedByUser: inferMetricsEditedByUser(defaults, undefined)
};
const legacyCompensation = reconcileReadingMetricPreset(legacyDefault, preset, 200);
assert.deepEqual(legacyCompensation.state.metrics, createFirst.state.metrics);

const manuallyTunedMetrics = { ...defaults, importance: 7.5 };
const inferredManual = inferMetricsEditedByUser(manuallyTunedMetrics, undefined);
assert.equal(inferredManual, true);
const protectedManual = reconcileReadingMetricPreset({
  metrics: manuallyTunedMetrics,
  metricsEditedByUser: inferredManual,
  metricPresetCheckedMtime: null
}, preset, 200);
assert.deepEqual(protectedManual.state.metrics, manuallyTunedMetrics);
assert.equal(protectedManual.changed, false);

const explicitDefault = reconcileReadingMetricPreset({
  metrics: { ...defaults },
  metricsEditedByUser: true,
  metricPresetCheckedMtime: null
}, preset, 200);
assert.deepEqual(explicitDefault.state.metrics, defaults);
assert.equal(explicitDefault.changed, false);

const idempotentRescan = reconcileReadingMetricPreset(createFirst.state, preset, 200);
assert.deepEqual(idempotentRescan.state, createFirst.state);
assert.equal(idempotentRescan.changed, false);

const source = fs.readFileSync(path.join(projectDir, "main.ts"), "utf8");
assert.ok(source.includes("await this.backfillRecordMetricPreset(file, existing)"), "syncRecords must backfill existing records after Markdown becomes readable");
assert.ok(source.includes("await this.backfillRecordMetricPreset(file, this.settings.records[file.path])"), "vault create must repair a sidecar-first record");
assert.ok(source.includes("record.metricsEditedByUser = true"), "explicit metric edits must permanently protect the record from preset backfill");
assert.ok(source.includes("record.metricPresetCheckedMtime === file.stat.mtime"), "unchanged Markdown must not be rescanned repeatedly");

console.log("priority initialization race tests passed");
