const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_VERSION = "1.4.0";
const PLUGIN_VERSION = "0.8.5";
const RUN_ID = process.env.LOCAL_IR_CANARY_RUN_ID || `real-material-v${MODULE_VERSION}`;
const projectRoot = path.resolve(__dirname, "..", "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const installedPluginRoot = path.join(workspaceRoot, ".obsidian", "plugins", "local-ir");
const dataPath = path.join(installedPluginRoot, "data.json");
const pluginMainPath = path.join(projectRoot, "main.js");
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const runRoot = path.join(localAppData, "LocalIRCanary", "batch-archive-backend", RUN_ID);
const publicReceiptPath = path.join(__dirname, "runs", RUN_ID, "receipt.json");

main().catch((error) => {
  console.error(JSON.stringify({
    schema: "progressive-reading.local-ir-real-material-canary-error/v1",
    runId: RUN_ID,
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
    runRoot
  }, null, 2));
  process.exitCode = 1;
});

async function main() {
  assertWithin(localAppData, runRoot, "Canary run root");
  if (fs.existsSync(runRoot)) throw new Error(`Canary run root already exists; refusing to overwrite: ${runRoot}`);
  if (!fs.existsSync(dataPath)) throw new Error(`Installed plugin data is missing: ${dataPath}`);
  if (!fs.existsSync(pluginMainPath)) throw new Error(`Built plugin is missing: ${pluginMainPath}`);

  const installedManifest = JSON.parse(await fsp.readFile(path.join(installedPluginRoot, "manifest.json"), "utf8"));
  if (installedManifest.version !== PLUGIN_VERSION) {
    throw new Error(`Installed plugin version ${installedManifest.version} does not match required ${PLUGIN_VERSION}`);
  }

  const rawDataText = await fsp.readFile(dataPath, "utf8");
  const settings = JSON.parse(rawDataText);
  const sourceRecords = selectCanaryRecords(settings, 12);
  if (sourceRecords.length !== 12) throw new Error(`Expected 12 safe done records, found ${sourceRecords.length}`);

  const protectedRoots = [
    settings.archiveFolder,
    settings.refinedReadingFolder,
    settings.questionQueueFolder,
    settings.sourceArchiveFolder
  ].filter(Boolean);
  const productionBefore = await snapshotProduction({ dataPath, protectedRoots });
  const sourceBefore = await snapshotSources(sourceRecords);

  await fsp.mkdir(runRoot, { recursive: true });
  const mockObsidian = createMockObsidian();
  const PluginClass = loadPluginClass(mockObsidian);
  const app = createReadOnlyApp(mockObsidian.TFile, mockObsidian.TFolder);
  const plugin = new PluginClass(app, installedManifest);
  plugin.settings = structuredClone(settings);
  if (process.env.LOCAL_IR_CANARY_PROFILE === "1") {
    const createAnnotationPayload = plugin.createArchiveAnnotationPayload.bind(plugin);
    plugin.createArchiveAnnotationPayload = (annotation, index, sourceContent) => {
      const annotationId = opaqueId(String(annotation?.id || index));
      const startedAt = Date.now();
      console.error(`[canary-profile] annotation-start ${index + 1}: ${annotationId}`);
      const result = createAnnotationPayload(annotation, index, sourceContent);
      console.error(`[canary-profile] annotation-end ${index + 1}: ${annotationId} ${Date.now() - startedAt}ms`);
      return result;
    };
  }

  const inputs = new Map();
  const privateSelections = [];
  for (const [selectionIndex, record] of sourceRecords.entries()) {
    const sourcePath = normalizePortablePath(record.path);
    const sourceId = opaqueId(sourcePath);
    const sourceContent = await fsp.readFile(resolveWorkspacePath(sourcePath), "utf8");
    const isolatedSourcePath = `sources/${sourceId}.md`;
    await writeAtomicPortable(isolatedSourcePath, sourceContent);

    const input = await plugin.createBatchArchiveInput(sourcePath);
    remapInputToCanary(input, sourceId, isolatedSourcePath);
    inputs.set(input.record.path, input);
    privateSelections.push({
      sourceId,
      sourcePath,
      sourceSha256: sha256(sourceContent),
      sourceBytes: Buffer.byteLength(sourceContent),
      annotations: input.annotations.length,
      cards: input.cards.length,
      clozeCards: input.clozeCards.length,
      articleMusings: input.articleMusings.length
    });
    console.error(`[canary] frozen ${selectionIndex + 1}/${sourceRecords.length}: ${sourceId}`);
  }

  const manifest = {
    schema: "progressive-reading.local-ir-real-material-canary-manifest/v1",
    runId: RUN_ID,
    moduleVersion: MODULE_VERSION,
    pluginVersion: PLUGIN_VERSION,
    createdAt: new Date().toISOString(),
    isolation: {
      runRoot,
      productionDataReadOnly: true,
      productionSourcesReadOnly: true,
      touchedFormalQueue: false,
      remnoteCallsAllowed: false,
      outputRoot: runRoot
    },
    productionBaseline: productionBefore,
    selections: privateSelections
  };
  await writeJsonAtomic(path.join(runRoot, "manifest.json"), manifest);

  const { countImportableRemnoteItems, createNoRemnoteContentConfirmation, runBatchArchive, validateExportPackage, validateFrozenInput } = await import(pathToFileURL(path.join(projectRoot, "batch-archive-backend", "core.mjs")).href);
  const { normalizePackage, validateNormalizedPackage } = await import(pathToFileURL(path.join(workspaceRoot, "04 Projects", "渐进阅读工作流", "remnote-formal-archive", "core.mjs")).href);
  const confirmationTimestamp = new Date().toISOString();
  let confirmedNoRemnoteContent = 0;
  for (const input of inputs.values()) {
    if (countImportableRemnoteItems(input) !== 0) continue;
    input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, confirmationTimestamp);
    confirmedNoRemnoteContent += 1;
  }
  const inputChecks = [...inputs.values()].map((input) => ({
    sourceId: path.basename(input.record.path, ".md"),
    errors: validateFrozenInput(input)
  }));
  const expectedPrepared = inputChecks.filter((check) => check.errors.length === 0).length;
  const expectedRejected = inputChecks.length - expectedPrepared;
  const io = createIsolatedIo();
  let activeLoads = 0;
  let maxConcurrentLoads = 0;
  let startedLoads = 0;
  let releaseLoadBarrier;
  const loadBarrier = new Promise((resolve) => { releaseLoadBarrier = resolve; });

  const batch = await runBatchArchive({
    records: [...inputs.values()].map((input) => input.record),
    concurrency: "auto",
    io,
    loadInput: async (recordPath) => {
      activeLoads += 1;
      startedLoads += 1;
      maxConcurrentLoads = Math.max(maxConcurrentLoads, activeLoads);
      if (startedLoads === inputs.size) releaseLoadBarrier();
      await loadBarrier;
      activeLoads -= 1;
      return inputs.get(recordPath);
    }
  });

  const packageChecks = [];
  for (const result of batch.results) {
    const packageText = await io.readText(result.packagePath);
    const pkg = JSON.parse(packageText);
    const normalized = normalizePackage(pkg, result.packagePath);
    packageChecks.push({
      packageId: result.packageId,
      packageRevision: result.packageRevision,
      packagePath: result.packagePath,
      sourceId: path.basename(pkg.localArchive.sourcePath, ".md"),
      producerValidationErrors: validateExportPackage(pkg),
      importerValidationErrors: validateNormalizedPackage(normalized),
      status: pkg.status,
      localArchiveState: pkg.localArchive.state,
      importItems: normalized.items.length,
      hasNoRemnoteContentConfirmation: Boolean(pkg.localArchive.noRemnoteContentConfirmation),
      confirmationAbsentFromRemnoteItems: !JSON.stringify(normalized.items).includes("noRemnoteContentConfirmation"),
      archivedTruePresent: packageText.includes('"archived": true'),
      dispositionSummary: normalized.dispositionSummary
    });
  }

  const productionAfter = await snapshotProduction({ dataPath, protectedRoots });
  const sourceAfter = await snapshotSources(sourceRecords);
  const productionUnchanged = stableJson(productionAfter) === stableJson(productionBefore);
  const sourcesUnchanged = stableJson(sourceAfter) === stableJson(sourceBefore);
  const rejectedPackagesAbsent = await Promise.all(batch.failures.map((failure) => io.exists(`queue/${path.basename(failure.path, ".md")}.json`)))
    .then((values) => values.every((exists) => !exists));
  const validationPassed = packageChecks.length === expectedPrepared && packageChecks.every((check) =>
    check.producerValidationErrors.length === 0 &&
    check.importerValidationErrors.length === 0 &&
    check.status === "export_package_ready" &&
    check.localArchiveState === "export_package_ready" &&
    !check.archivedTruePresent &&
    (check.importItems > 0 || check.hasNoRemnoteContentConfirmation) &&
    check.confirmationAbsentFromRemnoteItems
  );
  const expectedBatchStatus = expectedRejected > 0 ? "completed_with_failures" : "completed";
  const expectedFailures = batch.failures.length === expectedRejected && batch.failures.every((failure) =>
    failure.code === "INPUT_VALIDATION_FAILED" && failure.message.includes("批量归档输入未通过生产者校验")
  );
  const passed = batch.status === expectedBatchStatus && batch.prepared === expectedPrepared && batch.failed === expectedRejected &&
    batch.concurrency === 12 && maxConcurrentLoads === 12 && validationPassed && rejectedPackagesAbsent && expectedFailures && productionUnchanged && sourcesUnchanged;

  const receipt = {
    schema: "progressive-reading.local-ir-real-material-canary-receipt/v1",
    runId: RUN_ID,
    moduleVersion: MODULE_VERSION,
    pluginVersion: PLUGIN_VERSION,
    completedAt: new Date().toISOString(),
    status: passed ? "passed" : "failed",
    realMaterial: true,
    isolatedOutput: true,
    runRoot,
    selected: sourceRecords.length,
    concurrencyRequested: "auto",
    concurrencyActual: batch.concurrency,
    observedConcurrentLoads: maxConcurrentLoads,
    expectedPrepared,
    expectedProducerRejections: expectedRejected,
    confirmedNoRemnoteContent,
    prepared: batch.prepared,
    failed: batch.failed,
    productionUnchanged,
    sourcesUnchanged,
    touchedFormalQueue: false,
    remnoteCalls: 0,
    sourceCopies: privateSelections.length,
    packagesValidated: packageChecks.length,
    producerValidationErrorCount: packageChecks.reduce((sum, check) => sum + check.producerValidationErrors.length, 0),
    importerValidationErrorCount: packageChecks.reduce((sum, check) => sum + check.importerValidationErrors.length, 0),
    archivedTrueCount: packageChecks.filter((check) => check.archivedTruePresent).length,
    rejectedPackagesAbsent,
    selectedOpaqueIds: privateSelections.map((item) => item.sourceId),
    packageIds: packageChecks.map((item) => item.packageId),
    productionDataSha256: productionAfter.data.sha256,
    manifestSha256: sha256(await fsp.readFile(path.join(runRoot, "manifest.json"))),
    rollback: `Remove-Item -LiteralPath '${runRoot.replaceAll("'", "''")}' -Recurse`
  };
  await writeJsonAtomic(path.join(runRoot, "receipt.json"), { ...receipt, packageChecks, failures: batch.failures });
  await writeJsonAtomic(publicReceiptPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  if (!passed) process.exitCode = 1;

  function createIsolatedIo() {
    return {
      exists: async (portablePath) => fs.existsSync(resolveRunPath(portablePath)),
      readText: async (portablePath) => fsp.readFile(resolveRunPath(portablePath), "utf8"),
      writeAtomic: async (portablePath, content) => writeAtomicPortable(portablePath, content)
    };
  }

  async function writeAtomicPortable(portablePath, content) {
    const targetPath = resolveRunPath(portablePath);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    await fsp.writeFile(tempPath, content, "utf8");
    await fsp.rename(tempPath, targetPath);
  }
}

function selectCanaryRecords(settings, limit) {
  const annotationCounts = countByPath(Object.values(settings.annotations || {}));
  const cardCounts = countByPath(Object.values(settings.qaCards || {}));
  const musingPaths = new Set(Object.entries(settings.articleMusings || {})
    .filter(([, value]) => String(value?.bodyMarkdown || "").trim())
    .map(([key, value]) => normalizePortablePath(value?.path || key)));
  return Object.values(settings.records || {})
    .filter((record) => record?.status === "done" && fs.existsSync(resolveWorkspacePath(record.path)))
    .map((record) => ({
      ...record,
      richness: (annotationCounts.get(normalizePortablePath(record.path)) || 0) +
        (cardCounts.get(normalizePortablePath(record.path)) || 0) +
        (musingPaths.has(normalizePortablePath(record.path)) ? 1 : 0)
    }))
    .sort((left, right) => right.richness - left.richness || String(left.path).localeCompare(String(right.path), "en"))
    .slice(0, limit);
}

function countByPath(items) {
  const result = new Map();
  for (const item of items) {
    const itemPath = normalizePortablePath(item?.path || "");
    if (itemPath) result.set(itemPath, (result.get(itemPath) || 0) + 1);
  }
  return result;
}

function remapInputToCanary(input, sourceId, isolatedSourcePath) {
  input.record.path = isolatedSourcePath;
  input.record.originalSourcePath = `source-original/${sourceId}.md`;
  input.record.archivedSourcePath = `final-archive/${sourceId}.md`;
  input.paths = {
    markdownExportPath: `exports/${sourceId}.md`,
    packageJsonPath: `queue/${sourceId}.json`,
    refinedReadingPath: `derived/refined/${sourceId}.md`,
    questionQueueJsonPath: `derived/questions/${sourceId}.json`,
    questionQueueMarkdownPath: `derived/questions/${sourceId}.md`
  };
  for (const collection of [input.annotations, input.cards, input.clozeCards, input.articleMusings]) {
    for (const item of collection) item.path = isolatedSourcePath;
  }
}

function createMockObsidian() {
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest || { version: PLUGIN_VERSION };
    }
  }
  class BaseClass { constructor() {} }
  class TFile {
    constructor(filePath) {
      this.path = normalizePortablePath(filePath);
      this.name = path.posix.basename(this.path);
      this.basename = this.name.replace(/\.[^.]+$/u, "");
      this.extension = path.posix.extname(this.name).slice(1);
    }
  }
  class TFolder {
    constructor(folderPath) {
      this.path = normalizePortablePath(folderPath);
      this.name = path.posix.basename(this.path);
      this.children = [];
    }
  }
  return {
    Plugin,
    ItemView: BaseClass,
    PluginSettingTab: BaseClass,
    AbstractInputSuggest: BaseClass,
    FuzzySuggestModal: BaseClass,
    Modal: BaseClass,
    TFile,
    TFolder,
    Setting: BaseClass,
    Notice: class Notice {},
    normalizePath: normalizePortablePath,
    editorInfoField: {},
    requestUrl: async () => { throw new Error("Network calls are disabled in real-material Canary"); }
  };
}

