const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_VERSION = "1.4.0";
const { artifactRoot, buildDir, requireVaultRoot } = require("../../scripts/paths.cjs");
const PLUGIN_VERSION = require("../../manifest.json").version;
const RUN_ID = process.env.LOCAL_IR_BUTTON_CANARY_RUN_ID || `button-handler-v${MODULE_VERSION}-${Date.now()}`;
const projectRoot = path.resolve(__dirname, "..", "..");
const workspaceRoot = requireVaultRoot();
const installedRoot = path.join(workspaceRoot, ".obsidian", "plugins", "local-ir");
const dataPath = path.join(installedRoot, "data.json");
const builtMainPath = path.join(buildDir, "main.js");
const installedMainPath = path.join(installedRoot, "main.js");
const localAppData = artifactRoot;
const runRoot = path.join(artifactRoot, "private-canaries", RUN_ID);
const publicReceiptPath = path.join(artifactRoot, "canaries", RUN_ID, "receipt.json");
const genericFailureMessage = "批量归档输入未通过生产者校验";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  assertWithin(localAppData, runRoot, "button canary root");
  if (fs.existsSync(runRoot)) throw new Error(`Button canary root already exists: ${runRoot}`);
  const manifest = JSON.parse(await fsp.readFile(path.join(installedRoot, "manifest.json"), "utf8"));
  if (manifest.version !== PLUGIN_VERSION) throw new Error(`Installed plugin must be ${PLUGIN_VERSION}, found ${manifest.version}`);
  const builtMainSha256 = sha256(await fsp.readFile(builtMainPath));
  const installedMainSha256 = sha256(await fsp.readFile(installedMainPath));
  if (builtMainSha256 !== installedMainSha256) throw new Error("Built and installed main.js hashes differ");

  const rawData = await fsp.readFile(dataPath);
  const settings = JSON.parse(rawData.toString("utf8"));
  const records = Object.values(settings.records || {})
    .filter((record) => record?.status === "done" && record?.archiveLastError === genericFailureMessage)
    .sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
  if (records.length !== 7) throw new Error(`Expected 7 known producer failures, found ${records.length}`);
  const queueRoot = resolveWorkspacePath(settings.archiveFolder);
  const productionBefore = await snapshotProduction(rawData, queueRoot, records);

  await fsp.mkdir(runRoot, { recursive: true });
  const mockObsidian = createMockObsidian();
  const PluginClass = loadPluginClass(mockObsidian);
  const plugin = new PluginClass(createReadOnlyApp(mockObsidian.TFile, mockObsidian.TFolder), manifest);
  plugin.settings = structuredClone(settings);
  plugin.getRecords = () => records.map((record) => plugin.settings.records[record.path]);
  plugin.saveSettings = async () => { plugin.__canarySaveCalls = (plugin.__canarySaveCalls || 0) + 1; };
  plugin.refreshViews = async () => undefined;
  plugin.createBatchArchiveIo = () => createIsolatedIo();
  const originalCreateInput = plugin.createBatchArchiveInput.bind(plugin);
  plugin.createBatchArchiveInput = async (sourcePath) => {
    const input = await originalCreateInput(sourcePath);
    const sourceId = opaqueId(sourcePath);
    await writeAtomicPortable(`sources/${sourceId}.md`, await fsp.readFile(resolveWorkspacePath(sourcePath), "utf8"));
    remapInput(input, sourceId);
    return input;
  };

  const attemptsBefore = Object.fromEntries(records.map((record) => [record.path, record.archiveAttemptCount]));
  const prompts = [];
  let confirmDecision = false;
  plugin.confirmNoRemnoteContent = async (entries) => {
    prompts.push({ confirmed: confirmDecision, entries: structuredClone(entries) });
    return confirmDecision;
  };

  await plugin.batchArchiveDoneRecords();
  const cancelledPreservedDone = records.every((record) => {
    const current = plugin.settings.records[record.path];
    return current.status === "done" && current.archiveAttemptCount === attemptsBefore[record.path];
  });
  const packagesAfterCancel = await listPackageJsonFiles();

  confirmDecision = true;
  await plugin.batchArchiveDoneRecords();

  const { validateExportPackage } = await import(pathToFileURL(path.join(projectRoot, "batch-archive-backend", "core.mjs")).href);
  const { normalizePackage, validateNormalizedPackage } = await import(pathToFileURL(path.join(workspaceRoot, "04 Projects", "渐进阅读工作流", "remnote-formal-archive", "core.mjs")).href);
  const packageFiles = await listPackageJsonFiles();
  const packageChecks = [];
  for (const packageFile of packageFiles) {
    const packageText = await fsp.readFile(packageFile.fullPath, "utf8");
    const pkg = JSON.parse(packageText);
    const normalized = normalizePackage(pkg, packageFile.relativePath);
    packageChecks.push({
      packageId: pkg.packageId,
      packageRevision: pkg.packageRevision,
      importItems: normalized.items.length,
      producerErrors: validateExportPackage(pkg),
      importerErrors: validateNormalizedPackage(normalized),
      confirmation: pkg.localArchive.noRemnoteContentConfirmation || null,
      refinedReadingAnnotations: pkg.counts.refinedReadingAnnotations,
      questionQueueAnnotations: pkg.counts.questionQueueAnnotations,
      archivedTruePresent: packageText.includes('"archived": true'),
      confirmationAbsentFromRemnoteItems: !JSON.stringify(normalized.items).includes("noRemnoteContentConfirmation")
    });
  }

  const productionAfter = await snapshotProduction(await fsp.readFile(dataPath), queueRoot, records);
  const productionUnchanged = JSON.stringify(productionAfter) === JSON.stringify(productionBefore);
  const recordsReadyInMemory = records.every((record) => plugin.settings.records[record.path].status === "export_package_ready");
  const confirmationsValid = packageChecks.every((check) => check.importItems === 0 && check.confirmation?.confirmed === true &&
    check.confirmation?.schema === "progressive-reading.no-remnote-content-confirmation/v1" &&
    Array.isArray(check.confirmation?.missingElementKinds) && check.confirmation.missingElementKinds.length > 0 &&
    JSON.stringify(check.confirmation.missingElementKinds) === JSON.stringify([...check.confirmation.missingElementKinds].sort()));
  const packagesValid = packageChecks.length === 7 && packageChecks.every((check) => check.producerErrors.length === 0 && check.importerErrors.length === 0 &&
    !check.archivedTruePresent && check.confirmationAbsentFromRemnoteItems);
  const notices = mockObsidian.Notice.messages;
  const passed = cancelledPreservedDone && packagesAfterCancel.length === 0 && prompts.length === 2 && prompts[0].confirmed === false && prompts[1].confirmed === true &&
    prompts.every((prompt) => prompt.entries.length === 7) && recordsReadyInMemory && confirmationsValid && packagesValid && productionUnchanged &&
    notices.some((message) => message.includes("用户取消 7 篇")) && notices.some((message) => message.includes("已准备 7 篇"));

  const receipt = {
    schema: "progressive-reading.local-ir-button-handler-canary-receipt/v1",
    runId: RUN_ID,
    completedAt: new Date().toISOString(),
    status: passed ? "passed" : "failed",
    pluginVersion: PLUGIN_VERSION,
    moduleVersion: MODULE_VERSION,
    invocation: "LocalIncrementalReadingPlugin.batchArchiveDoneRecords",
    buttonHandlerExact: true,
    actualObsidianModalRendered: false,
    confirmationAuthority: "explicit user delegation; modal decision injected at handler boundary",
    selected: records.length,
    cancelPass: { preservedDone: cancelledPreservedDone, packagesWritten: packagesAfterCancel.length, countedAsFailure: false },
    confirmPass: { prompts: prompts[1]?.entries.length || 0, packagesWritten: packageChecks.length, recordsReadyInMemory },
    productionUnchanged,
    productionDataSha256: productionAfter.dataSha256,
    productionQueueDigest: productionAfter.queueDigest,
    remnoteCalls: 0,
    productionDataWrites: 0,
    productionQueueWrites: 0,
    importerValidationErrorCount: packageChecks.reduce((sum, item) => sum + item.importerErrors.length, 0),
    producerValidationErrorCount: packageChecks.reduce((sum, item) => sum + item.producerErrors.length, 0),
    confirmedNoRemnotePackages: packageChecks.filter((item) => item.confirmation?.confirmed).length,
    technicalConfirmationBecameRemnoteItem: packageChecks.some((item) => !item.confirmationAbsentFromRemnoteItems),
    noticeEvidence: notices.filter((message) => message.includes("导出包生成完成")),
    isolatedRunRoot: runRoot,
    rollback: `Remove-Item -LiteralPath '${runRoot.replaceAll("'", "''")}' -Recurse`
  };
  await writeJsonAtomic(path.join(runRoot, "receipt.json"), { ...receipt, prompts, packageChecks });
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

  async function listPackageJsonFiles() {
    const queuePath = path.join(runRoot, "queue");
    if (!fs.existsSync(queuePath)) return [];
    return (await fsp.readdir(queuePath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({ relativePath: `queue/${entry.name}`, fullPath: path.join(queuePath, entry.name) }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  }
}

function remapInput(input, sourceId) {
  input.record.path = `sources/${sourceId}.md`;
  input.record.originalSourcePath = `original/${sourceId}.md`;
  input.record.archivedSourcePath = `archive/${sourceId}.md`;
  input.paths = {
    markdownExportPath: `exports/${sourceId}.md`,
    packageJsonPath: `queue/${sourceId}.json`,
    refinedReadingPath: `derived/refined/${sourceId}.md`,
    questionQueueJsonPath: `derived/questions/${sourceId}.json`,
    questionQueueMarkdownPath: `derived/questions/${sourceId}.md`
  };
  for (const collection of [input.annotations, input.cards, input.clozeCards, input.articleMusings]) {
    for (const item of collection) item.path = input.record.path;
  }
}

function createMockObsidian() {
  class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
  class BaseClass { constructor() {} }
  class TFile {
    constructor(filePath) {
      this.path = normalizePortablePath(filePath);
      this.name = path.posix.basename(this.path);
      this.basename = this.name.replace(/\.[^.]+$/u, "");
      this.extension = path.posix.extname(this.name).slice(1);
    }
  }
  class TFolder { constructor(folderPath) { this.path = normalizePortablePath(folderPath); this.name = path.posix.basename(this.path); this.children = []; } }
  class Notice { constructor(message) { Notice.messages.push(String(message)); } }
  Notice.messages = [];
  return {
    Plugin, ItemView: BaseClass, PluginSettingTab: BaseClass, AbstractInputSuggest: BaseClass, FuzzySuggestModal: BaseClass, Modal: BaseClass,
    TFile, TFolder, Setting: BaseClass, Notice, normalizePath: normalizePortablePath, editorInfoField: {},
    requestUrl: async () => { throw new Error("Network calls are disabled in button handler canary"); }
  };
}

function loadPluginClass(mockObsidian) {
  const originalLoad = Module._load;
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "obsidian") return mockObsidian;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(builtMainPath)];
    return require(builtMainPath).default;
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
      cachedRead(file) { return fsp.readFile(resolveWorkspacePath(file.path), "utf8"); }
    }
  };
}

