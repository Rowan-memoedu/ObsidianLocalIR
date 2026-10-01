// Run via Obsidian eval after loading the candidate or activating the installed plugin.
// Temporary hidden DOM only; never changes theme, user selection, notes or plugin data.
return (() => {
  const assert = require('node:assert/strict');
  const host = document.createElement('div');
  host.className = 'markdown-source-view';
  host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;';
  const highlight = document.createElement('span');
  highlight.className = 'local-ir-virtual-highlight';
  const cloze = document.createElement('span');
  cloze.className = 'local-ir-virtual-cloze';
  const plain = document.createElement('span');
  host.append(highlight, cloze, plain);
  document.body.appendChild(host);
  try {
    const cases = [
      {name:'current-theme'},
      {name:'custom-palette', highlight:'rgba(30, 170, 90, 0.6)', orange:'rgb(220, 100, 30)'},
      {name:'alternate-palette', highlight:'rgba(80, 100, 200, 0.3)', orange:'rgb(230, 160, 70)'}
    ];
    const results = [];
    for (const item of cases) {
      if (item.highlight) host.style.setProperty('--text-highlight-bg', item.highlight);
      if (item.orange) host.style.setProperty('--color-orange', item.orange);
      for (const [kind, oldElement] of [['highlight', highlight], ['cloze', cloze]]) {
        const before = getComputedStyle(oldElement).backgroundColor;
        const after = getComputedStyle(plain, `::highlight(local-ir-reading-${kind})`).backgroundColor;
        assert.equal(after, before, `${item.name}: reading ${kind} must match existing editor palette`);
        assert.notEqual(after, 'rgba(0, 0, 0, 0)', 'palette must resolve');
        results.push({palette:item.name,kind,resolved:after});
      }
    }
    const injectedRules = [...document.querySelectorAll('style')].map(s => s.textContent)
      .filter(text => text.includes('::highlight(local-ir-reading-highlight)'));
    assert.equal(injectedRules.length, 1, 'no stale duplicate injected palette');
    assert.doesNotMatch(injectedRules[0], /(?:^|[;{])color\s*:/, 'must not override original text/link color');
    return {status:'PASS', checks:results, textColorsNotOverridden:true};
  } finally {
    host.remove();
  }
})();
