const path = require('node:path');

const artifactRoot = path.resolve(process.env.LOCAL_IR_ARTIFACT_DIR || 'D:/Artifacts/ObsidianLocalIR');
const buildDir = path.resolve(process.env.LOCAL_IR_BUILD_DIR || path.join(artifactRoot, 'build'));
function requireVaultRoot(value = process.env.LOCAL_IR_VAULT) {
  if (!value || !path.isAbsolute(value)) throw new Error('Specify an absolute LOCAL_IR_VAULT (or deploy --vault path); the vault is never inferred from the source directory.');
  return path.resolve(value);
}

module.exports = { artifactRoot, buildDir, requireVaultRoot };
