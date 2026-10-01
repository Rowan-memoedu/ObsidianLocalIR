

export type ReadingStatus = "inbox" | "reading" | "later" | "suspended" | "done" | "export_package_ready" | "archived";

export type MetricKey = "importance" | "urgency" | "difficulty" | "interest";

export type AnnotationType =
  | "highlight"
  | "comment"
  | "myth_truth"
  | "rebuttal"
  | "sample_quote"
  | "later"
  | "rewrite"
  | "refine"
  | "add_viewpoint"
  | "rebuttal_rewrite"
  | "question"
  | "optimize"
  | "example_viewpoint"
  | "qa_card";

export type AnnotationSourceFormat = "mark" | "legacy" | "virtual";

export type AnnotationRenderMode = "inline_mark" | "virtual_decoration";

export type ProtectedKind = "html_block" | "style_block" | "code_fence" | "math_block" | "link" | "image" | "mixed";

export type AnnotationMarkKind = "highlight" | "cloze";

export type AnnotationRoute = "remnote" | "remnote_card" | "codex_question_queue" | "refined_reading";

export type BilingualConfidence = "high" | "medium" | "low" | "none";

export type HierarchyScope = "selection" | "heading_subtree" | "list_subtree";

export type QaCardSource = "article" | "annotation";

export type ArticleMusingAiStatus = "pending" | "resolved" | "skipped";

export type PendingImportStatus = "pending" | "importing" | "failed";

export interface TextRange {
  start: number;
  end: number;
}

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface ProtectedRange extends TextRange {
  kind: ProtectedKind;
}

export interface NormalizedHighlightSelection {
  id: string;
  selectedText: string;
  fromOffset: number;
  toOffset: number;
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  renderMode: AnnotationRenderMode;
  sourceFormat: AnnotationSourceFormat;
  protectedKind: ProtectedKind | null;
  virtualRanges: TextRange[];
  overlappingIds: string[];
  beforeAnnotations: Record<string, AnnotationRecord | null>;
}

export interface MarkdownLine {
  index: number;
  text: string;
  start: number;
  end: number;
  breakEnd: number;
}

export interface HierarchyContext {
  scope: HierarchyScope;
  headingPath: string[];
  expandedText: string;
  expandedAnswerText: string;
  subtreeRange: TextRange | null;
}

export interface AnnotationFragment {
  index: number;
  text: string;
}

export interface AnnotationAnchor {
  sectionPath: string[];
  paragraphIndex: number | null;
  sourceOffset: number | null;
  contextBefore: string;
  contextAfter: string;
  contextHash: string;
  fragmentCount: number;
  crossedBlankLines: boolean;
}

export interface BilingualCandidate {
  index: number;
  text: string;
  score: number;
}

export interface BilingualMatch {
  detected: boolean;
  strategy: string;
  confidence: BilingualConfidence;
  chineseText: string;
  englishText: string;
  chineseParagraphIndex: number | null;
  englishParagraphIndex: number | null;
  candidates: BilingualCandidate[];
  warning: string | null;
  needsApiResolution: boolean;
}

export interface EditorSelection {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  fromOffset: number;
  toOffset: number;
  text: string;
}

export interface TextParagraph {
  index: number;
  text: string;
  start: number;
  end: number;
}

export interface BilingualSections {
  zh: { title: string; text: string; start: number; end: number } | null;
  en: { title: string; text: string; start: number; end: number } | null;
}

export interface MetricValues {
  importance: number;
  urgency: number;
  difficulty: number;
  interest: number;
}

export interface MetricWeights {
  importance: number;
  urgency: number;
  difficulty: number;
  interest: number;
}

