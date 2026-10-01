import assert from 'node:assert/strict';
import test from 'node:test';
import { Plugin, TFile } from './document-core-host.mjs';
import core from '../../渐进阅读工作流/document-core/index.mjs';

const metrics = { importance: 5, urgency: 5, difficulty: 5, interest: 5 };
const makeRecord = p => ({ path: p, title: p.split('/').pop().replace(/\.md$/, ''), status: 'reading', metrics: { ...metrics }, metricsEditedByUser: true, priority: 5 });
function plugin() {
  const p = new Plugin();
  p.settings = { records: {}, annotations: {}, qaCards: {}, articleMusings: {}, pendingImports: [], metricWeights: { importance: 40, urgency: 20, difficulty: 15, interest: 25 }, documentStateFolder: '.state', readingFolders: ['reading'], readingFolder: 'reading' };
  p.saveData = async () => {};
  return p;
}
function state(path, status = 'inbox') {
  return core.normalizeDocumentState({ document: { id: path, path, title: path, status, revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } });
}
test('pool removal and missing index entries preserve all processing data', async () => {
  const p = plugin(), path = 'reading/a.md';
  p.settings.records[path] = makeRecord(path);
  p.settings.annotations.a = { id: 'a', path, lastKnownPath: path, commentMarkdown: 'synthetic comment' };
  p.settings.qaCards.q = { id: 'q', path };
  p.settings.articleMusings[path] = { bodyMarkdown: 'synthetic musing' };
  const before = JSON.stringify(p.settings);
  p.getPoolFiles = () => [];
  await p.syncRecords({ save: false });
  assert.equal(JSON.stringify(p.settings), before);
});
test('retained but unavailable or out-of-pool records are not selected', () => {
  const p = plugin();
  for (const path of ['reading/present.md', 'reading/missing.md', 'elsewhere/outside.md']) p.settings.records[path] = makeRecord(path);
  p.app = { vault: { getAbstractFileByPath: path => path.endsWith('missing.md') ? null : new TFile(path) } };
  assert.deepEqual(Array.from(p.getSelectableRecords(), r => r.path), ['reading/present.md']);
});
test('state identities include the document path and remain deterministic', () => {
  const p = plugin();
  const a = p.getDocumentStateSidecarPath('reading/topic-a/shared.md');
  const b = p.getDocumentStateSidecarPath('reading/topic-b/shared.md');
  assert.notEqual(a, b);
  assert.equal(a, p.getDocumentStateSidecarPath('reading/topic-a/shared.md'));
  assert.ok(a.endsWith('.browser-ir.json'));
});
test('a same-name sidecar cannot replace another document', async () => {
  const p = plugin(), path = 'reading/second/shared.md';
  p.settings.records[path] = makeRecord(path);
  p.app = { vault: { adapter: { read: async () => JSON.stringify(state('reading/first/shared.md')) } } };
  const before = JSON.stringify(p.settings);
  assert.equal(await p.importDocumentStateSidecarPath(path, '.state/shared.md.browser-ir.json', '# synthetic'), false);
  assert.equal(JSON.stringify(p.settings), before);
});
test('legacy flat sidecars resolve only for their owning document', async () => {
  const p = plugin();
  p.app = { vault: { adapter: { exists: async path => path === '.state/shared.md.browser-ir.json', read: async () => JSON.stringify(state('reading/first/shared.md')) } } };
  assert.equal(await p.resolveDocumentStateSidecarPath('reading/first/shared.md'), '.state/shared.md.browser-ir.json');
  assert.equal(await p.resolveDocumentStateSidecarPath('reading/second/shared.md'), null);
});
test('an unchanged pool without sidecars performs zero Markdown reads', async () => {
  const p = plugin(); let reads = 0;
  const files = Array.from({ length: 100 }, (_, i) => {
    const f = new TFile('reading/synthetic-' + i + '.md'); f.basename = 'synthetic-' + i; f.stat = { mtime: 1 };
    p.settings.records[f.path] = makeRecord(f.path); return f;
  });
  p.getPoolFiles = () => files;
  p.app = { vault: { cachedRead: async () => { reads++; return 'synthetic'; }, adapter: { exists: async () => false } } };
  await p.syncRecords({ save: false });
  assert.equal(reads, 0);
});
test('a save arriving during a sidecar flush is drained before both callers finish', async () => {
  const p = plugin(), disk = new Map();
  for (const key of ['a', 'b']) {
    const path = 'reading/' + key + '.md';
    p.settings.records[path] = { ...makeRecord(path), documentStateSidecarPath: '.state/' + key + '.json' };
    disk.set(path, state(path));
  }
  let reachedSecond, unblockSecond;
  const secondReached = new Promise(resolve => reachedSecond = resolve);
  const secondReleased = new Promise(resolve => unblockSecond = resolve);
  p.readDocumentStateSidecar = async path => {
    if (path === 'reading/b.md') { reachedSecond(); await secondReleased; }
    return { state: structuredClone(disk.get(path)), sidecarPath: p.settings.records[path].documentStateSidecarPath };
  };
  p.writeDocumentStateSidecarAtomic = async (_sidecar, content) => { const s = JSON.parse(content); disk.set(s.document.path, s); };
  const first = p.flushDocumentStateSidecars(); await secondReached;
  p.settings.records['reading/a.md'].status = 'later'; p.settings.records['reading/a.md'].deferUntil = '2026-10-10';
  const second = p.flushDocumentStateSidecars(); unblockSecond(); await Promise.all([first, second]);
  assert.equal(disk.get('reading/a.md').document.status, 'later');
  assert.equal(disk.get('reading/a.md').document.deferUntil, '2026-10-10');
});
test('concurrent data saves are serialized and retain the final state', async () => {
  const p = plugin(); let writes = 0, active = 0, maxActive = 0, release, reached;
  const started = new Promise(resolve => reached = resolve), gate = new Promise(resolve => release = resolve);
  const saved = [];
  p.saveData = async value => {
    active++; maxActive = Math.max(maxActive, active); const snapshot = JSON.stringify(value);
    if (++writes === 1) { reached(); await gate; }
    saved.push(snapshot); active--;
  };
  const first = p.saveSettings({ flushDocumentStateSidecars: false }); await started;
  p.settings.records['reading/new.md'] = makeRecord('reading/new.md');
  const second = p.saveSettings({ flushDocumentStateSidecars: false }); release(); await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.ok(JSON.parse(saved.at(-1)).records['reading/new.md']);
});
test('targeted sidecar saves do not read unrelated documents', async () => {
  const p = plugin(), visited = [];
  for (const key of ['a', 'b']) { const path = 'reading/' + key + '.md'; p.settings.records[path] = { ...makeRecord(path), documentStateSidecarPath: '.state/' + key + '.json' }; }
  p.readDocumentStateSidecar = async path => { visited.push(path); return { state: state(path, 'reading'), sidecarPath: p.settings.records[path].documentStateSidecarPath }; };
  p.writeDocumentStateSidecarAtomic = async () => {};
  await p.flushDocumentStateSidecars(['reading/a.md']);
  assert.deepEqual(visited, ['reading/a.md']);
});
test('frozen records reject draft autosave, restoration and source repair', async () => {
  const p = plugin(), path = 'reading/frozen.md';
  p.settings.records[path] = { ...makeRecord(path), status: 'export_package_ready' };
  p.settings.annotations.a = { id: 'a', path, sourceFormat: 'virtual', commentMarkdown: 'original' };
  const before = JSON.stringify(p.settings);
  p.moveVaultFilePath = async () => { throw new Error('Frozen source was moved'); };
  p.readVaultFile = async () => { throw new Error('Frozen source was read for repair'); };
  p.getActiveEditorForPath = () => null;
  p.refreshViews = async () => {};
  await p.saveAnnotationDraft({ ...p.settings.annotations.a, commentMarkdown: 'changed', rewriteMarkdown: '' });
  await p.restoreRecord(path);
  await p.updateRecord(path, { status: 'reading' });
  await p.updateMetric(path, 'importance', 10);
  await p.setExtremeImportance(path, true);
  await p.reconcileAnnotationsForPath(path);
  p.mapVirtualRangesForEditorChange(path, {});
  await p.rebindAnnotationToSelection(p.settings.annotations.a);
  assert.equal(await p.repairDangerousMarksForPath(path), false);
  assert.equal(JSON.stringify(p.settings), before);
});

