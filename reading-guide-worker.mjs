// Embedded in main.js at build time; executed by local Node, without a service.
// All semantic production/validation remains in the existing standard workflow.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function generateGuideOnly(input, overrides = {}) {
  const api = overrides.api || await import(pathToFileURL(path.join(input.workflowRoot, 'standard-preprocessing/index.mjs')).href);
  const request = api.buildPreprocessRequest({ markdown: input.markdown, sourceType: 'local_ir_existing_markdown',
    materialId: input.materialId || undefined,
    sourceMetadata: { title: input.title, source_url: input.sourceUrl || null, original_url: input.originalUrl || null,
      // This stage consumes an already-prepared reading body. It never translates.
      translation: { is_translation: false, is_bilingual: false } },
    processingOptions: api.standardMarkdownOptions({ workflow_mode: 'single_stage', cleaning_mode: 'semantic_only',
      include_reading_guide: true, spoken_to_written: false, structure_body: false, translate: false,
      normalize_semantic_containers: false }) });
  const run = await api.runPreprocessingRequest(request, { outputDir: input.outputDir, cacheDir: input.cacheDir,
    skipCacheRead: true, ...(overrides.producer ? { producer: overrides.producer } : {}) });
  const result = run.result;
  if (!['completed', 'idempotent_replay'].includes(result?.status) || result.processing_state !== 'rendered' ||
    result.artifacts?.target_zone !== 'local-ir-reading' || !result.artifacts?.semantic?.judgments) {
    throw new Error(`guide_generation_failed:${result?.status || 'missing_result'}`);
  }
  const rendered = result.artifacts.reading_markdown;
  const start = rendered.indexOf('## 阅读前置卡\n');
  const end = rendered.indexOf('\n---\n\n## 正文\n', start);
  if (start < 0 || end < start) throw new Error('guide_output_boundary_missing');
  return { guide: rendered.slice(start, end).trim(), blocks: result.artifacts.body_blocks.map(block => ({
    id: block.block_id, markdown: block.markdown })), processorVersion: result.receipt.processor_version,
    stages: ['reading_guide'], calls: result.receipt.model.calls };
}

if (process.env.LOCAL_IR_GUIDE_WORKER === '1') {
  try {
    let source = '';
    for await (const chunk of process.stdin) {
      source += chunk;
      if (source.length > 16 * 1024 * 1024) throw new Error('article_too_large');
    }
    const result = await generateGuideOnly(JSON.parse(source));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    // No environment, credentials or raw provider response in stdout/UI.
    process.stdout.write(JSON.stringify({ ok: false, error: String(error.code || error.message || 'guide_generation_failed').split('\n')[0].slice(0, 180) }));
    process.exitCode = 1;
  }
}
