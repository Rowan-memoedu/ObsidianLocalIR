import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const source = await fs.readFile(path.resolve("../渐进阅读工作流/browser-highlight-extension/draft-core.js"), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const core = context.globalThis.LocalIrDraftCore;

const normalized = core.normalizeDocumentState({
  schema: core.DOCUMENT_STATE_SCHEMA,
  schemaVersion: core.DOCUMENT_STATE_VERSION,
  document: {
    id: "rss-later-fixture",
    path: "04 Projects/渐进阅读工作流/阅读区/RSS/Fixture.md",
    title: "Fixture",
    status: "later",
    deferUntil: "2026-08-29",
    revision: 1,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  }
});

assert.equal(normalized.document.status, "later");
assert.equal(normalized.document.deferUntil, "2026-08-29");

const replaced = core.replaceDocumentCollections(normalized, {
  path: normalized.document.path,
  status: "reading",
  deferUntil: null
});
assert.equal(replaced.document.status, "reading");
assert.equal(replaced.document.deferUntil, null);
assert.notEqual(core.comparableDocumentState(normalized), core.comparableDocumentState(replaced));
