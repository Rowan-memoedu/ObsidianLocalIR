const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.resolve(__dirname, "..", "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const installedPluginRoot = path.join(workspaceRoot, ".obsidian", "plugins", "local-ir");
const installedMainPath = path.join(installedPluginRoot, "main.js");
const builtMainPath = path.join(projectRoot, "main.js");
const dataPath = path.join(installedPluginRoot, "data.json");
const reportPath = path.join(__dirname, "runs", "production-failure-diagnosis-2026-08-23.json");
const genericFailureMessage = "批量归档输入未通过生产者校验";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const manifest = JSON.parse(await fsp.readFile(path.join(installedPluginRoot, "manifest.json"), "utf8"));
  const installedMainSha256 = sha256(await fsp.readFile(installedMainPath));
  const builtMainSha256 = sha256(await fsp.readFile(builtMainPath));
  if (installedMainSha256 !== builtMainSha256) {
    throw new Error("Built main.js does not match the installed plugin; refusing to diagnose a different implementation");
  }
  const rawData = await fsp.readFile(dataPath);
  const settings = JSON.parse(rawData.toString("utf8"));
  const candidates = Object.values(settings.records || {})
    .filter((record) => record?.status === "done" && record?.archiveLastError === genericFailureMessage)
    .sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
  if (candidates.length !== 7) throw new Error(`Expected exactly 7 generic producer failures, found ${candidates.length}`);

  const queueRoot = resolveWorkspacePath(settings.archiveFolder);
  const productionBefore = {
    dataSha256: sha256(rawData),
    queueDigest: await snapshotTreeDigest(queueRoot),
    sources: await snapshotSources(candidates)
  };

  const mockObsidian = createMockObsidian();
  const PluginClass = loadPluginClass(mockObsidian);
  const plugin = new PluginClass(createReadOnlyApp(mockObsidian.TFile, mockObsidian.TFolder), manifest);
  plugin.settings = structuredClone(settings);
  const { MODULE_VERSION, validateFrozenInput } = await import(pathToFileURL(path.join(projectRoot, "batch-archive-backend", "core.mjs")).href);

  const results = [];
  for (const record of candidates) {
    const input = await plugin.createBatchArchiveInput(record.path);
    results.push({
      title: record.title,
      path: record.path,
      status: record.status,
      priorFailure: record.archiveLastError,
      counts: {
        annotations: input.annotations.length,
        remnoteAnnotations: input.annotations.filter((item) => item.route === "remnote" && item.importable && item.targetDocument).length,
        refinedReadingAnnotations: input.annotations.filter((item) => item.route === "refined_reading").length,
        questionQueueAnnotations: input.annotations.filter((item) => item.route === "codex_question_queue" || item.type === "question").length,
        cards: input.cards.length,
        resolvedCards: input.cards.filter((item) => String(item.questionMarkdown || "").trim() && String(item.answerMarkdown || "").trim() && !item.needsQuestionGeneration && !item.needsAnswerGeneration).length,
        clozeCards: input.clozeCards.length,
        articleMusings: input.articleMusings.length
      },
      validatorErrors: validateFrozenInput(input)
    });
  }

  const productionAfter = {
    dataSha256: sha256(await fsp.readFile(dataPath)),
    queueDigest: await snapshotTreeDigest(queueRoot),
    sources: await snapshotSources(candidates)
  };
  if (JSON.stringify(productionAfter) !== JSON.stringify(productionBefore)) {
    throw new Error("Production data, queue, or source changed during read-only diagnosis");
  }

  const report = {
    schema: "progressive-reading.local-ir-production-failure-diagnosis/v1",
    createdAt: new Date().toISOString(),
    mode: "read_only",
    pluginVersion: manifest.version,
    moduleVersion: MODULE_VERSION,
    installedMainSha256,
    selected: results.length,
    productionUnchanged: true,
    remnoteCalls: 0,
    packagesWritten: 0,
    dataSha256: productionAfter.dataSha256,
    queueDigest: productionAfter.queueDigest,
    results
  };
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
}

function createMockObsidian() {
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
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
    requestUrl: async () => { throw new Error("Network calls are disabled in production failure diagnosis"); }
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
      cachedRead(file) {
        return fsp.readFile(resolveWorkspacePath(file.path), "utf8");
      }
    }
  };
}

async function snapshotSources(records) {
  const results = [];
  for (const record of records) {
    const buffer = await fsp.readFile(resolveWorkspacePath(record.path));
    results.push({ path: record.path, bytes: buffer.length, sha256: sha256(buffer) });
  }
  return results.sort((left, right) => left.path.localeCompare(right.path, "en"));
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

function resolveWorkspacePath(portablePath) {
  const normalized = normalizePortablePath(portablePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe workspace-relative path: ${portablePath}`);
  }
  const resolved = path.resolve(workspaceRoot, ...normalized.split("/"));
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Workspace path resolved outside root: ${portablePath}`);
  }
  return resolved;
}

function normalizePortablePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, targetPath);
}
