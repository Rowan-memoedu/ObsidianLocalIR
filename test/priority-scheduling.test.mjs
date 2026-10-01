import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(testDir, "..", "priority-scheduling.ts");
const main = fs.readFileSync(path.resolve(testDir, "..", "main.ts"), "utf8");
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
  comparePriorityRecords,
  findExtremePriorityRecord,
  isExtremePriorityMetrics
} = await import(moduleUrl);

const metrics = (importance, urgency, difficulty, interest) => ({ importance, urgency, difficulty, interest });
const ordinary = { id: "ordinary", metrics: metrics(10, 10, 10, 5), priority: 9.25 };
const extreme = { id: "extreme", metrics: metrics(10, 10, 10, 10), priority: 10 };
const low = { id: "low", metrics: metrics(0, 0, 0, 0), priority: 0 };

assert.equal(isExtremePriorityMetrics(extreme.metrics), true);
assert.equal(isExtremePriorityMetrics(ordinary.metrics), false);
assert.equal(findExtremePriorityRecord([ordinary, extreme, low])?.id, "extreme");
assert.equal(findExtremePriorityRecord([ordinary, low]), null);
assert.deepEqual([ordinary, low, extreme].sort(comparePriorityRecords).map((record) => record.id), ["extreme", "ordinary", "low"]);
assert.match(
  main,
  /const extremeCandidate = findExtremePriorityRecord\(candidates\);\s*if \(extremeCandidate\) return extremeCandidate;/u,
  "selectNextRecord must apply the extreme-priority override before probability and roulette"
);

console.log("priority scheduling tests passed");