export interface DocRecord {
  path: string;
  title: string;
  status: ReadingStatus;
  metrics: MetricValues;
  metricsEditedByUser: boolean;
  metricsBeforeExtreme?: MetricValues | null;
  readingPosition?: { cursor?: { line: number; ch: number }; scroll?: number; savedAt: string } | null;
  metricPresetCheckedMtime: number | null;
  priority: number;
  visitCount: number;
  lastVisited: string | null;
  deferUntil: string | null;
  archivedAt: string | null;
  archiveExportPath: string | null;
  archivePackagePath: string | null;
  archivePackageId: string | null;
  archivePackageRevision: number | null;
  archiveInputHash: string | null;
  exportPackageReadyAt: string | null;
  archiveAttemptCount: number;
  archiveLastError: string | null;
  archiveLastFailure: ArchiveFailureState | null;
  originalSourcePath: string | null;
  archivedSourcePath: string | null;
  movedIntoReadingPoolFromPath: string | null;
  movedIntoReadingPoolAt: string | null;
  removedFromReadingPoolAt: string | null;
  removedToPath: string | null;
  readingPathBeforeCompletion: string | null;
  completedSourcePath: string | null;
  completedAt: string | null;
  documentStateSidecarPath?: string | null;
  documentStateRevision?: number | null;
  documentStateUpdatedAt?: string | null;
  documentStateFingerprint?: string | null;
}

export interface ArchiveFailureState {
  code: string;
  kind: "blocked" | "failed";
  reasonCode: string | null;
  message: string;
  details: { errors: string[] };
  retryable: boolean;
  occurredAt: string | null;
}

export interface NoRemnoteContentPreflight {
  path: string;
  title: string;
  missingElementKinds: string[];
}

