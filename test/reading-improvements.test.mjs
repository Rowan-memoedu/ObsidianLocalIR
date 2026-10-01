import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Plugin, TFile, host, loadModule, plain } from './document-core-host.mjs';
import core from '../../渐进阅读工作流/document-core/index.mjs';
import { generateGuideOnly } from '../reading-guide-worker.mjs';
const require = createRequire(import.meta.url);
const { EditorState, ChangeSet, Transaction } = require('@codemirror/state');
const { history, undo, redo, isolateHistory, undoDepth } = require('@codemirror/commands');
const h = await loadModule('annotation-history.ts');
const model = await loadModule('model.ts');
const guide = await loadModule('reading-guide.ts');
const positions = await loadModule('reading-position.ts');
const path = 'reading/topic/a.md';
function annotation(id = 'a', range = { start: 0, end: 5 }) {
  return model.normalizeAnnotation(id, { id, path, sourceFormat: 'virtual', renderMode: 'virtual_decoration', range,
    virtualRanges: [range], currentText: 'hello', selectedText: 'hello', originalText: 'hello', type: 'highlight',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
}
function nativeHost(content = 'hello world', records = []) {
  const plugin = new Plugin();
  plugin.settings = { annotations: Object.fromEntries(records.map(r => [r.id, r])) };
  plugin.isRecordFrozenForExport = () => false;
  plugin.saveSettings = async () => {};
  plugin.refreshViews = async () => {};
  const target = { state: EditorState.create({ doc: content, extensions: [history(), h.createAnnotationHistoryExtension(plugin, () => path)] }),
    dispatch(tr) { target.state = tr.state; plugin.applyEditorAnnotationEntries(h.entriesFromTransactions([tr])); } };
  const change = (before, after) => {
    const diff = core.createChange(before, after);
    target.dispatch(target.state.update({ effects: h.annotationHistoryEffect.of({ path, change: diff, direction: 'forward', replay: true }), annotations: isolateHistory.of('full') }));
  };
  const edit = changes => target.dispatch(target.state.update({ changes, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.type')] }));
  return { plugin, target, change, edit };
}

test('native Ctrl+Z interleaves highlights, type, comment and body edits, one step each', () => {
  const { plugin, target, change, edit } = nativeHost();
  const original = annotation(), typed = { ...original, type: 'comment' }, commented = { ...typed, commentMarkdown: 'thought' };
  change([], [original]); change([original], [typed]); change([typed], [commented]);
  edit({ from: 11, insert: '!' });
  assert.equal(undoDepth(target.state), 4);
  undo(target); assert.equal(target.state.doc.toString(), 'hello world');
  undo(target); assert.equal(plugin.settings.annotations.a.commentMarkdown, '');
  undo(target); assert.equal(plugin.settings.annotations.a.type, 'highlight');
  undo(target); assert.deepEqual(Object.keys(plugin.settings.annotations), []);
  for (let i = 0; i < 4; i++) assert.equal(redo(target), true);
  assert.equal(plugin.settings.annotations.a.commentMarkdown, 'thought');
  assert.equal(target.state.doc.toString(), 'hello world!');
});

test('paragraph deletion removes worked annotation and native undo restores both atomically', () => {
  const a = { ...annotation(), type: 'comment', commentMarkdown: 'keep on undo' };
  const { plugin, target, edit } = nativeHost('hello\n\nworld', [a]);
  edit({ from: 0, to: 7 });
  assert.equal(plugin.settings.annotations.a, undefined);
  undo(target);
  assert.equal(target.state.doc.toString(), 'hello\n\nworld');
  assert.deepEqual(plain(plugin.settings.annotations.a), plain(a));
  redo(target); assert.equal(plugin.settings.annotations.a, undefined);
});

test('partial/multi-range deletion retains remaining text and undo restores exact snapshots', () => {
  const a = { ...annotation(), virtualRanges: [{ start: 0, end: 5 }, { start: 7, end: 12 }] };
  const { plugin, target, edit } = nativeHost('hello\n\nworld', [a]);
  edit({ from: 0, to: 7 });
  assert.equal(plugin.settings.annotations.a.currentText, 'world');
  assert.deepEqual(plain(plugin.settings.annotations.a.virtualRanges), [{ start: 0, end: 5 }]);
  undo(target); assert.deepEqual(plain(plugin.settings.annotations.a), plain(a));
  edit({ from: 1, to: 4 });
  assert.equal(plugin.settings.annotations.a.currentText, 'ho\n\nworld');
});

test('native history retains strict external-change protection without changing text/history', () => {
  const { plugin, target, change, edit } = nativeHost();
  const a = annotation(); change([], [a]); edit({ from: 0, to: 3 });
  plugin.settings.annotations.a.commentMarkdown = 'external edit';
  const text = target.state.doc.toString(), depth = undoDepth(target.state);
  assert.throws(() => undo(target), /stale_annotation_snapshot/);
  assert.equal(target.state.doc.toString(), text); assert.equal(undoDepth(target.state), depth);
});

test('preview type/comment edits are separately undoable and no-op saves add no step', async () => {
  const { plugin } = host([annotation()], 'hello world', path);
  const a = plugin.settings.annotations.a;
  await plugin.saveAnnotationDraft({ ...a, type: 'comment' });
  await plugin.saveAnnotationDraft({ ...plugin.settings.annotations.a, commentMarkdown: 'note' });
  await plugin.saveAnnotationDraft({ ...plugin.settings.annotations.a });
  assert.equal(plugin.recentHighlightActions.length, 2);
  await plugin.undoRecentHighlight(); assert.equal(plugin.settings.annotations.a.commentMarkdown, '');
  await plugin.undoRecentHighlight(); assert.equal(plugin.settings.annotations.a.type, 'highlight');
  await plugin.redoRecentVirtualHighlight(path); assert.equal(plugin.settings.annotations.a.type, 'comment');
});

test('extreme importance restores individual metrics after normalization/reload and repeated enable', async () => {
  const { plugin } = host([], 'hello', path);
  const metrics = { importance: 7.5, urgency: 2.5, difficulty: 0, interest: 10 };
  plugin.settings.metricWeights = { importance: 40, urgency: 20, difficulty: 15, interest: 25 };
  plugin.settings.records[path] = model.normalizeRecord(path, { metrics, metricsEditedByUser: true }, plugin.settings.metricWeights);
  await plugin.setExtremeImportance(path, true); await plugin.setExtremeImportance(path, true);
  plugin.settings.records[path] = model.normalizeRecord(path, plain(plugin.settings.records[path]), plugin.settings.metricWeights);
  await plugin.setExtremeImportance(path, false);
  assert.deepEqual(plain(plugin.settings.records[path].metrics), metrics);
  await plugin.setExtremeImportance(path, false);
  assert.deepEqual(plain(plugin.settings.records[path].metrics), metrics);
});

test('manual pool restricts only candidate selection, including descendants and respecting path boundary', () => {
  const { plugin } = host([], 'hello', path);
  plugin.settings.readingFolders = ['reading']; plugin.settings.activeReadingPoolFolder = 'reading/topic';
  plugin.settings.metricWeights = { importance: 1, urgency: 1, difficulty: 1, interest: 1 };
  plugin.app.vault = { getAbstractFileByPath: p => new TFile(p) };
  plugin.settings.records = Object.fromEntries(['reading/topic/a.md', 'reading/topic/sub/b.md', 'reading/topic2/c.md'].map(p => [p, model.normalizeRecord(p, { status: 'reading' }, plugin.settings.metricWeights)]));
  assert.deepEqual(Array.from(plugin.getSelectableRecords(), r => r.path), ['reading/topic/a.md', 'reading/topic/sub/b.md']);
  assert.equal(Object.keys(plugin.settings.records).length, 3);
});

test('saved reading position is preserved by normalization and does not override explicit navigation', () => {
  const editor = { getCursor: () => ({ line: 15, ch: 30 }), lineCount: () => 3, getLine: () => 'short',
    setCursor: value => { editor.restored = value; }, scrollIntoView() {} };
  let ephemeral = {};
  const view = { file: { path }, editor, currentMode: { getScroll: () => 2.5 }, setEphemeralState: value => { view.scroll = value.scroll; } };
  const workspace = { getActiveFile: () => ({ path }), activeEditor: { editor, file: { path } }, getMostRecentLeaf: () => ({ view, getEphemeralState: () => ephemeral }) };
  const saved = positions.captureReadingPosition(workspace, path);
  const record = model.normalizeRecord(path, { readingPosition: saved }, { importance: 1, urgency: 1, difficulty: 1, interest: 1 });
  assert.equal(positions.restoreReadingPosition(workspace, path, record.readingPosition), true);
  assert.deepEqual(plain(editor.restored), { line: 2, ch: 5 }); assert.equal(view.scroll, 2.5);
  ephemeral = { line: 0 };
  assert.equal(positions.restoreReadingPosition(workspace, path, saved), false);
});

const result = (body = 'Alpha paragraph.') => ({ guide: '## 阅读前置卡\n\n- 价值判断：高。测试。\n\n## 核心洞察\n\n观点\n[[#^pr-one|正文跳转]]',
  blocks: [{ id: 'pr-one', markdown: body }], stages: ['reading_guide'], processorVersion: 'test', calls: 1 });

for (const newline of ['\n', '\r\n']) test(`guide creation/update preserves body, metadata, original anchors and subsequent annotations (${JSON.stringify(newline)})`, () => {
  const source = ['---', 'title: original', 'tags: [test]', '---', '', '# A', '', 'Alpha paragraph.', '', '^existing', ''].join(newline);
  const plan = guide.planReadingGuideUpdate(source, result());
  const next = guide.applyGuideEdits(source, plan.edits);
  assert.match(next, /title: original/); assert.match(next, /tags: \[test\]/);
  assert.match(next, /\[\[#\^existing\|正文跳转\]\]/);
  assert.equal((next.match(/## 阅读前置卡/g) || []).length, 1);
  assert.ok(next.endsWith(`Alpha paragraph.${newline}${newline}^existing${newline}`));
  const second = guide.applyGuideEdits(next, guide.planReadingGuideUpdate(next, result(), 'later').edits);
  assert.equal((second.match(/## 阅读前置卡/g) || []).length, 1);
  assert.equal((second.match(/^local_ir_reading_guide:/gm) || []).length, 1);
  const from = source.indexOf('Alpha'), a = annotation('body', { start: from, end: from + 5 });
  const change = h.mappedAnnotationChange([a], path, ChangeSet.of(plan.edits, source.length, '\n'), source, next);
  const mapped = core.applyChange([a], change)[0];
  assert.equal(next.slice(mapped.range.start, mapped.range.end), 'Alpha');
});

test('guide adds missing anchors without changing original words and rejects unmatched/unknown output', () => {
  const source = 'Alpha paragraph.';
  const next = guide.applyGuideEdits(source, guide.planReadingGuideUpdate(source, result()).edits);
  assert.ok(next.startsWith('---\nlocal_ir_reading_guide: true'));
  assert.match(next, /Alpha paragraph\.\n\n\^pr-one/);
  assert.throws(() => guide.planReadingGuideUpdate(source, result('Changed body')), /原文块不一致/);
  assert.throws(() => guide.planReadingGuideUpdate(source, { ...result(), blocks: [] }), /无对应正文/);
});

test('standard imported guide is replaced, metadata can detect a guide, code examples are not guides', () => {
  const source = '---\nmaterial_id: test\n---\n\n# Title\n\n## 阅读前置卡\nold\n\n## 核心洞察\nold\n\n---\n\n## 正文\n\nAlpha paragraph.\n';
  const next = guide.applyGuideEdits(source, guide.planReadingGuideUpdate(source, result()).edits);
  assert.equal((next.match(/## 阅读前置卡/g) || []).length, 1);
  assert.equal(next.includes('\nold\n'), false);
  assert.equal(guide.hasReadingGuide('article', { local_ir_reading_guide: true }), true);
  assert.equal(guide.hasReadingGuide('```markdown\n## 阅读前置卡\n```'), false);
});

test('guide worker calls standard single-stage semantic processing, never publishes or translates', async () => {
  let request, options;
  const api = { buildPreprocessRequest: value => value, standardMarkdownOptions: value => value,
    runPreprocessingRequest: async (r, o) => { request = r; options = o; return { result: {
      status: 'completed', processing_state: 'rendered', artifacts: { target_zone: 'local-ir-reading', semantic: { judgments: {} },
        reading_markdown: '# Title\n\n## 阅读前置卡\nGuide\n\n---\n\n## 正文\nBody', body_blocks: [] }, receipt: { processor_version: 'test', model: { calls: 1 } } } }; } };
  await generateGuideOnly({ markdown: 'Body', title: 'Test', outputDir: 'audit', cacheDir: 'cache' }, { api });
  assert.equal(request.processingOptions.workflow_mode, 'single_stage');
  assert.equal(request.processingOptions.cleaning_mode, 'semantic_only');
  for (const key of ['translate', 'structure_body', 'spoken_to_written', 'normalize_semantic_containers']) assert.equal(request.processingOptions[key], false);
  assert.equal(options.publishPath, undefined); assert.equal(options.skipCacheRead, true);
});

function guidePlugin() {
  const p = new Plugin(), file = new TFile(path);
  let source = '# Synthetic\n\nAlpha paragraph.', writes = 0;
  p.settings = { preprocessingProjectPath: 'unused-test', annotations: {}, records: { [path]: { path, title: 'Synthetic', metricsEditedByUser: true,
    metrics: { importance: 7.5, urgency: 2.5, difficulty: 5, interest: 10 } } } };
  p.app = { workspace: { activeEditor: null, getActiveFile: () => file }, metadataCache: { getFileCache: () => ({}) },
    vault: { getAbstractFileByPath: () => file, read: async () => source, process: async (_file, callback) => { source = callback(source); writes++; } } };
  p.saveSettings = async () => {}; p.refreshViews = async () => {}; p.refreshVirtualHighlights = () => {};
  p.startReadingGuideJob = () => ({ result: Promise.resolve(result()), cancel() {} });
  return { p, file, source: () => source, setSource: value => { source = value; }, writes: () => writes };
}

test('guide button publishes into the same file and preserves hand-adjusted metrics', async () => {
  const { p, file, source, writes } = guidePlugin();
  const metrics = plain(p.settings.records[path].metrics);
  await p.generateReadingGuide(path);
  assert.equal(writes(), 1); assert.equal(file.path, path);
  assert.match(source(), /local_ir_reading_guide: true/);
  assert.deepEqual(plain(p.settings.records[path].metrics), metrics);
  assert.equal(p.readingGuideJobs.size, 0);
});

test('guide failures and concurrent body edits never replace the file', async () => {
  for (const failure of ['producer', 'edit', 'move', 'freeze']) {
    const { p, file, source, setSource, writes } = guidePlugin();
    const initial = source();
    p.startReadingGuideJob = () => ({ result: Promise.resolve().then(() => {
      if (failure === 'producer') throw new Error('synthetic failure');
      if (failure === 'edit') setSource(initial + '\nuser edit');
      if (failure === 'move') file.path = 'another.md';
      if (failure === 'freeze') p.settings.records[path].status = 'export_package_ready';
      return result();
    }), cancel() {} });
    await p.generateReadingGuide(path);
    assert.equal(writes(), 0, failure);
    assert.equal(source(), failure === 'edit' ? initial + '\nuser edit' : initial);
    assert.equal(p.readingGuideJobs.size, 0);
  }
});
