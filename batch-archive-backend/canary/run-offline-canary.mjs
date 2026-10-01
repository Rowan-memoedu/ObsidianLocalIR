import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import paths from "../../scripts/paths.cjs";
import { normalizePackage, validateNormalizedPackage } from "../../../渐进阅读工作流/remnote-formal-archive/core.mjs";
import { MODULE_VERSION, prepareExportPackage, validateExportPackage } from "../core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, "..");
const runRoot = path.join(paths.artifactRoot, "canaries", `offline-v${MODULE_VERSION}-${randomUUID()}`);
const input = JSON.parse(await readFile(path.join(moduleRoot, "fixtures", "mixed-package.input.json"), "utf8"));

const resolvePath = (portable) => path.join(runRoot, ...portable.split("/"));
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
    const temporary = `${target}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rm(target, { force: true });
    await rename(temporary, target);
  }
};

await io.writeAtomic(input.record.path, input.sourceContent);
const first = await prepareExportPackage({ input, io, clock: () => new Date("2026-08-22T00:00:00.000Z") });
const replay = await prepareExportPackage({ input, io, clock: () => new Date("2030-01-01T00:00:00.000Z") });
const pkg = JSON.parse(await io.readText(input.paths.packageJsonPath));
const normalized = normalizePackage(pkg, input.paths.packageJsonPath);
const result = {
  schema: "progressive-reading.local-ir-batch-archive-canary/v1",
  moduleVersion: MODULE_VERSION,
  status: validateExportPackage(pkg).length === 0 && validateNormalizedPackage(normalized).length === 0 && replay.idempotentReplay ? "passed" : "failed",
  syntheticFixtureOnly: true,
  touchedRealQueue: false,
  sourceRemainedInStaging: await io.exists(input.record.path),
  finalArchiveAbsent: !(await io.exists(input.record.archivedSourcePath)),
  packageId: first.packageId,
  packageRevision: first.packageRevision,
  idempotentReplay: replay.idempotentReplay,
  producerValidationErrors: validateExportPackage(pkg),
  importerValidationErrors: validateNormalizedPackage(normalized),
  dispositionSummary: normalized.dispositionSummary,
  packagePath: input.paths.packageJsonPath,
  runRoot
};
await writeFile(path.join(runRoot, "canary-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed" || !result.sourceRemainedInStaging || !result.finalArchiveAbsent) process.exitCode = 1;