export interface AnnotationRecord {
  id: string;
  path: string;
  selectedText: string;
  sourceFormat: AnnotationSourceFormat;
  renderMode: AnnotationRenderMode;
  protectedKind: ProtectedKind | null;
  markKind: AnnotationMarkKind;
  originalText: string;
  currentText: string;
  type: AnnotationType;
  commentMarkdown: string;
  rewriteMarkdown: string;
  hasRewrite: boolean;
  rewriteApplied: boolean;
  orphaned: boolean;
  lastKnownPath: string;
  sourceOffset: number | null;
  range: TextRange | null;
  virtualRanges: TextRange[];
  lineRange: LineRange | null;
  anchor: AnnotationAnchor | null;
  fragments: AnnotationFragment[];
  scope: HierarchyScope;
  headingPath: string[];
  expandedText: string;
  expandedAnswerText: string;
  subtreeRange: TextRange | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface QaCardRecord {
  id: string;
  path: string;
  source: QaCardSource;
  sourceAnnotationId: string | null;
  questionMarkdown: string;
  answerMarkdown: string;
  answerSourceText: string;
  needsQuestionGeneration: boolean;
  needsAnswerGeneration: boolean;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ArticleMusingRecord {
  id: string;
  path: string;
  bodyMarkdown: string;
  aiStatus: ArticleMusingAiStatus;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface PendingImportRecord {
  id: string;
  url: string;
  normalizedUrl: string;
  sourcePath: string | null;
  status: PendingImportStatus;
  addedAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  attemptCount: number;
  lastError: string | null;
  brokerClientRequestId: string | null;
}

export interface LinkImportResult {
  ok: boolean;
  error: string | null;
}

export interface LinkImportBatchItem {
  requested_url: string;
  final_url?: string;
  status: "imported" | "imported_with_warnings" | "idempotent_replay" | "failed" | "requires_browser_auth" | "requires_js_render";
  receipt?: { quality_status?: "ready" | "warning" | "failed"; readable_with_warnings?: boolean; warning_codes?: string[] };
  error?: string;
  errors?: Array<{ code?: string; message?: string }>;
}

export interface LinkImportBatchResponse {
  status: "completed" | "completed_with_warnings" | "completed_with_failures" | "completed_with_degradations" | "requires_browser_auth" | "requires_js_render" | "degraded" | "failed";
  requested: number;
  imported: number;
  failed: number;
  degraded?: number;
  warnings?: number;
  concurrency: number;
  results: LinkImportBatchItem[];
}

export interface BrowserImportRequestResponse extends LinkImportBatchResponse {
  request_id: string;
  client_request_id?: string | null;
  terminal: boolean;
  active: number;
  queued: number;
}

export interface ArchiveAnnotationPayload {
  index: number;
  id: string;
  type: AnnotationType;
  typeLabel: string;
  route: AnnotationRoute;
  targetDocument: string | null;
  importable: boolean;
  highlightOnly: boolean;
  sourceFormat: AnnotationSourceFormat;
  renderMode: AnnotationRenderMode;
  protectedKind: ProtectedKind | null;
  markKind: AnnotationMarkKind;
  orphaned: boolean;
  rewriteApplied: boolean;
  originalText: string;
  currentText: string;
  commentMarkdown: string;
  rewriteMarkdown: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  anchor: AnnotationAnchor | null;
  range: TextRange | null;
  lineRange: LineRange | null;
  fragments: AnnotationFragment[];
  scope: HierarchyScope;
  headingPath: string[];
  expandedText: string;
  expandedAnswerText: string;
  subtreeRange: TextRange | null;
  bilingual: BilingualMatch;
}

export interface ArchiveClozeCardPayload {
  index: number;
  id: string;
  sourceAnnotationId: string;
  status: "pending" | "imported" | "failed";
  sourcePath: string;
  sourceTitle: string;
  scope: HierarchyScope;
  headingPath: string[];
  contextText: string;
  answerText: string;
  clozeMarkdown: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ArchiveQaCardPayload {
  index: number;
  id: string;
  source: QaCardSource;
  sourceAnnotationId: string | null;
  status: "pending" | "imported" | "failed";
  questionMarkdown: string;
  answerMarkdown: string;
  answerSourceText: string;
  needsQuestionGeneration: boolean;
  needsAnswerGeneration: boolean;
  headingPath: string[];
  scope: HierarchyScope;
  sourcePath: string;
  sourceTitle: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  cardMarkdown: string;
}

export interface ArchiveArticleMusingPayload {
  index: number;
  id: string;
  path: string;
  bodyMarkdown: string;
  aiStatus: ArticleMusingAiStatus;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface LocalIRSettings {
  settingsVersion: number;
  readingFolder: string;
  readingFolders: string[];
  activeReadingPoolFolder: string | null;
  preprocessingProjectPath: string;
  excludeVisitedToday: boolean;
  absolutePriorityProbability: number;
  defaultDeferDays: number;
  archiveFolder: string;
  sourceArchiveFolder: string;
  completedSourceFolder: string;
  removedReadingFolder: string;
  refinedReadingFolder: string;
  questionQueueFolder: string;
  linkImportFolder: string;
  documentStateFolder: string;
  processingModeEnabled: boolean;
  clozeModeEnabled: boolean;
  autoMergeHighlightsEnabled: boolean;
  alwaysVirtualHighlightsEnabled: boolean;
  autoOpenAnnotationModal: boolean;
  metricWeights: MetricWeights;
  records: Record<string, DocRecord>;
  annotations: Record<string, AnnotationRecord>;
  qaCards: Record<string, QaCardRecord>;
  articleMusings: Record<string, ArticleMusingRecord>;
  pendingImports: PendingImportRecord[];
}

export type RecentHighlightAction = RecentHighlightCreateAction | RecentHighlightMergeAction;

export interface RecentHighlightCreateAction {
  kind: "highlight";
  id: string;
  path: string;
  selectedText: string;
  wrappedText: string;
}

export interface RecentHighlightMergeAction {
  change?: any;
  kind: "merge";
  path: string;
  beforeContent: string;
  afterContent: string;
  beforeAnnotations: Record<string, AnnotationRecord | null>;
  mergedIds: string[];
}

export interface RecentVirtualHighlightRedoAction extends RecentHighlightMergeAction {
  afterAnnotations: Record<string, AnnotationRecord | null>;
}

export interface LegacyHighlight {
  id: string;
  path: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface MarkRange extends TextRange {
  id: string;
  fullText: string;
  innerText: string;
  markKind: AnnotationMarkKind;
}

export interface RepairedMarkGroup {
  id: string;
  markKind: AnnotationMarkKind;
  protectedKind: ProtectedKind;
  ranges: TextRange[];
}
