import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deployRelease } from '../scripts/deploy.mjs';
import paths from '../scripts/paths.cjs';

async function fixture() {
  const parent = path.join(paths.artifactRoot, 'tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'deployment-'));
  const vaultRoot = path.join(root, 'vault'), target = path.join(vaultRoot, '.obsidian/plugins/local-ir'), buildDir = path.join(root, 'build');
  await fs.mkdir(target, { recursive: true }); await fs.mkdir(buildDir);
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({ id: 'local-ir', version: 'old' }));
  await fs.writeFile(path.join(target, 'main.js'), 'old runtime');
  await fs.writeFile(path.join(target, 'styles.css'), 'old css');
  await fs.writeFile(path.join(target, 'data.json'), '  { "synthetic": true }\n');
  for (const [file, content] of Object.entries({ 'main.js': '/* Local Incremental Reading vtest. */', 'manifest.json': JSON.stringify({ id: 'local-ir', version: 'test' }), 'styles.css': 'test css' })) await fs.writeFile(path.join(buildDir, file), content);
  return { vaultRoot, target, buildDir, artifactRoot: path.join(root, 'artifacts') };
}

test('deployment verifies all three files, preserves raw data and retains rollback bytes', async () => {
  const f = await fixture(), before = await fs.readFile(path.join(f.target, 'data.json'));
  const receipt = await deployRelease(f);
  assert.equal(receipt.dataUnchanged, true);
  assert.deepEqual(await fs.readFile(path.join(f.target, 'data.json')), before);
  assert.equal(await fs.readFile(path.join(receipt.backupDir, 'main.js'), 'utf8'), 'old runtime');
  for (const file of ['main.js', 'manifest.json', 'styles.css']) assert.deepEqual(await fs.readFile(path.join(f.target, file)), await fs.readFile(path.join(f.buildDir, file)));
});

test('deployment refuses mixed-version artifacts before touching the installed files', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.buildDir, 'main.js'), 'stale build');
  await assert.rejects(deployRelease(f), /Bundle and manifest versions differ/);
  assert.equal(await fs.readFile(path.join(f.target, 'main.js'), 'utf8'), 'old runtime');
});

test('deployment requires an explicit absolute vault path', async () => {
  await assert.rejects(deployRelease({ vaultRoot: 'relative/vault' }), /absolute LOCAL_IR_VAULT/);
});
