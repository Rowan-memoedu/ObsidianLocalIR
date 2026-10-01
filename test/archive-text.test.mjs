import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { extractMarkdownHeadingsLinear, extractParagraphsLinear } from "../archive-text.mjs";

const mixed = "第一行\r\n第二行\r\n\r\n  third\n\n#### 12:34\n\nfinal";
assert.deepEqual(extractParagraphsLinear(mixed, 10, true), [
  { index: 0, text: "第一行\r\n第二行", start: 10, end: 18 },
  { index: 1, text: "third", start: 22, end: 29 },
  { index: 2, text: "final", start: 43, end: 48 }
]);

const markup = extractParagraphsLinear("<mark>alpha</mark>\n\n beta ", 0, false, (value) => value.replace(/<[^>]+>/gu, ""));
assert.deepEqual(markup.map((item) => item.text), ["alpha", "beta"]);

const longLine = "x".repeat(500_000);
const startedAt = performance.now();
const longResult = extractParagraphsLinear(longLine, 0, false);
const elapsedMs = performance.now() - startedAt;
assert.equal(longResult.length, 1);
assert.equal(longResult[0].end, longLine.length);
assert.ok(elapsedMs < 1000, `linear paragraph scan took ${elapsedMs.toFixed(1)}ms`);

assert.deepEqual(extractMarkdownHeadingsLinear("# 中文\n正文\n## English\ntext\n"), [
  { title: "中文", start: 0, end: 4 },
  { title: "English", start: 8, end: 18 }
]);
assert.deepEqual(extractMarkdownHeadingsLinear("plain text ending with newline\n"), []);

console.log("archive text tests passed");