function loadPluginClass(mockObsidian) {
  const originalLoad = Module._load;
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "obsidian") return mockObsidian;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(pluginMainPath)];
    return require(pluginMainPath).default;
  } finally {
    Module._load = originalLoad;
  }
}

function createReadOnlyApp(TFile, TFolder) {
  return {
    vault: {
      getAbstractFileByPath(portablePath) {
        const fullPath = resolveWorkspacePath(portablePath);
        if (!fs.existsSync(fullPath)) return null;
        return fs.statSync(fullPath).isDirectory() ? new TFolder(portablePath) : new TFile(portablePath);
      },
      cachedRead(file) {
        return fsp.readFile(resolveWorkspacePath(file.path), "utf8");
      }
    }
  };
}

async function snapshotProduction({ dataPath: pluginDataPath, protectedRoots }) {
  const dataBuffer = await fsp.readFile(pluginDataPath);
  const roots = [];
  for (const portableRoot of protectedRoots) {
    const rootPath = resolveWorkspacePath(portableRoot);
    const entries = await snapshotTree(rootPath);
    roots.push({
      path: normalizePortablePath(portableRoot),
      exists: fs.existsSync(rootPath),
      fileCount: entries.length,
      digest: sha256(stableJson(entries))
    });
  }
  return {
    data: {
      bytes: dataBuffer.length,
      sha256: sha256(dataBuffer),
      lastWriteTimeUtc: fs.statSync(pluginDataPath).mtime.toISOString()
    },
    roots
  };
}

