import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INPUT_SCHEMA,
  NO_REMNOTE_CONTENT_CONFIRMATION_ERROR,
  PACKAGE_SCHEMA,
  countImportableRemnoteItems,
  createNoRemnoteContentConfirmation,
  formatBatchArchiveFailure,
  inferSourceDescriptor,
  prepareExportPackage,
  runBatchArchive,
  selectPendingRecords,
  validateExportPackage
} from "../core.mjs";
import { normalizePackage, validateNormalizedPackage } from "../../../渐进阅读工作流/remnote-formal-archive/core.mjs";

const moduleRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(moduleRoot, "fixtures", "mixed-package.input.json");

test("mixed native-v2 package covers every disposition without premature archived state", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  const result = await prepareExportPackage({ input, io: harness.io, clock: fixedClock });
  assert.equal(result.status, "export_package_ready");
  assert.equal(result.packageRevision, 1);
  assert.equal(result.idempotentReplay, false);
  assert.equal(await harness.io.exists("staging/canary-mixed.md"), true, "source remains in staging");
  assert.equal(await harness.io.exists("archive/canary-mixed.md"), false, "producer never moves source to final archive");

  const pkg = JSON.parse(await harness.io.readText("queue/canary-mixed.json"));
  assert.equal(pkg.schema, PACKAGE_SCHEMA);
  assert.equal(pkg.status, "export_package_ready");
  assert.equal(pkg.localArchive.state, "export_package_ready");
  assert.deepEqual(validateExportPackage(pkg), []);
  assert.equal(JSON.stringify(pkg).includes('"archived":true'), false);
  assert.equal(pkg.annotations.length, 5);
  assert.equal(pkg.cards.length, 2);
  assert.equal(pkg.clozeCards.length, 1);
  assert.equal(pkg.articleMusings.length, 1);
  assert.ok(pkg.refinedReadingPath);
  assert.ok(pkg.questionQueueJsonPath);
  const snapshot = JSON.parse(await harness.io.readText(pkg.producer.snapshotPath));
  assert.equal(Object.hasOwn(snapshot, "sourceContent"), false, "frozen audit snapshot stores only source hash/size");
  assert.match(snapshot.sourceContentHash, /^[a-f0-9]{64}$/);

  const normalized = normalizePackage(pkg, "queue/canary-mixed.json");
  assert.deepEqual(validateNormalizedPackage(normalized), []);
  assert.equal(normalized.dispositionSummary["remnote_import:covered"], 5);
  assert.equal(normalized.dispositionSummary["refined_reading:covered"], 2);
  assert.equal(normalized.dispositionSummary["codex_question_queue:covered"], 1);
  assert.equal(normalized.dispositionSummary["derived_to_qa_card:covered"], 1);
});

test("repeated preparation is an idempotent replay with stable package identity and revision", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  const first = await prepareExportPackage({ input, io: harness.io, clock: fixedClock });
  const firstPackage = await harness.io.readText("queue/canary-mixed.json");
  const second = await prepareExportPackage({ input, io: harness.io, clock: () => new Date("2030-01-01T00:00:00.000Z") });
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.packageId, first.packageId);
  assert.equal(second.packageRevision, 1);
  assert.equal(await harness.io.readText("queue/canary-mixed.json"), firstPackage);
});

test("batch isolates a single invalid QA failure and keeps the other record prepared", async (t) => {
  const harness = await createHarness(t);
  const valid = await loadFixture(harness);
  const invalid = structuredClone(valid);
  invalid.record.path = "staging/invalid.md";
  invalid.record.originalSourcePath = "reading/invalid.md";
  invalid.record.archivedSourcePath = "archive/invalid.md";
  invalid.record.title = "invalid";
  invalid.paths = remapPaths(invalid.paths, "invalid");
  invalid.cards[0].answerMarkdown = "";
  invalid.cards[0].needsAnswerGeneration = true;
  await harness.io.writeAtomic("staging/invalid.md", "# invalid\n");
  const failures = [];
  const batch = await runBatchArchive({
    records: [valid.record, invalid.record],
    loadInput: async (recordPath) => recordPath === valid.record.path ? valid : invalid,
    io: harness.io,
    clock: fixedClock,
    onFailure: async (_path, failure) => failures.push(failure)
  });
  assert.equal(batch.status, "completed_with_failures");
  assert.equal(batch.prepared, 1);
  assert.equal(batch.failed, 1);
  assert.equal(failures[0].code, "INPUT_VALIDATION_FAILED");
  assert.equal(await harness.io.exists("queue/canary-mixed.json"), true);
  assert.equal(await harness.io.exists("queue/invalid.json"), false);
});

