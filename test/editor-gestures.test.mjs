import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Text } from "@codemirror/state";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, "..");
const build = await esbuild.build({
  entryPoints: [path.join(projectDir, "editor-gestures.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString("base64")}`;
const {
  getMarkdownBlockRangeAtOffset,
  isPlainRedoShortcut,
  isPlainUndoShortcut,
  isUndoableVirtualHighlightAction,
  isWholeBlockHighlightGesture
} = await import(moduleUrl);

assert.equal(isWholeBlockHighlightGesture({ ctrlKey: true, altKey: false }, true), true);
assert.equal(isWholeBlockHighlightGesture({ ctrlKey: false, altKey: false }, true), false);
assert.equal(isWholeBlockHighlightGesture({ ctrlKey: true, altKey: true }, true), false);
assert.equal(isWholeBlockHighlightGesture({ ctrlKey: true, altKey: false }, false), false);

assert.equal(isPlainUndoShortcut({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), true);
assert.equal(isPlainUndoShortcut({ key: "Z", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }), true);
assert.equal(isPlainUndoShortcut({ key: "z", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }), false);
assert.equal(isPlainUndoShortcut({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true }), false);
assert.equal(isPlainUndoShortcut({ key: "y", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), false);
assert.equal(isPlainRedoShortcut({ key: "y", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), true);
assert.equal(isPlainRedoShortcut({ key: "Y", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), true);
assert.equal(isPlainRedoShortcut({ key: "y", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), false);
assert.equal(isPlainRedoShortcut({ key: "y", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }), false);
assert.equal(isPlainRedoShortcut({ key: "y", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true }), false);

const virtualUndoAction = {
  kind: "merge",
  path: "阅读区/示例.md",
  beforeContent: "正文",
  afterContent: "正文"
};
assert.equal(isUndoableVirtualHighlightAction(virtualUndoAction, "阅读区/示例.md", "正文"), true);
assert.equal(isUndoableVirtualHighlightAction({ ...virtualUndoAction, afterContent: "==正文==" }, "阅读区/示例.md", "==正文=="), false);
assert.equal(isUndoableVirtualHighlightAction(virtualUndoAction, "阅读区/示例.md", "正文已修改"), false);
assert.equal(isUndoableVirtualHighlightAction(virtualUndoAction, "阅读区/其他.md", "正文"), false);

const markdown = "第一段第一行。\n第一段第二行。\n\n第二段。\n\n第三段。";
const first = getMarkdownBlockRangeAtOffset(markdown, markdown.indexOf("第二行"));
assert.equal(markdown.slice(first.start, first.end), "第一段第一行。\n第一段第二行。");
const second = getMarkdownBlockRangeAtOffset(markdown, markdown.indexOf("第二段"));
assert.equal(markdown.slice(second.start, second.end), "第二段。");

const editorDoc = Text.of(["第一段。", "紧邻的内部跳转。", "", "第二段。"]);
const clickedEditorLine = editorDoc.lineAt(editorDoc.toString().indexOf("第一段"));
assert.equal(editorDoc.sliceString(clickedEditorLine.from, clickedEditorLine.to), "第一段。");
assert.equal(clickedEditorLine.to, "第一段。".length);

const source = fs.readFileSync(path.join(projectDir, "main.ts"), "utf8");
assert.ok(source.includes("void plugin.highlightWholeBlockAtClick(view, event)"), "Ctrl click must invoke whole-block highlighting");
const ctrlMethodStart = source.indexOf("async highlightWholeBlockAtClick");
const ctrlMethodEnd = source.indexOf("handleMergeKeyDown", ctrlMethodStart);
const ctrlMethod = source.slice(ctrlMethodStart, ctrlMethodEnd);
assert.ok(ctrlMethod.includes("view.state.doc.lineAt(offset)"), "Ctrl click must use the exact CodeMirror editor line");
assert.equal(ctrlMethod.includes("metadataCache"), false, "Ctrl click must not depend on stale or broader metadata sections");
assert.equal(ctrlMethod.includes("getMarkdownBlockRangeAtOffset"), false, "Ctrl click must not use the broader Markdown block range");
assert.ok(source.includes("if (event.code === \"AltLeft\")"), "left Alt merge activation must remain unchanged");
assert.ok(source.includes("if (this.isManualMergeEvent(event))"), "inline annotation merge routing must remain unchanged");
assert.ok(source.includes("handleVirtualHighlightUndoShortcut(view: EditorView, event: KeyboardEvent)"), "virtual highlights must expose a Ctrl+Z handler");
assert.ok(source.includes("return plugin.handleVirtualHighlightUndoShortcut(view, event)"), "the CodeMirror extension must route keydown to virtual undo");
assert.ok(source.includes("handleVirtualHighlightRedoShortcut(view: EditorView, event: KeyboardEvent)"), "virtual highlights must expose a Ctrl+Y handler");
assert.ok(source.includes("|| plugin.handleVirtualHighlightRedoShortcut(view, event)"), "the CodeMirror extension must route keydown to virtual redo");
assert.ok(source.includes("Prec.highest(EditorView.domEventHandlers"), "virtual undo and redo must run before the native CodeMirror keymap");
const undoHandlerStart = source.indexOf("handleVirtualHighlightUndoShortcut(view: EditorView");
const undoHandlerEnd = source.indexOf("scheduleReconcile", undoHandlerStart);
const undoHandler = source.slice(undoHandlerStart, undoHandlerEnd);
assert.ok(undoHandler.includes("isUndoableVirtualHighlightAction"), "Ctrl+Z must only intercept an eligible virtual highlight action");
assert.ok(undoHandler.includes("event.preventDefault()"), "eligible virtual Ctrl+Z must suppress native undo");
assert.ok(undoHandler.includes("void this.undoRecentHighlight()"), "eligible virtual Ctrl+Z must use the existing undo operation");
assert.ok(undoHandler.includes("void this.redoRecentVirtualHighlight(path)"), "eligible virtual Ctrl+Y must use the virtual redo operation");
assert.ok(source.includes("this.recentVirtualHighlightRedoActions.push"), "virtual undo must preserve the state needed by redo");
// Record restoration, stale snapshots and unrelated IDs are exercised by
// document-core/test.mjs against the real plugin methods.
const undoMethodStart = source.indexOf("async undoRecentHighlight");
const undoMethodEnd = source.indexOf("handleVirtualHighlightUndoShortcut", undoMethodStart);
const undoMethod = source.slice(undoMethodStart, undoMethodEnd);
assert.ok(undoMethod.indexOf("this.refreshVirtualHighlights(activePath)") < undoMethod.indexOf("await this.saveSettings()"), "virtual decoration refresh must happen before settings persistence");
const reconcileStart = source.indexOf("async reconcileAnnotationsForPath");
const reconcileEnd = source.indexOf("async repairActiveFileDangerousMarks", reconcileStart);
assert.ok(source.slice(reconcileStart, reconcileEnd).includes("this.refreshVirtualHighlights(path)"), "reconcile must refresh decorations after deleting stale records");
const extensionStart = source.indexOf("function createVirtualHighlightExtension");
const altBranch = source.indexOf("if (id && annotation && event.altKey)", extensionStart);
const ctrlBranch = source.indexOf("if (isWholeBlockHighlightGesture(event, plugin.settings.processingModeEnabled))", extensionStart);
assert.ok(altBranch >= extensionStart && ctrlBranch > altBranch, "left Alt merge must take precedence over Ctrl whole-block highlighting");

console.log("editor gesture tests passed");
