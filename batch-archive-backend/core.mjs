import { createHash } from "crypto";

export const MODULE_VERSION = "1.4.0";
export const INPUT_SCHEMA = "progressive-reading.local-ir-batch-archive-input/v1";
export const PACKAGE_SCHEMA = "progressive-reading.local-ir-export-package/v2";
export const PACKAGE_STATUS = "export_package_ready";
export const JOURNAL_SCHEMA = "progressive-reading.local-ir-batch-archive-journal/v1";

export class BatchArchiveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BatchArchiveError";
    this.code = code;
    this.details = details;
  }
}

export const NO_REMNOTE_CONTENT_CONFIRMATION_SCHEMA = "progressive-reading.no-remnote-content-confirmation/v1";
export const NO_REMNOTE_CONTENT_CONFIRMATION_ERROR = "zero RemNote import items require explicit noRemnoteContentConfirmation";
export const NO_REMNOTE_CONTENT_CONFIRMATION_REASON = "NO_REMNOTE_CONTENT_CONFIRMATION_REQUIRED";
export const ARCHIVE_ELEMENT_KINDS = ["annotations", "articleMusings", "cards", "clozeCards"];

export function normalizeBatchArchiveFailure(error, context = {}) {
  const code = safeDiagnosticText(error?.code, 80) || "UNEXPECTED_ERROR";
  const message = safeDiagnosticText(error instanceof Error ? error.message : error?.message ?? error, 500) || "Unknown batch archive package generation failure";
  const errors = Array.isArray(error?.details?.errors)
    ? error.details.errors.map((item) => safeDiagnosticText(item, 500)).filter(Boolean).slice(0, 20)
    : [];
  const missingConfirmation = code === "INPUT_VALIDATION_FAILED" && errors.includes(NO_REMNOTE_CONTENT_CONFIRMATION_ERROR);
  return {
    path: String(context.path || ""),
    title: String(context.title || context.path || ""),
    code,
    kind: missingConfirmation ? "blocked" : "failed",
    reasonCode: missingConfirmation ? NO_REMNOTE_CONTENT_CONFIRMATION_REASON : null,
    message,
    details: { errors },
    retryable: true,
    occurredAt: String(context.occurredAt || "") || null
  };
}

export function formatBatchArchiveFailure(failure) {
  const errors = Array.isArray(failure?.details?.errors) ? failure.details.errors.filter(Boolean) : [];
  if (failure?.reasonCode === NO_REMNOTE_CONTENT_CONFIRMATION_REASON || errors.includes(NO_REMNOTE_CONTENT_CONFIRMATION_ERROR)) {
    return `没有可写入 RemNote 的内容；需在 Obsidian 明确确认缺失项后才能生成导出包。[${NO_REMNOTE_CONTENT_CONFIRMATION_ERROR}]`;
  }
  return errors.length > 0 ? `${failure?.message || "导出包生成失败"}：[${errors.join("；")}]` : failure?.message || "导出包生成失败";
}

export function selectPendingRecords(records) {
  return [...(Array.isArray(records) ? records : [])]
    .filter((record) => record?.status === "done" && String(record?.path || "").trim())
    .sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
}

