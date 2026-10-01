import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import paths from './paths.cjs';

const files = ['main.js', 'manifest.json', 'styles.css'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function optionalRead(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Deploy only the three runtime files. Never load, normalize or write data.json. */
export async function deployRelease({ vaultRoot, buildDir = paths.buildDir, artifactRoot = paths.artifactRoot }) {
  vaultRoot = paths.requireVaultRoot(vaultRoot);
  const target = path.join(vaultRoot, '.obsidian', 'plugins', 'local-ir');
  const oldManifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
  const next = Object.fromEntries(await Promise.all(files.map(async name => [name, await fs.readFile(path.join(buildDir, name))])));
  const manifest = JSON.parse(next['manifest.json']);
  if (oldManifest.id !== 'local-ir' || manifest.id !== 'local-ir') throw new Error('Refusing to overwrite a different plugin.');
  if (!next['main.js'].toString('utf8').includes(`Local Incremental Reading v${manifest.version}.`)) throw new Error('Bundle and manifest versions differ. Build first.');
  const dataPath = path.join(target, 'data.json'), dataBefore = await optionalRead(dataPath);
  const old = Object.fromEntries(await Promise.all(files.map(async name => [name, await optionalRead(path.join(target, name))])));
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backupDir = path.join(artifactRoot, 'deployments', runId);
  await fs.mkdir(backupDir, { recursive: true });
  for (const name of files) if (old[name]) await fs.writeFile(path.join(backupDir, name), old[name], { flag: 'wx' });
  const touched = [];
  try {
    for (const name of files) {
      const destination = path.join(target, name), temporary = `${destination}.${runId}.tmp`;
      try {
        await fs.writeFile(temporary, next[name], { flag: 'wx' });
        await fs.rename(temporary, destination);
        touched.push(name);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    for (const name of files) if (digest(await fs.readFile(path.join(target, name))) !== digest(next[name])) throw new Error(`Deployment readback mismatch: ${name}`);
  } catch (error) {
    for (const name of touched.reverse()) {
      if (old[name]) await fs.writeFile(path.join(target, name), old[name]);
      else await fs.rm(path.join(target, name), { force: true });
    }
    throw error;
  }
  const dataAfter = await optionalRead(dataPath);
  const dataHash = value => value === null ? null : digest(value);
  const receipt = {
    status: 'deployed', version: manifest.version, target, backupDir,
    hashes: Object.fromEntries(files.map(name => [name, digest(next[name])])),
    dataUnchanged: dataHash(dataBefore) === dataHash(dataAfter),
    dataBeforeSha256: dataHash(dataBefore), dataAfterSha256: dataHash(dataAfter),
    runtimeReloaded: false
  };
  await fs.writeFile(path.join(backupDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--vault');
  const vaultRoot = index < 0 ? paths.requireVaultRoot() : paths.requireVaultRoot(process.argv[index + 1]);
  console.log(JSON.stringify(await deployRelease({ vaultRoot }), null, 2));
}