test("an explicit concurrency cap is honored while preserving deterministic result order", async (t) => {
  const harness = await createHarness(t);
  const base = await loadFixture(harness);
  const inputs = new Map();
  for (const key of ["d", "a", "c", "b"]) {
    const input = structuredClone(base);
    input.record.path = `staging/${key}.md`;
    input.record.originalSourcePath = `reading/${key}.md`;
    input.record.archivedSourcePath = `archive/${key}.md`;
    input.record.title = key;
    input.paths = remapPaths(input.paths, key);
    await harness.io.writeAtomic(input.record.path, `# ${key}\n`);
    inputs.set(input.record.path, input);
  }
  let active = 0;
  let maxActive = 0;
  const batch = await runBatchArchive({
    records: [...inputs.values()].map((input) => input.record),
    concurrency: 3,
    loadInput: async (recordPath) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, recordPath.endsWith("a.md") ? 20 : 5));
      active -= 1;
      return inputs.get(recordPath);
    },
    io: harness.io,
    clock: fixedClock
  });
  assert.equal(maxActive, 3);
  assert.equal(batch.concurrency, 3);
  assert.equal(batch.prepared, 4);
  assert.deepEqual(batch.results.map((result) => result.packagePath), ["queue/a.json", "queue/b.json", "queue/c.json", "queue/d.json"]);
});

test("auto concurrency starts every independent candidate without a fixed lane cap", async (t) => {
  const harness = await createHarness(t);
  const base = await loadFixture(harness);
  const inputs = new Map();
  for (let index = 0; index < 12; index += 1) {
    const key = String(index).padStart(2, "0");
    const input = structuredClone(base);
    input.record.path = `staging/auto-${key}.md`;
    input.record.originalSourcePath = `reading/auto-${key}.md`;
    input.record.archivedSourcePath = `archive/auto-${key}.md`;
    input.record.title = `auto-${key}`;
    input.paths = remapPaths(input.paths, `auto-${key}`);
    await harness.io.writeAtomic(input.record.path, `# auto-${key}\n`);
    inputs.set(input.record.path, input);
  }
  let active = 0;
  let maxActive = 0;
  let releaseInputs;
  const inputBarrier = new Promise((resolve) => { releaseInputs = resolve; });
  let started = 0;
  const batchPromise = runBatchArchive({
    records: [...inputs.values()].map((input) => input.record),
    loadInput: async (recordPath) => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === inputs.size) releaseInputs();
      await inputBarrier;
      active -= 1;
      return inputs.get(recordPath);
    },
    io: harness.io,
    clock: fixedClock
  });
  const batch = await batchPromise;
  assert.equal(maxActive, 12);
  assert.equal(batch.concurrency, 12);
  assert.equal(batch.prepared, 12);
  assert.deepEqual(batch.results.map((result) => result.packagePath), [...inputs.keys()].sort().map((recordPath) => `queue/${path.basename(recordPath, ".md")}.json`));
});

test("batch rejects invalid concurrency before reading inputs", async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(
    () => runBatchArchive({ records: [{ path: "staging/x.md", status: "done" }], concurrency: 0, loadInput: async () => null, io: harness.io }),
    (error) => error?.code === "INVALID_CONCURRENCY"
  );
});

test("zero-item material fails closed without confirmation and succeeds with audited confirmation", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  input.annotations = [];
  input.cards = [];
  input.clozeCards = [];
  input.articleMusings = [];
  await assert.rejects(
    () => prepareExportPackage({ input, io: harness.io, clock: fixedClock }),
    (error) => error?.code === "INPUT_VALIDATION_FAILED" && error?.details?.errors?.includes(NO_REMNOTE_CONTENT_CONFIRMATION_ERROR)
  );
  assert.equal(await harness.io.exists(input.paths.packageJsonPath), false);
  input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, fixedClock());
  const prepared = await prepareExportPackage({ input, io: harness.io, clock: fixedClock });
  const pkg = JSON.parse(await harness.io.readText(prepared.packagePath));
  assert.deepEqual(pkg.localArchive.noRemnoteContentConfirmation, {
    schema: "progressive-reading.no-remnote-content-confirmation/v1",
    confirmed: true,
    confirmedAt: "2026-08-22T00:00:00.000Z",
    missingElementKinds: ["annotations", "articleMusings", "cards", "clozeCards"]
  });
  const normalized = normalizePackage(pkg, prepared.packagePath);
  assert.equal(normalized.items.length, 0);
  assert.deepEqual(validateNormalizedPackage(normalized), []);
});