export async function runBatchArchive({ records, loadInput, io, clock = () => new Date(), onPrepared, onFailure, concurrency = "auto" }) {
  if (typeof loadInput !== "function") throw new BatchArchiveError("INVALID_ADAPTER", "loadInput adapter is required");
  assertIo(io);
  const candidates = selectPendingRecords(records);
  const workerCount = normalizeConcurrency(concurrency, candidates.length);
  const outcomes = new Array(candidates.length);
  let nextCandidateIndex = 0;
  const worker = async () => {
    while (nextCandidateIndex < candidates.length) {
      const candidateIndex = nextCandidateIndex;
      nextCandidateIndex += 1;
      const candidate = candidates[candidateIndex];
      outcomes[candidateIndex] = await processBatchCandidate(candidate);
    }
  };
  const processBatchCandidate = async (candidate) => {
    try {
      const rawInput = await loadInput(candidate.path);
      const result = await prepareExportPackage({ input: rawInput, io, clock });
      if (onPrepared) await onPrepared(candidate.path, result);
      return { type: "prepared", value: result };
    } catch (error) {
      const failure = normalizeBatchArchiveFailure(error, {
        path: candidate.path,
        title: candidate.title || candidate.path,
        occurredAt: clock().toISOString()
      });
      if (onFailure) await onFailure(candidate.path, failure);
      return { type: "failed", value: failure };
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const prepared = outcomes.filter((outcome) => outcome?.type === "prepared").map((outcome) => outcome.value);
  const failed = outcomes.filter((outcome) => outcome?.type === "failed").map((outcome) => outcome.value);
  return {
    status: failed.length === 0 ? "completed" : prepared.length > 0 ? "completed_with_failures" : "failed",
    selected: candidates.length,
    concurrency: workerCount,
    prepared: prepared.length,
    idempotentReplays: prepared.filter((item) => item.idempotentReplay).length,
    failed: failed.length,
    results: prepared,
    failures: failed
  };
}

function normalizeConcurrency(value, candidateCount) {
  if (candidateCount === 0) return 0;
  if (value === "auto" || value === undefined || value === null) return candidateCount;
  const requested = Number(value);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new BatchArchiveError("INVALID_CONCURRENCY", "concurrency must be a positive integer");
  }
  return Math.min(requested, candidateCount);
}

export async function prepareExportPackage({ input: rawInput, io, clock = () => new Date() }) {
  assertIo(io);
  const input = normalizeInput(rawInput);
  const validationErrors = validateFrozenInput(input);
  if (validationErrors.length > 0) {
    throw new BatchArchiveError("INPUT_VALIDATION_FAILED", "批量归档输入未通过生产者校验", { errors: validationErrors });
  }

  const packageId = stablePackageId(input.record.originalSourcePath || input.record.path);
  const existingPackage = await readJsonIfExists(io, input.paths.packageJsonPath);
  if (existingPackage && existingPackage.packageId !== packageId) {
    throw new BatchArchiveError("PATH_CONFLICT", `导出包路径已被其他 package 占用：${input.paths.packageJsonPath}`, {
      expectedPackageId: packageId,
      actualPackageId: existingPackage.packageId || null
    });
  }

  const frozen = createFrozenSnapshot(input, packageId);
  const inputHash = sha256(canonicalJson(frozen));
  if (
    existingPackage?.schema === PACKAGE_SCHEMA &&
    existingPackage?.status === PACKAGE_STATUS &&
    existingPackage?.producer?.inputHash === inputHash
  ) {
    const errors = validateExportPackage(existingPackage);
    if (errors.length > 0) {
      throw new BatchArchiveError("EXISTING_PACKAGE_INVALID", "已存在的同输入导出包未通过校验", { errors });
    }
    return summarizePrepared(existingPackage, input, true);
  }

  const priorRevision = Number.isInteger(existingPackage?.packageRevision) ? existingPackage.packageRevision : 0;
  const packageRevision = priorRevision + 1;
  const preparedAt = clock().toISOString();
  const snapshotPath = hiddenAuditPath(input.paths.packageJsonPath, `${packageId}.r${packageRevision}.input.json`);
  const journalPath = hiddenAuditPath(input.paths.packageJsonPath, `${packageId}.state.json`);
  const bundle = buildExportBundle({ input, packageId, packageRevision, inputHash, preparedAt, snapshotPath });
  const packageErrors = validateExportPackage(bundle.package);
  if (packageErrors.length > 0) {
    throw new BatchArchiveError("PACKAGE_VALIDATION_FAILED", "native-v2 导出包未通过生产者校验", { errors: packageErrors });
  }

  const ownedByPriorAttempt = await isOwnedSnapshot(io, snapshotPath, packageId, inputHash);
  await guardOutputPaths(io, bundle.files, {
    allowReplace: Boolean(existingPackage?.packageId === packageId || ownedByPriorAttempt)
  });

  await io.writeAtomic(journalPath, `${JSON.stringify({
    schema: JOURNAL_SCHEMA,
    moduleVersion: MODULE_VERSION,
    packageId,
    packageRevision,
    inputHash,
    status: "writing",
    sourcePath: input.record.path,
    packagePath: input.paths.packageJsonPath,
    noRemnoteContentConfirmation: input.noRemnoteContentConfirmation,
    startedAt: preparedAt
  }, null, 2)}\n`);

  await io.writeAtomic(snapshotPath, `${JSON.stringify({
    ...frozen,
    inputHash,
    packageRevision,
    frozenAt: preparedAt
  }, null, 2)}\n`);

  for (const file of bundle.files.filter((item) => item.role !== "package" && item.role !== "snapshot")) {
    await io.writeAtomic(file.path, file.content);
  }
  const packageFile = bundle.files.find((item) => item.role === "package");
  await io.writeAtomic(packageFile.path, packageFile.content);
  await io.writeAtomic(journalPath, `${JSON.stringify({
    schema: JOURNAL_SCHEMA,
    moduleVersion: MODULE_VERSION,
    packageId,
    packageRevision,
    inputHash,
    status: PACKAGE_STATUS,
    sourcePath: input.record.path,
    packagePath: input.paths.packageJsonPath,
    snapshotPath,
    noRemnoteContentConfirmation: input.noRemnoteContentConfirmation,
    completedAt: preparedAt
  }, null, 2)}\n`);

  return summarizePrepared(bundle.package, input, false);
}

export function buildExportBundle({ input, packageId, packageRevision, inputHash, preparedAt, snapshotPath }) {
  const annotations = input.annotations.map(stripPrematureArchiveFlags);
  const cards = input.cards.map(stripPrematureArchiveFlags);
  const clozeCards = input.clozeCards.map(stripPrematureArchiveFlags);
  const articleMusings = input.articleMusings.map(stripPrematureArchiveFlags);
  const refinedAnnotations = annotations.filter((item) => item.route === "refined_reading" && item.markKind !== "cloze");
  const questionAnnotations = annotations.filter((item) => item.route === "codex_question_queue" || item.type === "question");
  const packageObject = {
    schema: PACKAGE_SCHEMA,
    packageId,
    packageRevision,
    status: PACKAGE_STATUS,
    title: input.record.title,
    sourcePath: input.record.path,
    source: input.source,
    localArchive: {
      state: PACKAGE_STATUS,
      sourcePath: input.record.path,
      archivedSourcePath: input.record.archivedSourcePath,
      ...(input.noRemnoteContentConfirmation ? { noRemnoteContentConfirmation: input.noRemnoteContentConfirmation } : {})
    },
    exportPackageReadyAt: preparedAt,
    markdownExportPath: input.paths.markdownExportPath,
    refinedReadingPath: refinedAnnotations.length > 0 ? input.paths.refinedReadingPath : null,
    questionQueueJsonPath: questionAnnotations.length > 0 ? input.paths.questionQueueJsonPath : null,
    questionQueueMarkdownPath: questionAnnotations.length > 0 ? input.paths.questionQueueMarkdownPath : null,
    producer: {
      module: "batch-archive-backend",
      moduleVersion: MODULE_VERSION,
      inputSchema: INPUT_SCHEMA,
      inputHash,
      snapshotPath
    },
    counts: {
      totalAnnotations: annotations.length,
      remnoteAnnotations: annotations.filter((item) => item.route === "remnote").length,
      refinedReadingAnnotations: refinedAnnotations.length,
      questionQueueAnnotations: questionAnnotations.length,
      derivedQaAnnotations: annotations.filter((item) => item.route === "remnote_card" || item.type === "qa_card").length,
      qaCards: cards.length,
      clozeCards: clozeCards.length,
      articleMusings: articleMusings.length
    },
    annotations,
    cards,
    clozeCards,
    articleMusings
  };

  const files = [
    { role: "snapshot", path: snapshotPath, content: "" },
    { role: "markdown", path: input.paths.markdownExportPath, content: renderHumanExport(packageObject) }
  ];
  if (refinedAnnotations.length > 0) {
    files.push({ role: "refined_reading", path: input.paths.refinedReadingPath, content: renderRefinedReading(packageObject, refinedAnnotations) });
  }
  if (questionAnnotations.length > 0) {
    files.push({ role: "question_json", path: input.paths.questionQueueJsonPath, content: renderQuestionQueueJson(packageObject, questionAnnotations) });
    files.push({ role: "question_markdown", path: input.paths.questionQueueMarkdownPath, content: renderQuestionQueueMarkdown(packageObject, questionAnnotations) });
  }
  files.push({ role: "package", path: input.paths.packageJsonPath, content: `${JSON.stringify(packageObject, null, 2)}\n` });
  return { package: packageObject, files };
}

export function validateFrozenInput(input) {
  const errors = [];
  if (input?.schema !== INPUT_SCHEMA) errors.push(`schema must be ${INPUT_SCHEMA}`);
  if (input?.record?.status !== "done") errors.push("record.status must be done");
  if (!input?.record?.path) errors.push("record.path is required");
  if (!input?.record?.title) errors.push("record.title is required");
  if (!input?.record?.archivedSourcePath) errors.push("record.archivedSourcePath is required");
  if (!input?.source?.materialType) errors.push("source.materialType is required");
  if (!input?.source?.format) errors.push("source.format is required");
  for (const [name, value] of Object.entries(input?.paths || {})) {
    if (!value) errors.push(`paths.${name} is required`);
    else if (isUnsafeVaultPath(value)) errors.push(`paths.${name} must be vault-relative and cannot traverse parents`);
  }
  const pathValues = Object.values(input?.paths || {}).filter(Boolean);
  if (new Set(pathValues).size !== pathValues.length) errors.push("output paths must be unique");
  for (const [kind, items] of Object.entries({ annotations: input.annotations, cards: input.cards, clozeCards: input.clozeCards, articleMusings: input.articleMusings })) {
    if (!Array.isArray(items)) {
      errors.push(`${kind} must be an array`);
      continue;
    }
    const ids = new Set();
    for (const item of items) {
      if (!String(item?.id || "").trim()) errors.push(`${kind} item id is required`);
      else if (ids.has(item.id)) errors.push(`${kind} contains duplicate id: ${item.id}`);
      else ids.add(item.id);
    }
  }
  for (const annotation of input?.annotations || []) {
    const route = annotation?.route;
    if (route === "remnote") {
      if (!annotation.importable || !annotation.targetDocument) errors.push(`annotation ${annotation.id} remnote route is incomplete`);
    } else if (route === "refined_reading") {
      if (!input?.paths?.refinedReadingPath) errors.push(`annotation ${annotation.id} requires refinedReadingPath`);
    } else if (route === "codex_question_queue") {
      if (!input?.paths?.questionQueueJsonPath && !input?.paths?.questionQueueMarkdownPath) errors.push(`annotation ${annotation.id} requires question queue artifact`);
    } else if (route === "remnote_card") {
      if (!(input?.cards || []).some((card) => card.sourceAnnotationId === annotation.id)) errors.push(`annotation ${annotation.id} requires linked derived QA card`);
    } else {
      errors.push(`annotation ${annotation.id} has unsupported route: ${route || "missing"}`);
    }
  }
  for (const card of input?.cards || []) {
    if (!String(card?.questionMarkdown || "").trim() || !String(card?.answerMarkdown || "").trim() || card?.needsQuestionGeneration || card?.needsAnswerGeneration) {
      errors.push(`QA card ${card.id} is unresolved`);
    }
  }
  for (const card of input?.clozeCards || []) {
    if (!String(card?.clozeMarkdown || "").trim()) errors.push(`cloze card ${card.id} is empty`);
  }
  for (const musing of input?.articleMusings || []) {
    if (!String(musing?.bodyMarkdown || "").trim()) errors.push(`article musing ${musing.id} is empty`);
  }
  if (countImportableRemnoteItems(input) === 0) {
    errors.push(...validateNoRemnoteContentConfirmation(input?.noRemnoteContentConfirmation, getMissingArchiveElementKinds(input)));
  }
  return errors;
}

export function validateExportPackage(pkg) {
  const errors = [];
  if (pkg?.schema !== PACKAGE_SCHEMA) errors.push(`schema must be ${PACKAGE_SCHEMA}`);
  if (!pkg?.packageId) errors.push("packageId is required");
  if (!Number.isInteger(pkg?.packageRevision) || pkg.packageRevision < 1) errors.push("packageRevision must be a positive integer");
  if (pkg?.status !== PACKAGE_STATUS) errors.push(`status must be ${PACKAGE_STATUS}`);
  if (!pkg?.title) errors.push("title is required");
  if (!pkg?.sourcePath || isUnsafeVaultPath(pkg.sourcePath)) errors.push("sourcePath must be a safe vault-relative path");
  if (pkg?.localArchive?.state !== PACKAGE_STATUS) errors.push(`localArchive.state must be ${PACKAGE_STATUS}`);
  for (const field of ["sourcePath", "archivedSourcePath"]) {
    if (!pkg?.localArchive?.[field] || isUnsafeVaultPath(pkg.localArchive[field])) errors.push(`localArchive.${field} must be a safe vault-relative path`);
  }
  for (const name of ["annotations", "cards", "clozeCards", "articleMusings"]) {
    if (!Array.isArray(pkg?.[name])) errors.push(`${name} must be an array`);
  }
  if (countImportableRemnoteItems(pkg) === 0) {
    errors.push(...validateNoRemnoteContentConfirmation(pkg?.localArchive?.noRemnoteContentConfirmation, getMissingArchiveElementKinds(pkg)));
  }
  if (containsPrematureArchiveFlag(pkg)) errors.push("package contains premature archived state");
  return errors;
}

export function countImportableRemnoteItems(value) {
  return (value?.annotations || []).filter((annotation) => annotation?.route === "remnote" && annotation?.importable && annotation?.targetDocument).length +
    (value?.cards || []).filter((card) => String(card?.questionMarkdown || "").trim() && String(card?.answerMarkdown || "").trim() && !card?.needsQuestionGeneration && !card?.needsAnswerGeneration).length +
    (value?.clozeCards || []).filter((card) => String(card?.clozeMarkdown || "").trim()).length +
    (value?.articleMusings || []).filter((musing) => String(musing?.bodyMarkdown || "").trim()).length;
}

export function getMissingArchiveElementKinds(value) {
  return ARCHIVE_ELEMENT_KINDS.filter((kind) => !Array.isArray(value?.[kind]) || value[kind].length === 0);
}

export function createNoRemnoteContentConfirmation(value, confirmedAt) {
  const missingElementKinds = getMissingArchiveElementKinds(value);
  if (missingElementKinds.length === 0) {
    throw new BatchArchiveError("INVALID_CONFIRMATION", "noRemnoteContentConfirmation requires at least one missing element kind");
  }
  return {
    schema: NO_REMNOTE_CONTENT_CONFIRMATION_SCHEMA,
    confirmed: true,
    confirmedAt: new Date(confirmedAt).toISOString(),
    missingElementKinds
  };
}

function validateNoRemnoteContentConfirmation(confirmation, expectedMissingKinds) {
  if (!confirmation) return [NO_REMNOTE_CONTENT_CONFIRMATION_ERROR];
  const errors = [];
  if (confirmation.schema !== NO_REMNOTE_CONTENT_CONFIRMATION_SCHEMA) errors.push(`noRemnoteContentConfirmation.schema must be ${NO_REMNOTE_CONTENT_CONFIRMATION_SCHEMA}`);
  if (confirmation.confirmed !== true) errors.push("noRemnoteContentConfirmation.confirmed must be true");
  if (!isIsoDateTime(confirmation.confirmedAt)) errors.push("noRemnoteContentConfirmation.confirmedAt must be an ISO date-time");
  const kinds = Array.isArray(confirmation.missingElementKinds) ? confirmation.missingElementKinds : [];
  if (kinds.length === 0) errors.push("noRemnoteContentConfirmation.missingElementKinds must be non-empty");
  if (kinds.some((kind) => !ARCHIVE_ELEMENT_KINDS.includes(kind))) errors.push("noRemnoteContentConfirmation.missingElementKinds contains an unsupported kind");
  if (new Set(kinds).size !== kinds.length) errors.push("noRemnoteContentConfirmation.missingElementKinds must be unique");
  if (JSON.stringify(kinds) !== JSON.stringify([...kinds].sort())) errors.push("noRemnoteContentConfirmation.missingElementKinds must be deterministically sorted");
  if (JSON.stringify(kinds) !== JSON.stringify(expectedMissingKinds)) errors.push("noRemnoteContentConfirmation.missingElementKinds must match the frozen input");
  return errors;
}

export function inferSourceDescriptor({ sourcePath = "", sourceContent = "" }) {
  const normalized = String(sourcePath).replaceAll("\\", "/").toLowerCase();
  const origin = extractOrigin(sourceContent);
  if (normalized.includes("youtube") || /youtube\.com|youtu\.be/i.test(origin || "")) return { materialType: "video_transcript", format: "youtube-transcript-markdown", origin };
  if (normalized.includes("/pdf/") || /source_(?:type|format):\s*["']?pdf/i.test(sourceContent)) return { materialType: "document", format: "pdf-derived-markdown", origin };
  if (normalized.includes("/word/") || /source_(?:type|format):\s*["']?(?:word|docx?)/i.test(sourceContent)) return { materialType: "document", format: "word-derived-markdown", origin };
  if (normalized.includes("/epub/") || /source_(?:type|format):\s*["']?epub/i.test(sourceContent)) return { materialType: "book", format: "epub-derived-markdown", origin };
  if (origin || normalized.includes("浏览器") || normalized.includes("微信") || normalized.includes("知乎")) return { materialType: "web_article", format: "web-markdown", origin };
  return { materialType: "markdown_document", format: "markdown", origin };
}

export function stablePackageId(sourcePath) {
  return `local-ir-${sha256(normalizePortable(sourcePath)).slice(0, 24)}`;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeInput(raw) {
  return {
    schema: raw?.schema || INPUT_SCHEMA,
    record: {
      path: normalizePortable(raw?.record?.path),
      originalSourcePath: normalizePortable(raw?.record?.originalSourcePath || raw?.record?.path),
      archivedSourcePath: normalizePortable(raw?.record?.archivedSourcePath),
      title: String(raw?.record?.title || "").trim(),
      status: raw?.record?.status,
      completedAt: raw?.record?.completedAt || null
    },
    source: {
      materialType: String(raw?.source?.materialType || ""),
      format: String(raw?.source?.format || ""),
      origin: raw?.source?.origin ? String(raw.source.origin) : null
    },
    sourceContentHash: raw?.sourceContentHash || sha256(raw?.sourceContent || ""),
    sourceContentBytes: Number.isInteger(raw?.sourceContentBytes) ? raw.sourceContentBytes : Buffer.byteLength(String(raw?.sourceContent || ""), "utf8"),
    paths: Object.fromEntries(Object.entries(raw?.paths || {}).map(([key, value]) => [key, normalizePortable(value)])),
    annotations: cloneArray(raw?.annotations),
    cards: cloneArray(raw?.cards),
    clozeCards: cloneArray(raw?.clozeCards),
    articleMusings: cloneArray(raw?.articleMusings),
    noRemnoteContentConfirmation: normalizeNoRemnoteContentConfirmation(raw?.noRemnoteContentConfirmation)
  };
}

function createFrozenSnapshot(input, packageId) {
  return {
    schema: INPUT_SCHEMA,
    moduleVersion: MODULE_VERSION,
    packageId,
    record: input.record,
    source: input.source,
    sourceContentHash: input.sourceContentHash,
    sourceContentBytes: input.sourceContentBytes,
    paths: input.paths,
    annotations: input.annotations.map(stripPrematureArchiveFlags),
    cards: input.cards.map(stripPrematureArchiveFlags),
    clozeCards: input.clozeCards.map(stripPrematureArchiveFlags),
    articleMusings: input.articleMusings.map(stripPrematureArchiveFlags),
    noRemnoteContentConfirmation: input.noRemnoteContentConfirmation
  };
}

function renderHumanExport(pkg) {
  const lines = [
    `# ${pkg.title}`,
    "",
    `- source path: ${pkg.sourcePath}`,
    `- final archive target: ${pkg.localArchive.archivedSourcePath}`,
    `- export package ready at: ${pkg.exportPackageReadyAt}`,
    `- status: ${PACKAGE_STATUS}`,
    "- 注意：本文件与 JSON 只证明导出包已准备，不证明 RemNote 正式归档成功。",
    "",
    "## 高亮加工",
    ""
  ];
  renderCollection(lines, pkg.annotations, (item) => [
    `### ${item.index || ""}. ${item.typeLabel || item.type || "annotation"}`.replace(". .", "."),
    "",
    `- id: ${item.id}`,
    `- route: ${item.route}`,
    item.targetDocument ? `- targetDocument: ${item.targetDocument}` : "",
    "",
    "**原文/当前文本**",
    "",
    blockquote(item.expandedText || item.currentText || item.originalText || ""),
    "",
    "**评论/结构化加工**",
    "",
    String(item.commentMarkdown || "_无评论_"),
    ""
  ]);
  lines.push("## 问答卡", "");
  renderCollection(lines, pkg.cards, (item) => [`### ${item.id}`, "", String(item.cardMarkdown || `${item.questionMarkdown}\n\n${item.answerMarkdown}`), ""]);
  lines.push("## 挖空卡", "");
  renderCollection(lines, pkg.clozeCards, (item) => [`### ${item.id}`, "", String(item.clozeMarkdown || ""), ""]);
  lines.push("## 文章随想", "");
  renderCollection(lines, pkg.articleMusings, (item) => [`### ${item.id}`, "", String(item.bodyMarkdown || ""), ""]);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderRefinedReading(pkg, annotations) {
  const lines = ["---", `source_path: \"${escapeYaml(pkg.sourcePath)}\"`, `source_title: \"${escapeYaml(pkg.title)}\"`, `export_package_ready_at: \"${pkg.exportPackageReadyAt}\"`, `status: ${PACKAGE_STATUS}`, "---", "", `# ${pkg.title}：精炼摘录`, ""];
  annotations.forEach((item, index) => lines.push(`## ${index + 1}`, "", String(item.expandedText || item.currentText || item.originalText || "").trim(), ""));
  return `${lines.join("\n").trim()}\n`;
}

function renderQuestionQueueJson(pkg, annotations) {
  return `${JSON.stringify({
    schema: "progressive-reading.codex-question-queue/v1",
    packageId: pkg.packageId,
    sourcePath: pkg.sourcePath,
    title: pkg.title,
    status: "pending",
    questions: annotations.map((item) => ({
      id: item.id,
      status: "pending",
      currentText: item.expandedText || item.currentText || item.originalText || "",
      originalText: item.originalText || "",
      questionMarkdown: item.commentMarkdown || "",
      bilingual: item.bilingual || null,
      sourcePath: pkg.sourcePath,
      sourceTitle: pkg.title,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    }))
  }, null, 2)}\n`;
}

function renderQuestionQueueMarkdown(pkg, annotations) {
  const lines = [`# ${pkg.title}：Codex 提问队列`, "", `- source path: ${pkg.sourcePath}`, `- package ID: ${pkg.packageId}`, "- status: pending", ""];
  annotations.forEach((item, index) => lines.push(`## 问题 ${index + 1}`, "", blockquote(item.expandedText || item.currentText || item.originalText || ""), "", String(item.commentMarkdown || "- 问题："), ""));
  return `${lines.join("\n").trim()}\n`;
}

async function guardOutputPaths(io, files, { allowReplace }) {
  for (const file of files.filter((item) => item.role !== "snapshot")) {
    if (!(await io.exists(file.path))) continue;
    const existing = await io.readText(file.path);
    if (existing === file.content || allowReplace) continue;
    throw new BatchArchiveError("PATH_CONFLICT", `派生产物路径已存在且不属于当前 package：${file.path}`, { role: file.role });
  }
}

async function isOwnedSnapshot(io, snapshotPath, packageId, inputHash) {
  const snapshot = await readJsonIfExists(io, snapshotPath);
  return snapshot?.packageId === packageId && snapshot?.inputHash === inputHash;
}

async function readJsonIfExists(io, path) {
  if (!(await io.exists(path))) return null;
  try {
    return JSON.parse(await io.readText(path));
  } catch (error) {
    throw new BatchArchiveError("INVALID_EXISTING_JSON", `已有 JSON 无法解析：${path}`, { message: error instanceof Error ? error.message : String(error) });
  }
}

function summarizePrepared(pkg, input, idempotentReplay) {
  return {
    path: input.record.path,
    title: input.record.title,
    status: PACKAGE_STATUS,
    packageId: pkg.packageId,
    packageRevision: pkg.packageRevision,
    inputHash: pkg.producer.inputHash,
    packagePath: input.paths.packageJsonPath,
    markdownExportPath: input.paths.markdownExportPath,
    archivedSourcePath: input.record.archivedSourcePath,
    preparedAt: pkg.exportPackageReadyAt,
    noRemnoteContentConfirmation: pkg.localArchive.noRemnoteContentConfirmation || null,
    idempotentReplay
  };
}

function stripPrematureArchiveFlags(value) {
  const result = structuredClone(value || {});
  delete result.archived;
  delete result.archivedAt;
  if (result.status === "archived") result.status = "pending";
  return result;
}

function containsPrematureArchiveFlag(value) {
  if (!value || typeof value !== "object") return false;
  if (value.status === "archived" || value.archived === true || value.archivedAt) return true;
  return Object.values(value).some(containsPrematureArchiveFlag);
}

function hiddenAuditPath(packagePath, fileName) {
  const parts = normalizePortable(packagePath).split("/");
  parts.pop();
  return [...parts, ".batch-archive", fileName].filter(Boolean).join("/");
}

function extractOrigin(markdown) {
  const text = String(markdown || "");
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const scope = frontmatter?.[1] || text.slice(0, 3000);
  const match = scope.match(/^(?:source_url|source-url|original_url|url|origin)\s*:\s*["']?([^\s"']+)["']?\s*$/im);
  return match?.[1] || null;
}

function normalizePortable(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function isUnsafeVaultPath(value) {
  const normalized = normalizePortable(value);
  return !normalized || /^[a-z]:\//i.test(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..");
}

function assertIo(io) {
  for (const name of ["exists", "readText", "writeAtomic"]) {
    if (typeof io?.[name] !== "function") throw new BatchArchiveError("INVALID_ADAPTER", `io.${name} adapter is required`);
  }
}

function cloneArray(value) {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function normalizeNoRemnoteContentConfirmation(value) {
  if (!value || typeof value !== "object") return null;
  return {
    schema: String(value.schema || ""),
    confirmed: value.confirmed === true,
    confirmedAt: String(value.confirmedAt || ""),
    missingElementKinds: Array.isArray(value.missingElementKinds) ? value.missingElementKinds.map(String) : []
  };
}

function isIsoDateTime(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(text)) return false;
  return !Number.isNaN(Date.parse(text));
}

function safeDiagnosticText(value, limit) {
  return String(value ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, limit);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function renderCollection(lines, items, render) {
  if (items.length === 0) {
    lines.push("暂无。", "");
    return;
  }
  for (const item of items) lines.push(...render(item));
}

function blockquote(value) {
  return String(value || "").split("\n").map((line) => `> ${line}`).join("\n");
}

function escapeYaml(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