async function snapshotProduction(dataBuffer, queueRoot, records) {
  return {
    dataSha256: sha256(dataBuffer),
    queueDigest: await snapshotTreeDigest(queueRoot),
    sources: await Promise.all(records.map(async (record) => {
      const buffer = await fsp.readFile(resolveWorkspacePath(record.path));
      return { sourceId: opaqueId(record.path), bytes: buffer.length, sha256: sha256(buffer) };
    }))
  };
}

async function snapshotTreeDigest(rootPath) {
  const entries = [];
  if (fs.existsSync(rootPath)) await walk(rootPath, "");
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return sha256(Buffer.from(JSON.stringify(entries), "utf8"));
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

async function writeAtomicPortable(portablePath, content) {
  const targetPath = resolveRunPath(portablePath);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tempPath, content, "utf8");
  await fsp.rm(targetPath, { force: true });
  await fsp.rename(tempPath, targetPath);
}

async function writeJsonAtomic(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, targetPath);
}

function resolveWorkspacePath(portablePath) {
  const normalized = normalizePortablePath(portablePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe workspace path: ${portablePath}`);
  const resolved = path.resolve(workspaceRoot, ...normalized.split("/"));
  assertWithin(workspaceRoot, resolved, "workspace path");
  return resolved;
}

function resolveRunPath(portablePath) {
  const normalized = normalizePortablePath(portablePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe run path: ${portablePath}`);
  const resolved = path.resolve(runRoot, ...normalized.split("/"));
  assertWithin(runRoot, resolved, "run path");
  return resolved;
}

function assertWithin(rootPath, candidatePath, label) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escaped root: ${candidate}`);
}

function normalizePortablePath(value) { return String(value || "").replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, ""); }
function opaqueId(value) { return sha256(Buffer.from(String(value), "utf8")).slice(0, 12); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
