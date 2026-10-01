import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(testDir, "..", "metric-presets.ts");
const build = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString("base64")}`;
const {
  MAX_METRIC_VALUE,
  metricLevelLabel,
  parseReadingMetricPreset,
  snapMetricValue
} = await import(moduleUrl);

assert.deepEqual(parseReadingMetricPreset(`
# 标准产物

## 阅读前置卡

- 价值判断：高。值得认真阅读。
- 信息密度判断：低。内容比较松散。

## 正文
`), { valueJudgment: 7.5, informationDensity: 2.5 });

assert.deepEqual(parseReadingMetricPreset(`
## 阅读前置卡

### 对我的价值判断
**中**。有一定参考价值。

### 信息密度判断
**高。** 信息紧凑。
`), { valueJudgment: 5, informationDensity: 7.5 });

assert.deepEqual(parseReadingMetricPreset(`---
value_judgment: low
information_density: medium
---

## 阅读前置卡

- 价值判断：高。正文中的旧判断。
- 信息密度判断：高。正文中的旧判断。
`), { valueJudgment: 2.5, informationDensity: 5 });

assert.deepEqual(parseReadingMetricPreset(`
## 阅读前置卡

- 价值判断：跳过。没有继续阅读价值。
- 信息密度判断：中。信息密度一般。
`), { valueJudgment: 0, informationDensity: 5 });

assert.deepEqual(parseReadingMetricPreset(`
## 阅读前置卡

- 价值判断：极高。具有直接且不可替代的价值。
- 信息密度判断：极低。有效信息非常稀疏。
`), { valueJudgment: 10, informationDensity: 0 });

assert.deepEqual(parseReadingMetricPreset(`---
value_judgment: very_low
information_density: very_high
---
`), { valueJudgment: 0, informationDensity: 10 });

assert.deepEqual(parseReadingMetricPreset("# 普通文章\n\n没有前置卡。"), {});
assert.equal(snapMetricValue(1.5), 2.5);
assert.equal(snapMetricValue(4.9), 5);
assert.equal(snapMetricValue(8.2), 7.5);
assert.equal(snapMetricValue(9.1), MAX_METRIC_VALUE);
assert.equal(metricLevelLabel(8.2), "高");
assert.equal(metricLevelLabel(9.1), "极高");

console.log("metric preset tests passed");
