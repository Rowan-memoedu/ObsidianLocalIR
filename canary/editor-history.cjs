// Actual Obsidian-bundled CodeMirror, hidden isolated editor, no Vault writes.
return (async () => {
  const assert = require('node:assert/strict');
  const runtime = window.app.plugins.plugins['local-ir']?.getEditorRuntime?.();
  if (!runtime) return { status: 'PENDING', reason: 'candidate plugin must be loaded to verify its host module instances' };
  const { EditorState, EditorView, history, undoDepth, isolateHistory, editorInfoField } = runtime;
  const LoadedPlugin = window.app.plugins.plugins['local-ir'].constructor;
  const file = { path: 'synthetic/editor-history.md', extension: 'md' };
  const source = 'hello\n\nworld';
  const editor = { cm: null, getValue: () => editor.cm.state.doc.toString(),
    offsetToPos: offset => { const line = editor.cm.state.doc.lineAt(offset); return { line: line.number - 1, ch: offset - line.from }; },
    posToOffset: pos => editor.cm.state.doc.line(pos.line + 1).from + pos.ch,
    getCursor: which => editor.offsetToPos(which === 'from' ? 0 : 5),
    getSelection: () => 'hello', replaceRange: () => { throw new Error('Virtual highlight wrote text'); } };
  const app = { workspace: { getActiveFile: () => file, activeEditor: { file, editor } } };
  const plugin = new LoadedPlugin(app, { id: 'local-ir-isolated-canary' });
  plugin.settings = { records: { [file.path]: {} }, annotations: {}, qaCards: {}, articleMusings: {},
    alwaysVirtualHighlightsEnabled: true, autoMergeHighlightsEnabled: false, clozeModeEnabled: false };
  plugin.isRecordFrozenForExport = () => false;
  plugin.ensureFileInReadingPool = async () => file;
  plugin.readVaultFile = async () => editor.getValue();
  plugin.saveSettings = async () => {};
  plugin.refreshViews = async () => {};
  plugin.refreshReadingHighlights = () => {};
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;visibility:hidden;pointer-events:none';
  document.body.appendChild(container);
  let view;
  try {
    view = new EditorView({ parent: container, state: EditorState.create({ doc: source,
      extensions: [history(), editorInfoField.init(() => ({ file, editor })), plugin.getEditorExtensions()] }) });
    editor.cm = view;
    await plugin.highlightSelection(editor, file, false, { from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 }, fromOffset: 0, toOffset: 5, text: 'hello' });
    const id = Object.keys(plugin.settings.annotations)[0];
    assert.ok(id);
    assert.equal(undoDepth(view.state), 1);
    await plugin.saveAnnotationDraft({ ...plugin.settings.annotations[id], type: 'comment' });
    await plugin.saveAnnotationDraft({ ...plugin.settings.annotations[id], commentMarkdown: 'synthetic thought' });
    assert.equal(undoDepth(view.state), 3);
    view.dispatch({ changes: { from: 0, to: 7 }, annotations: isolateHistory.of('full') });
    assert.equal(plugin.settings.annotations[id], undefined);
    await plugin.undoRecentHighlight();
    assert.equal(view.state.doc.toString(), source);
    assert.equal(plugin.settings.annotations[id].commentMarkdown, 'synthetic thought');
    const event = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {} };
    assert.equal(plugin.handleVirtualHighlightUndoShortcut(view, event), true);
    assert.equal(plugin.settings.annotations[id].commentMarkdown, '');
    await plugin.undoRecentHighlight(); assert.equal(plugin.settings.annotations[id].type, 'highlight');
    await plugin.undoRecentHighlight(); assert.equal(plugin.settings.annotations[id], undefined);
    for (let i = 0; i < 4; i++) plugin.handleVirtualHighlightRedoShortcut(view, { ...event, key: 'y' });
    assert.equal(view.state.doc.toString(), 'world');
    assert.equal(plugin.settings.annotations[id], undefined);
    await plugin.undoRecentHighlight();
    assert.equal(plugin.settings.annotations[id].commentMarkdown, 'synthetic thought');
    return { status: 'PASS', cases: 9, nativeHistory: true, productionWrites: 0 };
  } finally { view?.destroy(); container.remove(); }
})();
