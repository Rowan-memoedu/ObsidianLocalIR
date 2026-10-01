// Run inside Obsidian eval via new Function('require','document','window','buildPath','projectPath', source).
// Detached native DOM and in-memory settings only: no vault writes, selection changes or plugin reload.
return (async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const localRequire = require('node:module').createRequire(projectPath + '/package.json');
  const doc = document.implementation.createHTMLDocument('Local IR isolated canary');
  const registry = new Map();
  const notices = [];
  const fakeWindow = { CSS: { highlights: registry }, Highlight: window.Highlight,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) };
  class Base { constructor(app) { this.app = app; } }
  class TFile { constructor(path) { this.path = path; } }
  const obsidian = new Proxy({ Plugin: Base, TFile, normalizePath: p => p,
    Notice: class { constructor(message) { notices.push(message); } } }, { get: (o,k) => o[k] ?? Base });
  const mod = { exports: {} };
  new Function('require','module','exports','document','window', fs.readFileSync(buildPath,'utf8'))(
    name => name === 'obsidian' ? obsidian : localRequire(name), mod, mod.exports, doc, fakeWindow);
  const Plugin = mod.exports.default;
  const source = '上邻段不高亮。\n\n重复正文 **加粗部分** 和 [链接文字](https://example.invalid)。\n\n重复正文 **加粗部分** 和 [链接文字](https://example.invalid)。\n\n下邻段不高亮。';
  const blocks = source.split('\n\n');
  const container = doc.createElement('div');
  container.className = 'markdown-reading-view'; doc.body.appendChild(container);
  let offset = 0;
  const sections = blocks.map(text => {
    const el = doc.createElement('div'); el.className = 'el-p';
    el.innerHTML = '<p>' + text.replace('**加粗部分**','<strong>加粗部分</strong>').replace('[链接文字](https://example.invalid)','<a>链接文字</a>') + '</p>';
    container.appendChild(el);
    const section = { el, start: { offset }, end: { offset: offset + text.length } };
    offset += text.length + 2; return section;
  });
  const file = new TFile('fixture/reading.md');
  const view = { file, containerEl: container, getMode: () => 'preview', previewMode: { containerEl: container, renderer: { text: source, sections } } };
  let selectedRange = null;
  doc.getSelection = () => selectedRange ? { isCollapsed: selectedRange.collapsed, rangeCount: 1, getRangeAt: () => selectedRange } : null;
  let saves = 0, writes = 0;
  const app = { workspace: { activeEditor: null, getActiveFile: () => file, getLeavesOfType: () => [{view}] },
    vault: { cachedRead: async () => source, read: async () => source, getAbstractFileByPath: () => file,
      modify: async () => { writes++; throw new Error('Unexpected note write'); } } };
  const plugin = new Plugin(app);
  plugin.settings = { records: {[file.path]: {}}, annotations: {}, processingModeEnabled: true,
    clozeModeEnabled: false, alwaysVirtualHighlightsEnabled: false, autoMergeHighlightsEnabled: false, autoOpenAnnotationModal: false };
  plugin.ensureFileInReadingPool = async f => f;
  plugin.isRecordFrozenForExport = () => false;
  plugin.saveSettings = async () => { saves++; };
  plugin.refreshViews = async () => {};
  function select(sectionIndex, selector = 'p') {
    const el = sections[sectionIndex].el.querySelector(selector);
    selectedRange = doc.createRange(); selectedRange.selectNodeContents(el); return el;
  }
  function count(key) { return registry.get('local-ir-reading-' + key)?.size || 0; }
  function painted(key) { return [...(registry.get('local-ir-reading-' + key) || [])].map(r => r.toString()).join(''); }
  await plugin.handleEditorMouseup({target: select(2)});
  assert.equal(Object.keys(plugin.settings.annotations).length, 1, 'reading selection creates annotation');
  const mark = Object.values(plugin.settings.annotations)[0];
  assert.equal(mark.renderMode, 'virtual_decoration');
  assert.equal(mark.range.start, sections[2].start.offset, 'repeated text resolves to selected paragraph');
  assert.equal(mark.range.end, sections[2].end.offset, 'no adjacent paragraphs');
  assert.equal(painted('highlight'), '重复正文 加粗部分 和 链接文字。');
  assert.ok(count('highlight') >= 4, 'inline formatting painted across DOM nodes');
  await plugin.undoRecentHighlight();
  assert.equal(Object.keys(plugin.settings.annotations).length, 0);
  assert.equal(count('highlight'), 0, 'undo clears visible ranges immediately');
  await plugin.redoRecentVirtualHighlight(file.path);
  assert.equal(Object.keys(plugin.settings.annotations).length, 1);
  assert.ok(count('highlight') > 0, 'redo restores visible ranges without active editor');
  plugin.settings.processingModeEnabled = false; plugin.settings.clozeModeEnabled = true;
  await plugin.handleEditorMouseup({target: select(1, 'strong')});
  assert.equal(Object.keys(plugin.settings.annotations).length, 2);
  assert.equal(painted('cloze'), '加粗部分', 'cloze creates separate visible ranges');
  await plugin.undoRecentHighlight();
  assert.equal(count('cloze'), 0);
  plugin.settings.clozeModeEnabled = false;
  await plugin.handleEditorMouseup({target: select(0)});
  assert.equal(Object.keys(plugin.settings.annotations).length, 1, 'modes off does not highlight');
  // Obsidian reuses rendered sections when scrolling. Rebind ranges to new nodes.
  const old = sections[2].el; const replacement = old.cloneNode(true);
  old.replaceWith(replacement); sections[2].el = replacement;
  plugin.refreshReadingHighlights();
  assert.ok([...registry.get('local-ir-reading-highlight')].every(r => replacement.contains(r.startContainer)));
  let prevented = 0;
  const key = letter => ({target: replacement.querySelector('p'), key: letter, ctrlKey: true,
    metaKey: false, shiftKey: false, altKey: false, preventDefault: () => { prevented++; }, stopPropagation() {}});
  plugin.handleReadingHistoryShortcut(key('z'));
  await new Promise(resolve => window.setTimeout(resolve, 20));
  assert.equal(count('highlight'), 0, 'reading Ctrl+Z clears highlight');
  plugin.handleReadingHistoryShortcut(key('y'));
  await new Promise(resolve => window.setTimeout(resolve, 20));
  assert.ok(count('highlight') > 0, 'reading Ctrl+Y restores highlight');
  assert.equal(prevented, 2);
  plugin.settings.processingModeEnabled = true;
  view.previewMode.renderer.text = source + ' changed';
  await plugin.handleEditorMouseup({target: select(0)});
  assert.equal(Object.keys(plugin.settings.annotations).length, 1, 'stale renderer does not create incorrect record');
  assert.equal(writes, 0, 'Markdown untouched');
  assert.ok(saves >= 5);
  return {status:'PASS', cases:['reading highlight','duplicate paragraphs','inline formatting','undo immediate','redo immediate','cloze','modes off','rerender','Ctrl+Z','Ctrl+Y','stale source','no Markdown writes'], saves, writes};
})();
