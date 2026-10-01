import esbuild from "esbuild";
import vm from "node:vm";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const build = await esbuild.build({ entryPoints: [root + "main.ts"], absWorkingDir: root, bundle: true,
  platform: "node", format: "cjs", packages: "external", write: false,
  define: { __LOCAL_IR_GUIDE_WORKER__: JSON.stringify(fs.readFileSync(root + "reading-guide-worker.mjs", "utf8")) } });
const notices = [];
export class TFile { constructor(path) { this.path = path; this.extension = "md"; } }
class Base {}
const obsidian = new Proxy({ Plugin: Base, TFile, Notice: class { constructor(message) { notices.push(message); } },
  normalizePath: value => value.replaceAll("\\", "/") }, { get: (target, key) => target[key] || Base });
const context = { module: { exports: {} }, exports: {}, require: name => name === "obsidian" ? obsidian : require(name),
  console, process, Buffer, setTimeout, clearTimeout, window: { setTimeout, clearTimeout }, URL, TextEncoder, TextDecoder };
context.exports = context.module.exports;
vm.runInNewContext(build.outputFiles[0].text, context, { filename: root + "test/host.cjs" });
export const Plugin = context.module.exports.default;
export const plain = value => JSON.parse(JSON.stringify(value));
export async function loadModule(entry) {
  const built = await esbuild.build({ entryPoints: [root + entry], absWorkingDir: root, bundle: true,
    platform: "node", format: "cjs", packages: "external", write: false });
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { ...context, module, exports: module.exports }, { filename: root + entry });
  return module.exports;
}
export function host(records, content, path = "fixture.md") {
  const plugin = new Plugin();
  const file = new TFile(path);
  const editor = { getValue: () => content, offsetToPos: offset => ({ line: 0, ch: offset }),
    replaceRange: () => { throw new Error("virtual operation wrote Markdown"); } };
  plugin.settings = { annotations: Object.fromEntries(records.map(record => [record.id, plain(record)])), records: { [path]: {} },
    qaCards: { qa: { id: "qa", questionMarkdown: "q", answerMarkdown: "a" } }, articleMusings: { [path]: { bodyMarkdown: "musing" } },
    alwaysVirtualHighlightsEnabled: true, autoMergeHighlightsEnabled: false, clozeModeEnabled: false };
  plugin.app = { workspace: { getActiveFile: () => file, activeEditor: { editor, file } } };
  plugin.isRecordFrozenForExport = () => false;
  plugin.ensureFileInReadingPool = async () => file;
  plugin.readVaultFile = async () => content;
  plugin.refreshVirtualHighlights = () => { plugin.events.push("refresh"); };
  plugin.saveSettings = async () => { plugin.events.push("save"); };
  plugin.refreshViews = async () => {};
  plugin.events = [];
  return { plugin, file, editor, notices, setContent: value => { content = value; } };
}