test("only-highlight material preserves refined disposition after explicit no-content confirmation", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  input.annotations = input.annotations.filter((annotation) => annotation.route === "refined_reading");
  input.cards = [];
  input.clozeCards = [];
  input.articleMusings = [];
  assert.equal(countImportableRemnoteItems(input), 0);
  input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, fixedClock());
  const prepared = await prepareExportPackage({ input, io: harness.io, clock: fixedClock });
  const pkg = JSON.parse(await harness.io.readText(prepared.packagePath));
  assert.ok(pkg.refinedReadingPath);
  assert.equal(pkg.questionQueueJsonPath, null);
  assert.deepEqual(pkg.localArchive.noRemnoteContentConfirmation.missingElementKinds, ["articleMusings", "cards", "clozeCards"]);
  const normalized = normalizePackage(pkg, prepared.packagePath);
  assert.equal(normalized.items.length, 0);
  assert.ok(normalized.dispositions.every((item) => item.disposition === "refined_reading" && item.status === "covered"));
  assert.deepEqual(validateNormalizedPackage(normalized), []);
});

test("only-question material preserves question artifacts after explicit no-content confirmation", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  input.annotations = input.annotations.filter((annotation) => annotation.route === "codex_question_queue" || annotation.type === "question");
  input.cards = [];
  input.clozeCards = [];
  input.articleMusings = [];
  assert.equal(countImportableRemnoteItems(input), 0);
  input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, fixedClock());
  const prepared = await prepareExportPackage({ input, io: harness.io, clock: fixedClock });
  const pkg = JSON.parse(await harness.io.readText(prepared.packagePath));
  assert.ok(pkg.questionQueueJsonPath);
  assert.ok(pkg.questionQueueMarkdownPath);
  assert.equal(pkg.refinedReadingPath, null);
  const normalized = normalizePackage(pkg, prepared.packagePath);
  assert.equal(normalized.items.length, 0);
  assert.ok(normalized.dispositions.every((item) => item.disposition === "codex_question_queue" && item.status === "covered"));
  assert.deepEqual(validateNormalizedPackage(normalized), []);
});

test("mixed batch prepares remote and confirmed zero-item packages while preserving unconfirmed failure details", async (t) => {
  const harness = await createHarness(t);
  const base = await loadFixture(harness);
  const remote = await createVariant(harness, base, "mixed-remote", () => undefined);
  const zero = await createVariant(harness, base, "mixed-zero", (input) => {
    input.annotations = [];
    input.cards = [];
    input.clozeCards = [];
    input.articleMusings = [];
    input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, fixedClock());
  });
  const question = await createVariant(harness, base, "mixed-question", (input) => {
    input.annotations = input.annotations.filter((annotation) => annotation.route === "codex_question_queue" || annotation.type === "question");
    input.cards = [];
    input.clozeCards = [];
    input.articleMusings = [];
    input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, fixedClock());
  });
  const unconfirmedHighlight = await createVariant(harness, base, "mixed-unconfirmed-highlight", (input) => {
    input.annotations = input.annotations.filter((annotation) => annotation.route === "refined_reading");
    input.cards = [];
    input.clozeCards = [];
    input.articleMusings = [];
  });
  const inputs = new Map([remote, zero, question, unconfirmedHighlight].map((input) => [input.record.path, input]));
  const batch = await runBatchArchive({
    records: [...inputs.values()].map((input) => input.record),
    loadInput: async (recordPath) => inputs.get(recordPath),
    io: harness.io,
    clock: fixedClock
  });
  assert.equal(batch.status, "completed_with_failures");
  assert.equal(batch.prepared, 3);
  assert.equal(batch.failed, 1);
  assert.equal(batch.failures[0].kind, "blocked");
  assert.equal(batch.failures[0].reasonCode, "NO_REMNOTE_CONTENT_CONFIRMATION_REQUIRED");
  assert.deepEqual(batch.failures[0].details.errors, [NO_REMNOTE_CONTENT_CONFIRMATION_ERROR]);
  assert.match(formatBatchArchiveFailure(batch.failures[0]), /明确确认/);
  assert.equal(await harness.io.exists(unconfirmedHighlight.paths.packageJsonPath), false);
});

test("crash before package commit recovers from owned snapshot on retry", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  let injected = false;
  const crashingIo = {
    ...harness.io,
    async writeAtomic(filePath, content) {
      if (filePath === input.paths.packageJsonPath && !injected) {
        injected = true;
        throw new Error("simulated crash before commit marker");
      }
      return harness.io.writeAtomic(filePath, content);
    }
  };
  await assert.rejects(() => prepareExportPackage({ input, io: crashingIo, clock: fixedClock }), /simulated crash/);
  assert.equal(await harness.io.exists(input.paths.packageJsonPath), false);
  assert.equal(await harness.io.exists(input.paths.markdownExportPath), true);
  const recovered = await prepareExportPackage({ input, io: harness.io, clock: fixedClock });
  assert.equal(recovered.packageRevision, 1);
  assert.equal(await harness.io.exists(input.paths.packageJsonPath), true);
});