test('stale sidecar cannot reopen a committed package; archive receipt may advance it', async () => {
  const p = plugin(), path = 'reading/frozen.md';
  p.settings.records[path] = { ...makeRecord(path), status: 'export_package_ready' };
  let incoming = state(path, 'reading');
  p.app = { vault: { adapter: { read: async () => JSON.stringify(incoming) } } };
  assert.equal(await p.importDocumentStateSidecarPath(path, '.state/frozen.json', 'synthetic'), false);
  assert.equal(p.settings.records[path].status, 'export_package_ready');
  incoming = state(path, 'archived');
  assert.equal(await p.importDocumentStateSidecarPath(path, '.state/frozen.json', 'synthetic'), true);
  assert.equal(p.settings.records[path].status, 'archived');
});

test('managed rename handles the vault event once and preserves a legacy sidecar', async () => {
  const p = plugin(), oldPath = 'reading/a.md', newPath = 'staging/a.md', sidecar = '.state/a.md.browser-ir.json';
  const record = p.settings.records[oldPath] = { ...makeRecord(oldPath), documentStateSidecarPath: sidecar };
  const file = new TFile(oldPath); file.basename = 'a';
  const disk = new Map([[sidecar, JSON.stringify(state(oldPath, 'reading'))]]); let writes = 0;
  p.app = { vault: { adapter: { exists: async path => disk.has(path), read: async path => disk.get(path) } },
    fileManager: { renameFile: async (f, next) => { f.path = next; await p.handleVaultRename(f, oldPath); } } };
  p.writeDocumentStateSidecarAtomic = async (path, text) => { writes++; disk.set(path, text); };
  await p.renameManagedFile(file, newPath);
  assert.equal(writes, 1);
  assert.equal(p.settings.records[newPath], record);
  assert.equal(record.documentStateSidecarPath, sidecar);
  assert.equal(p.settings.records[oldPath], undefined);
  record.status = 'done';
  await p.saveSettings({ documentPaths: [newPath] });
  assert.equal(JSON.parse(disk.get(sidecar)).document.path, newPath);
  assert.equal(JSON.parse(disk.get(sidecar)).document.status, 'done');
});

test('save failures surface to callers and a later request can retry', async () => {
  const p = plugin(); let attempts = 0;
  p.saveData = async () => { if (++attempts === 1) throw new Error('synthetic IO failure'); };
  await assert.rejects(p.saveSettings({ flushDocumentStateSidecars: false }), /synthetic IO failure/);
  await p.saveSettings({ flushDocumentStateSidecars: false });
  assert.equal(attempts, 2);
});

test('autosave touches only the current document and does not rebuild the sidebar', async () => {
  const p = plugin(), path = 'reading/a.md', saves = [];
  p.settings.records[path] = makeRecord(path);
  p.settings.annotations.a = { id: 'a', path, sourceFormat: 'virtual', type: 'comment', commentMarkdown: '' };
  p.saveSettings = async options => saves.push(options);
  p.refreshViews = async () => { throw new Error('draft rebuilt the sidebar'); };
  await p.saveAnnotationDraft({ ...p.settings.annotations.a, commentMarkdown: 'draft', rewriteMarkdown: '' });
  assert.equal(p.settings.annotations.a.commentMarkdown, 'draft');
  assert.deepEqual(Array.from(saves[0].documentPaths), [path]);
});
