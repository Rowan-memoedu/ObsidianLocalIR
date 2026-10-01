import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const canaryDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(canaryDir, "..");
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
const preset = parseReadingMetricPreset(`
## 阅读前置卡

- 价值判断：低。独立合成 Canary。
- 信息密度判断：极高。独立合成 Canary。
`);
const fresh = () => ({ metrics: { ...defaults }, metricsEditedByUser: false, metricPresetCheckedMtime: null });
const checks = [];

const createFirst = reconcileReadingMetricPreset(fresh(), preset, 300);
assert.deepEqual(createFirst.state.metrics, { importance: 2.5, urgency: 10, difficulty: 5, interest: 5 });
checks.push("create_before_sidecar");

const sidecarFirst = reconcileReadingMetricPreset(fresh(), preset, 300);
assert.deepEqual(sidecarFirst.state.metrics, createFirst.state.metrics);
checks.push("sidecar_before_create");

const legacy = reconcileReadingMetricPreset({
  ...fresh(),
  metricsEditedByUser: inferMetricsEditedByUser(defaults, undefined)
}, preset, 300);
assert.deepEqual(legacy.state.metrics, createFirst.state.metrics);
checks.push("legacy_default_backfill");

const tuned = { ...defaults, urgency: 7.5 };
const protectedResult = reconcileReadingMetricPreset({
  metrics: tuned,
  metricsEditedByUser: inferMetricsEditedByUser(tuned, undefined),
  metricPresetCheckedMtime: null
}, preset, 300);
assert.deepEqual(protectedResult.state.metrics, tuned);
checks.push("manual_value_protected");

const explicitDefault = reconcileReadingMetricPreset({
  metrics: { ...defaults },
  metricsEditedByUser: true,
  metricPresetCheckedMtime: null
}, preset, 300);
assert.deepEqual(explicitDefault.state.metrics, defaults);
checks.push("explicit_default_protected");

const rescan = reconcileReadingMetricPreset(createFirst.state, preset, 300);
assert.equal(rescan.changed, false);
assert.deepEqual(rescan.state, createFirst.state);
checks.push("idempotent_rescan");

console.log(JSON.stringify({ status: "passed", fixture: "synthetic", checks }, null, 2));