test("unowned existing artifact fails closed on path conflict", async (t) => {
  const harness = await createHarness(t);
  const input = await loadFixture(harness);
  await harness.io.writeAtomic(input.paths.markdownExportPath, "user-owned-content\n");
  await assert.rejects(
    () => prepareExportPackage({ input, io: harness.io, clock: fixedClock }),
    (error) => error?.code === "PATH_CONFLICT"
  );
  assert.equal(await harness.io.exists(input.paths.packageJsonPath), false);
});

test("selection is deterministic and source descriptor covers supported material families", () => {
  assert.deepEqual(selectPendingRecords([
    { path: "z.md", status: "done" },
    { path: "skip.md", status: "reading" },
    { path: "a.md", status: "done" }
  ]).map((item) => item.path), ["a.md", "z.md"]);
  assert.deepEqual(inferSourceDescriptor({ sourcePath: "阅读区/PDF/x.md", sourceContent: "" }).format, "pdf-derived-markdown");
  assert.deepEqual(inferSourceDescriptor({ sourcePath: "阅读区/Word/x.md", sourceContent: "" }).format, "word-derived-markdown");
  assert.deepEqual(inferSourceDescriptor({ sourcePath: "阅读区/Epub/x.md", sourceContent: "" }).format, "epub-derived-markdown");
  assert.deepEqual(inferSourceDescriptor({ sourcePath: "阅读区/YouTube/x.md", sourceContent: "" }).format, "youtube-transcript-markdown");
  assert.deepEqual(inferSourceDescriptor({ sourcePath: "阅读区/x.md", sourceContent: "---\nsource_url: https://example.com/x\n---" }), {
    materialType: "web_article",
    format: "web-markdown",
    origin: "https://example.com/x"
  });
});

test("module schema remains byte-identical to formal importer authority", async () => {
  const local = await readFile(path.join(moduleRoot, "schemas", "local-ir-export-package.v2.schema.json"), "utf8");
  const authority = await readFile(path.resolve(moduleRoot, "../../渐进阅读工作流/remnote-formal-archive/schemas/local-ir-export-package.v2.schema.json"), "utf8");
  assert.deepEqual(JSON.parse(local), JSON.parse(authority));
});

test("shared document sidecar preserves export_package_ready without translating it to archived", async () => {
  await import("../../../渐进阅读工作流/browser-highlight-extension/draft-core.js");
  const core = globalThis.LocalIrDraftCore;
  const normalized = core.normalizeDocumentState({
    schema: core.DOCUMENT_STATE_SCHEMA,
    document: {
      id: "sidecar-canary",
      path: "staging/canary.md",
      title: "Canary",
      status: "export_package_ready",
      revision: 1,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z"
    },
    annotations: [],
    qaCards: [],
    articleMusing: null
  }, { path: "staging/canary.md" });
  assert.equal(normalized.document.status, "export_package_ready");
  const roundTrip = core.replaceDocumentCollections(normalized, {
    path: normalized.document.path,
    title: normalized.document.title,
    status: "export_package_ready",
    annotations: [],
    qaCards: [],
    articleMusing: null
  });
  assert.equal(roundTrip.document.status, "export_package_ready");
});

async function createHarness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-ir-batch-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolvePath = (portable) => path.join(root, ...portable.split("/"));
  const io = {
    async exists(filePath) {
      try {
        await readFile(resolvePath(filePath));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    async readText(filePath) {
      return readFile(resolvePath(filePath), "utf8");
    },
    async writeAtomic(filePath, content) {
      const target = resolvePath(filePath);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, content, "utf8");
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  };
  return { root, io };
}

async function loadFixture(harness) {
  const input = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(input.schema, INPUT_SCHEMA);
  await harness.io.writeAtomic(input.record.path, input.sourceContent);
  return input;
}

function remapPaths(paths, stem) {
  return Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, value.replaceAll("canary-mixed", stem)]));
}

async function createVariant(harness, base, stem, mutate) {
  const input = structuredClone(base);
  input.record.path = `staging/${stem}.md`;
  input.record.originalSourcePath = `reading/${stem}.md`;
  input.record.archivedSourcePath = `archive/${stem}.md`;
  input.record.title = stem;
  input.paths = remapPaths(input.paths, stem);
  input.noRemnoteContentConfirmation = null;
  mutate(input);
  await harness.io.writeAtomic(input.record.path, `# ${stem}\n`);
  return input;
}

function fixedClock() {
  return new Date("2026-08-22T00:00:00.000Z");
}