async function snapshotSources(records) {
  const entries = [];
  for (const record of records) {
    const sourcePath = normalizePortablePath(record.path);
    const buffer = await fsp.readFile(resolveWorkspacePath(sourcePath));
    entries.push({ sourceId: opaqueId(sourcePath), bytes: buffer.length, sha256: sha256(buffer) });
  }
  return entries.sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en"));
}

async function snapshotTree(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const entries = [];
  await walk(rootPath, "");
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));

  async function walk(currentPath, relativePath) {
    for (const entry of await fsp.readdir(currentPath, { withFileTypes: true })) {
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await walk(childPath, childRelative);
      else if (entry.isFile()) {
        const buffer = await fsp.readFile(childPath);
        entries.push({ path: childRelative.replaceAll("\\", "/"), bytes: buffer.length, sha256: sha256(buffer) });
      }
    }
  }
}

function resolveWorkspacePath(portablePath) {
  const normalized = normalizePortablePath(portablePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe workspace-relative path: ${portablePath}`);
  }
  const resolved = path.resolve(workspaceRoot, ...normalized.split("/"));
  assertWithin(workspaceRoot, resolved, "Workspace path");
  return resolved;
}

function resolveRunPath(portablePath) {
  const normalized = normalizePortablePath(portablePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Canary-relative path: ${portablePath}`);
  }
  const resolved = path.resolve(runRoot, ...normalized.split("/"));
  assertWithin(runRoot, resolved, "Canary output path");
  return resolved;
}

function assertWithin(rootPath, candidatePath, label) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} resolved outside allowed root: ${candidate}`);
  }
}

function normalizePortablePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function opaqueId(value) {
  return sha256(Buffer.from(value, "utf8")).slice(0, 12);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
}

async function writeJsonAtomic(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, targetPath);
}
