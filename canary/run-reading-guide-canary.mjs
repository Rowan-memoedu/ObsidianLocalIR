import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { generateGuideOnly } from '../reading-guide-worker.mjs';
import { loadModule } from '../test/document-core-host.mjs';
import { SyntheticProducer } from '../../渐进阅读工作流/standard-preprocessing/test-support/synthetic-producer.mjs';
const require = createRequire(import.meta.url);
const { spawn } = require('node:child_process');
const guide = await loadModule('reading-guide.ts');
const live = process.argv.includes('--live');
const root = path.join('D:/Artifacts/ObsidianLocalIR/canaries', `guide-${live ? 'live' : 'offline'}-${randomUUID()}`);
const fixtures = [
  '# 分散练习\n\n分散练习把复习安排在不同日期，而不是在一天内重复完成。每次重新提取记忆都提供反馈，帮助学习者识别尚未掌握的内容。\n\n练习应先尝试回忆，再检查答案。答错并不意味着学习失败，及时获得解释可以修正错误。\n\n## 实施方法\n\n先记录概念和问题，再安排短时间复习。根据回忆情况调整下一次间隔，避免只重复已经熟悉的题目。\n',
  '# A reversible file update\r\n\r\nA safe update records the original hash before generating a candidate. If the source changes while generation is running, the application leaves it untouched.\r\n\r\nValidation checks the candidate before publication. The application stores a recoverable original and applies only the intended changes.\r\n\r\n```js\r\nconst changed = beforeHash !== currentHash;\r\nif (changed) throw new Error("source changed");\r\n```\r\n\r\nThis approach separates preparation from publication. A generated result is not proof that it has been installed or accepted by the running application.\r\n'
];
const reports = [];
for (const [index, source] of fixtures.entries()) {
  console.log(`guide ${live ? 'live' : 'offline'} case ${index + 1}: starting`);
  const parts = guide.splitGuideDocument(source);
  const input = { markdown: guide.guideBodyProjection(parts.body).text, title: `Synthetic guide ${index + 1}`,
    workflowRoot: 'D:/Projects/渐进阅读工作流', outputDir: path.join(root, `case-${index + 1}`), cacheDir: 'D:/Caches/ProgressiveReading/preprocess' };
  const producer = new SyntheticProducer();
  const generated = live ? await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', require('node:fs').readFileSync(new URL('../reading-guide-worker.mjs', import.meta.url), 'utf8')],
      { windowsHide: true, env: { ...process.env, LOCAL_IR_GUIDE_WORKER: '1' } });
    let stdout = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { stdout += data; });
    child.stderr.resume(); child.on('error', reject);
    child.on('exit', code => { try { const response = JSON.parse(stdout); if (code || !response.ok) reject(new Error(response.error)); else resolve(response.result); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(input));
  }) : await generateGuideOnly(input, { producer });
  assert.deepEqual(generated.stages, ['reading_guide']);
  if (!live) { assert.equal(producer.routingCalls, 0); assert.equal(producer.lastPayload.cleaning_policy.mode, 'semantic_only'); }
  const plan = guide.planReadingGuideUpdate(source, generated);
  const published = guide.applyGuideEdits(source, plan.edits);
  for (const edit of plan.edits) if (edit.from >= parts.bodyStart && edit.to > parts.bodyStart) assert.equal(edit.from, edit.to, 'body edits can only insert anchors');
  for (const target of published.matchAll(/\[\[#\^([A-Za-z0-9-]+)\|/g)) assert.ok(published.includes(`^${target[1]}`), 'guide link has a real target');
  const rerunParts = guide.splitGuideDocument(published);
  const projection = guide.guideBodyProjection(rerunParts.body).text;
  assert.equal(projection.replace(/\s/g, ''), guide.guideBodyProjection(parts.body).text.replace(/\s/g, ''), 'body words, code and punctuation unchanged');
  await fs.mkdir(input.outputDir, { recursive: true });
  await fs.writeFile(path.join(input.outputDir, 'source.md'), source);
  await fs.writeFile(path.join(input.outputDir, 'published.md'), published);
  reports.push({ case: index + 1, status: 'PASS', sourceSha256: guide.textHash(source), publishedSha256: guide.textHash(published), stages: generated.stages, calls: generated.calls, processorVersion: generated.processorVersion });
  console.log(`guide case ${index + 1}: PASS`);
}
const receipt = { status: 'PASS', live, syntheticOnly: true, reports };
await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...receipt, receipt: path.join(root, 'receipt.json') }, null, 2));
