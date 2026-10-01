import fs from 'node:fs';

// Source-level wiring assertions cover every extracted module; behavioral tests
// still bundle the real plugin entry point through document-core-host.mjs.
export function readPluginSource() {
  return ['main', 'model', 'types', 'sidebar', 'modals', 'settings', 'editor-integration']
    .map(name => fs.readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8'))
    .join('\n');
}
