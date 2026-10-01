import {
  AbstractInputSuggest,
  App,
  Editor,
  FuzzySuggestModal,
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  editorInfoField,
  normalizePath,
  requestUrl
} from "obsidian";
import { Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { promises as fs } from "fs";
import { mapReadingText, readingSelectionOffsets, readingDecorationRanges } from "./reading-highlights";
import * as path from "path";
import LocalIrDocumentCore from "../渐进阅读工作流/document-core/index.mjs";
import { extractMarkdownHeadingsLinear, extractParagraphsLinear } from "./archive-text.mjs";
import {
  DEFAULT_METRIC_VALUE,
  MAX_METRIC_VALUE,
  inferMetricsEditedByUser,
  isDefaultMetricInitialization,
  metricLevelLabel,
  parseReadingMetricPreset,
  reconcileReadingMetricPreset,
  snapMetricValue
} from "./metric-presets";
import {
  comparePriorityRecords,
  findExtremePriorityRecord,
  isExtremePriorityMetrics
} from "./priority-scheduling";
import {
  getMarkdownBlockRangeAtOffset,
  isPlainRedoShortcut,
  isPlainUndoShortcut,
  isUndoableVirtualHighlightAction,
  isWholeBlockHighlightGesture
} from "./editor-gestures";
import {
  INPUT_SCHEMA as BATCH_ARCHIVE_INPUT_SCHEMA,
  PACKAGE_STATUS as EXPORT_PACKAGE_READY,
  countImportableRemnoteItems,
  createNoRemnoteContentConfirmation,
  formatBatchArchiveFailure,
  getMissingArchiveElementKinds,
  inferSourceDescriptor,
  normalizeBatchArchiveFailure,
  prepareExportPackage,
  runBatchArchive
} from "./batch-archive-backend/core.mjs";

const VIEW_TYPE_LOCAL_IR = "local-incremental-reading-view";
const localIrRefreshEffect = StateEffect.define<void>();

if (!LocalIrDocumentCore?.normalizeDocumentState) {
  throw new Error("Local IR document core is unavailable.");
}

type ReadingStatus = "inbox" | "reading" | "later" | "suspended" | "done" | "export_package_ready" | "archived";
type MetricKey = "importance" | "urgency" | "difficulty" | "interest";
type AnnotationType =
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
type AnnotationSourceFormat = "mark" | "legacy" | "virtual";
type AnnotationRenderMode = "inline_mark" | "virtual_decoration";
type ProtectedKind = "html_block" | "style_block" | "code_fence" | "math_block" | "link" | "image" | "mixed";
type AnnotationMarkKind = "highlight" | "cloze";
type AnnotationRoute = "remnote" | "remnote_card" | "codex_question_queue" | "refined_reading";
type BilingualConfidence = "high" | "medium" | "low" | "none";
type HierarchyScope = "selection" | "heading_subtree" | "list_subtree";
type QaCardSource = "article" | "annotation";
type ArticleMusingAiStatus = "pending" | "resolved" | "skipped";
type PendingImportStatus = "pending" | "importing" | "failed";

interface TextRange {
  start: number;
  end: number;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

interface ProtectedRange extends TextRange {
  kind: ProtectedKind;
}

interface NormalizedHighlightSelection {
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

interface MarkdownLine {
  index: number;
  text: string;
  start: number;
  end: number;
  breakEnd: number;
}

interface HierarchyContext {
  scope: HierarchyScope;
  headingPath: string[];
  expandedText: string;
  expandedAnswerText: string;
  subtreeRange: TextRange | null;
}

interface AnnotationFragment {
  index: number;
  text: string;
}

interface AnnotationAnchor {
  sectionPath: string[];
  paragraphIndex: number | null;
  sourceOffset: number | null;
  contextBefore: string;
  contextAfter: string;
  contextHash: string;
  fragmentCount: number;
  crossedBlankLines: boolean;
}

interface BilingualCandidate {
  index: number;
  text: string;
  score: number;
}

interface BilingualMatch {
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

interface EditorSelection {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  fromOffset: number;
  toOffset: number;
  text: string;
}

interface TextParagraph {
  index: number;
  text: string;
  start: number;
  end: number;
}

interface BilingualSections {
  zh: { title: string; text: string; start: number; end: number } | null;
  en: { title: string; text: string; start: number; end: number } | null;
}

interface MetricValues {
  importance: number;
  urgency: number;
  difficulty: number;
  interest: number;
}

interface MetricWeights {
  importance: number;
  urgency: number;
  difficulty: number;
  interest: number;
}

interface DocRecord {
  path: string;
  title: string;
  status: ReadingStatus;
  metrics: MetricValues;
  metricsEditedByUser: boolean;
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

interface ArchiveFailureState {
  code: string;
  kind: "blocked" | "failed";
  reasonCode: string | null;
  message: string;
  details: { errors: string[] };
  retryable: boolean;
  occurredAt: string | null;
}

interface NoRemnoteContentPreflight {
  path: string;
  title: string;
  missingElementKinds: string[];
}

interface AnnotationRecord {
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

interface QaCardRecord {
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

interface ArticleMusingRecord {
  id: string;
  path: string;
  bodyMarkdown: string;
  aiStatus: ArticleMusingAiStatus;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

interface PendingImportRecord {
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

interface LinkImportResult {
  ok: boolean;
  error: string | null;
}

interface LinkImportBatchItem {
  requested_url: string;
  final_url?: string;
  status: "imported" | "imported_with_warnings" | "idempotent_replay" | "failed" | "requires_browser_auth" | "requires_js_render";
  receipt?: { quality_status?: "ready" | "warning" | "failed"; readable_with_warnings?: boolean; warning_codes?: string[] };
  error?: string;
  errors?: Array<{ code?: string; message?: string }>;
}

interface LinkImportBatchResponse {
  status: "completed" | "completed_with_warnings" | "completed_with_failures" | "completed_with_degradations" | "requires_browser_auth" | "requires_js_render" | "degraded" | "failed";
  requested: number;
  imported: number;
  failed: number;
  degraded?: number;
  warnings?: number;
  concurrency: number;
  results: LinkImportBatchItem[];
}

interface BrowserImportRequestResponse extends LinkImportBatchResponse {
  request_id: string;
  client_request_id?: string | null;
  terminal: boolean;
  active: number;
  queued: number;
}

interface ArchiveAnnotationPayload {
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

interface ArchiveClozeCardPayload {
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

interface ArchiveQaCardPayload {
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

interface ArchiveArticleMusingPayload {
  index: number;
  id: string;
  path: string;
  bodyMarkdown: string;
  aiStatus: ArticleMusingAiStatus;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

interface LocalIRSettings {
  settingsVersion: number;
  readingFolder: string;
  readingFolders: string[];
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

type RecentHighlightAction = RecentHighlightCreateAction | RecentHighlightMergeAction;

interface RecentHighlightCreateAction {
  kind: "highlight";
  id: string;
  path: string;
  selectedText: string;
  wrappedText: string;
}

interface RecentHighlightMergeAction {
  change?: any;
  kind: "merge";
  path: string;
  beforeContent: string;
  afterContent: string;
  beforeAnnotations: Record<string, AnnotationRecord | null>;
  mergedIds: string[];
}

interface RecentVirtualHighlightRedoAction extends RecentHighlightMergeAction {
  afterAnnotations: Record<string, AnnotationRecord | null>;
}

interface LegacyHighlight {
  id: string;
  path: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

const DEFAULT_FOLDER = "00 Inbox/IR 工作台/00 原文队列";
const DEFAULT_ARCHIVE_FOLDER = "04 Projects/渐进阅读工作流/RemNote 导出队列";
const DEFAULT_SOURCE_ARCHIVE_FOLDER = "04 Projects/渐进阅读工作流/已归档原文";
const DEFAULT_COMPLETED_SOURCE_FOLDER = "04 Projects/渐进阅读工作流/待归档原文";
const DEFAULT_REMOVED_READING_FOLDER = "04 Projects/渐进阅读工作流/移出阅读池";
const DEFAULT_REFINED_READING_FOLDER = "04 Projects/渐进阅读工作流/阅读区/二次阅读";
const DEFAULT_QUESTION_QUEUE_FOLDER = "04 Projects/渐进阅读工作流/Codex 提问队列";
const DEFAULT_LINK_IMPORT_FOLDER = "04 Projects/渐进阅读工作流/阅读区/微信";
const DEFAULT_DOCUMENT_STATE_FOLDER = "04 Projects/渐进阅读工作流/.local-ir/browser-document-state";
const DOCUMENT_STATE_SUFFIX = ".browser-ir.json";
const LOCAL_IR_SERVICE_PORT_START = 37829;
const LOCAL_IR_SERVICE_PORT_END = 37849;

const DEFAULT_METRICS: MetricValues = {
  importance: DEFAULT_METRIC_VALUE,
  urgency: DEFAULT_METRIC_VALUE,
  difficulty: DEFAULT_METRIC_VALUE,
  interest: DEFAULT_METRIC_VALUE
};

const DEFAULT_WEIGHTS: MetricWeights = {
  importance: 40,
  urgency: 20,
  difficulty: 15,
  interest: 25
};

const METRIC_LABELS: Record<MetricKey, string> = {
  importance: "价值判断",
  urgency: "信息密度判断",
  difficulty: "难度",
  interest: "兴趣"
};

const STATUS_LABELS: Record<ReadingStatus, string> = {
  inbox: "待读",
  reading: "阅读中",
  later: "Later",
  suspended: "搁置",
  done: "待批量生成导出包",
  export_package_ready: "导出包已准备（尚未正式归档）",
  archived: "正式归档成功"
};

const ARCHIVE_ELEMENT_LABELS: Record<string, string> = {
  annotations: "批注",
  cards: "QA",
  clozeCards: "挖空",
  articleMusings: "随想"
};

const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  highlight: "仅高亮",
  comment: "普通评论",
  myth_truth: "迷思 / 真相",
  rebuttal: "反驳",
  sample_quote: "引用",
  later: "稍后处理",
  rewrite: "改写",
  refine: "精炼",
  add_viewpoint: "联想",
  rebuttal_rewrite: "反驳后改写",
  question: "提问",
  optimize: "优化",
  example_viewpoint: "例子与观点",
  qa_card: "问答卡"
};

const ANNOTATION_MODAL_TYPES: AnnotationType[] = ["comment", "myth_truth", "sample_quote", "add_viewpoint", "question", "optimize", "example_viewpoint", "qa_card"];

const VALID_STATUSES = new Set<ReadingStatus>(["inbox", "reading", "later", "suspended", "done", "export_package_ready", "archived"]);
const VALID_ANNOTATION_TYPES = new Set<AnnotationType>([
  "highlight",
  "comment",
  "myth_truth",
  "rebuttal",
  "sample_quote",
  "later",
  "rewrite",
  "refine",
  "add_viewpoint",
  "rebuttal_rewrite",
  "question",
  "optimize",
  "example_viewpoint",
  "qa_card"
]);
const PLUGIN_DATA_VERSION = 14;

const DEFAULT_SETTINGS: LocalIRSettings = {
  settingsVersion: PLUGIN_DATA_VERSION,
  readingFolder: DEFAULT_FOLDER,
  readingFolders: [DEFAULT_FOLDER],
  excludeVisitedToday: true,
  absolutePriorityProbability: 0.2,
  defaultDeferDays: 7,
  archiveFolder: DEFAULT_ARCHIVE_FOLDER,
  sourceArchiveFolder: DEFAULT_SOURCE_ARCHIVE_FOLDER,
  completedSourceFolder: DEFAULT_COMPLETED_SOURCE_FOLDER,
  removedReadingFolder: DEFAULT_REMOVED_READING_FOLDER,
  refinedReadingFolder: DEFAULT_REFINED_READING_FOLDER,
  questionQueueFolder: DEFAULT_QUESTION_QUEUE_FOLDER,
  linkImportFolder: DEFAULT_LINK_IMPORT_FOLDER,
  documentStateFolder: DEFAULT_DOCUMENT_STATE_FOLDER,
  processingModeEnabled: false,
  clozeModeEnabled: false,
  autoMergeHighlightsEnabled: false,
  alwaysVirtualHighlightsEnabled: true,
  autoOpenAnnotationModal: false,
  metricWeights: DEFAULT_WEIGHTS,
  records: {},
  annotations: {},
  qaCards: {},
  articleMusings: {},
  pendingImports: []
};

export default class LocalIncrementalReadingPlugin extends Plugin {
  settings: LocalIRSettings;
  recentHighlightActions: RecentHighlightAction[] = [];
  recentVirtualHighlightRedoActions: RecentVirtualHighlightRedoAction[] = [];
  reconcileTimers: Record<string, number | undefined> = {};
  manualMergeModeActive = false;
  manualMergePath: string | null = null;
  manualMergeIds: string[] = [];
  virtualRangeSaveTimer: number | undefined;
  pendingImportResumeTimer: number | undefined;
  sidecarFlushInProgress = false;
  batchArchiveInProgress = false;
  singleArchivePathsInProgress = new Set<string>();
  localIrServicePort: number | null = null;
  lastHandledActiveFilePath: string | null | undefined;
  readingHighlightTimer: number | undefined;

  async onload() {
    await this.loadSettings();
    this.lastHandledActiveFilePath = this.app.workspace.getActiveFile()?.path || null;
    console.log("Local Incremental Reading loaded", this.manifest.version);

    this.registerView(
      VIEW_TYPE_LOCAL_IR,
      (leaf) => new LocalIRView(leaf, this)
    );
    this.registerEditorExtension(createVirtualHighlightExtension(this));
    this.registerReadingHighlights();

    this.addRibbonIcon("list-checks", "Local Incremental Reading", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-local-incremental-reading",
      name: "Open Local Incremental Reading panel",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "continue-local-incremental-reading",
      name: "Continue incremental reading",
      callback: () => void this.continueReading()
    });

    this.addCommand({
      id: "undo-local-incremental-reading-highlight",
      name: "Undo last incremental reading highlight",
      callback: () => void this.undoRecentHighlight()
    });

    this.addCommand({
      id: "highlight-local-incremental-reading-selection",
      name: "Highlight selection for incremental reading",
      editorCallback: (editor, ctx) => void this.highlightSelection(editor, ctx.file, false)
    });

    this.registerDomEvent(document, "mouseup", (event) => {
      void this.handleEditorMouseup(event);
    });

    this.registerDomEvent(document, "click", (event) => {
      void this.handleAnnotationClick(event);
    });

    this.registerDomEvent(document, "keydown", (event) => {
      this.handleMergeKeyDown(event);
    });

    this.registerDomEvent(document, "keyup", (event) => {
      void this.handleMergeKeyUp(event);
    });

    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      if (!info.file) return;
      this.scheduleReconcile(info.file.path, editor.getValue());
    }));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      window.setTimeout(() => void this.handleActiveFileChange(), 0);
    }));
    this.registerEvent(this.app.workspace.on("url-menu", (menu, url) => {
      this.addUrlImportMenuItems(menu, url);
    }));
    this.register(() => window.clearTimeout(this.virtualRangeSaveTimer));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.handleVaultRename(file, oldPath);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      void this.handleVaultCreate(file);
    }));

    this.addSettingTab(new LocalIRSettingTab(this.app, this));
    await this.migrateLegacyDocumentStateSidecars();
    await this.importAvailableDocumentStateSidecars();
    this.register(() => window.clearTimeout(this.pendingImportResumeTimer));
    this.schedulePendingImportResume(1000);
  }

  async activateView() {
    await this.syncRecords();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LOCAL_IR);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Local IR: unable to open the sidebar view.");
      return;
    }

    await leaf.setViewState({ type: VIEW_TYPE_LOCAL_IR, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = await this.loadData();
    const previousVersion = Number(data?.settingsVersion || 0);
    const metricWeights = {
      ...DEFAULT_WEIGHTS,
      ...(data?.metricWeights || data?.weights || {})
    };
    const records: Record<string, DocRecord> = {};
    for (const [path, record] of Object.entries(data?.records || {})) {
      records[path] = normalizeRecord(path, record, metricWeights);
      if (previousVersion < 14 && records[path].status === "archived") {
        records[path].status = "export_package_ready";
        records[path].exportPackageReadyAt = records[path].archivedAt;
        records[path].archivedAt = null;
        records[path].archiveLastError = "legacy 0.7.19 package moved the source before a formal receipt; reconcile through formal archive before claiming archived";
      }
    }
    const annotations: Record<string, AnnotationRecord> = {};
    for (const [id, annotation] of Object.entries(data?.annotations || {})) {
      annotations[id] = normalizeAnnotation(id, annotation);
    }
    const qaCards: Record<string, QaCardRecord> = {};
    for (const [id, card] of Object.entries(data?.qaCards || {})) {
      qaCards[id] = normalizeQaCard(id, card);
    }
    const articleMusings: Record<string, ArticleMusingRecord> = {};
    for (const [id, musing] of Object.entries(data?.articleMusings || {})) {
      const normalized = normalizeArticleMusing(id, musing);
      articleMusings[normalized.path || id] = normalized;
    }
    const pendingImports = normalizePendingImports(data?.pendingImports);
    const readingFolders = normalizeReadingFolders(data?.readingFolders, data?.readingFolder);

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      settingsVersion: PLUGIN_DATA_VERSION,
      readingFolder: readingFolders[0],
      readingFolders,
      defaultDeferDays: clamp(data?.defaultDeferDays ?? DEFAULT_SETTINGS.defaultDeferDays, 1, 365),
      archiveFolder: normalizePath(data?.archiveFolder || DEFAULT_ARCHIVE_FOLDER),
      sourceArchiveFolder: normalizePath(data?.sourceArchiveFolder || DEFAULT_SOURCE_ARCHIVE_FOLDER),
      completedSourceFolder: normalizePath(data?.completedSourceFolder || DEFAULT_COMPLETED_SOURCE_FOLDER),
      removedReadingFolder: normalizePath(data?.removedReadingFolder || DEFAULT_REMOVED_READING_FOLDER),
      refinedReadingFolder: normalizePath(data?.refinedReadingFolder || DEFAULT_REFINED_READING_FOLDER),
      questionQueueFolder: normalizePath(data?.questionQueueFolder || DEFAULT_QUESTION_QUEUE_FOLDER),
      linkImportFolder: normalizePath(data?.linkImportFolder || DEFAULT_LINK_IMPORT_FOLDER),
      documentStateFolder: normalizePath(data?.documentStateFolder || DEFAULT_DOCUMENT_STATE_FOLDER),
      processingModeEnabled: Boolean(data?.processingModeEnabled),
      clozeModeEnabled: Boolean(data?.clozeModeEnabled),
      autoMergeHighlightsEnabled: Boolean(data?.autoMergeHighlightsEnabled),
      // v0.6.8 makes virtual annotations the default to avoid rewriting Markdown.
      alwaysVirtualHighlightsEnabled: previousVersion < PLUGIN_DATA_VERSION ? true : Boolean(data?.alwaysVirtualHighlightsEnabled),
      autoOpenAnnotationModal: previousVersion > 0 ? Boolean(data?.autoOpenAnnotationModal) : false,
      metricWeights,
      records,
      annotations,
      qaCards,
      articleMusings,
      pendingImports
    };
  }

  async saveSettings(options?: { flushDocumentStateSidecars?: boolean }) {
    await this.saveData(this.settings);
    if (options?.flushDocumentStateSidecars !== false) {
      await this.flushDocumentStateSidecars();
    }
  }

  getDocumentStateSidecarPath(markdownPath: string): string {
    const fileName = normalizePath(markdownPath).split("/").pop() || `document-${shortHash(markdownPath)}.md`;
    const folder = normalizePath(this.settings.documentStateFolder || DEFAULT_DOCUMENT_STATE_FOLDER);
    return normalizePath(`${folder}/${fileName}${DOCUMENT_STATE_SUFFIX}`);
  }

  getLegacyDocumentStateSidecarPath(markdownPath: string): string {
    return normalizePath(`${markdownPath}${DOCUMENT_STATE_SUFFIX}`);
  }

  async resolveDocumentStateSidecarPath(markdownPath: string): Promise<string | null> {
    const preferred = this.getDocumentStateSidecarPath(markdownPath);
    if (await this.app.vault.adapter.exists(preferred)) return preferred;
    const legacy = this.getLegacyDocumentStateSidecarPath(markdownPath);
    if (await this.app.vault.adapter.exists(legacy)) return legacy;
    return null;
  }

  async readDocumentStateSidecarAtPath(sidecarPath: string, fallbackMarkdownPath = ""): Promise<{ state: any; sidecarPath: string }> {
    const raw = await this.app.vault.adapter.read(sidecarPath);
    const parsed = JSON.parse(raw);
    const supported = parsed?.schema === LocalIrDocumentCore.DOCUMENT_STATE_SCHEMA || parsed?.schema_version === 1;
    if (!supported) throw new Error("Unsupported Local IR document state schema.");
    const documentPath = normalizePath(parsed?.document?.path || fallbackMarkdownPath);
    if (!documentPath) throw new Error("Local IR document state is missing document.path.");
    return {
      state: LocalIrDocumentCore.normalizeDocumentState(parsed, { path: documentPath }),
      sidecarPath: normalizePath(sidecarPath)
    };
  }

  async readDocumentStateSidecar(markdownPath: string): Promise<{ state: any; sidecarPath: string } | null> {
    const sidecarPath = await this.resolveDocumentStateSidecarPath(markdownPath);
    if (!sidecarPath) return null;
    return this.readDocumentStateSidecarAtPath(sidecarPath, markdownPath);
  }

  async migrateLegacyDocumentStateSidecars() {
    const adapter = this.app.vault.adapter;
    const candidatePaths = new Set([
      ...this.getPoolFiles().map((file) => file.path),
      ...Object.keys(this.settings.records)
    ]);
    let changed = false;
    for (const markdownPath of candidatePaths) {
      const legacyPath = this.getLegacyDocumentStateSidecarPath(markdownPath);
      if (!(await adapter.exists(legacyPath))) continue;
      const preferredPath = this.getDocumentStateSidecarPath(markdownPath);
      const preferredExists = await adapter.exists(preferredPath);
      if (!preferredExists) {
        const folder = preferredPath.split("/").slice(0, -1).join("/");
        if (folder) await this.ensureFolder(folder);
        await adapter.rename(legacyPath, preferredPath);
      } else {
        const legacy = await this.readDocumentStateSidecarAtPath(legacyPath, markdownPath);
        const preferred = await this.readDocumentStateSidecarAtPath(preferredPath, markdownPath);
        if (Number(legacy.state.document.revision || 0) > Number(preferred.state.document.revision || 0)) {
          await this.writeDocumentStateSidecarAtomic(preferredPath, `${JSON.stringify(legacy.state, null, 2)}\n`);
        }
        await adapter.remove(legacyPath);
      }
      const record = this.settings.records[markdownPath];
      if (record) record.documentStateSidecarPath = preferredPath;
      changed = true;
    }
    if (changed) await this.saveData(this.settings);
  }

  async importDocumentStateSidecar(file: TFile, explicitSidecarPath = ""): Promise<boolean> {
    const markdown = await this.app.vault.cachedRead(file);
    return this.importDocumentStateSidecarPath(file.path, explicitSidecarPath, markdown);
  }

  async importDocumentStateSidecarPath(markdownPathValue: string, explicitSidecarPath = "", providedMarkdown = ""): Promise<boolean> {
    const markdownPath = normalizePath(markdownPathValue);
    let loaded: { state: any; sidecarPath: string } | null;
    try {
      loaded = explicitSidecarPath
        ? await this.readDocumentStateSidecarAtPath(explicitSidecarPath, markdownPath)
        : await this.readDocumentStateSidecar(markdownPath);
    } catch (error) {
      console.error(`Local IR: invalid document state sidecar for ${markdownPath}`, error);
      return false;
    }
    if (!loaded) return false;
    const state = loaded.state;
    let markdown = providedMarkdown;
    if (!markdown) {
      try {
        markdown = await this.app.vault.adapter.read(markdownPath);
      } catch (error) {
        console.error(`Local IR: cannot read Markdown for document state ${markdownPath}`, error);
        return false;
      }
    }
    state.annotations = LocalIrDocumentCore.anchorAnnotationsToMarkdown(state.annotations, markdown, markdownPath);

    const record = this.settings.records[markdownPath];
    if (!record) return false;
    const fingerprint = LocalIrDocumentCore.comparableDocumentState(state);
    if (
      record.documentStateRevision === state.document.revision &&
      record.documentStateUpdatedAt === state.document.updatedAt &&
      record.documentStateFingerprint === fingerprint
    ) return false;

    for (const [id, annotation] of Object.entries(this.settings.annotations)) {
      if (annotation.path === markdownPath || annotation.lastKnownPath === markdownPath) delete this.settings.annotations[id];
    }
    for (const [id, card] of Object.entries(this.settings.qaCards)) {
      if (card.path === markdownPath) delete this.settings.qaCards[id];
    }
    delete this.settings.articleMusings[markdownPath];

    for (const annotation of state.annotations) {
      const normalized = normalizeAnnotation(annotation.id, { ...annotation, path: markdownPath, lastKnownPath: markdownPath });
      this.settings.annotations[normalized.id] = normalized;
    }
    for (const card of state.qaCards) {
      const normalized = normalizeQaCard(card.id, { ...card, path: markdownPath });
      this.settings.qaCards[normalized.id] = normalized;
    }
    if (state.articleMusing?.bodyMarkdown) {
      this.settings.articleMusings[markdownPath] = normalizeArticleMusing(markdownPath, {
        ...state.articleMusing,
        path: markdownPath
      });
    }

    record.title = state.document.title || record.title;
    record.status = normalizeStatus(state.document.status);
    record.deferUntil = record.status === "later" ? state.document.deferUntil || null : null;
    if (record.status === "done" && this.isPathInCompletedSourceFolder(markdownPath)) {
      record.completedSourcePath = markdownPath;
      record.completedAt = state.document.updatedAt || new Date().toISOString();
    }
    record.documentStateSidecarPath = loaded.sidecarPath;
    record.documentStateRevision = state.document.revision;
    record.documentStateUpdatedAt = state.document.updatedAt;
    record.documentStateFingerprint = fingerprint;
    return true;
  }

  async writeDocumentStateSidecarAtomic(sidecarPath: string, contents: string) {
    const adapter = this.app.vault.adapter as any;
    const normalizedSidecarPath = normalizePath(sidecarPath);
    const folder = normalizedSidecarPath.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);
    const basePath = typeof adapter.getBasePath === "function" ? String(adapter.getBasePath()) : "";
    if (!basePath) {
      await adapter.write(normalizedSidecarPath, contents);
      return;
    }

    const target = path.join(basePath, ...normalizedSidecarPath.split("/"));
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, "utf8");
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async flushDocumentStateSidecars() {
    if (this.sidecarFlushInProgress) return;
    this.sidecarFlushInProgress = true;
    let cacheChanged = false;
    try {
      for (const record of Object.values(this.settings.records)) {
        if (!record.documentStateSidecarPath) continue;
        let loaded: { state: any; sidecarPath: string } | null;
        try {
          loaded = await this.readDocumentStateSidecar(record.path);
        } catch (error) {
          console.error(`Local IR: cannot read document state sidecar for ${record.path}`, error);
          continue;
        }
        if (!loaded) continue;
        const current = loaded.state;
        record.documentStateSidecarPath = loaded.sidecarPath;

        const next = LocalIrDocumentCore.replaceDocumentCollections(current, {
          path: record.path,
          title: record.title,
          status: record.status,
          deferUntil: record.deferUntil,
          annotations: this.getAnnotationsForPath(record.path),
          qaCards: this.getQaCardsForPath(record.path),
          articleMusing: this.getArticleMusing(record.path)
        });
        if (LocalIrDocumentCore.comparableDocumentState(current) === LocalIrDocumentCore.comparableDocumentState(next)) {
          continue;
        }

        await this.writeDocumentStateSidecarAtomic(loaded.sidecarPath, `${JSON.stringify(next, null, 2)}\n`);
        record.documentStateRevision = next.document.revision;
        record.documentStateUpdatedAt = next.document.updatedAt;
        record.documentStateFingerprint = LocalIrDocumentCore.comparableDocumentState(next);
        cacheChanged = true;
      }
      if (cacheChanged) await this.saveData(this.settings);
    } finally {
      this.sidecarFlushInProgress = false;
    }
  }

  async handleActiveFileChange() {
    const file = this.app.workspace.getActiveFile();
    const activeFilePath = file?.path || null;
    if (activeFilePath === this.lastHandledActiveFilePath) return;
    this.lastHandledActiveFilePath = activeFilePath;
    if (file && this.isPathInReadingPool(file.path) && !this.settings.records[file.path]) {
      this.settings.records[file.path] = await this.createRecord(file);
      await this.saveSettings();
    }
    this.refreshVirtualHighlights(file?.path);
    await this.refreshViews();
  }

  async handleVaultCreate(file: unknown) {
    if (!(file instanceof TFile)) return;
    if (file.path.endsWith(DOCUMENT_STATE_SUFFIX)) {
      await this.handleDocumentStateSidecarArrival(file.path);
      return;
    }
    if (file.extension.toLowerCase() !== "md" || !this.isPathInReadingPool(file.path)) return;

    let changed = false;
    if (!this.settings.records[file.path]) {
      this.settings.records[file.path] = await this.createRecord(file);
      changed = true;
    } else if (await this.backfillRecordMetricPreset(file, this.settings.records[file.path])) {
      changed = true;
    }
    if (await this.importDocumentStateSidecar(file)) changed = true;
    if (changed) await this.saveSettings();
    await this.refreshViews();
  }

  async handleDocumentStateSidecarArrival(sidecarPath: string) {
    let loaded: { state: any; sidecarPath: string };
    try {
      loaded = await this.readDocumentStateSidecarAtPath(sidecarPath);
    } catch (error) {
      console.error(`Local IR: invalid arriving document state sidecar ${sidecarPath}`, error);
      return;
    }
    const markdownPath = normalizePath(loaded.state.document.path);
    const file = this.app.vault.getAbstractFileByPath(markdownPath);
    if (!markdownPath.toLowerCase().endsWith(".md") || !this.isImportableDocumentStatePath(markdownPath, loaded.state.document.status)) return;
    if (!(file instanceof TFile) && !(await this.app.vault.adapter.exists(markdownPath))) return;

    let changed = false;
    if (!this.settings.records[markdownPath]) {
      this.settings.records[markdownPath] = file instanceof TFile
        ? await this.createRecord(file)
        : normalizeRecord(markdownPath, { title: loaded.state.document.title, status: loaded.state.document.status }, this.settings.metricWeights);
      changed = true;
    }
    if (await this.importDocumentStateSidecarPath(markdownPath, loaded.sidecarPath)) changed = true;
    if (!changed) return;
    await this.saveSettings();
    this.refreshVirtualHighlights(markdownPath);
    await this.refreshViews();
  }

  async importAvailableDocumentStateSidecars() {
    const folder = normalizePath(this.settings.documentStateFolder || DEFAULT_DOCUMENT_STATE_FOLDER);
    let files: string[] = [];
    try {
      files = (await this.app.vault.adapter.list(folder)).files;
    } catch (error) {
      console.error(`Local IR: cannot enumerate document state folder ${folder}`, error);
      return;
    }
    const sidecars = files
      .map((file) => normalizePath(file))
      .filter((file) => file.endsWith(DOCUMENT_STATE_SUFFIX))
      .sort((a, b) => a.localeCompare(b));
    for (const sidecarPath of sidecars) {
      await this.handleDocumentStateSidecarArrival(sidecarPath);
    }
  }

  async setReadingFolder(folder: string) {
    const normalized = normalizePath(folder.trim() || DEFAULT_FOLDER);
    this.settings.readingFolders = uniqueNormalizedPaths([normalized]);
    this.settings.readingFolder = normalized;
    await this.saveSettings();
    await this.syncRecords();
    await this.refreshViews();
    new Notice(`阅读池已切换：${normalized}`);
  }

  async addReadingFolder(folder: string) {
    const normalized = normalizePath(folder.trim());
    if (!normalized || normalized === "/") {
      new Notice("请选择一个具体的阅读池文件夹。");
      return;
    }
    this.settings.readingFolders = uniqueNormalizedPaths([...this.getReadingFolders(), normalized]);
    this.settings.readingFolder = this.getPrimaryReadingFolder();
    await this.saveSettings();
    await this.syncRecords();
    await this.refreshViews();
    new Notice(`已加入阅读池：${normalized}`);
  }

  async removeReadingFolder(folder: string) {
    const normalized = normalizePath(folder.trim());
    const nextFolders = this.getReadingFolders().filter((item) => item !== normalized);
    this.settings.readingFolders = nextFolders.length > 0 ? nextFolders : [DEFAULT_FOLDER];
    this.settings.readingFolder = this.getPrimaryReadingFolder();
    await this.saveSettings();
    await this.syncRecords();
    await this.refreshViews();
    new Notice(`已移除阅读池文件夹：${normalized}`);
  }

  async setPrimaryReadingFolder(folder: string) {
    const normalized = normalizePath(folder.trim());
    const folders = this.getReadingFolders().filter((item) => item !== normalized);
    this.settings.readingFolders = uniqueNormalizedPaths([normalized, ...folders]);
    this.settings.readingFolder = this.getPrimaryReadingFolder();
    await this.saveSettings();
    await this.syncRecords();
    await this.refreshViews();
    new Notice(`第一阅读池已设为：${normalized}`);
  }

  getReadingFolders(): string[] {
    const folders = normalizeReadingFolders(this.settings.readingFolders, this.settings.readingFolder);
    this.settings.readingFolders = folders;
    this.settings.readingFolder = folders[0];
    return folders;
  }

  getPrimaryReadingFolder(): string {
    return this.getReadingFolders()[0] || DEFAULT_FOLDER;
  }

  getActiveFolderPath(): string | null {
    const file = this.app.workspace.getActiveFile();
    if (!file?.parent) return null;
    return file.parent.path || "/";
  }

  async moveActiveFileToReadingPool() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      new Notice("当前没有打开的 Markdown 文件。");
      return;
    }

    await this.moveFileToReadingPool(file, false);
  }

  async moveFileToReadingPool(file: TFile, silent: boolean): Promise<TFile | null> {
    const folder = this.getPrimaryReadingFolder();
    if (!folder || folder === "/") {
      new Notice("请先设置一个具体的阅读池文件夹。");
      return null;
    }

    if (this.isFileInReadingPool(file)) {
      if (!this.settings.records[file.path]) {
        this.settings.records[file.path] = await this.createRecord(file);
        await this.saveSettings();
      }
      await this.refreshViews();
      if (!silent) new Notice("当前文件已经在阅读池中。");
      return file;
    }

    await this.ensureFolder(folder);
    const oldPath = file.path;
    const targetPath = this.getUniquePathInFolder(folder, file);
    const existingRecord = this.settings.records[oldPath] || null;
    await this.app.fileManager.renameFile(file, targetPath);
    const moved = this.app.vault.getAbstractFileByPath(targetPath);

    if (moved instanceof TFile) {
      if (existingRecord) {
        delete this.settings.records[oldPath];
        this.settings.records[targetPath] = {
          ...existingRecord,
          path: targetPath,
          title: this.getTitle(moved),
          status: existingRecord.status === "archived" || existingRecord.status === "export_package_ready" ? "reading" : existingRecord.status === "done" || existingRecord.removedFromReadingPoolAt ? "reading" : existingRecord.status,
          completedSourcePath: null,
          completedAt: null,
          readingPathBeforeCompletion: null,
          movedIntoReadingPoolFromPath: existingRecord.movedIntoReadingPoolFromPath || oldPath,
          movedIntoReadingPoolAt: existingRecord.movedIntoReadingPoolAt || new Date().toISOString(),
          removedFromReadingPoolAt: null,
          removedToPath: null
        };
      } else {
        this.settings.records[targetPath] = {
          ...(await this.createRecord(moved)),
          movedIntoReadingPoolFromPath: oldPath,
          movedIntoReadingPoolAt: new Date().toISOString()
        };
      }

      this.updateLinkedPaths(oldPath, targetPath);

      await this.saveSettings();
      await this.syncRecords();
      await this.openRecord(targetPath, false);
      await this.refreshViews();
      if (!silent) new Notice(`已放入阅读池：${targetPath}`);
      return moved;
    }
    return null;
  }

  async ensureFileInReadingPool(file: TFile): Promise<TFile | null> {
    if (this.isFileInReadingPool(file)) {
      if (!this.settings.records[file.path]) {
        this.settings.records[file.path] = await this.createRecord(file);
        await this.saveSettings();
      }
      return file;
    }
    return this.moveFileToReadingPool(file, true);
  }

  async moveActiveFileOutOfReadingPool() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      new Notice("当前没有打开的 Markdown 文件。");
      return;
    }
    const record = this.settings.records[file.path] || await this.createRecord(file);
    if (!this.isPathInReadingPool(file.path)) {
      new Notice("当前文件不在阅读池中。");
      return;
    }

    const targetPath = this.getRemoveFromReadingTargetPath(record);
    const movedPath = await this.moveVaultFilePath(file.path, targetPath);
    if (!movedPath) {
      new Notice("移出阅读池失败：找不到当前文件。");
      return;
    }
    if (movedPath !== file.path) {
      delete this.settings.records[file.path];
      this.updateLinkedPaths(file.path, movedPath);
    }
    this.settings.records[movedPath] = {
      ...record,
      path: movedPath,
      status: "suspended",
      deferUntil: null,
      removedFromReadingPoolAt: new Date().toISOString(),
      removedToPath: movedPath
    };
    await this.saveSettings();
    await this.openRecord(movedPath, false);
    await this.refreshViews();
    new Notice(`已移出阅读池：${movedPath}`);
  }

  getUniquePathInFolder(folder: string, file: TFile): string {
    const extension = file.extension ? `.${file.extension}` : "";
    const baseName = file.basename || file.name.replace(/\.[^.]+$/, "");
    let candidate = normalizePath(`${folder}/${file.name}`);
    if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;

    for (let index = 2; index < 1000; index += 1) {
      candidate = normalizePath(`${folder}/${baseName} ${index}${extension}`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return normalizePath(`${folder}/${baseName} ${Date.now()}${extension}`);
  }

  getUniqueVaultPath(targetPath: string): string {
    const normalized = normalizePath(targetPath);
    if (!this.app.vault.getAbstractFileByPath(normalized)) return normalized;

    const parts = normalized.split("/");
    const fileName = parts.pop() || "untitled.md";
    const folder = parts.join("/");
    const dotIndex = fileName.lastIndexOf(".");
    const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";

    for (let index = 2; index < 1000; index += 1) {
      const candidate = normalizePath(`${folder ? `${folder}/` : ""}${baseName} ${index}${extension}`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return normalizePath(`${folder ? `${folder}/` : ""}${baseName} ${Date.now()}${extension}`);
  }

  getVaultFolders(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  isFileInReadingPool(file: TFile): boolean {
    return this.isPathInReadingPool(file.path);
  }

  isPathInReadingPool(pathValue: string): boolean {
    const folders = this.getReadingFolders();
    const path = normalizePath(pathValue);
    return folders.some((folder) => Boolean(folder) && (path === folder || path.startsWith(`${folder}/`)));
  }

  isPathInCompletedSourceFolder(pathValue: string): boolean {
    const folder = normalizePath(this.settings.completedSourceFolder || DEFAULT_COMPLETED_SOURCE_FOLDER);
    const path = normalizePath(pathValue);
    return Boolean(folder) && (path === folder || path.startsWith(`${folder}/`));
  }

  isImportableDocumentStatePath(pathValue: string, status: unknown): boolean {
    return this.isPathInReadingPool(pathValue)
      || (normalizeStatus(status) === "done" && this.isPathInCompletedSourceFolder(pathValue));
  }

  updateLinkedPaths(oldPath: string, newPath: string) {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    if (normalizedOldPath === normalizedNewPath) return;

    for (const annotation of Object.values(this.settings.annotations)) {
      if (annotation.path === normalizedOldPath) annotation.path = normalizedNewPath;
      if (annotation.lastKnownPath === normalizedOldPath) annotation.lastKnownPath = normalizedNewPath;
    }
    for (const card of Object.values(this.settings.qaCards)) {
      if (card.path === normalizedOldPath) card.path = normalizedNewPath;
    }
    const musing = this.settings.articleMusings[normalizedOldPath];
    if (musing) {
      delete this.settings.articleMusings[normalizedOldPath];
      this.settings.articleMusings[normalizedNewPath] = {
        ...musing,
        path: normalizedNewPath,
        updatedAt: new Date().toISOString()
      };
    }
    for (const item of this.settings.pendingImports) {
      if (item.sourcePath === normalizedOldPath) {
        item.sourcePath = normalizedNewPath;
        item.updatedAt = new Date().toISOString();
      }
    }
  }

  async handleVaultRename(file: unknown, oldPath: string) {
    if (!(file instanceof TFile)) return;
    if (file.path.endsWith(DOCUMENT_STATE_SUFFIX)) {
      await this.handleDocumentStateSidecarArrival(file.path);
      return;
    }
    if (file.extension.toLowerCase() !== "md") return;
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(file.path);
    if (normalizedOldPath === normalizedNewPath) return;
    const existingRecord = this.settings.records[normalizedOldPath];
    const hasLinkedData = Boolean(
      existingRecord ||
      Object.values(this.settings.annotations).some((annotation) => annotation.path === normalizedOldPath || annotation.lastKnownPath === normalizedOldPath) ||
      Object.values(this.settings.qaCards).some((card) => card.path === normalizedOldPath) ||
      this.settings.articleMusings[normalizedOldPath] ||
      this.settings.pendingImports.some((item) => item.sourcePath === normalizedOldPath)
    );
    if (!hasLinkedData) return;

    const oldSidecarPath = this.getDocumentStateSidecarPath(normalizedOldPath);
    const newSidecarPath = this.getDocumentStateSidecarPath(normalizedNewPath);
    let sidecarMoved = oldSidecarPath === newSidecarPath && await this.app.vault.adapter.exists(oldSidecarPath);
    if (oldSidecarPath !== newSidecarPath && await this.app.vault.adapter.exists(oldSidecarPath)) {
      if (await this.app.vault.adapter.exists(newSidecarPath)) {
        console.error(`Local IR: sidecar rename conflict: ${newSidecarPath}`);
      } else {
        await this.app.vault.adapter.rename(oldSidecarPath, newSidecarPath);
        sidecarMoved = true;
      }
    }

    if (existingRecord) {
      delete this.settings.records[normalizedOldPath];
      this.settings.records[normalizedNewPath] = normalizeRecord(normalizedNewPath, {
        ...existingRecord,
        path: normalizedNewPath,
        title: this.getTitle(file)
      }, this.settings.metricWeights);
      if (existingRecord.documentStateSidecarPath) {
        this.settings.records[normalizedNewPath].documentStateSidecarPath = sidecarMoved ? newSidecarPath : null;
      }
    }
    this.updateLinkedPaths(normalizedOldPath, normalizedNewPath);
    await this.saveSettings();
    await this.refreshViews();
  }

  async moveVaultFilePath(oldPath: string, targetPath: string): Promise<string | null> {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedTargetPath = normalizePath(targetPath);
    const file = this.app.vault.getAbstractFileByPath(normalizedOldPath);
    if (!(file instanceof TFile)) return null;
    if (normalizedOldPath === normalizedTargetPath) return normalizedOldPath;

    const folder = normalizedTargetPath.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);
    const finalPath = this.getUniqueVaultPath(normalizedTargetPath);
    await this.app.fileManager.renameFile(file, finalPath);
    return finalPath;
  }

  async syncRecords(options?: { save?: boolean }): Promise<DocRecord[]> {
    const files = this.getPoolFiles();
    const activePaths = new Set(files.map((file) => file.path));
    let changed = false;

    for (const file of files) {
      const existing = this.settings.records[file.path];
      if (!existing) {
        this.settings.records[file.path] = await this.createRecord(file);
        changed = true;
      } else {
        if (await this.backfillRecordMetricPreset(file, existing)) changed = true;
        const title = this.getTitle(file);
        const metrics = normalizeMetrics(existing.metrics);
        const priority = this.calculatePriority(metrics);
        if (existing.title !== title || existing.priority !== priority || JSON.stringify(existing.metrics) !== JSON.stringify(metrics)) {
          existing.title = title;
          existing.metrics = metrics;
          existing.priority = priority;
          changed = true;
        }
      }
      if (await this.importDocumentStateSidecar(file)) changed = true;
    }

    for (const path of Object.keys(this.settings.records)) {
      if (!activePaths.has(path) && !this.shouldKeepRecordOutsideReadingPool(this.settings.records[path])) {
        this.removeLinkedDataForPath(path);
        delete this.settings.records[path];
        changed = true;
      }
    }

    if (changed && options?.save !== false) await this.saveSettings();
    return this.getRecords();
  }

  getPoolFiles(): TFile[] {
    const folders = this.getReadingFolders();
    if (folders.length === 0) return [];

    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        if (/^FAILED\s/i.test(file.basename)) return false;
        const path = normalizePath(file.path);
        return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  shouldKeepRecordOutsideReadingPool(record: DocRecord): boolean {
    return Boolean(
      record.status === "archived" ||
      record.status === "export_package_ready" ||
      record.status === "done" ||
      record.archivedSourcePath ||
      record.completedSourcePath ||
      record.removedFromReadingPoolAt ||
      record.removedToPath
    );
  }

  removeLinkedDataForPath(pathValue: string) {
    const targetPath = normalizePath(pathValue);
    for (const [id, annotation] of Object.entries(this.settings.annotations)) {
      if (annotation.path === targetPath || annotation.lastKnownPath === targetPath) delete this.settings.annotations[id];
    }
    for (const [id, card] of Object.entries(this.settings.qaCards)) {
      if (card.path === targetPath) delete this.settings.qaCards[id];
    }
    delete this.settings.articleMusings[targetPath];
  }

  getRecords(): DocRecord[] {
    return Object.values(this.settings.records)
      .map((record) => ({
        ...record,
        priority: this.calculatePriority(record.metrics)
      }))
      .sort(comparePriorityRecords);
  }

  isRecordFrozenForExport(path: string): boolean {
    const status = this.settings.records[path]?.status;
    return status === "export_package_ready" || status === "archived";
  }

  getActiveRecord(): DocRecord | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return this.settings.records[file.path] || null;
  }

  async createRecord(file: TFile): Promise<DocRecord> {
    let preset: ReturnType<typeof parseReadingMetricPreset> = {};
    let presetCheckedMtime: number | null = null;
    try {
      preset = parseReadingMetricPreset(await this.app.vault.cachedRead(file));
      presetCheckedMtime = file.stat.mtime;
    } catch (error) {
      console.warn(`Local IR: cannot read metric preset from ${file.path}`, error);
    }
    const metrics = {
      ...DEFAULT_METRICS,
      ...(preset.valueJudgment === undefined ? {} : { importance: preset.valueJudgment }),
      ...(preset.informationDensity === undefined ? {} : { urgency: preset.informationDensity })
    };
    return {
      path: file.path,
      title: this.getTitle(file),
      status: "inbox",
      metrics,
      metricsEditedByUser: false,
      metricPresetCheckedMtime: presetCheckedMtime,
      priority: this.calculatePriority(metrics),
      visitCount: 0,
      lastVisited: null,
      deferUntil: null,
      archivedAt: null,
      archiveExportPath: null,
      archivePackagePath: null,
      archivePackageId: null,
      archivePackageRevision: null,
      archiveInputHash: null,
      exportPackageReadyAt: null,
      archiveAttemptCount: 0,
      archiveLastError: null,
      archiveLastFailure: null,
      originalSourcePath: null,
      archivedSourcePath: null,
      movedIntoReadingPoolFromPath: null,
      movedIntoReadingPoolAt: null,
      removedFromReadingPoolAt: null,
      removedToPath: null,
      readingPathBeforeCompletion: null,
      completedSourcePath: null,
      completedAt: null,
      documentStateSidecarPath: null,
      documentStateRevision: null,
      documentStateUpdatedAt: null,
      documentStateFingerprint: null
    };
  }

  getTitle(file: TFile): string {
    return file.basename || file.name;
  }

  calculatePriority(metrics: MetricValues): number {
    return calculatePriorityWithWeights(metrics, this.settings.metricWeights);
  }

  isRecordDeferred(record: DocRecord): boolean {
    return record.status === "later" && Boolean(record.deferUntil) && record.deferUntil! > todayKey();
  }

  isRecordReadable(record: DocRecord): boolean {
    if (record.status === "suspended" || record.status === "done" || record.status === "export_package_ready" || record.status === "archived") return false;
    return !this.isRecordDeferred(record);
  }

  getSelectableRecords(): DocRecord[] {
    const today = todayKey();
    return this.getRecords().filter((record) => {
      if (!this.isRecordReadable(record)) return false;
      if (!this.settings.excludeVisitedToday) return true;
      return !isDateOnDay(record.lastVisited, today);
    });
  }

  selectNextRecord(): DocRecord | null {
    const candidates = this.getSelectableRecords();
    if (candidates.length === 0) return null;

    const extremeCandidate = findExtremePriorityRecord(candidates);
    if (extremeCandidate) return extremeCandidate;

    const probability = clamp(this.settings.absolutePriorityProbability, 0, 1);
    if (Math.random() < probability) {
      return candidates.sort((a, b) => b.priority - a.priority)[0];
    }

    return roulette(candidates);
  }

  async continueReading() {
    await this.syncRecords();
    const selected = this.selectNextRecord();
    if (!selected) {
      new Notice("没有可继续阅读的 Markdown。可以重置今日访问记录，或检查阅读池。");
      await this.refreshViews();
      return;
    }

    await this.openRecord(selected.path, true);
    await this.refreshViews();
  }

  async openRecord(path: string, countVisit: boolean) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${path}`);
      return;
    }

    const record = this.settings.records[path] || await this.createRecord(file);
    if (countVisit) {
      record.status = "reading";
      record.deferUntil = null;
      record.visitCount += 1;
      record.lastVisited = new Date().toISOString();
      record.priority = this.calculatePriority(record.metrics);
      this.settings.records[path] = record;
      await this.saveSettings();
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  async updateRecord(path: string, updates: Partial<DocRecord>) {
    const record = this.settings.records[path];
    if (!record) return;
    this.settings.records[path] = {
      ...record,
      ...updates,
      metrics: updates.metrics ? { ...record.metrics, ...updates.metrics } : record.metrics
    };
    this.settings.records[path].priority = this.calculatePriority(this.settings.records[path].metrics);
    await this.saveSettings();
    await this.refreshViews();
  }

  async deferRecord(path: string, days: number) {
    const safeDays = Math.max(1, Math.round(Number(days) || this.settings.defaultDeferDays));
    await this.updateRecord(path, {
      status: "later",
      deferUntil: addDaysKey(safeDays),
      archivedAt: null
    });
    new Notice(`已推迟 ${safeDays} 天。`);
  }

  async archiveRecord(path: string) {
    if (this.batchArchiveInProgress) {
      new Notice("批量生成导出包正在运行，暂不能启动单篇生成。");
      return;
    }
    if (this.singleArchivePathsInProgress.has(path)) {
      new Notice("这篇文章的导出包正在生成，请等待本轮完成。");
      return;
    }
    this.singleArchivePathsInProgress.add(path);
    try {
      const input = await this.createBatchArchiveInput(path);
      if (countImportableRemnoteItems(input) === 0) {
        const confirmed = await this.confirmNoRemnoteContent([this.createNoRemnoteContentPreflight(input)]);
        if (!confirmed) {
          new Notice("已取消生成；文章保持待生成，不计为失败。");
          return;
        }
        input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(input, new Date().toISOString());
      }
      const archivePath = await this.archiveRecordToPackage(path, input);
      if (!archivePath) return;
      await this.saveSettings();
      await this.refreshViews();
      new Notice(`导出包已准备（尚未正式归档）：${archivePath}`);
    } catch (error) {
      const failure = normalizeBatchArchiveFailure(error, {
        path,
        title: this.settings.records[path]?.title || path,
        occurredAt: new Date().toISOString()
      });
      this.applyBatchArchiveFailure(path, failure);
      await this.saveSettings();
      this.singleArchivePathsInProgress.delete(path);
      await this.refreshViews();
      console.error("Local IR single archive package generation failed", failure);
      new Notice(`单篇导出包生成${failure.kind === "blocked" ? "受阻" : "失败"}，文章仍保持待生成：${formatBatchArchiveFailure(failure)}`);
    } finally {
      this.singleArchivePathsInProgress.delete(path);
    }
  }

  async completeRecord(path: string) {
    const record = this.settings.records[path];
    if (!record) return;
    const targetPath = this.getCompletedSourceTargetPath(record);
    const movedPath = await this.moveVaultFilePath(path, targetPath);
    if (!movedPath) {
      new Notice(`完成阅读失败：找不到当前原文：${path}`);
      return;
    }

    if (movedPath !== path) {
      delete this.settings.records[path];
      this.updateLinkedPaths(path, movedPath);
    }

    const now = new Date().toISOString();
    this.settings.records[movedPath] = {
      ...record,
      path: movedPath,
      status: "done",
      deferUntil: null,
      originalSourcePath: record.originalSourcePath || path,
      readingPathBeforeCompletion: record.readingPathBeforeCompletion || path,
      completedSourcePath: movedPath,
      completedAt: now,
      archivedAt: null,
      archivePackagePath: null,
      archivePackageId: null,
      archivePackageRevision: null,
      archiveInputHash: null,
      exportPackageReadyAt: null,
      archiveLastError: null,
      archiveLastFailure: null,
      removedFromReadingPoolAt: null,
      removedToPath: null
    };

    await this.saveSettings();
    await this.openRecord(movedPath, false);
    await this.refreshViews();
    new Notice(`已完成阅读，原文已归入待归档区：${movedPath}`);
  }

  async batchArchiveDoneRecords() {
    if (this.batchArchiveInProgress) {
      new Notice("批量生成导出包正在运行，请等待本轮完成。");
      return;
    }
    if (this.singleArchivePathsInProgress.size > 0) {
      new Notice("已有单篇导出包正在生成，请等待完成后再启动批量任务。");
      return;
    }
    const records = this.getRecords().filter((record) => record.status === "done");
    if (records.length === 0) {
      new Notice("没有待批量生成导出包的文章。");
      return;
    }

    this.batchArchiveInProgress = true;
    new Notice(`正在检查 ${records.length} 篇待生成文章的归档输入。`);
    try {
      const preflightOutcomes = await Promise.all(records.map(async (record) => {
        try {
          return { record, input: await this.createBatchArchiveInput(record.path), failure: null };
        } catch (error) {
          return {
            record,
            input: null,
            failure: normalizeBatchArchiveFailure(error, {
              path: record.path,
              title: record.title,
              occurredAt: new Date().toISOString()
            })
          };
        }
      }));
      const preflightFailures = preflightOutcomes.filter((outcome) => outcome.failure).map((outcome) => outcome.failure!);
      for (const failure of preflightFailures) {
        console.error("Local IR batch archive input preflight failed", failure);
        this.applyBatchArchiveFailure(failure.path, failure);
      }
      const available = preflightOutcomes.filter((outcome) => outcome.input).map((outcome) => ({ record: outcome.record, input: outcome.input! }));
      const noRemnoteContent = available.filter((outcome) => countImportableRemnoteItems(outcome.input) === 0);
      let cancelledNoRemnoteCount = 0;
      if (noRemnoteContent.length > 0) {
        const confirmed = await this.confirmNoRemnoteContent(noRemnoteContent.map((outcome) => this.createNoRemnoteContentPreflight(outcome.input)));
        if (confirmed) {
          const confirmedAt = new Date().toISOString();
          for (const outcome of noRemnoteContent) {
            outcome.input.noRemnoteContentConfirmation = createNoRemnoteContentConfirmation(outcome.input, confirmedAt);
          }
        } else {
          cancelledNoRemnoteCount = noRemnoteContent.length;
        }
      }
      const runnable = cancelledNoRemnoteCount > 0
        ? available.filter((outcome) => countImportableRemnoteItems(outcome.input) > 0)
        : available;
      const inputByPath = new Map(runnable.map((outcome) => [outcome.record.path, outcome.input]));
      const result = await runBatchArchive({
        records: runnable.map((outcome) => outcome.record),
        concurrency: "auto",
        loadInput: async (recordPath: string) => inputByPath.get(recordPath),
        io: this.createBatchArchiveIo(),
        onPrepared: async (recordPath: string, prepared: any) => this.applyBatchArchivePrepared(recordPath, prepared),
        onFailure: async (recordPath: string, failure: any) => {
          console.error("Local IR batch archive package generation failed", failure);
          this.applyBatchArchiveFailure(recordPath, failure);
        }
      });
      await this.saveSettings();
      await this.refreshViews();
      const totalFailed = preflightFailures.length + result.failed;
      const firstFailure = preflightFailures[0] || result.failures[0];
      if (totalFailed > 0 || cancelledNoRemnoteCount > 0) {
        const failureDetail = firstFailure ? `首条诊断：${formatBatchArchiveFailure(firstFailure)}` : "";
        new Notice(`导出包生成完成（并发 ${result.concurrency} 路）：已准备 ${result.prepared} 篇，失败 ${totalFailed} 篇，用户取消 ${cancelledNoRemnoteCount} 篇。取消项保持待生成且不计故障。${failureDetail}`);
      } else {
        new Notice(`导出包生成完成（并发 ${result.concurrency} 路）：已准备 ${result.prepared} 篇。尚未正式归档，须等待工程五 receipt。`);
      }
    } finally {
      this.batchArchiveInProgress = false;
    }
  }

  async archiveRecordToPackage(path: string, frozenInput?: any): Promise<string | null> {
    const record = this.settings.records[path];
    if (!record) return null;
    if (record.status !== "done") throw new Error(`Record is not pending package generation: ${path}`);
    const input = frozenInput || await this.createBatchArchiveInput(path);
    const prepared = await prepareExportPackage({ input, io: this.createBatchArchiveIo() });
    this.applyBatchArchivePrepared(path, prepared);
    return prepared.packagePath;
  }

  createBatchArchiveIo() {
    return {
      exists: (filePath: string) => this.app.vault.adapter.exists(normalizePath(filePath)),
      readText: (filePath: string) => this.app.vault.adapter.read(normalizePath(filePath)),
      writeAtomic: (filePath: string, content: string) => this.writeDocumentStateSidecarAtomic(normalizePath(filePath), content)
    };
  }

  async backfillRecordMetricPreset(file: TFile, record: DocRecord): Promise<boolean> {
    if (record.metricsEditedByUser || !isDefaultMetricInitialization(record.metrics)) return false;
    if (record.metricPresetCheckedMtime === file.stat.mtime) return false;
    let preset: ReturnType<typeof parseReadingMetricPreset>;
    try {
      preset = parseReadingMetricPreset(await this.app.vault.cachedRead(file));
    } catch (error) {
      console.warn(`Local IR: cannot reconcile metric preset from ${file.path}`, error);
      return false;
    }
    const reconciliation = reconcileReadingMetricPreset({
      metrics: record.metrics,
      metricsEditedByUser: record.metricsEditedByUser,
      metricPresetCheckedMtime: record.metricPresetCheckedMtime
    }, preset, file.stat.mtime);
    if (!reconciliation.changed) return false;
    record.metrics = reconciliation.state.metrics;
    record.metricsEditedByUser = reconciliation.state.metricsEditedByUser;
    record.metricPresetCheckedMtime = reconciliation.state.metricPresetCheckedMtime;
    record.priority = this.calculatePriority(record.metrics);
    return true;
  }

  async createBatchArchiveInput(path: string) {
    const record = this.settings.records[path];
    if (!record) throw new Error(`Cannot package missing record: ${path}`);
    if (record.status !== "done") throw new Error(`Record is not pending package generation: ${path}`);
    const sourceFile = this.app.vault.getAbstractFileByPath(path);
    if (!(sourceFile instanceof TFile)) throw new Error(`Cannot package missing source file: ${path}`);
    const sourceContent = await this.app.vault.cachedRead(sourceFile);
    const archivedSourcePath = record.archivedSourcePath || this.getSourceArchiveTargetPath(record);
    record.archivedSourcePath = archivedSourcePath;
    const packageRecord: DocRecord = {
      ...record,
      status: "export_package_ready",
      archivedAt: null,
      archiveExportPath: record.archiveExportPath || this.getArchiveExportPath(record),
      archivePackagePath: record.archivePackagePath || this.getArchiveImportPath(record),
      originalSourcePath: record.originalSourcePath || path,
      archivedSourcePath
    };
    const annotations = this.getAnnotationsForPath(path);
    const exportAnnotations = annotations.map((annotation, index) => this.createArchiveAnnotationPayload(annotation, index, sourceContent));
    const cards = this.createArchiveQaCardPayloads(packageRecord, this.getQaCardsForPath(path), exportAnnotations, sourceContent);
    const clozeCards = this.createArchiveClozeCardPayloads(packageRecord, exportAnnotations);
    const articleMusings = this.createArchiveArticleMusingPayloads(path);
    return {
      schema: BATCH_ARCHIVE_INPUT_SCHEMA,
      record: {
        path,
        originalSourcePath: packageRecord.originalSourcePath,
        archivedSourcePath,
        title: record.title,
        status: "done",
        completedAt: record.completedAt
      },
      source: inferSourceDescriptor({ sourcePath: packageRecord.originalSourcePath || path, sourceContent }),
      sourceContent,
      paths: {
        markdownExportPath: packageRecord.archiveExportPath!,
        packageJsonPath: packageRecord.archivePackagePath!,
        refinedReadingPath: this.getRefinedReadingPath(packageRecord),
        questionQueueJsonPath: this.getQuestionQueueJsonPath(packageRecord),
        questionQueueMarkdownPath: this.getQuestionQueueMarkdownPath(packageRecord)
      },
      annotations: exportAnnotations,
      cards,
      clozeCards,
      articleMusings,
      noRemnoteContentConfirmation: null as any
    };
  }

  createNoRemnoteContentPreflight(input: any): NoRemnoteContentPreflight {
    return {
      path: input.record.path,
      title: input.record.title,
      missingElementKinds: getMissingArchiveElementKinds(input)
    };
  }

  confirmNoRemnoteContent(entries: NoRemnoteContentPreflight[]): Promise<boolean> {
    return new Promise((resolve) => {
      new NoRemnoteContentConfirmationModal(this.app, entries, resolve).open();
    });
  }

  applyBatchArchivePrepared(path: string, prepared: any) {
    const record = this.settings.records[path];
    if (!record) return;
    this.settings.records[path] = {
      ...record,
      status: EXPORT_PACKAGE_READY as ReadingStatus,
      deferUntil: null,
      archivedAt: null,
      archiveExportPath: prepared.markdownExportPath,
      archivePackagePath: prepared.packagePath,
      archivePackageId: prepared.packageId,
      archivePackageRevision: prepared.packageRevision,
      archiveInputHash: prepared.inputHash,
      exportPackageReadyAt: prepared.preparedAt,
      archiveAttemptCount: record.archiveAttemptCount + 1,
      archiveLastError: null,
      archiveLastFailure: null,
      archivedSourcePath: prepared.archivedSourcePath
    };
  }

  applyBatchArchiveFailure(path: string, failure: any) {
    const record = this.settings.records[path];
    if (!record) return;
    const normalized = normalizeBatchArchiveFailure(failure, {
      path,
      title: record.title,
      occurredAt: failure?.occurredAt || new Date().toISOString()
    });
    const archiveLastFailure = normalizeArchiveFailureState(normalized);
    this.settings.records[path] = {
      ...record,
      status: "done",
      archiveAttemptCount: record.archiveAttemptCount + 1,
      archiveLastError: formatBatchArchiveFailure(normalized),
      archiveLastFailure
    };
  }

  async restoreRecord(path: string, status: ReadingStatus = "reading") {
    const record = this.settings.records[path];
    if (!record) return;
    let restoredPath = path;
    if (record.status === "archived" || record.status === "done" || record.status === "export_package_ready") {
      const restoreTargetPath = this.getRestoreSourceTargetPath(record);
      const movedPath = await this.moveVaultFilePath(path, restoreTargetPath);
      if (!movedPath) {
        new Notice(`找不到原文，无法恢复阅读：${path}`);
        return;
      }
      restoredPath = movedPath;
      if (restoredPath !== path) {
        delete this.settings.records[path];
        this.updateLinkedPaths(path, restoredPath);
      }
    }

    const restored: DocRecord = {
      ...record,
      path: restoredPath,
      status,
      deferUntil: null,
      archivedAt: null,
      originalSourcePath: record.status === "archived" || record.status === "done" || record.status === "export_package_ready" ? restoredPath : record.originalSourcePath,
      archivedSourcePath: record.status === "archived" ? null : record.archivedSourcePath,
      archivePackagePath: null,
      archivePackageId: null,
      archivePackageRevision: null,
      archiveInputHash: null,
      exportPackageReadyAt: null,
      archiveLastError: null,
      archiveLastFailure: null,
      completedSourcePath: null,
      completedAt: null,
      readingPathBeforeCompletion: null,
      removedFromReadingPoolAt: null,
      removedToPath: null
    };
    this.settings.records[restoredPath] = restored;
    if (record.status === "archived" || record.status === "done" || record.status === "export_package_ready") {
      for (const annotation of this.getAnnotationsForPath(restoredPath)) {
        this.settings.annotations[annotation.id] = {
          ...annotation,
          archived: false,
          updatedAt: new Date().toISOString()
        };
      }
      for (const card of this.getQaCardsForPath(restoredPath)) {
        this.settings.qaCards[card.id] = {
          ...card,
          archived: false,
          updatedAt: new Date().toISOString()
        };
      }
      const musing = this.settings.articleMusings[restoredPath];
      if (musing) {
        this.settings.articleMusings[restoredPath] = {
          ...musing,
          archived: false,
          updatedAt: new Date().toISOString()
        };
      }
    }
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已恢复到阅读队列。已生成的导出包会保留，便于审计。");
  }

  async updateMetric(path: string, metric: MetricKey, value: number) {
    const record = this.settings.records[path];
    if (!record) return;
    record.metrics[metric] = snapMetricValue(value);
    record.metricsEditedByUser = true;
    record.priority = this.calculatePriority(record.metrics);
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
  }

  async setExtremeImportance(path: string, enabled: boolean) {
    const record = this.settings.records[path];
    if (!record) return;
    const value = enabled ? MAX_METRIC_VALUE : DEFAULT_METRIC_VALUE;
    for (const metric of Object.keys(METRIC_LABELS) as MetricKey[]) {
      record.metrics[metric] = value;
    }
    record.metricsEditedByUser = true;
    record.priority = this.calculatePriority(record.metrics);
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
  }

  async resetTodayVisits() {
    const today = todayKey();
    for (const record of Object.values(this.settings.records)) {
      if (isDateOnDay(record.lastVisited, today)) {
        record.lastVisited = null;
      }
    }
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已重置今日访问记录。");
  }

  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LOCAL_IR)) {
      const view = leaf.view;
      if (view instanceof LocalIRView) {
        await view.render();
      }
    }
  }

  getAnnotationsForPath(path: string): AnnotationRecord[] {
    return Object.values(this.settings.annotations)
      .filter((annotation) => annotation.path === path || annotation.lastKnownPath === path)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getActiveAnnotations(): AnnotationRecord[] {
    const file = this.app.workspace.getActiveFile();
    if (!file) return [];
    return this.getAnnotationsForPath(file.path);
  }

  getQaCardsForPath(path: string): QaCardRecord[] {
    return Object.values(this.settings.qaCards)
      .filter((card) => card.path === path)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getArticleMusing(path: string): ArticleMusingRecord | null {
    return this.settings.articleMusings[path] || null;
  }

  async saveArticleMusing(path: string, bodyMarkdown: string) {
    if (this.isRecordFrozenForExport(path)) {
      new Notice("导出包已冻结；正式 receipt 前如需修改，请先撤销对应待导入包。当前版本不会自动删除审计包。");
      return;
    }
    const body = bodyMarkdown.trim();
    const now = new Date().toISOString();
    const existing = this.settings.articleMusings[path];
    if (!body) {
      if (existing) {
        delete this.settings.articleMusings[path];
        await this.saveSettings();
        await this.refreshViews();
        new Notice("已清空文章随想。");
      }
      return;
    }

    this.settings.articleMusings[path] = normalizeArticleMusing(path, {
      ...(existing || {}),
      id: existing?.id || createMusingId(),
      path,
      bodyMarkdown: body,
      aiStatus: existing?.aiStatus || "pending",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      archived: false
    });
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已保存文章随想。");
  }

  async saveArticleQaCard(path: string, questionMarkdown: string, answerMarkdown: string, needsAnswerGeneration: boolean) {
    if (this.isRecordFrozenForExport(path)) {
      new Notice("导出包已冻结，当前问答卡只读。");
      return;
    }
    const question = questionMarkdown.trim();
    const answer = answerMarkdown.trim();
    if (!question) {
      new Notice("请先输入问题。");
      return;
    }
    const now = new Date().toISOString();
    const id = createQaCardId();
    this.settings.qaCards[id] = normalizeQaCard(id, {
      id,
      path,
      source: "article",
      sourceAnnotationId: null,
      questionMarkdown: question,
      answerMarkdown: answer,
      answerSourceText: "",
      needsQuestionGeneration: false,
      needsAnswerGeneration: needsAnswerGeneration || !answer,
      createdAt: now,
      updatedAt: now,
      archived: false
    });
    await this.saveSettings();
    await this.refreshViews();
    new Notice(needsAnswerGeneration || !answer ? "已保存问答卡，答案将在归档/解析时生成。" : "已保存问答卡。");
  }

  async updateQaCard(card: QaCardRecord): Promise<boolean> {
    const existing = this.settings.qaCards[card.id];
    if (!existing) return false;
    if (existing.archived || this.isRecordFrozenForExport(existing.path)) {
      new Notice("这张问答卡已冻结或已正式归档，不能修改。");
      return false;
    }
    const question = card.questionMarkdown.trim();
    if (!question) {
      new Notice("问题不能为空。");
      return false;
    }
    const answer = card.answerMarkdown.trim();
    this.settings.qaCards[card.id] = normalizeQaCard(card.id, {
      ...existing,
      ...card,
      questionMarkdown: question,
      answerMarkdown: answer,
      needsQuestionGeneration: false,
      needsAnswerGeneration: card.needsAnswerGeneration || !answer,
      updatedAt: new Date().toISOString()
    });
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已更新问答卡。");
    return true;
  }

  async deleteQaCard(id: string) {
    const existing = this.settings.qaCards[id];
    if (existing?.archived || (existing && this.isRecordFrozenForExport(existing.path))) {
      new Notice("这张问答卡已冻结或已正式归档，不能删除。");
      return;
    }
    delete this.settings.qaCards[id];
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已删除问答卡。");
  }

  openQaCardModal(card: QaCardRecord) {
    new QaCardModal(this.app, this, card).open();
  }

  async updateAnnotation(annotation: AnnotationRecord, options?: { applyRewrite?: boolean }) {
    const existing = this.settings.annotations[annotation.id];
    if (this.isRecordFrozenForExport(existing?.path || annotation.path)) {
      new Notice("导出包已冻结，当前加工记录只读。");
      return;
    }
    let next = normalizeAnnotation(annotation.id, annotation);
    const rewriteText = next.rewriteMarkdown.trim();
    if (options?.applyRewrite && rewriteText) {
      next.currentText = rewriteText;
      next.rewriteApplied = true;
    }

    next.type = normalizeAnnotationType(next.type);
    next.hasRewrite = Boolean(rewriteText);
    next.selectedText = next.currentText;
    next.lastKnownPath = next.path;
    next.fragments = createWrappedHighlightText(next.id, next.currentText, next.markKind).fragments;
    next.updatedAt = new Date().toISOString();

    if (next.sourceFormat === "legacy" && !existing) {
      const upgraded = await this.upgradeLegacyHighlight(next);
      if (!upgraded) {
        new Notice("没有找到对应的旧高亮，未保存。");
        return;
      }
      next = upgraded;
    } else if (next.sourceFormat === "virtual" || next.renderMode === "virtual_decoration") {
      // Virtual annotations deliberately never rewrite source Markdown. Edits here
      // update the processing record and export text only, leaving formatting intact.
      next.sourceFormat = "virtual";
      next.renderMode = "virtual_decoration";
      next.orphaned = getAnnotationVirtualRanges(next).length === 0;
    } else if (next.sourceFormat === "mark") {
      const linked = await this.replaceAnnotationText(next.path, next.id, next.currentText);
      next.orphaned = !linked;
    }

    next.sourceFormat = next.renderMode === "virtual_decoration" ? "virtual" : "mark";
    next = await this.refreshAnnotationHierarchy(next);
    this.settings.annotations[next.id] = next;
    this.refreshVirtualHighlights();
    await this.saveSettings();
    await this.refreshViews();
  }

  async replaceVirtualAnnotationText(annotation: AnnotationRecord): Promise<AnnotationRecord | null> {
    if (!annotation.range) return annotation;
    const current = this.getActiveEditorForPath(annotation.path)?.getValue() ?? await this.readVaultFile(annotation.path);
    if (current === null) return null;
    const start = clampRangeIndex(annotation.range.start, current.length);
    const end = clampRangeIndex(annotation.range.end, current.length);
    if (end < start) return null;
    const nextContent = `${current.slice(0, start)}${annotation.currentText}${current.slice(end)}`;
    const changed = await this.updateContentInEditorOrFile(annotation.path, () => nextContent);
    const nextRange = { start, end: start + annotation.currentText.length };
    return {
      ...annotation,
      sourceFormat: "virtual",
      renderMode: "virtual_decoration",
      range: nextRange,
      lineRange: getLineRangeForOffsets(nextContent, nextRange.start, nextRange.end),
      sourceOffset: nextRange.start,
      orphaned: false,
      updatedAt: new Date().toISOString()
    };
  }

  async refreshAnnotationHierarchy(annotation: AnnotationRecord): Promise<AnnotationRecord> {
    const content = await this.readVaultFile(annotation.path);
    if (content === null) return annotation;
    const hierarchy = resolveAnnotationHierarchy(content, annotation);
    return {
      ...annotation,
      scope: hierarchy.scope,
      headingPath: hierarchy.headingPath,
      expandedText: hierarchy.expandedText,
      expandedAnswerText: hierarchy.expandedAnswerText,
      subtreeRange: hierarchy.subtreeRange
    };
  }

  async saveAnnotationDraft(annotation: AnnotationRecord) {
    const existing = this.settings.annotations[annotation.id];
    if (!existing || annotation.sourceFormat === "legacy") return;

    const next = normalizeAnnotation(annotation.id, {
      ...existing,
      type: normalizeAnnotationType(annotation.type),
      commentMarkdown: annotation.commentMarkdown,
      rewriteMarkdown: annotation.rewriteMarkdown,
      hasRewrite: Boolean(annotation.rewriteMarkdown.trim()),
      updatedAt: new Date().toISOString()
    });
    this.settings.annotations[next.id] = next;
    await this.saveSettings();
    await this.refreshViews();
  }

  openAnnotationModal(annotation: AnnotationRecord) {
    new AnnotationModal(this.app, this, annotation).open();
  }

  registerReadingHighlights() {
    const style = document.createElement("style");
    // Match the existing virtual decoration palette; keep native text/link colors.
    style.textContent = "::highlight(local-ir-reading-highlight){background-color:color-mix(in srgb, var(--text-highlight-bg) 78%, transparent)}::highlight(local-ir-reading-cloze){background-color:color-mix(in srgb, var(--color-orange) 28%, transparent)}";
    document.head.appendChild(style);
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => this.handleReadingHistoryShortcut(event), true);
    const observer = new MutationObserver((changes) => {
      if (!changes.some(change => (change.target as Element).closest?.(".markdown-reading-view") ||
        Array.from(change.addedNodes).some(node => node instanceof Element && (node.matches(".markdown-reading-view") || node.querySelector(".markdown-reading-view"))))) return;
      window.clearTimeout(this.readingHighlightTimer);
      this.readingHighlightTimer = window.setTimeout(() => this.refreshReadingHighlights(), 80);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => {
      observer.disconnect();
      window.clearTimeout(this.readingHighlightTimer);
      style.remove();
      (window as any).CSS?.highlights?.delete("local-ir-reading-highlight");
      (window as any).CSS?.highlights?.delete("local-ir-reading-cloze");
    });
    this.refreshReadingHighlights();
  }

  handleReadingHistoryShortcut(event: KeyboardEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target?.closest(".markdown-reading-view") || target.closest("input, textarea, [contenteditable=true]")) return;
    const undo = isPlainUndoShortcut(event);
    if (!undo && !isPlainRedoShortcut(event)) return;
    const view = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view as any)
      .find(candidate => candidate.getMode?.() === "preview" && candidate.containerEl.contains(target));
    const path = view?.file?.path;
    if (!path || this.app.workspace.getActiveFile()?.path !== path) return;
    const actions = undo ? this.recentHighlightActions : this.recentVirtualHighlightRedoActions;
    const index = findLastIndex(actions, action => action.path === path);
    if (!isUndoableVirtualHighlightAction(actions[index], path, view.previewMode?.renderer?.text)) return;
    event.preventDefault();
    event.stopPropagation();
    void (undo ? this.undoRecentHighlight() : this.redoRecentVirtualHighlight(path));
  }

  refreshReadingHighlights() {
    const registry = (window as any).CSS?.highlights;
    const HighlightClass = (window as any).Highlight;
    if (!registry || !HighlightClass) return;
    const highlights: Range[] = [];
    const clozes: Range[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as any;
      if (view.getMode?.() !== "preview" || !view.file) continue;
      const renderer = view.previewMode?.renderer;
      if (!renderer?.text || !renderer.sections) continue;
      const mapped = mapReadingText(renderer.text, renderer.sections.filter((s: any) => s.el?.isConnected));
      for (const annotation of this.getAnnotationsForPath(view.file.path)) {
        if (annotation.renderMode !== "virtual_decoration" || annotation.orphaned) continue;
        const target = annotation.markKind === "cloze" ? clozes : highlights;
        target.push(...readingDecorationRanges(mapped, getAnnotationVirtualRanges(annotation)));
      }
    }
    registry.set("local-ir-reading-highlight", new HighlightClass(...highlights));
    registry.set("local-ir-reading-cloze", new HighlightClass(...clozes));
  }

  async highlightReadingSelection(target: HTMLElement) {
    const selection = target.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0).cloneRange();
    const view = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view as any)
      .find(candidate => candidate.getMode?.() === "preview" && candidate.containerEl.contains(target));
    const reading = view?.previewMode?.containerEl;
    if (!view?.file || !reading?.contains(range.startContainer) || !reading.contains(range.endContainer)) return;
    const renderer = view.previewMode.renderer;
    const content = renderer.text;
    const offsets = readingSelectionOffsets(range, mapReadingText(content, renderer.sections));
    if (!offsets) { new Notice("无法准确定位此选区，请在编辑视图中选择这段内容。"); return; }
    const file = view.file;
    if (this.isRecordFrozenForExport(file.path)) { new Notice("该文章的导出包已冻结，不能继续加工。"); return; }
    if (await this.app.vault.cachedRead(file) !== content) { new Notice("正文正在更新，请重新选择。"); return; }
    const offsetToPos = (offset: number) => {
      const lines = content.slice(0, offset).split("\n");
      return { line: lines.length - 1, ch: lines[lines.length - 1].length };
    };
    const editor = { getValue: () => content, offsetToPos,
      replaceRange: () => { throw new Error("Reading view must not modify Markdown"); } } as unknown as Editor;
    await this.highlightSelection(editor, file, this.settings.autoOpenAnnotationModal, {
      from: offsetToPos(offsets.start), to: offsetToPos(offsets.end),
      fromOffset: offsets.start, toOffset: offsets.end, text: content.slice(offsets.start, offsets.end)
    }, true);
  }

  async handleEditorMouseup(event: MouseEvent) {
    if (!this.settings.processingModeEnabled && !this.settings.clozeModeEnabled) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".markdown-reading-view")) {
      try { await this.highlightReadingSelection(target); }
      catch (error) { console.error("Local IR: reading selection failed", error); new Notice("选区加工失败，请重试。"); }
      return;
    }
    if (!target?.closest(".cm-editor")) return;

    const activeEditor = this.app.workspace.activeEditor;
    if (!activeEditor?.editor || !activeEditor.file) return;
    const editor = activeEditor.editor;
    const file = activeEditor.file;
    const selection = getNormalizedSelection(editor);
    if (!selection) return;

    window.setTimeout(() => {
      void this.highlightSelection(editor, file, this.settings.autoOpenAnnotationModal, selection);
    }, 80);
  }

  async handleAnnotationClick(event: MouseEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const mark = target?.closest("mark") as HTMLElement | null;
    if (!mark) return;

    const id = mark.getAttribute("data-ir-id");
    event.preventDefault();

    if (!id) {
      const file = this.app.workspace.getActiveFile();
      if (!file) return;
      this.openAnnotationModal(this.createAnnotation(createAnnotationId(), file.path, mark.textContent || "", "legacy"));
      return;
    }

    if (this.isManualMergeEvent(event)) {
      this.queueManualMergeAnnotation(id);
      return;
    }

    let annotation = this.settings.annotations[id];
    if (!annotation) {
      const file = this.app.workspace.getActiveFile();
      if (!file) return;
      annotation = this.createAnnotation(id, file.path, mark.textContent || "", "mark", null, null, [], null, normalizeMarkKind(mark.getAttribute("data-ir-kind")));
      this.settings.annotations[id] = annotation;
      await this.saveSettings();
    }
    this.openAnnotationModal(annotation);
  }

  async highlightWholeBlockAtClick(view: EditorView, event: MouseEvent) {
    const path = getEditorViewPath(view);
    const activeEditor = this.app.workspace.activeEditor;
    if (!path || !activeEditor?.editor || !activeEditor.file || activeEditor.file.path !== path) return;

    const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (offset === null) return;
    const content = activeEditor.editor.getValue();
    const clickedLine = view.state.doc.lineAt(offset);
    const range = { start: clickedLine.from, end: clickedLine.to };
    const text = content.slice(range.start, range.end);
    if (!text.trim()) return;

    await this.highlightSelection(
      activeEditor.editor,
      activeEditor.file,
      this.settings.autoOpenAnnotationModal,
      {
        from: activeEditor.editor.offsetToPos(range.start),
        to: activeEditor.editor.offsetToPos(range.end),
        fromOffset: range.start,
        toOffset: range.end,
        text
      }
    );
  }

  handleMergeKeyDown(event: KeyboardEvent) {
    if (event.code === "AltLeft") {
      this.manualMergeModeActive = true;
    }
  }

  async handleMergeKeyUp(event: KeyboardEvent) {
    if (event.code !== "AltLeft") return;
    if (!this.manualMergeModeActive && this.manualMergeIds.length === 0) return;
    this.manualMergeModeActive = false;
    await this.finishManualMerge();
  }

  isManualMergeEvent(event: MouseEvent): boolean {
    return this.manualMergeModeActive || event.altKey;
  }

  queueManualMergeAnnotation(id: string) {
    const annotation = this.settings.annotations[id];
    if (!annotation) return;
    if (this.manualMergePath && this.manualMergePath !== annotation.path) {
      new Notice("一次手动合并只能处理同一篇文章里的高亮。");
      return;
    }
    this.manualMergePath = annotation.path;
    if (!this.manualMergeIds.includes(id)) this.manualMergeIds.push(id);
    new Notice(`已加入合并：${this.manualMergeIds.length} 条。松开左 Alt 后合并。`);
  }

  async finishManualMerge() {
    const path = this.manualMergePath;
    const ids = [...this.manualMergeIds];
    this.manualMergePath = null;
    this.manualMergeIds = [];
    if (!path || ids.length < 2) return;
    await this.mergeAnnotations(path, ids, { silent: false });
  }

  getMergeCandidateIdsForSelection(content: string, selection: EditorSelection, markKind: AnnotationMarkKind): string[] {
    const ranges = this.getVirtualAnnotationRangesForPath(this.app.workspace.getActiveFile()?.path || "")
      .filter((range) => range.markKind === markKind);
    if (ranges.length === 0) return [];
    const selectionRange = { start: selection.fromOffset, end: selection.toOffset };
    const blockRange = getMarkdownBlockRangeAtOffset(content, selection.fromOffset);
    return ranges
      .filter((range) => rangesOverlap(selectionRange, range) || (this.settings.autoMergeHighlightsEnabled && rangesOverlap(blockRange, range)))
      .map((range) => range.id)
      .filter((id, index, array) => array.indexOf(id) === index);
  }

  normalizeHighlightSelection(editor: Editor, content: string, selection: EditorSelection, markKind: AnnotationMarkKind, path: string, forceVirtual = false): NormalizedHighlightSelection {
    const inlineRanges = findAllMarkRanges(content).filter((range) => range.markKind === markKind);
    const virtualRanges = this.getVirtualAnnotationRangesForPath(path)
      .filter((range) => range.markKind === markKind);
    const selectionRange = { start: selection.fromOffset, end: selection.toOffset };
    const blockRange = getMarkdownBlockRangeAtOffset(content, selection.fromOffset);
    const protectedKind = detectProtectedKindForSelection(content, selectionRange.start, selectionRange.end, selection.text);
    let shouldUseVirtual = Boolean(forceVirtual || protectedKind || this.settings.alwaysVirtualHighlightsEnabled);
    const candidateRanges = shouldUseVirtual ? virtualRanges : [...inlineRanges, ...virtualRanges];
    const overlapping = candidateRanges.filter((range) => rangesOverlap(selectionRange, range));
    const blockMerge = this.settings.autoMergeHighlightsEnabled
      ? candidateRanges.filter((range) => !overlapping.includes(range) && rangesOverlap(blockRange, range))
      : [];
    const mergeRanges = [...overlapping, ...blockMerge].sort((a, b) => a.start - b.start || a.end - b.end);
    const id = mergeRanges[0]?.id || createAnnotationId();
    const normalizedRanges = normalizeTextRanges([selectionRange, ...mergeRanges]);
    if (normalizedRanges.length > 1) shouldUseVirtual = true;
    const fromOffset = normalizedRanges[0]?.start ?? selection.fromOffset;
    const toOffset = normalizedRanges[normalizedRanges.length - 1]?.end ?? selection.toOffset;
    const selectedText = normalizedRanges
      .map((range) => stripIrMarkup(content.slice(range.start, range.end)))
      .filter(Boolean)
      .join("\n\n");
    const overlappingIds = mergeRanges.map((range) => range.id).filter((item, index, array) => array.indexOf(item) === index);
    const beforeAnnotations: Record<string, AnnotationRecord | null> = {};
    for (const existingId of overlappingIds) {
      beforeAnnotations[existingId] = this.settings.annotations[existingId] ? cloneAnnotation(this.settings.annotations[existingId]) : null;
    }
    if (!(id in beforeAnnotations)) beforeAnnotations[id] = null;

    return {
      id,
      selectedText,
      fromOffset,
      toOffset,
      from: editor.offsetToPos(fromOffset),
      to: editor.offsetToPos(toOffset),
      renderMode: shouldUseVirtual ? "virtual_decoration" : "inline_mark",
      sourceFormat: shouldUseVirtual ? "virtual" : "mark",
      protectedKind,
      virtualRanges: normalizedRanges,
      overlappingIds,
      beforeAnnotations
    };
  }

  getVirtualAnnotationRangesForPath(path: string): MarkRange[] {
    return this.getAnnotationsForPath(path)
      .filter((annotation) => annotation.renderMode === "virtual_decoration" && !annotation.orphaned)
      .flatMap((annotation) => getAnnotationVirtualRanges(annotation).map((range) => ({
        id: annotation.id,
        start: range.start,
        end: range.end,
        fullText: annotation.currentText || annotation.selectedText,
        innerText: annotation.currentText || annotation.selectedText,
        markKind: annotation.markKind
      })));
  }

  async mergeAnnotations(path: string, ids: string[], options?: {
    silent?: boolean;
    undoBeforeContent?: string;
    undoBeforeAnnotations?: Record<string, AnnotationRecord | null>;
  }): Promise<string | null> {
    const uniqueIds = ids.filter((id, index, array) => id && array.indexOf(id) === index);
    if (uniqueIds.length < 2) return null;
    if (this.isRecordFrozenForExport(path)) return null;
    const annotations = uniqueIds
      .map((id) => this.settings.annotations[id])
      .filter((annotation): annotation is AnnotationRecord => Boolean(annotation) && annotation.path === path);
    if (annotations.length < 2) return null;
    if (annotations.length !== uniqueIds.length || new Set(annotations.map(annotation => annotation.markKind)).size !== 1 || annotations.some(annotation => annotation.archived)) {
      new Notice("不能合并跨文档、冻结或不同标注类型的记录。");
      return null;
    }

    const content = this.getActiveEditorForPath(path)?.getValue() ?? await this.readVaultFile(path);
    if (content === null) return null;
    const ranges = [
      ...findAllMarkRanges(content),
      ...this.getVirtualAnnotationRangesForPath(path)
    ].filter((range) => uniqueIds.includes(range.id));
    if (ranges.length < 2) return null;
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);

    const coreResult = LocalIrDocumentCore.mergeRecords(annotations.map(annotation => ({
      ...annotation, virtualRanges: ranges.filter(range => range.id === annotation.id)
    })), uniqueIds, { path, textForRange: (range: TextRange) => stripIrMarkup(content.slice(range.start, range.end)) });
    const primaryId = coreResult.annotation.id;
    const primary = this.settings.annotations[primaryId];
    if (!primary) return null;
    const beforeAnnotations: Record<string, AnnotationRecord | null> = { ...(options?.undoBeforeAnnotations || {}) };
    for (const id of uniqueIds) {
      if (!(id in beforeAnnotations)) {
        beforeAnnotations[id] = this.settings.annotations[id] ? cloneAnnotation(this.settings.annotations[id]) : null;
      }
    }

    const mergedRanges = coreResult.annotation.virtualRanges as TextRange[];
    const unionStart = mergedRanges[0].start;
    const unionEnd = mergedRanges[mergedRanges.length - 1].end;
    const mergedText = mergedRanges
      .map((range) => stripIrMarkup(content.slice(range.start, range.end)))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const protectedKind = detectProtectedKindForSelection(content, unionStart, unionEnd, mergedText);
    const useVirtual = Boolean(mergedRanges.length > 1 || protectedKind || this.settings.alwaysVirtualHighlightsEnabled || annotations.some((annotation) => annotation.renderMode === "virtual_decoration"));
    const wrapped = createWrappedHighlightText(primaryId, mergedText, primary.markKind);
    const nextContent = useVirtual
      ? content
      : `${content.slice(0, unionStart)}${wrapped.wrappedText}${content.slice(unionEnd)}`;

    if (!useVirtual) await this.updateContentInEditorOrFile(path, () => nextContent);
    const mergedAnnotation = normalizeAnnotation(primaryId, {
      ...coreResult.annotation,
      selectedText: mergedText || primary.selectedText,
      currentText: mergedText || primary.currentText,
      sourceFormat: useVirtual ? "virtual" : "mark",
      renderMode: useVirtual ? "virtual_decoration" : "inline_mark",
      protectedKind: useVirtual ? protectedKind || "mixed" : null,
      range: useVirtual ? { ...mergedRanges[0] } : null,
      virtualRanges: useVirtual ? mergedRanges : [],
      lineRange: useVirtual ? getLineRangeForOffsets(nextContent, unionStart, unionEnd) : null,
      sourceOffset: unionStart,
      updatedAt: new Date().toISOString(),
      fragments: useVirtual
        ? coreResult.annotation.fragments
        : wrapped.fragments
    });
    this.settings.annotations[primaryId] = mergedAnnotation;
    for (const id of uniqueIds) {
      if (id !== primaryId) delete this.settings.annotations[id];
    }
    this.refreshVirtualHighlights();
    this.clearVirtualHighlightRedoActions(path);
    this.recentHighlightActions.push({
      kind: "merge",
      path,
      beforeContent: options?.undoBeforeContent ?? content,
      afterContent: nextContent,
      beforeAnnotations,
      change: LocalIrDocumentCore.createChange(Object.values(beforeAnnotations).filter(Boolean), [this.settings.annotations[primaryId]], "merge"),
      mergedIds: uniqueIds
    });
    this.recentHighlightActions = this.recentHighlightActions.slice(-20);
    await this.saveSettings();
    await this.refreshViews();
    if (!options?.silent) new Notice(`已合并 ${uniqueIds.length} 条高亮。`);
    return primaryId;
  }

  addUrlImportMenuItems(menu: Menu, url: string) {
    const normalizedUrl = normalizeExternalUrl(url);
    if (!normalizedUrl) return;

    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("加入待导入列表")
        .setIcon("list-plus")
        .onClick(() => void this.addPendingImport(normalizedUrl, this.app.workspace.getActiveFile()?.path || null));
    });
    menu.addItem((item) => {
      item
        .setTitle("立即导入到渐进阅读")
        .setIcon("download")
        .onClick(() => void this.importLinkToReading(normalizedUrl));
    });
  }

  async addPendingImport(url: string, sourcePath: string | null = null) {
    const rawUrl = normalizeExternalUrl(url);
    const normalizedUrl = normalizePendingImportUrl(rawUrl || "");
    if (!rawUrl || !normalizedUrl) {
      new Notice("没有识别到有效链接。");
      return;
    }

    const existing = this.settings.pendingImports.find((item) => item.normalizedUrl === normalizedUrl);
    if (existing) {
      new Notice("该链接已经在待导入列表中。");
      return;
    }

    const now = new Date().toISOString();
    this.settings.pendingImports.push({
      id: `pending-import-${shortHash(normalizedUrl)}`,
      url: rawUrl,
      normalizedUrl,
      sourcePath: sourcePath ? normalizePath(sourcePath) : null,
      status: "pending",
      addedAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
      brokerClientRequestId: null
    });
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
    new Notice("已加入待导入列表。");
  }

  async removePendingImport(id: string) {
    const item = this.settings.pendingImports.find((candidate) => candidate.id === id);
    if (!item || item.status === "importing") return;
    const next = this.settings.pendingImports.filter((item) => item.id !== id);
    this.settings.pendingImports = next;
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
  }

  async importPendingImport(id: string) {
    await this.importPendingImports([id]);
  }

  async queueAndImportLinks(text: string) {
    const urls = extractExternalUrls(text);
    if (!urls.length) {
      new Notice("没有识别到有效链接。");
      return;
    }
    const ids = new Set<string>();
    let added = 0;
    for (const url of urls) {
      const normalizedUrl = normalizePendingImportUrl(url);
      if (!normalizedUrl) continue;
      const existing = this.settings.pendingImports.find((item) => item.normalizedUrl === normalizedUrl);
      if (existing) {
        if (existing.status !== "importing") ids.add(existing.id);
        continue;
      }
      const now = new Date().toISOString();
      const item: PendingImportRecord = {
        id: `pending-import-${shortHash(normalizedUrl)}`,
        url,
        normalizedUrl,
        sourcePath: null,
        status: "pending",
        addedAt: now,
        updatedAt: now,
        lastAttemptAt: null,
        attemptCount: 0,
        lastError: null,
        brokerClientRequestId: null
      };
      this.settings.pendingImports.push(item);
      ids.add(item.id);
      added += 1;
    }
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
    if (!ids.size) {
      new Notice("识别到的链接都已在导入中。");
      return;
    }
    new Notice(`已识别 ${urls.length} 个链接，新增 ${added} 个；正在并行标准导入。`);
    await this.importPendingImports([...ids]);
  }

  async resumeInterruptedPendingImports() {
    window.clearTimeout(this.pendingImportResumeTimer);
    this.pendingImportResumeTimer = undefined;
    const groups = new Map<string, string[]>();
    for (const item of this.settings.pendingImports) {
      if (item.status !== "importing" || !item.brokerClientRequestId) continue;
      const ids = groups.get(item.brokerClientRequestId) || [];
      ids.push(item.id);
      groups.set(item.brokerClientRequestId, ids);
    }
    for (const [clientRequestId, ids] of groups) {
      await this.importPendingImports(ids, { resume: true, clientRequestId });
    }
  }

  schedulePendingImportResume(delayMs = 30000) {
    window.clearTimeout(this.pendingImportResumeTimer);
    this.pendingImportResumeTimer = window.setTimeout(() => void this.resumeInterruptedPendingImports(), delayMs);
  }

  async importPendingImports(ids: string[], options?: { resume?: boolean; clientRequestId?: string }) {
    const uniqueIds = [...new Set(ids)];
    const items = uniqueIds
      .map((id) => this.settings.pendingImports.find((candidate) => candidate.id === id))
      .filter((item): item is PendingImportRecord => Boolean(item) && (options?.resume ? item!.status === "importing" : item!.status !== "importing"));
    if (!items.length) return;
    const attemptAt = new Date().toISOString();
    const clientRequestId = options?.clientRequestId
      || `obsidian-local-ir-${Date.now()}-${shortHash(items.map((item) => item.normalizedUrl).sort().join("\n"))}`;
    for (const item of items) {
      item.status = "importing";
      item.lastAttemptAt = options?.resume ? item.lastAttemptAt || attemptAt : attemptAt;
      item.updatedAt = attemptAt;
      if (!options?.resume) item.attemptCount += 1;
      item.lastError = null;
      item.brokerClientRequestId = clientRequestId;
    }
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();

    let batch: LinkImportBatchResponse | null = null;
    let batchError = "";
    try {
      batch = await this.importLinksToReading(items.map((item) => item.url), { clientRequestId });
    } catch (error) {
      batchError = error instanceof Error ? error.message : String(error);
      console.error("Local IR batch standard import failed", error);
    }
    const resultByUrl = new Map(
      (batch?.results || []).map((result) => [normalizePendingImportUrl(result.requested_url) || result.requested_url, result])
    );
    const succeededIds = new Set<string>();
    for (const item of items) {
      const current = this.settings.pendingImports.find((candidate) => candidate.id === item.id);
      if (!current) continue;
      const result = resultByUrl.get(current.normalizedUrl);
      if (result?.status === "imported" || result?.status === "imported_with_warnings" || result?.status === "idempotent_replay") {
        succeededIds.add(current.id);
      } else if (!result && batchError) {
        current.status = "importing";
        current.lastError = `连接暂时中断，后台将自动续接：${batchError}`;
        current.updatedAt = new Date().toISOString();
      } else {
        current.status = "failed";
        current.lastError = result?.error || result?.errors?.[0]?.message || result?.status || batchError || "标准导入未返回该链接的结果。";
        current.brokerClientRequestId = null;
        current.updatedAt = new Date().toISOString();
      }
    }
    if (succeededIds.size) {
      this.settings.pendingImports = this.settings.pendingImports.filter((item) => !succeededIds.has(item.id));
      await this.syncRecords({ save: false });
    }
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
    const failed = items.length - succeededIds.size;
    const warnings = (batch?.results || []).filter((result) => result.receipt?.quality_status === "warning").length;
    if (batchError && succeededIds.size === 0) {
      this.schedulePendingImportResume();
      new Notice("导入连接暂时中断；任务已持久化并将在后台自动续接。");
      return;
    }
    new Notice(failed
      ? `标准导入完成：成功 ${succeededIds.size}${warnings ? `（其中 ${warnings} 份 Markdown 有瑕疵）` : ""}，失败 ${failed}；失败项已保留。`
      : warnings
        ? `标准导入完成：${succeededIds.size} 个链接已进入阅读区，其中 ${warnings} 份 Markdown 有瑕疵，请复核。`
        : `标准导入完成：${succeededIds.size} 个链接已进入阅读区。`);
  }

  async importLinkToReading(url: string, options?: { syncAndRefresh?: boolean }): Promise<LinkImportResult> {
    const normalizedUrl = normalizeExternalUrl(url);
    if (!normalizedUrl) {
      new Notice("没有识别到有效链接。");
      return { ok: false, error: "没有识别到有效链接。" };
    }
    new Notice(`开始标准导入链接：${truncate(normalizedUrl, 80)}`);
    let batch: LinkImportBatchResponse;
    try {
      batch = await this.importLinksToReading([normalizedUrl]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`链接导入失败：${message}`);
      return { ok: false, error: message };
    }
    const result = batch.results[0];
    if (!result || !new Set(["imported", "imported_with_warnings", "idempotent_replay"]).has(result.status)) {
      const message = result?.error || result?.errors?.[0]?.message || result?.status || "标准导入未返回结果。";
      new Notice(`链接导入失败：${message}`);
      return { ok: false, error: message };
    }
    new Notice(result.receipt?.quality_status === "warning"
      ? "链接已导入阅读区，但生成的 Markdown 有瑕疵，请复核。正在刷新阅读池。"
      : "链接已按标准格式导入阅读区。正在刷新阅读池。");
    if (options?.syncAndRefresh !== false) {
      await this.syncRecords();
      await this.refreshViews();
    }
    return { ok: true, error: null };
  }

  async requestBrowserImportApi(pathValue: string, options?: { method?: string; body?: string }) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const port = await this.resolveLocalIrServicePort();
        const response = await requestUrl({
          url: `http://127.0.0.1:${port}${pathValue}`,
          method: options?.method || "GET",
          ...(options?.body ? { headers: { "Content-Type": "application/json" }, body: options.body } : {})
        });
        if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
          throw new Error(`本地服务暂时不可用（HTTP ${response.status}）。`);
        }
        return response;
      } catch (error) {
        lastError = error;
        this.localIrServicePort = null;
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 300 * (2 ** (attempt - 1))));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || "本地服务请求失败。"));
  }

  async importLinksToReading(urls: string[], options?: { clientRequestId?: string }): Promise<LinkImportBatchResponse> {
    const normalizedUrls = extractExternalUrls(urls.join("\n"));
    if (!normalizedUrls.length) throw new Error("没有识别到有效链接。");
    const clientRequestId = options?.clientRequestId
      || `obsidian-local-ir-${Date.now()}-${shortHash(normalizedUrls.slice().sort().join("\n"))}`;
    const createdResponse = await this.requestBrowserImportApi("/api/browser-import/requests", {
      method: "POST",
      body: JSON.stringify({ urls: normalizedUrls, source: "obsidian_local_ir", client_request_id: clientRequestId })
    });
    const created = createdResponse.json as Partial<BrowserImportRequestResponse> & { error?: unknown };
    if (createdResponse.status < 200 || createdResponse.status >= 300) {
      throw new Error(String(created?.error || `本地服务返回 HTTP ${createdResponse.status}`));
    }
    if (!created.request_id) throw new Error("本地服务未返回浏览器导入请求 ID。");
    new Notice(`已提交 ${normalizedUrls.length} 个链接，等待后台静默抓取与标准加工。`);

    const deadline = Date.now() + 35 * 60 * 1000;
    let lastTransientError = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      let statusResponse;
      try {
        statusResponse = await this.requestBrowserImportApi(`/api/browser-import/requests/${encodeURIComponent(created.request_id)}`);
        lastTransientError = "";
      } catch (error) {
        lastTransientError = error instanceof Error ? error.message : String(error);
        continue;
      }
      const status = statusResponse.json as Partial<BrowserImportRequestResponse> & { error?: unknown };
      if (statusResponse.status < 200 || statusResponse.status >= 300) {
        throw new Error(String(status?.error || `导入状态查询返回 HTTP ${statusResponse.status}`));
      }
      if (!status.terminal) continue;
      if (!Array.isArray(status.results) || typeof status.imported !== "number" || typeof status.failed !== "number") {
        throw new Error("本地服务返回了无效的浏览器导入回执。");
      }
      return {
        status: status.status || "failed",
        requested: Number(status.requested || normalizedUrls.length),
        imported: status.imported,
        failed: status.failed,
        degraded: Number(status.degraded || 0),
        warnings: Number(status.warnings || 0),
        concurrency: Math.max(1, Number(status.concurrency || 1)),
        results: status.results.filter((item): item is LinkImportBatchItem => new Set([
          "imported",
          "imported_with_warnings",
          "idempotent_replay",
          "failed",
          "requires_browser_auth",
          "requires_js_render"
        ]).has(item.status))
      };
    }
    throw new Error(`等待后台 URL 导入超时；请确认本地渐进阅读服务正在运行。${lastTransientError ? ` 最近错误：${lastTransientError}` : ""}`);
  }

  async resolveLocalIrServicePort(): Promise<number> {
    const candidates = [
      ...(this.localIrServicePort ? [this.localIrServicePort] : []),
      ...Array.from({ length: LOCAL_IR_SERVICE_PORT_END - LOCAL_IR_SERVICE_PORT_START + 1 }, (_value, index) => LOCAL_IR_SERVICE_PORT_START + index)
    ];
    for (const port of [...new Set(candidates)]) {
      try {
        const response = await requestUrl({ url: `http://127.0.0.1:${port}/api/highlights/health`, method: "GET" });
        if (response.status === 200 && response.json?.service === "local-ir-browser-highlight") {
          this.localIrServicePort = port;
          return port;
        }
      } catch {
        // Probe the next bounded local port.
      }
    }
    throw new Error(`本地渐进阅读服务不可用（端口 ${LOCAL_IR_SERVICE_PORT_START}-${LOCAL_IR_SERVICE_PORT_END}）。`);
  }

  async highlightSelection(editor: Editor, file: TFile | null, openModal: boolean, capturedSelection?: EditorSelection | null, forceVirtual = false) {
    if (!file) return;
    if (this.isRecordFrozenForExport(file.path)) return;
    const workingFile = await this.ensureFileInReadingPool(file);
    if (!workingFile) {
      return;
    }

    const selection = capturedSelection ?? getNormalizedSelection(editor);
    if (!selection) return;
    if (!selection.text.trim()) return;

    if (!this.settings.records[workingFile.path]) {
      this.settings.records[workingFile.path] = await this.createRecord(workingFile);
    }

    const markKind: AnnotationMarkKind = this.settings.clozeModeEnabled ? "cloze" : "highlight";
    const content = editor.getValue();
    if (this.isRecordFrozenForExport(workingFile.path)) return;
    const normalized = this.normalizeHighlightSelection(editor, content, selection, markKind, workingFile.path, forceVirtual);
    if (!normalized.selectedText.trim()) return;
    const wrapped = createWrappedHighlightText(normalized.id, normalized.selectedText, markKind);
    const hierarchy = resolveSelectionHierarchy(content, selection.fromOffset, selection.toOffset, selection.text);
    const existing = this.settings.annotations[normalized.id];
    const annotation = existing
      ? normalizeAnnotation(normalized.id, {
        ...existing,
        selectedText: normalized.selectedText,
        currentText: normalized.selectedText,
        sourceFormat: normalized.sourceFormat,
        renderMode: normalized.renderMode,
        protectedKind: normalized.protectedKind,
        markKind,
        orphaned: false,
        updatedAt: new Date().toISOString()
      })
      : this.createAnnotation(
        normalized.id,
        workingFile.path,
        normalized.selectedText,
        normalized.sourceFormat,
        normalized.fromOffset,
        createAnnotationAnchor(content, normalized.fromOffset, normalized.toOffset, normalized.selectedText, wrapped.fragments),
        wrapped.fragments,
        hierarchy,
        markKind
      );
    annotation.renderMode = normalized.renderMode;
    annotation.protectedKind = normalized.protectedKind;
    annotation.range = normalized.virtualRanges[0] ? { ...normalized.virtualRanges[0] } : null;
    annotation.virtualRanges = normalized.renderMode === "virtual_decoration" ? normalized.virtualRanges : [];
    annotation.lineRange = getLineRangeForOffsets(content, normalized.fromOffset, normalized.toOffset);
    annotation.sourceOffset = normalized.virtualRanges[0]?.start ?? normalized.fromOffset;
    annotation.anchor = createAnnotationAnchor(content, normalized.fromOffset, normalized.toOffset, normalized.selectedText, wrapped.fragments);
    annotation.fragments = normalized.virtualRanges.map((range, index) => ({
      index,
      text: stripIrMarkup(content.slice(range.start, range.end))
    }));
    annotation.scope = hierarchy.scope;
    annotation.headingPath = hierarchy.headingPath;
    annotation.expandedText = hierarchy.expandedText;
    annotation.expandedAnswerText = hierarchy.expandedAnswerText;
    annotation.subtreeRange = hierarchy.subtreeRange;

    if (normalized.renderMode === "virtual_decoration") {
      annotation.orphaned = false;
    } else {
      annotation.range = null;
      annotation.virtualRanges = [];
      annotation.lineRange = null;
    }
    const prior = Object.values(normalized.beforeAnnotations).filter((item): item is AnnotationRecord => Boolean(item));
    // Selection geometry is host-owned; source records are merged by the shared core.
    const incoming = { ...annotation, id: createAnnotationId(), originalText: selection.text,
      selectedText: selection.text, currentText: selection.text, commentMarkdown: "", rewriteMarkdown: "", hasRewrite: false,
      mergedSources: undefined, type: "highlight", rewriteApplied: false, createdAt: new Date().toISOString(),
      virtualRanges: [{ start: selection.fromOffset, end: selection.toOffset }],
      ranges: [{ start: selection.fromOffset, end: selection.toOffset }], fragments: [{ index: 0, text: selection.text }] };
    const result = LocalIrDocumentCore.addRecord(prior, prior.length ? incoming : annotation, {
      path: workingFile.path, mergeIds: normalized.overlappingIds,
      textForRange: (range: TextRange) => stripIrMarkup(content.slice(range.start, range.end))
    });
    const modalAnnotation = normalizeAnnotation(result.annotation.id, { ...annotation, ...result.annotation });
    const finalWrapped = createWrappedHighlightText(modalAnnotation.id, modalAnnotation.currentText, markKind);
    const nextContent = normalized.renderMode === "virtual_decoration" ? content
      : `${content.slice(0, normalized.fromOffset)}${finalWrapped.wrappedText}${content.slice(normalized.toOffset)}`;
    if (nextContent !== content) {
      editor.replaceRange(finalWrapped.wrappedText, normalized.from, normalized.to, "local-ir-highlight");
      modalAnnotation.range = null;
      modalAnnotation.virtualRanges = [];
      modalAnnotation.lineRange = null;
    }
    for (const oldId of normalized.overlappingIds) delete this.settings.annotations[oldId];
    this.settings.annotations[modalAnnotation.id] = modalAnnotation;
    this.clearVirtualHighlightRedoActions(workingFile.path);
    this.recentHighlightActions.push({
      kind: "merge",
      path: workingFile.path,
      beforeContent: content,
      afterContent: nextContent,
      beforeAnnotations: normalized.beforeAnnotations,
      change: LocalIrDocumentCore.createChange(prior, [modalAnnotation], "add"),
      mergedIds: [...normalized.overlappingIds, modalAnnotation.id].filter((item, index, array) => item && array.indexOf(item) === index)
    });
    this.recentHighlightActions = this.recentHighlightActions.slice(-20);
    this.refreshVirtualHighlights();
    await this.saveSettings();
    await this.refreshViews();

    if (openModal) {
      this.openAnnotationModal(modalAnnotation);
    } else {
      new Notice(normalized.renderMode === "virtual_decoration" ? "已创建特殊格式高亮。" : markKind === "cloze" ? "已挖空标注选区。" : normalized.overlappingIds.length > 0 ? "已合并重叠高亮。" : "已高亮选区。");
    }
  }

  async undoRecentHighlight() {
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (!activePath) {
      new Notice("当前没有可撤销高亮的 Markdown 文件。");
      return;
    }
    while (true) {
      const actionIndex = findLastIndex(this.recentHighlightActions, (action) => action.path === activePath);
      if (actionIndex < 0) break;
      const action = this.recentHighlightActions[actionIndex];
      if (action.kind === "merge") {
        if (this.isRecordFrozenForExport(activePath)) return;
        if (action.change) {
          const currentContent = this.getActiveEditorForPath(activePath)?.getValue() ?? await this.readVaultFile(activePath);
          if (currentContent !== action.afterContent) { new Notice("正文已变化，无法撤销过期操作。"); return; }
          let restoredRecords;
          try { restoredRecords = LocalIrDocumentCore.applyChange(Object.values(this.settings.annotations), action.change, "backward", { path: activePath }); }
          catch { new Notice("加工记录已变化，无法撤销过期操作。"); return; }
          if (action.beforeContent !== action.afterContent) await this.updateContentInEditorOrFile(action.path, () => action.beforeContent);
          this.settings.annotations = Object.fromEntries(restoredRecords.map((record: AnnotationRecord) => [record.id, record]));
          this.recentHighlightActions.splice(actionIndex, 1);
          if (action.beforeContent === action.afterContent) {
            this.recentVirtualHighlightRedoActions.push({ ...action, afterAnnotations: action.change.after });
            this.recentVirtualHighlightRedoActions = this.recentVirtualHighlightRedoActions.slice(-20);
          }
          this.refreshVirtualHighlights(activePath);
          await this.saveSettings();
          await this.refreshViews();
          new Notice("已撤销最近加工操作。");
          return;
        }
        this.recentHighlightActions.splice(actionIndex, 1);
        const virtualOnly = action.beforeContent === action.afterContent;
        const afterAnnotations = virtualOnly
          ? captureAnnotationSnapshot(this.settings.annotations, [...Object.keys(action.beforeAnnotations), ...action.mergedIds])
          : null;
        const restored = virtualOnly ? false : await this.updateContentInEditorOrFile(action.path, (content) => {
          if (content === action.afterContent) return action.beforeContent;
          return content.includes(action.afterContent) ? content.replace(action.afterContent, action.beforeContent) : content;
        });
        for (const [id, annotation] of Object.entries(action.beforeAnnotations)) {
          if (annotation) {
            this.settings.annotations[id] = annotation;
          } else {
            delete this.settings.annotations[id];
          }
        }
        if (virtualOnly || restored || Object.keys(action.beforeAnnotations).length > 0) {
          if (virtualOnly && afterAnnotations) {
            this.recentVirtualHighlightRedoActions.push({ ...action, afterAnnotations });
            this.recentVirtualHighlightRedoActions = this.recentVirtualHighlightRedoActions.slice(-20);
          }
          this.refreshVirtualHighlights(activePath);
          await this.saveSettings();
          await this.refreshViews();
          new Notice(virtualOnly ? "已撤销最近虚拟高亮。" : restored ? "已撤销最近合并。" : "已恢复最近合并记录。");
          return;
        }
        continue;
      }

      this.recentHighlightActions.splice(actionIndex, 1);
      const removed = await this.replaceFirstInEditorOrFile(action.path, action.wrappedText, action.selectedText);
      const hadAnnotation = Boolean(this.settings.annotations[action.id]);
      delete this.settings.annotations[action.id];
      if (removed || hadAnnotation) {
        this.refreshVirtualHighlights(activePath);
        await this.saveSettings();
        await this.refreshViews();
        new Notice(removed ? "已撤销最近高亮。" : "已清理最近高亮记录。");
        return;
      }
    }
    new Notice("当前文件没有可撤销的插件高亮。");
  }

  handleVirtualHighlightUndoShortcut(view: EditorView, event: KeyboardEvent): boolean {
    if (!isPlainUndoShortcut(event)) return false;
    const path = getEditorViewPath(view);
    if (!path) return false;
    const actionIndex = findLastIndex(this.recentHighlightActions, (action) => action.path === path);
    const action = actionIndex >= 0 ? this.recentHighlightActions[actionIndex] : undefined;
    if (!isUndoableVirtualHighlightAction(action, path, view.state.doc.toString())) return false;
    event.preventDefault();
    event.stopPropagation();
    void this.undoRecentHighlight();
    return true;
  }

  handleVirtualHighlightRedoShortcut(view: EditorView, event: KeyboardEvent): boolean {
    if (!isPlainRedoShortcut(event)) return false;
    const path = getEditorViewPath(view);
    if (!path) return false;
    const actionIndex = findLastIndex(this.recentVirtualHighlightRedoActions, (action) => action.path === path);
    const action = actionIndex >= 0 ? this.recentVirtualHighlightRedoActions[actionIndex] : undefined;
    if (!isUndoableVirtualHighlightAction(action, path, view.state.doc.toString())) return false;
    event.preventDefault();
    event.stopPropagation();
    void this.redoRecentVirtualHighlight(path);
    return true;
  }

  async redoRecentVirtualHighlight(path: string) {
    if (this.app.workspace.getActiveFile()?.path !== path) return;
    if (this.isRecordFrozenForExport(path)) return;
    const actionIndex = findLastIndex(this.recentVirtualHighlightRedoActions, (action) => action.path === path);
    if (actionIndex < 0) return;
    const action = this.recentVirtualHighlightRedoActions[actionIndex];
    const editor = this.getActiveEditorForPath(path);
    const content = editor?.getValue() ?? await this.readVaultFile(path);
    if (content === null || !isUndoableVirtualHighlightAction(action, path, content)) return;
    const change = action.change || LocalIrDocumentCore.createChange(Object.values(action.beforeAnnotations).filter(Boolean), Object.values(action.afterAnnotations).filter(Boolean));
    try {
      const restored = LocalIrDocumentCore.applyChange(Object.values(this.settings.annotations), change, "forward", { path });
      this.settings.annotations = Object.fromEntries(restored.map((record: AnnotationRecord) => [record.id, record]));
    } catch { new Notice("加工记录已变化，无法重做过期操作。"); return; }
    this.recentVirtualHighlightRedoActions.splice(actionIndex, 1);
    const { afterAnnotations: _afterAnnotations, ...undoAction } = action;
    this.recentHighlightActions.push(undoAction);
    this.recentHighlightActions = this.recentHighlightActions.slice(-20);
    this.refreshVirtualHighlights(path);
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已重做最近虚拟高亮。");
  }

  clearVirtualHighlightRedoActions(path: string) {
    this.recentVirtualHighlightRedoActions = this.recentVirtualHighlightRedoActions.filter((action) => action.path !== path);
  }

  scheduleReconcile(path: string, content: string) {
    window.clearTimeout(this.reconcileTimers[path]);
    this.reconcileTimers[path] = window.setTimeout(() => {
      void this.reconcileAnnotationsForPath(path, content);
    }, 300);
  }

  async reconcileAnnotationsForPath(path: string, content?: string) {
    const source = content ?? await this.readVaultFile(path);
    if (source === null) return;
    const repaired = await this.repairDangerousMarksForPath(path, { content: source, silent: true, refresh: false });
    if (repaired) return;

    let changed = false;
    for (const annotation of Object.values(this.settings.annotations)) {
      if (annotation.path !== path && annotation.lastKnownPath !== path) continue;
      if (annotation.sourceFormat !== "mark") continue;

      const exists = source.includes(`data-ir-id="${annotation.id}"`);
      if (exists) {
        if (annotation.orphaned) {
          annotation.orphaned = false;
          changed = true;
        }
        continue;
      }

      if (hasAnnotationWork(annotation)) {
        if (!annotation.orphaned) {
          annotation.orphaned = true;
          annotation.updatedAt = new Date().toISOString();
          changed = true;
        }
      } else {
        delete this.settings.annotations[annotation.id];
        changed = true;
      }
    }

    if (changed) {
      this.refreshVirtualHighlights(path);
      await this.saveSettings();
      await this.refreshViews();
    }
  }

  async repairActiveFileDangerousMarks() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("当前没有打开的 Markdown 文件。");
      return;
    }
    const changed = await this.repairDangerousMarksForPath(file.path, { silent: false, refresh: true });
    if (!changed) new Notice("当前文件没有需要修复的危险高亮。");
  }

  async repairDangerousMarksForPath(path: string, options?: { content?: string; silent?: boolean; refresh?: boolean }): Promise<boolean> {
    const content = options?.content ?? this.getActiveEditorForPath(path)?.getValue() ?? await this.readVaultFile(path);
    if (content === null) return false;
    const dangerousRanges = findAllMarkRanges(content).filter((range) => isDangerousMarkedRange(range, content));
    if (dangerousRanges.length === 0) return false;

    const { nextContent, groups } = stripMarkedRangesAndTrack(content, dangerousRanges);
    if (nextContent === content) return false;
    await this.updateContentInEditorOrFile(path, () => nextContent);
    const now = new Date().toISOString();
    for (const group of groups) {
      const existing = this.settings.annotations[group.id];
      const firstRange = group.ranges[0];
      const lastRange = group.ranges[group.ranges.length - 1];
      const selectedText = group.ranges.map((range) => nextContent.slice(range.start, range.end)).join("\n\n");
      const protectedKind = detectProtectedKindForSelection(nextContent, firstRange.start, lastRange.end, selectedText) || group.protectedKind;
      const fragments = group.ranges.map((range, index) => ({ index, text: nextContent.slice(range.start, range.end) }));
      const base = existing || this.createAnnotation(group.id, path, selectedText, "virtual", firstRange.start, null, fragments, createSelectionHierarchy(selectedText), group.markKind);
      this.settings.annotations[group.id] = normalizeAnnotation(group.id, {
        ...base,
        id: group.id,
        path,
        selectedText,
        currentText: selectedText,
        sourceFormat: "virtual",
        renderMode: "virtual_decoration",
        protectedKind,
        sourceOffset: firstRange.start,
        range: { ...firstRange },
        virtualRanges: group.ranges,
        lineRange: getLineRangeForOffsets(nextContent, firstRange.start, lastRange.end),
        fragments,
        anchor: createAnnotationAnchor(nextContent, firstRange.start, lastRange.end, selectedText, fragments),
        orphaned: false,
        lastKnownPath: path,
        updatedAt: now
      });
    }
    this.refreshVirtualHighlights();
    await this.saveSettings();
    if (options?.refresh !== false) await this.refreshViews();
    if (!options?.silent) new Notice(`已修复 ${groups.length} 组危险高亮。`);
    return true;
  }

  async getLegacyHighlightsForPath(path: string): Promise<LegacyHighlight[]> {
    const content = await this.readVaultFile(path);
    if (content === null) return [];
    return scanLegacyHighlights(path, content);
  }

  async upgradeLegacyHighlight(annotation: AnnotationRecord): Promise<AnnotationRecord | null> {
    const searchText = `==${annotation.originalText}==`;
    const wrapped = createWrappedHighlightText(annotation.id, annotation.currentText, annotation.markKind);
    const replacement = wrapped.wrappedText;
    const replaced = await this.replaceFirstInEditorOrFile(annotation.path, searchText, replacement, annotation.sourceOffset);
    if (!replaced) return null;
    return {
      ...annotation,
      sourceFormat: "mark",
      selectedText: annotation.currentText,
      fragments: wrapped.fragments,
      orphaned: false,
      lastKnownPath: annotation.path,
      sourceOffset: null,
      updatedAt: new Date().toISOString()
    };
  }

  async replaceAnnotationText(path: string, id: string, nextText: string): Promise<boolean> {
    const editor = this.getActiveEditorForPath(path);
    if (editor) {
      const current = editor.getValue();
      if (!hasMarkId(current, id)) return false;
      const range = findMarkedTextRange(current, id);
      if (!range) return false;
      const markKind = this.settings.annotations[id]?.markKind || "highlight";
      const replacement = createWrappedHighlightText(id, nextText, markKind).wrappedText;
      editor.replaceRange(replacement, editor.offsetToPos(range.start), editor.offsetToPos(range.end), "local-ir-replace-mark");
      return true;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const current = await this.app.vault.read(file);
    if (!hasMarkId(current, id)) return false;
    const next = replaceMarkedText(current, id, nextText);
    if (next !== current) await this.app.vault.modify(file, next);
    return true;
  }

  async replaceFirstInEditorOrFile(path: string, search: string, replacement: string, expectedOffset?: number | null): Promise<boolean> {
    const editor = this.getActiveEditorForPath(path);
    if (editor) {
      const content = editor.getValue();
      const offset = findSearchOffset(content, search, expectedOffset);
      if (offset < 0) return false;
      editor.replaceRange(replacement, editor.offsetToPos(offset), editor.offsetToPos(offset + search.length), "local-ir-replace");
      return true;
    }

    return this.updateContentInEditorOrFile(path, (content) => {
      const offset = findSearchOffset(content, search, expectedOffset);
      if (offset < 0) return content;
      return `${content.slice(0, offset)}${replacement}${content.slice(offset + search.length)}`;
    });
  }

  async updateContentInEditorOrFile(path: string, updater: (content: string) => string): Promise<boolean> {
    const editor = this.getActiveEditorForPath(path);
    if (editor) {
      const current = editor.getValue();
      const next = updater(current);
      if (next === current) return false;
      editor.setValue(next);
      return true;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const current = await this.app.vault.read(file);
    const next = updater(current);
    if (next === current) return false;
    await this.app.vault.modify(file, next);
    return true;
  }

  getActiveEditorForPath(path: string): Editor | null {
    const active = this.app.workspace.activeEditor;
    if (!active?.editor || active.file?.path !== path) return null;
    return active.editor;
  }

  refreshVirtualHighlights(expectedPath?: string) {
    this.refreshReadingHighlights();
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (expectedPath && activePath !== expectedPath) return;
    const editor = this.app.workspace.activeEditor?.editor;
    const view = getCodeMirrorView(editor || null);
    if (view) {
      view.dispatch({ effects: localIrRefreshEffect.of() });
    }
  }

  mapVirtualRangesForEditorChange(path: string, update: ViewUpdate) {
    let changed = false;
    for (const annotation of this.getAnnotationsForPath(path)) {
      if (annotation.renderMode !== "virtual_decoration" || annotation.orphaned) continue;
      const mapped = normalizeTextRanges(getAnnotationVirtualRanges(annotation)
        .map((range) => ({
          start: update.changes.mapPos(range.start, 1),
          end: update.changes.mapPos(range.end, -1)
        }))
        .filter((range) => range.end > range.start));
      if (sameTextRanges(mapped, getAnnotationVirtualRanges(annotation))) continue;
      annotation.virtualRanges = mapped;
      annotation.range = mapped[0] ? { ...mapped[0] } : null;
      annotation.sourceOffset = mapped[0]?.start ?? null;
      annotation.lineRange = mapped[0] ? getLineRangeForOffsets(update.state.doc.toString(), mapped[0].start, mapped[mapped.length - 1].end) : null;
      annotation.orphaned = mapped.length === 0;
      annotation.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (!changed) return;
    window.clearTimeout(this.virtualRangeSaveTimer);
    this.virtualRangeSaveTimer = window.setTimeout(() => void this.saveSettings(), 450);
  }

  async readVaultFile(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return this.app.vault.cachedRead(file);
  }

  async deleteAnnotation(id: string) {
    const annotation = this.settings.annotations[id];
    if (!annotation || annotation.archived) return;
    if (annotation && this.isRecordFrozenForExport(annotation.path)) {
      new Notice("导出包已冻结，当前加工记录不能删除。");
      return;
    }
    const content = this.getActiveEditorForPath(annotation.path)?.getValue() ?? await this.readVaultFile(annotation.path);
    if (content === null) return;
    const result = LocalIrDocumentCore.deleteRecords(Object.values(this.settings.annotations), [id], { path: annotation.path });
    this.settings.annotations = Object.fromEntries(result.records.map((record: AnnotationRecord) => [record.id, record]));
    this.clearVirtualHighlightRedoActions(annotation.path);
    this.recentHighlightActions.push({ kind: "merge", path: annotation.path, beforeContent: content, afterContent: content,
      beforeAnnotations: result.change.before, mergedIds: [id], change: result.change });
    this.recentHighlightActions = this.recentHighlightActions.slice(-20);
    this.refreshVirtualHighlights(annotation?.path);
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已删除高亮加工记录。");
  }

  async rebindAnnotationToSelection(annotation: AnnotationRecord) {
    const active = this.app.workspace.activeEditor;
    if (!active?.editor || !active.file) {
      new Notice("当前没有可用选区。");
      return;
    }

    const selection = getNormalizedSelection(active.editor);
    const selectedText = selection?.text || "";
    if (!selectedText.trim()) {
      new Notice("请先选中要重新绑定的文本。");
      return;
    }

    const wrapped = createWrappedHighlightText(annotation.id, selectedText, annotation.markKind);
    const content = active.editor.getValue();
    const anchor = createAnnotationAnchor(content, selection!.fromOffset, selection!.toOffset, selectedText, wrapped.fragments);
    const hierarchy = resolveSelectionHierarchy(content, selection!.fromOffset, selection!.toOffset, selectedText);
    const useVirtual = this.settings.alwaysVirtualHighlightsEnabled;
    if (!useVirtual) active.editor.replaceRange(wrapped.wrappedText, selection!.from, selection!.to, "local-ir-rebind");
    const next = normalizeAnnotation(annotation.id, {
      ...annotation,
      path: active.file.path,
      lastKnownPath: active.file.path,
      selectedText,
      currentText: selectedText,
      sourceFormat: useVirtual ? "virtual" : "mark",
      renderMode: useVirtual ? "virtual_decoration" : "inline_mark",
      orphaned: false,
      sourceOffset: selection!.fromOffset,
      range: useVirtual ? { start: selection!.fromOffset, end: selection!.toOffset } : null,
      virtualRanges: useVirtual ? [{ start: selection!.fromOffset, end: selection!.toOffset }] : [],
      anchor,
      fragments: wrapped.fragments,
      scope: hierarchy.scope,
      headingPath: hierarchy.headingPath,
      expandedText: hierarchy.expandedText,
      expandedAnswerText: hierarchy.expandedAnswerText,
      subtreeRange: hierarchy.subtreeRange
    });
    this.settings.annotations[annotation.id] = next;
    this.refreshVirtualHighlights(active.file.path);
    await this.saveSettings();
    await this.refreshViews();
    new Notice("已重新绑定到当前选区。");
  }

  createAnnotation(
    id: string,
    path: string,
    selectedText: string,
    sourceFormat: AnnotationSourceFormat = "mark",
    sourceOffset: number | null = null,
    anchor: AnnotationAnchor | null = null,
    fragments: AnnotationFragment[] = [],
    hierarchy: HierarchyContext | null = null,
    markKind: AnnotationMarkKind = "highlight"
  ): AnnotationRecord {
    const now = new Date().toISOString();
    const normalizedFragments = fragments.length > 0 ? fragments : [{ index: 0, text: selectedText }];
    const normalizedHierarchy = hierarchy || createSelectionHierarchy(selectedText);
    return {
      id,
      path,
      selectedText,
      sourceFormat,
      renderMode: sourceFormat === "virtual" ? "virtual_decoration" : "inline_mark",
      protectedKind: null,
      markKind,
      originalText: selectedText,
      currentText: selectedText,
      type: "highlight",
      commentMarkdown: "",
      rewriteMarkdown: "",
      hasRewrite: false,
      rewriteApplied: false,
      orphaned: false,
      lastKnownPath: path,
      sourceOffset,
      range: null,
      virtualRanges: [],
      lineRange: null,
      anchor,
      fragments: normalizedFragments,
      scope: normalizedHierarchy.scope,
      headingPath: normalizedHierarchy.headingPath,
      expandedText: normalizedHierarchy.expandedText,
      expandedAnswerText: normalizedHierarchy.expandedAnswerText,
      subtreeRange: normalizedHierarchy.subtreeRange,
      createdAt: now,
      updatedAt: now,
      archived: false
    };
  }

  getArchiveExportPath(record: DocRecord): string {
    const folder = normalizePath(this.settings.archiveFolder || DEFAULT_ARCHIVE_FOLDER);
    const fileName = `${sanitizeFileName(record.title)}--${shortHash(record.path)}.md`;
    return normalizePath(`${folder}/${fileName}`);
  }

  getArchiveImportPath(record: DocRecord): string {
    return this.getArchiveExportPath(record).replace(/\.md$/i, ".json");
  }

  getRefinedReadingPath(record: DocRecord): string {
    const folder = normalizePath(this.settings.refinedReadingFolder || DEFAULT_REFINED_READING_FOLDER);
    const fileName = `${sanitizeFileName(record.title)}--精炼摘录--${shortHash(record.path)}.md`;
    return normalizePath(`${folder}/${fileName}`);
  }

  getQuestionQueueJsonPath(record: DocRecord): string {
    const folder = normalizePath(this.settings.questionQueueFolder || DEFAULT_QUESTION_QUEUE_FOLDER);
    const fileName = `${sanitizeFileName(record.title)}--提问队列--${shortHash(record.path)}.json`;
    return normalizePath(`${folder}/${fileName}`);
  }

  getQuestionQueueMarkdownPath(record: DocRecord): string {
    return this.getQuestionQueueJsonPath(record).replace(/\.json$/i, ".md");
  }

  getSourceArchiveTargetPath(record: DocRecord): string {
    const archiveFolder = normalizePath(this.settings.sourceArchiveFolder || DEFAULT_SOURCE_ARCHIVE_FOLDER);
    const sourcePath = normalizePath(record.path);
    const relativePath = this.getRelativePathForManagedSource(sourcePath, record);

    return this.getUniqueVaultPath(normalizePath(`${archiveFolder}/${relativePath}`));
  }

  getCompletedSourceTargetPath(record: DocRecord): string {
    const folder = normalizePath(this.settings.completedSourceFolder || DEFAULT_COMPLETED_SOURCE_FOLDER);
    const sourcePath = normalizePath(record.path);
    const relativePath = this.getRelativePathForManagedSource(sourcePath, record);
    return this.getUniqueVaultPath(normalizePath(`${folder}/${relativePath}`));
  }

  getRemoveFromReadingTargetPath(record: DocRecord): string {
    const originalPath = normalizePath(record.movedIntoReadingPoolFromPath || "");
    if (originalPath && !this.isPathInReadingPool(originalPath)) {
      return this.getUniqueVaultPath(originalPath);
    }
    const folder = normalizePath(this.settings.removedReadingFolder || DEFAULT_REMOVED_READING_FOLDER);
    const sourcePath = normalizePath(record.path);
    const relativePath = this.getRelativePathForManagedSource(sourcePath, record);
    return this.getUniqueVaultPath(normalizePath(`${folder}/${relativePath}`));
  }

  getRelativePathForManagedSource(sourcePath: string, record: DocRecord): string {
    const fallback = sourcePath.split("/").pop() || `${sanitizeFileName(record.title)}.md`;
    const baseFolders = uniqueNormalizedPaths([
      ...this.getReadingFolders(),
      this.settings.completedSourceFolder || DEFAULT_COMPLETED_SOURCE_FOLDER,
      this.settings.sourceArchiveFolder || DEFAULT_SOURCE_ARCHIVE_FOLDER,
      this.settings.removedReadingFolder || DEFAULT_REMOVED_READING_FOLDER
    ]);
    for (const folder of baseFolders) {
      if (sourcePath === folder) return fallback;
      if (folder && sourcePath.startsWith(`${folder}/`)) return sourcePath.slice(folder.length + 1);
    }
    return fallback;
  }

  getRestoreSourceTargetPath(record: DocRecord): string {
    if (record.status === "done" || record.status === "export_package_ready") {
      const completedPath = normalizePath(record.readingPathBeforeCompletion || record.originalSourcePath || "");
      if (completedPath) return this.getUniqueVaultPath(completedPath);
      const readingFolder = this.getPrimaryReadingFolder();
      return this.getUniqueVaultPath(normalizePath(`${readingFolder}/${record.path.split("/").pop() || `${sanitizeFileName(record.title)}.md`}`));
    }

    const originalSourcePath = normalizePath(record.originalSourcePath || "");
    if (originalSourcePath) return this.getUniqueVaultPath(originalSourcePath);

    const readingFolder = this.getPrimaryReadingFolder();
    const archiveFolder = normalizePath(this.settings.sourceArchiveFolder || DEFAULT_SOURCE_ARCHIVE_FOLDER);
    const currentPath = normalizePath(record.path);
    let relativePath = currentPath.split("/").pop() || `${sanitizeFileName(record.title)}.md`;

    if (archiveFolder && currentPath.startsWith(`${archiveFolder}/`)) {
      relativePath = currentPath.slice(archiveFolder.length + 1);
    }

    return this.getUniqueVaultPath(normalizePath(`${readingFolder}/${relativePath}`));
  }

  createArchiveAnnotationPayload(annotation: AnnotationRecord, index: number, sourceContent: string | null): ArchiveAnnotationPayload {
    const route = getAnnotationRoute(annotation);
    const originalText = annotation.originalText || annotation.selectedText;
    const currentText = annotation.currentText || annotation.selectedText || originalText;
    const hierarchy = sourceContent ? resolveAnnotationHierarchy(sourceContent, annotation) : createSelectionHierarchy(currentText);
    const expandedText = hierarchy.expandedText || currentText;
    const expandedAnswerText = hierarchy.expandedAnswerText || expandedText;
    const bilingual = resolveBilingualMatch(sourceContent, annotation);
    return {
      index: index + 1,
      id: annotation.id,
      type: annotation.type,
      typeLabel: ANNOTATION_LABELS[annotation.type],
      route,
      targetDocument: route === "remnote" ? getRemNoteTargetDocument(annotation) : route === "remnote_card" ? "问答卡" : null,
      importable: route === "remnote",
      highlightOnly: route === "refined_reading",
      sourceFormat: annotation.sourceFormat,
      renderMode: annotation.renderMode,
      protectedKind: annotation.protectedKind,
      markKind: annotation.markKind,
      orphaned: annotation.orphaned,
      rewriteApplied: annotation.rewriteApplied,
      originalText,
      currentText,
      commentMarkdown: annotation.commentMarkdown,
      rewriteMarkdown: annotation.rewriteMarkdown,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
      archived: false,
      anchor: annotation.anchor,
      range: annotation.range,
      lineRange: annotation.lineRange,
      fragments: annotation.fragments,
      scope: hierarchy.scope,
      headingPath: hierarchy.headingPath,
      expandedText,
      expandedAnswerText,
      subtreeRange: hierarchy.subtreeRange,
      bilingual
    };
  }

  createArchiveQaCardPayloads(record: DocRecord, qaCards: QaCardRecord[], annotations: ArchiveAnnotationPayload[], sourceContent: string): ArchiveQaCardPayload[] {
    const cards: ArchiveQaCardPayload[] = [];
    for (const card of qaCards) {
      const questionMarkdown = card.questionMarkdown.trim();
      const answerMarkdown = card.answerMarkdown.trim();
      const needsAnswerGeneration = Boolean(card.needsAnswerGeneration || !answerMarkdown);
      const payload = this.createArchiveQaCardPayload(record, card, cards.length + 1, {
        questionMarkdown,
        answerMarkdown,
        answerSourceText: needsAnswerGeneration ? stripIrMarkup(sourceContent).trim() : card.answerSourceText,
        needsQuestionGeneration: !questionMarkdown,
        needsAnswerGeneration,
        scope: "selection",
        headingPath: [],
        sourceAnnotationId: null
      });
      cards.push(payload);
    }

    for (const annotation of annotations.filter((item) => shouldCreateQaCardFromAnnotation(item))) {
      const question = resolveQaQuestion(annotation);
      const answer = (annotation.expandedAnswerText || annotation.expandedText || annotation.currentText || annotation.originalText || "").trim();
      const payload = this.createArchiveQaCardPayload(record, {
        id: annotation.id,
        path: record.path,
        source: "annotation",
        sourceAnnotationId: annotation.id,
        questionMarkdown: question,
        answerMarkdown: answer,
        answerSourceText: annotation.expandedText || answer,
        needsQuestionGeneration: !question,
        needsAnswerGeneration: !answer,
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt,
        archived: false
      }, cards.length + 1, {
        questionMarkdown: question,
        answerMarkdown: answer,
        answerSourceText: annotation.expandedText || answer,
        needsQuestionGeneration: !question,
        needsAnswerGeneration: !answer,
        scope: annotation.scope,
        headingPath: annotation.headingPath,
        sourceAnnotationId: annotation.id
      });
      cards.push(payload);
    }

    return cards;
  }

  createArchiveClozeCardPayloads(record: DocRecord, annotations: ArchiveAnnotationPayload[]): ArchiveClozeCardPayload[] {
    return annotations
      .filter((annotation) => annotation.markKind === "cloze")
      .map((annotation, index) => {
        const contextText = stripIrMarkup(annotation.expandedText || annotation.currentText || annotation.originalText).trim();
        const answerText = stripIrMarkup(annotation.currentText || annotation.originalText).trim();
        return {
          index: index + 1,
          id: `ir-cloze-${annotation.id}`,
          sourceAnnotationId: annotation.id,
          status: "pending",
          sourcePath: record.originalSourcePath || record.path,
          sourceTitle: record.title,
          scope: annotation.scope,
          headingPath: annotation.headingPath,
          contextText,
          answerText,
          clozeMarkdown: renderClozeMarkdown(contextText, answerText),
          createdAt: annotation.createdAt,
          updatedAt: annotation.updatedAt,
          archived: false
        };
      });
  }

  createArchiveArticleMusingPayloads(path: string): ArchiveArticleMusingPayload[] {
    const musing = this.settings.articleMusings[path];
    if (!musing || !musing.bodyMarkdown.trim()) return [];
    return [{
      index: 1,
      id: musing.id,
      path: musing.path,
      bodyMarkdown: musing.bodyMarkdown.trim(),
      aiStatus: musing.aiStatus || "pending",
      createdAt: musing.createdAt,
      updatedAt: musing.updatedAt,
      archived: false
    }];
  }

  createArchiveQaCardPayload(record: DocRecord, card: Partial<QaCardRecord>, index: number, options: {
    questionMarkdown: string;
    answerMarkdown: string;
    answerSourceText: string;
    needsQuestionGeneration: boolean;
    needsAnswerGeneration: boolean;
    scope: HierarchyScope;
    headingPath: string[];
    sourceAnnotationId: string | null;
  }): ArchiveQaCardPayload {
    const questionMarkdown = options.questionMarkdown.trim();
    const answerMarkdown = options.answerMarkdown.trim();
    return {
      index,
      id: card.id || createQaCardId(),
      source: card.source || "article",
      sourceAnnotationId: options.sourceAnnotationId,
      status: "pending",
      questionMarkdown,
      answerMarkdown,
      answerSourceText: options.answerSourceText,
      needsQuestionGeneration: Boolean(options.needsQuestionGeneration || !questionMarkdown),
      needsAnswerGeneration: Boolean(options.needsAnswerGeneration || !answerMarkdown),
      headingPath: options.headingPath,
      scope: options.scope,
      sourcePath: record.originalSourcePath || record.path,
      sourceTitle: record.title,
      createdAt: card.createdAt || new Date().toISOString(),
      updatedAt: card.updatedAt || card.createdAt || new Date().toISOString(),
      archived: false,
      cardMarkdown: renderRemNoteMultiLineCard(questionMarkdown || "待生成问题", answerMarkdown || options.answerSourceText || "待生成答案")
    };
  }

  renderArchiveExport(record: DocRecord, annotations: ArchiveAnnotationPayload[], qaCards: ArchiveQaCardPayload[], clozeCards: ArchiveClozeCardPayload[], articleMusings: ArchiveArticleMusingPayload[]): string {
    const sourcePath = record.originalSourcePath || record.path;
    const lines = [
      `# ${record.title}`,
      "",
      `- source path: ${sourcePath}`,
      `- final archive target: ${record.archivedSourcePath || ""}`,
      `- exportPackageReadyAt: ${record.exportPackageReadyAt || new Date().toISOString()}`,
      `- status: export_package_ready`,
      "",
      "## 高亮加工",
      ""
    ];

    if (annotations.length === 0) {
      lines.push("暂无高亮加工记录。", "");
    } else {
      annotations.forEach((annotation, index) => {
        lines.push(`### ${index + 1}. ${ANNOTATION_LABELS[annotation.type]}`);
        lines.push("");
        lines.push(`- id: ${annotation.id}`);
        lines.push(`- route: ${annotation.route}`);
        if (annotation.targetDocument) lines.push(`- targetDocument: ${annotation.targetDocument}`);
        lines.push(`- sourceFormat: ${annotation.sourceFormat}`);
        lines.push(`- renderMode: ${annotation.renderMode}`);
        if (annotation.protectedKind) lines.push(`- protectedKind: ${annotation.protectedKind}`);
        lines.push(`- markKind: ${annotation.markKind}`);
        lines.push(`- orphaned: ${annotation.orphaned ? "true" : "false"}`);
        lines.push(`- rewriteApplied: ${annotation.rewriteApplied ? "true" : "false"}`);
        if (annotation.scope !== "selection") {
          lines.push(`- scope: ${annotation.scope}`);
          if (annotation.headingPath.length > 0) lines.push(`- headingPath: ${annotation.headingPath.join(" > ")}`);
        }
        if (annotation.bilingual.detected) {
          lines.push(`- bilingualConfidence: ${annotation.bilingual.confidence}`);
          lines.push(`- bilingualStrategy: ${annotation.bilingual.strategy}`);
        }
        if (annotation.type === "example_viewpoint") {
          lines.push("");
          lines.push("**例子**");
          lines.push("");
          lines.push(blockquote(annotation.expandedText || annotation.currentText));
          lines.push("");
          lines.push("**观点**");
          lines.push("");
          lines.push(annotation.commentMarkdown.trim() || "_待补充观点_");
        }
        lines.push("");
        lines.push("**原文高亮文本**");
        lines.push("");
        lines.push(blockquote(annotation.originalText));
        lines.push("");
        lines.push("**当前高亮文本**");
        lines.push("");
        lines.push(blockquote(annotation.currentText));
        if (annotation.scope !== "selection" && annotation.expandedText.trim()) {
          lines.push("");
          lines.push("**层级扩展内容**");
          lines.push("");
          lines.push(blockquote(annotation.expandedText));
        }
        if (annotation.bilingual.detected) {
          lines.push("");
          lines.push("**对应英文原文**");
          lines.push("");
          if (annotation.bilingual.englishText.trim()) {
            lines.push(blockquote(annotation.bilingual.englishText));
          } else {
            lines.push("_需要 API 对齐。候选如下：_");
            lines.push("");
            annotation.bilingual.candidates.slice(0, 3).forEach((candidate) => {
              lines.push(`- candidate ${candidate.index + 1}: ${candidate.text}`);
            });
          }
          if (annotation.bilingual.warning) {
            lines.push("");
            lines.push(`> ${annotation.bilingual.warning}`);
          }
        }
        lines.push("");
        lines.push("**评论/结构化加工**");
        lines.push("");
        lines.push(annotation.commentMarkdown.trim() || "_无评论_");
        lines.push("");
        lines.push("**改写稿**");
        lines.push("");
        lines.push(annotation.rewriteMarkdown.trim() || "_无改写_");
        lines.push("");
      });
    }

    lines.push("## 文章随想");
    lines.push("");
    if (articleMusings.length === 0) {
      lines.push("暂无文章随想。", "");
    } else {
      articleMusings.forEach((musing) => {
        lines.push(`### 随想 ${musing.index}`);
        lines.push("");
        lines.push(`- id: ${musing.id}`);
        lines.push(`- aiStatus: ${musing.aiStatus}`);
        lines.push("");
        lines.push(musing.bodyMarkdown);
        lines.push("");
      });
    }

    lines.push("## 挖空卡");
    lines.push("");
    if (clozeCards.length === 0) {
      lines.push("暂无挖空卡。", "");
    } else {
      clozeCards.forEach((card) => {
        lines.push(`### 挖空 ${card.index}`);
        lines.push("");
        lines.push(`- id: ${card.id}`);
        lines.push(`- sourceAnnotationId: ${card.sourceAnnotationId}`);
        if (card.scope !== "selection") lines.push(`- scope: ${card.scope}`);
        if (card.headingPath.length > 0) lines.push(`- headingPath: ${card.headingPath.join(" > ")}`);
        lines.push("");
        lines.push("```text");
        lines.push(card.clozeMarkdown);
        lines.push("```");
        lines.push("");
      });
    }

    lines.push("## 问答卡");
    lines.push("");
    if (qaCards.length === 0) {
      lines.push("暂无问答卡。", "");
    } else {
      qaCards.forEach((card) => {
        lines.push(`### 卡片 ${card.index}`);
        lines.push("");
        lines.push(`- id: ${card.id}`);
        lines.push(`- source: ${card.source}`);
        if (card.sourceAnnotationId) lines.push(`- sourceAnnotationId: ${card.sourceAnnotationId}`);
        lines.push(`- needsQuestionGeneration: ${card.needsQuestionGeneration ? "true" : "false"}`);
        lines.push(`- needsAnswerGeneration: ${card.needsAnswerGeneration ? "true" : "false"}`);
        if (card.scope !== "selection") lines.push(`- scope: ${card.scope}`);
        if (card.headingPath.length > 0) lines.push(`- headingPath: ${card.headingPath.join(" > ")}`);
        lines.push("");
        lines.push("```text");
        lines.push(card.cardMarkdown);
        lines.push("```");
        lines.push("");
      });
    }

    return lines.join("\n");
  }

  renderRemNoteImportJson(record: DocRecord, _annotations: AnnotationRecord[], options: {
    importableAnnotations: ArchiveAnnotationPayload[];
    highlightOnlyAnnotations: ArchiveAnnotationPayload[];
    questionAnnotations: ArchiveAnnotationPayload[];
    markdownExportPath: string;
    refinedReadingPath: string | null;
    questionQueueJsonPath: string | null;
    questionQueueMarkdownPath: string | null;
    exportAnnotations: ArchiveAnnotationPayload[];
    qaCards: ArchiveQaCardPayload[];
    clozeCards: ArchiveClozeCardPayload[];
    articleMusings: ArchiveArticleMusingPayload[];
  }): string {
    void record;
    void options;
    throw new Error("Legacy inline package renderer is retired; use batch-archive-backend/core.mjs");
  }

  renderRefinedReadingMarkdown(record: DocRecord, annotations: ArchiveAnnotationPayload[]): string {
    const exportPackageReadyAt = record.exportPackageReadyAt || new Date().toISOString();
    const sourcePath = record.originalSourcePath || record.path;
    const lines = [
      "---",
      `source_path: "${escapeYaml(sourcePath)}"`,
      `source_title: "${escapeYaml(record.title)}"`,
      `export_package_ready_at: "${exportPackageReadyAt}"`,
      "status: refined-reading",
      "---",
      "",
      `# ${record.title}：精炼摘录`,
      "",
      `- source path: ${sourcePath}`,
      `- exportPackageReadyAt: ${exportPackageReadyAt}`,
      "- 用途：仅高亮内容回流，作为下一轮渐进阅读材料。",
      "",
      "## 摘录",
      ""
    ];

    annotations.forEach((annotation, index) => {
      lines.push(`### ${index + 1}`);
      lines.push("");
      lines.push((annotation.expandedText || annotation.currentText).trim());
      lines.push("");
    });

    return lines.join("\n");
  }

  renderQuestionQueueJson(record: DocRecord, annotations: ArchiveAnnotationPayload[], markdownPath: string): string {
    const sourcePath = record.originalSourcePath || record.path;
    const payload = {
      schemaVersion: 1,
      sourcePath,
      title: record.title,
      exportPackageReadyAt: record.exportPackageReadyAt || new Date().toISOString(),
      status: "pending",
      targetThreadTitle: "学习问答中枢｜带背景的科目与技术答疑",
      targetThreadId: "019f22c5-2f57-7c12-9662-f0832d9d975c",
      markdownPath,
      questions: annotations.map((annotation) => ({
        id: annotation.id,
        index: annotation.index,
        status: "pending",
        currentText: annotation.expandedText || annotation.currentText,
        originalText: annotation.originalText,
        questionMarkdown: annotation.commentMarkdown,
        bilingual: annotation.bilingual,
        sourcePath,
        sourceTitle: record.title,
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt
      }))
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  renderQuestionQueueMarkdown(record: DocRecord, annotations: ArchiveAnnotationPayload[]): string {
    const exportPackageReadyAt = record.exportPackageReadyAt || new Date().toISOString();
    const sourcePath = record.originalSourcePath || record.path;
    const lines = [
      `# ${record.title}：Codex 提问队列`,
      "",
      `- source path: ${sourcePath}`,
      `- exportPackageReadyAt: ${exportPackageReadyAt}`,
      "- target thread: 学习问答中枢｜带背景的科目与技术答疑",
      "- status: pending",
      ""
    ];

    annotations.forEach((annotation) => {
      lines.push(`## 问题 ${annotation.index}`);
      lines.push("");
      lines.push("### 中文摘录");
      lines.push("");
      lines.push(blockquote(annotation.expandedText || annotation.currentText));
      if (annotation.bilingual.detected) {
        lines.push("");
        lines.push("### 对应英文");
        lines.push("");
        if (annotation.bilingual.englishText.trim()) {
          lines.push(blockquote(annotation.bilingual.englishText));
        } else {
          lines.push("_等待 API 对齐。候选：_");
          annotation.bilingual.candidates.slice(0, 3).forEach((candidate) => {
            lines.push(`- candidate ${candidate.index + 1}: ${candidate.text}`);
          });
        }
      }
      lines.push("");
      lines.push("### 提问");
      lines.push("");
      lines.push(annotation.commentMarkdown.trim() || "- 问题：");
      lines.push("");
    });

    return lines.join("\n");
  }

  async writeVaultFile(path: string, content: string) {
    const normalizedPath = normalizePath(path);
    const folder = normalizedPath.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);

    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    if (existing) {
      throw new Error(`Cannot write archive export over a folder: ${normalizedPath}`);
    }
    await this.app.vault.create(normalizedPath, content);
  }

  async ensureFolder(folderPath: string) {
    const adapter = this.app.vault.adapter;
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Archive path segment is not a folder: ${current}`);
      const diskEntry = await adapter.stat(current).catch(() => null);
      if (diskEntry?.type === "folder") continue;
      if (diskEntry) throw new Error(`Archive path segment is not a folder: ${current}`);
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const afterCreate = await adapter.stat(current).catch(() => null);
        if (afterCreate?.type === "folder") continue;
        throw error;
      }
    }
  }
}

class LocalIRView extends ItemView {
  plugin: LocalIncrementalReadingPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: LocalIncrementalReadingPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_LOCAL_IR;
  }

  getDisplayText(): string {
    return "Local Incremental Reading";
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen() {
    window.setTimeout(() => {
      void (async () => {
        await this.plugin.syncRecords();
        await this.render();
      })();
    }, 0);
  }

  async render() {
    try {
      await this.renderUnsafe();
    } catch (error) {
      const container = this.getContentContainer();
      container.empty();
      container.addClass("local-ir-view");
      container.createEl("h2", { text: "本地渐进阅读" });
      container.createEl("div", {
        cls: "local-ir-muted",
        text: `面板渲染失败：${error instanceof Error ? error.message : String(error)}`
      });
      console.error("Local Incremental Reading render failed", error);
    }
  }

  getContentContainer(): Element {
    const child = this.containerEl.children[1];
    return child || this.containerEl;
  }

  async renderUnsafe() {
    const container = this.getContentContainer();
    container.empty();
    container.addClass("local-ir-view");

    container.createEl("h2", { text: "本地渐进阅读" });
    container.createEl("div", {
      cls: "local-ir-muted",
      text: "核心阅读、深度高亮与本地加工"
    });

    await this.renderActiveDocControls(container);
    this.renderProcessingToolbar(container);
    await this.renderActiveDocDetails(container);
    this.renderPendingImports(container);
    this.renderReadingPoolToolbar(container);
    this.renderStats(container);
    this.renderLists(container);
  }

  renderProcessingToolbar(container: Element) {
    const card = container.createDiv({ cls: "local-ir-card" });
    card.createEl("h3", { text: "阅读加工工具" });
    const toolbar = card.createDiv({ cls: "local-ir-toolbar" });
    const modeLabel = toolbar.createEl("label", { cls: "local-ir-toggle" });
    const modeInput = modeLabel.createEl("input", { type: "checkbox" });
    modeLabel.createSpan({ text: "加工模式" });
    modeInput.checked = this.plugin.settings.processingModeEnabled;
    modeInput.addEventListener("change", async () => {
      this.plugin.settings.processingModeEnabled = modeInput.checked;
      if (modeInput.checked) {
        this.plugin.settings.clozeModeEnabled = false;
        clozeInput.checked = false;
      }
      await this.plugin.saveSettings();
      new Notice(modeInput.checked ? "加工模式已开启。选中文本会自动高亮。" : "加工模式已关闭。");
    });

    const clozeLabel = toolbar.createEl("label", { cls: "local-ir-toggle" });
    const clozeInput = clozeLabel.createEl("input", { type: "checkbox" });
    clozeLabel.createSpan({ text: "挖空模式" });
    clozeInput.checked = this.plugin.settings.clozeModeEnabled;
    clozeInput.addEventListener("change", async () => {
      this.plugin.settings.clozeModeEnabled = clozeInput.checked;
      if (clozeInput.checked) {
        this.plugin.settings.processingModeEnabled = false;
        modeInput.checked = false;
      }
      await this.plugin.saveSettings();
      new Notice(clozeInput.checked ? "挖空模式已开启。选中文本会自动挖空标注。" : "挖空模式已关闭。");
    });

    const mergeLabel = toolbar.createEl("label", { cls: "local-ir-toggle" });
    const mergeInput = mergeLabel.createEl("input", { type: "checkbox" });
    mergeLabel.createSpan({ text: "自动合并" });
    mergeInput.checked = this.plugin.settings.autoMergeHighlightsEnabled;
    mergeInput.addEventListener("change", async () => {
      this.plugin.settings.autoMergeHighlightsEnabled = mergeInput.checked;
      await this.plugin.saveSettings();
      new Notice(mergeInput.checked ? "自动合并已开启。同一 block 内高亮会合并。" : "自动合并已关闭。");
    });

    const virtualLabel = toolbar.createEl("label", { cls: "local-ir-toggle" });
    const virtualInput = virtualLabel.createEl("input", { type: "checkbox" });
    virtualLabel.createSpan({ text: "全部虚拟高亮" });
    virtualInput.checked = this.plugin.settings.alwaysVirtualHighlightsEnabled;
    virtualInput.addEventListener("change", async () => {
      this.plugin.settings.alwaysVirtualHighlightsEnabled = virtualInput.checked;
      await this.plugin.saveSettings();
      new Notice(virtualInput.checked ? "全部虚拟高亮已开启。新高亮不会写入 Markdown。" : "全部虚拟高亮已关闭。普通正文会继续写入 mark。");
    });

    toolbar.createDiv({
      cls: "local-ir-muted",
      text: "手动合并：按住左 Alt 点击多个高亮，松开后合并。"
    });

    const undoButton = toolbar.createEl("button", {
      text: "撤销最近高亮",
      cls: "local-ir-button"
    });
    undoButton.addEventListener("click", () => void this.plugin.undoRecentHighlight());

    const repairButton = toolbar.createEl("button", {
      text: "修复当前文件高亮",
      cls: "local-ir-button"
    });
    repairButton.addEventListener("click", () => void this.plugin.repairActiveFileDangerousMarks());
  }

  renderReadingPoolToolbar(container: Element) {
    const card = container.createDiv({ cls: "local-ir-card" });
    card.createEl("h3", { text: "阅读池管理" });
    card.createDiv({
      cls: "local-ir-muted",
      text: `阅读池：${this.plugin.getReadingFolders().join(" / ")}`
    });
    const toolbar = card.createDiv({ cls: "local-ir-toolbar" });

    const continueButton = toolbar.createEl("button", {
      text: "继续阅读",
      cls: "local-ir-button local-ir-primary"
    });
    continueButton.addEventListener("click", () => void this.plugin.continueReading());

    const scanButton = toolbar.createEl("button", {
      text: "刷新阅读池",
      cls: "local-ir-button"
    });
    scanButton.addEventListener("click", () => void (async () => {
      await this.plugin.syncRecords();
      await this.render();
    })());

    const batchArchiveButton = toolbar.createEl("button", {
      text: "批量生成 RemNote 导出包",
      cls: "local-ir-button"
    });
    batchArchiveButton.addEventListener("click", () => void this.plugin.batchArchiveDoneRecords());

    const addFolderButton = toolbar.createEl("button", {
      text: "添加阅读池文件夹",
      cls: "local-ir-button"
    });
    addFolderButton.addEventListener("click", () => {
      new FolderPickerModal(this.app, this.plugin, async (folder) => {
        await this.plugin.addReadingFolder(folder.path);
      }, "搜索并添加阅读池文件夹").open();
    });

    const useActiveFolderButton = toolbar.createEl("button", {
      text: "当前文件夹加入阅读池",
      cls: "local-ir-button"
    });
    useActiveFolderButton.addEventListener("click", () => {
      const folder = this.plugin.getActiveFolderPath();
      if (!folder) {
        new Notice("当前没有打开的 Markdown 文件。");
        return;
      }
      void this.plugin.addReadingFolder(folder);
    });

    const moveActiveFileButton = toolbar.createEl("button", {
      text: "当前文件放入阅读池",
      cls: "local-ir-button"
    });
    moveActiveFileButton.addEventListener("click", () => void this.plugin.moveActiveFileToReadingPool());

    const moveOutFileButton = toolbar.createEl("button", {
      text: "当前文件移出阅读池",
      cls: "local-ir-button"
    });
    moveOutFileButton.addEventListener("click", () => void this.plugin.moveActiveFileOutOfReadingPool());

    const resetButton = toolbar.createEl("button", {
      text: "重置今日访问",
      cls: "local-ir-button"
    });
    resetButton.addEventListener("click", () => void this.plugin.resetTodayVisits());
  }

  renderStats(container: Element) {
    const records = this.plugin.getRecords();
    const today = todayKey();
    const active = records.filter((record) => this.plugin.isRecordReadable(record));
    const visitedToday = records.filter((record) => isDateOnDay(record.lastVisited, today));
    const later = records.filter((record) => record.status === "later");
    const suspended = records.filter((record) => record.status === "suspended");
    const done = records.filter((record) => record.status === "done");
    const exportReady = records.filter((record) => record.status === "export_package_ready");
    const archived = records.filter((record) => record.status === "archived");

    const statCard = container.createDiv({ cls: "local-ir-card" });
    statCard.createEl("h3", { text: "阅读池统计" });
    const grid = statCard.createDiv({ cls: "local-ir-stat-grid" });
    this.stat(grid, "总数", records.length);
    this.stat(grid, "可读", active.length);
    this.stat(grid, "今日已访问", visitedToday.length);
    this.stat(grid, "Later", later.length);
    this.stat(grid, "搁置", suspended.length);
    this.stat(grid, "待生成导出包", done.length);
    this.stat(grid, "导出包已准备", exportReady.length);
    this.stat(grid, "正式归档成功", archived.length);
  }

  stat(container: Element, label: string, value: number) {
    const stat = container.createDiv({ cls: "local-ir-stat" });
    stat.createEl("strong", { text: String(value) });
    stat.createEl("span", { text: label });
  }

  async renderActiveDocControls(container: Element) {
    const record = this.plugin.getActiveRecord();
    const card = container.createDiv({ cls: "local-ir-card" });
    card.createEl("h3", { text: "当前文档控制" });

    if (!record) {
      card.createEl("div", {
        cls: "local-ir-muted",
        text: "当前打开的文件不在阅读池中。"
      });
      return;
    }
    await this.plugin.repairDangerousMarksForPath(record.path, { silent: true, refresh: false });

    card.createEl("div", { cls: "local-ir-doc-title", text: record.title });
    const docMeta = card.createEl("div", {
      cls: "local-ir-doc-meta",
      text: `${STATUS_LABELS[record.status]} · priority ${record.priority.toFixed(2)} · visits ${record.visitCount}${record.deferUntil ? ` · defer until ${record.deferUntil}` : ""}`
    });

    const metricInputs = new Map<MetricKey, HTMLInputElement>();
    const metricValueLabels = new Map<MetricKey, HTMLSpanElement>();
    let extremeInput: HTMLInputElement | null = null;
    const updateMetricControlDisplay = () => {
      const previewMetrics = { ...record.metrics };
      for (const [key, input] of metricInputs) {
        const value = snapMetricValue(Number(input.value));
        previewMetrics[key] = value;
        metricValueLabels.get(key)?.setText(metricLevelLabel(value));
      }
      const previewPriority = this.plugin.calculatePriority(previewMetrics);
      docMeta.setText(`${STATUS_LABELS[record.status]} · priority ${previewPriority.toFixed(2)} · visits ${record.visitCount}${record.deferUntil ? ` · defer until ${record.deferUntil}` : ""}`);
      if (extremeInput) extremeInput.checked = isExtremePriorityMetrics(previewMetrics);
    };

    (Object.keys(METRIC_LABELS) as MetricKey[]).forEach((key) => {
      const metric = card.createDiv({ cls: "local-ir-metric" });
      const label = metric.createEl("label");
      label.createSpan({ text: METRIC_LABELS[key] });
      const valueLabel = label.createSpan({ text: metricLevelLabel(record.metrics[key]) });
      const input = metric.createEl("input", {
        type: "range",
        attr: {
          "aria-label": METRIC_LABELS[key],
          min: "0",
          max: "10",
          step: "2.5",
          value: String(snapMetricValue(record.metrics[key]))
        }
      });
      metricInputs.set(key, input);
      metricValueLabels.set(key, valueLabel);
      input.addEventListener("input", updateMetricControlDisplay);
      input.addEventListener("change", () => {
        updateMetricControlDisplay();
        void this.plugin.updateMetric(record.path, key, Number(input.value)).catch((error) => {
          console.error(`Local IR: failed to update ${key} for ${record.path}`, error);
          new Notice("档位保存失败，请重试。");
        });
      });
    });

    const extreme = card.createDiv({ cls: "local-ir-metric" });
    const extremeLabel = extreme.createEl("label");
    extremeLabel.createSpan({ text: "极度重要" });
    extremeInput = extremeLabel.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": "极度重要" }
    });
    extremeInput.checked = isExtremePriorityMetrics(record.metrics);
    extremeInput.addEventListener("change", () => {
      const enabled = extremeInput?.checked === true;
      const value = enabled ? MAX_METRIC_VALUE : DEFAULT_METRIC_VALUE;
      for (const input of metricInputs.values()) input.value = String(value);
      updateMetricControlDisplay();
      void this.plugin.setExtremeImportance(record.path, enabled).catch((error) => {
        console.error(`Local IR: failed to set extreme importance for ${record.path}`, error);
        new Notice("极度重要保存失败，请重试。");
      });
    });

    const actions = card.createDiv({ cls: "local-ir-toolbar" });
    if (record.status === "archived") {
      actions.createDiv({ cls: "local-ir-muted", text: "正式归档结果由工程五 receipt 回写；插件不直接撤销 RemNote 状态。" });
    } else if (record.status === "export_package_ready") {
      actions.createDiv({ cls: "local-ir-muted", text: "导出包已冻结并留在队列；原文仍在待归档区，尚未正式归档。" });
    } else if (record.status === "later") {
      this.action(actions, "取消 Later", () => this.plugin.restoreRecord(record.path));
    } else if (record.status === "suspended" || record.status === "done") {
      this.action(actions, "恢复阅读中", () => this.plugin.restoreRecord(record.path));
    } else {
      this.action(actions, "明天", () => this.plugin.deferRecord(record.path, 1));
      this.action(actions, "3 天", () => this.plugin.deferRecord(record.path, 3));
      this.action(actions, "1 周", () => this.plugin.deferRecord(record.path, 7));
      this.action(actions, "自定义天数", () => {
        new NumberInputModal(this.app, "自定义推迟天数", this.plugin.settings.defaultDeferDays, (days) => this.plugin.deferRecord(record.path, days)).open();
        return Promise.resolve();
      });
      this.action(actions, "搁置", () => this.plugin.updateRecord(record.path, { status: "suspended", deferUntil: null }));
      this.action(actions, "完成阅读", () => this.plugin.completeRecord(record.path));
    }
  }

  async renderActiveDocDetails(container: Element) {
    const record = this.plugin.getActiveRecord();
    if (!record) return;
    const card = container.createDiv({ cls: "local-ir-card" });
    card.createEl("h3", { text: "当前文档详情" });
    await this.renderArticleMusing(card, record.path);
    await this.renderQaCards(card, record.path);
    await this.renderAnnotations(card, record.path);
  }

  renderLists(container: Element) {
    const records = this.plugin.getRecords();
    const today = todayKey();

    this.renderList(
      container,
      "高优先级",
      records.filter((record) => this.plugin.isRecordReadable(record)).slice(0, 8)
    );

    this.renderList(
      container,
      "今日已访问",
      records.filter((record) => isDateOnDay(record.lastVisited, today)).slice(0, 8)
    );

    this.renderList(
      container,
      "Later",
      records.filter((record) => record.status === "later").sort((a, b) => (a.deferUntil || "").localeCompare(b.deferUntil || "")).slice(0, 8)
    );

    this.renderList(
      container,
      "待生成导出包",
      records.filter((record) => record.status === "done").slice(0, 8)
    );

    this.renderList(
      container,
      "导出包已准备（尚未正式归档）",
      records.filter((record) => record.status === "export_package_ready").slice(0, 8)
    );

    this.renderList(
      container,
      "正式归档成功",
      records.filter((record) => record.status === "archived").slice(0, 8)
    );

    this.renderList(
      container,
      "搁置",
      records.filter((record) => record.status === "suspended").slice(0, 8)
    );
  }

  renderList(container: Element, title: string, records: DocRecord[]) {
    const card = container.createDiv({ cls: "local-ir-card" });
    card.createEl("h3", { text: title });

    if (records.length === 0) {
      card.createEl("div", { cls: "local-ir-muted", text: "暂无" });
      return;
    }

    for (const record of records) {
      const row = card.createDiv({ cls: "local-ir-doc-row" });
      const titleEl = row.createDiv({ cls: "local-ir-doc-title", text: record.title });
      titleEl.addEventListener("click", () => void this.plugin.openRecord(record.path, false));
      row.createDiv({
        cls: "local-ir-doc-meta",
        text: `${STATUS_LABELS[record.status]} · priority ${record.priority.toFixed(2)} · visits ${record.visitCount}${record.deferUntil ? ` · defer until ${record.deferUntil}` : ""}`
      });
      if (record.status === "done" && (record.archiveLastFailure || record.archiveLastError)) {
        const label = record.archiveLastFailure?.kind === "blocked" ? "生成受阻" : "上次生成失败";
        row.createDiv({
          cls: "local-ir-pending-error",
          text: `${label}：${record.archiveLastError || record.archiveLastFailure?.message || "未知错误"}`
        });
        const validatorErrors = record.archiveLastFailure?.details.errors || [];
        if (validatorErrors.length > 0) {
          row.createDiv({
            cls: "local-ir-doc-meta",
            text: `生产者校验：${validatorErrors.join("；")}`
          });
        }
      }
      if (record.status === "suspended" || record.status === "done" || record.status === "later") {
        const rowActions = row.createDiv({ cls: "local-ir-row-actions" });
        if (record.status === "done") {
          const archive = rowActions.createEl("button", {
            text: "生成导出包",
            cls: "local-ir-button"
          });
          archive.disabled = this.plugin.singleArchivePathsInProgress.has(record.path) || this.plugin.batchArchiveInProgress;
          archive.addEventListener("click", (event) => {
            event.stopPropagation();
            archive.disabled = true;
            void this.plugin.archiveRecord(record.path);
          });
        }
        const restore = rowActions.createEl("button", {
          text: record.status === "later" ? "取消 Later" : "恢复",
          cls: "local-ir-button"
        });
        restore.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.plugin.restoreRecord(record.path);
        });
      }
    }
  }

  renderPendingImports(container: Element) {
    const card = container.createDiv({ cls: "local-ir-card" });
    card.createEl("h3", { text: `待导入列表（${this.plugin.settings.pendingImports.length}）` });
    card.createDiv({
      cls: "local-ir-muted",
      text: "可一次粘贴多个网页链接；按标准化 URL 去重，并行进入与浏览器“导入本地”相同的标准工作流。失败条目会保留以便重试。"
    });

    const inputArea = card.createDiv({ cls: "local-ir-link-import-box" });
    const input = inputArea.createEl("textarea", { cls: "local-ir-link-import-input" });
    input.placeholder = "粘贴一个或多个 http/https 链接；可混合换行、文字或 Markdown 链接。";
    const inputMeta = inputArea.createDiv({ cls: "local-ir-doc-meta", text: "尚未识别链接。" });
    const inputActions = inputArea.createDiv({ cls: "local-ir-row-actions" });
    const importLinksButton = inputActions.createEl("button", {
      cls: "local-ir-button",
      text: "标准导入链接"
    });
    const updateInputState = () => {
      const count = extractExternalUrls(input.value).length;
      inputMeta.textContent = count ? `已识别 ${count} 个有效链接。` : "尚未识别链接。";
      importLinksButton.disabled = count === 0;
    };
    input.addEventListener("input", updateInputState);
    importLinksButton.addEventListener("click", () => {
      const value = input.value;
      input.disabled = true;
      importLinksButton.disabled = true;
      inputMeta.textContent = "正在加入队列并启动标准导入…";
      void this.plugin.queueAndImportLinks(value).catch((error) => {
        input.disabled = false;
        updateInputState();
        new Notice(`批量导入失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });
    updateInputState();

    if (this.plugin.settings.pendingImports.length === 0) {
      card.createDiv({ cls: "local-ir-muted", text: "暂无待导入链接。" });
      return;
    }

    for (const item of this.plugin.settings.pendingImports) {
      const row = card.createDiv({ cls: "local-ir-doc-row" });
      const link = row.createEl("a", {
        cls: "local-ir-pending-url",
        text: item.url,
        href: item.url
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener noreferrer");
      const statusLabel = item.status === "importing" ? "导入中" : item.status === "failed" ? "失败，可重试" : "待导入";
      row.createDiv({
        cls: "local-ir-doc-meta",
        text: `${statusLabel} · 加入 ${item.addedAt} · 尝试 ${item.attemptCount} 次`
      });
      if (item.sourcePath) {
        row.createDiv({ cls: "local-ir-doc-meta", text: `来源文档：${item.sourcePath}` });
      }
      if (item.lastError) {
        row.createDiv({ cls: "local-ir-pending-error", text: item.lastError });
      }
      const actions = row.createDiv({ cls: "local-ir-row-actions" });
      const importButton = actions.createEl("button", {
        cls: "local-ir-button",
        text: item.status === "failed" ? "重试导入" : item.status === "importing" ? "导入中…" : "立即导入"
      });
      importButton.disabled = item.status === "importing";
      importButton.addEventListener("click", () => void this.plugin.importPendingImport(item.id));
      const removeButton = actions.createEl("button", {
        cls: "local-ir-button",
        text: "移除"
      });
      removeButton.disabled = item.status === "importing";
      removeButton.addEventListener("click", () => void this.plugin.removePendingImport(item.id));
    }
  }

  async renderArticleMusing(container: Element, path: string) {
    const musing = this.plugin.getArticleMusing(path);
    const isArchived = this.plugin.isRecordFrozenForExport(path) || Boolean(musing?.archived);
    const section = container.createDiv({ cls: "local-ir-qa-section" });
    section.createEl("h3", { text: "文章随想" });
    section.createDiv({
      cls: "local-ir-muted",
      text: "记录你对全文的随想或总批注。native-v2 会完整携带随想，正式导入由工程五写入 RemNote 并回读。"
    });

    const input = section.createEl("textarea", { cls: "local-ir-qa-input local-ir-qa-answer" });
    input.placeholder = "写下这篇文章触发的想法、判断、疑问或后续要处理的线索。";
    input.value = musing?.bodyMarkdown || "";
    input.disabled = isArchived;

    const actions = section.createDiv({ cls: "local-ir-toolbar" });
    if (!isArchived) {
      this.action(actions, "保存随想", () => this.plugin.saveArticleMusing(path, input.value));
    }
    if (musing?.bodyMarkdown.trim()) {
      section.createDiv({
        cls: "local-ir-doc-meta",
        text: `${this.plugin.isRecordFrozenForExport(path) ? "输入已冻结" : "可编辑"} · AI 解析状态：${musing.aiStatus}`
      });
    }
  }

  async renderQaCards(container: Element, path: string) {
    const cards = this.plugin.getQaCardsForPath(path);
    const isFrozen = this.plugin.isRecordFrozenForExport(path);
    const section = container.createDiv({ cls: "local-ir-qa-section" });
    section.createEl("h3", { text: "文章问答卡" });
    section.createDiv({
      cls: "local-ir-muted",
      text: "保存的问题会在归档包中进入 RemNote 问答卡队列；答案可手写，也可留空后由 qa:resolve 生成。"
    });

    const questionInput = section.createEl("textarea", { cls: "local-ir-qa-input" });
    questionInput.placeholder = "输入这篇文章要回答的问题";
    questionInput.disabled = isFrozen;
    const answerInput = section.createEl("textarea", { cls: "local-ir-qa-input local-ir-qa-answer" });
    answerInput.placeholder = "可选：手写答案。留空时点击生成答案会进入 API 解析队列。";
    answerInput.disabled = isFrozen;

    const actions = section.createDiv({ cls: "local-ir-toolbar" });
    if (!isFrozen) {
      this.action(actions, "保存问答卡", () => this.plugin.saveArticleQaCard(path, questionInput.value, answerInput.value, false));
      this.action(actions, "生成答案", () => this.plugin.saveArticleQaCard(path, questionInput.value, answerInput.value, true));
    }

    if (cards.length === 0) {
      section.createEl("div", { cls: "local-ir-muted", text: "暂无文章级问答卡。" });
      return;
    }

    for (const card of cards) {
      const row = section.createDiv({ cls: "local-ir-doc-row local-ir-qa-row" });
      row.createDiv({ cls: "local-ir-doc-title", text: truncate(card.questionMarkdown || "未命名问题", 80) });
      row.createDiv({
        cls: "local-ir-doc-meta",
        text: `${card.needsAnswerGeneration ? "待生成答案" : "已有答案"} · ${isFrozen ? "输入已冻结" : "可编辑"}`
      });
      const preview = row.createDiv({ cls: "local-ir-qa-preview" });
      preview.setText(renderQaCardPreview(card));
      row.addEventListener("click", () => this.plugin.openQaCardModal(card));
      const rowActions = row.createDiv({ cls: "local-ir-row-actions" });
      const edit = rowActions.createEl("button", { text: isFrozen || card.archived ? "查看" : "编辑", cls: "local-ir-button" });
      edit.addEventListener("click", (event) => {
        event.stopPropagation();
        this.plugin.openQaCardModal(card);
      });
      const del = rowActions.createEl("button", { text: "删除", cls: "local-ir-button" });
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.plugin.deleteQaCard(card.id);
      });
    }
  }

  async renderAnnotations(container: Element, path: string) {
    const annotations = this.plugin.getAnnotationsForPath(path);
    const linkedAnnotations = annotations.filter((annotation) => !annotation.orphaned);
    const orphanedAnnotations = annotations.filter((annotation) => annotation.orphaned);
    const legacyHighlights = await this.plugin.getLegacyHighlightsForPath(path);
    const sourceContent = await this.plugin.readVaultFile(path);
    const section = container.createDiv({ cls: "local-ir-annotations" });
    section.createEl("h3", { text: "本文高亮/评论" });

    if (linkedAnnotations.length === 0 && legacyHighlights.length === 0) {
      section.createEl("div", {
        cls: "local-ir-muted",
        text: "暂无。开启加工模式后，选中文本只会自动高亮；需要加工时再点击高亮。"
      });
    }

    for (const annotation of linkedAnnotations) {
      const displayHierarchy = sourceContent ? resolveAnnotationHierarchy(sourceContent, annotation) : annotation;
      const row = section.createDiv({ cls: "local-ir-doc-row local-ir-annotation-row" });
      row.createDiv({
        cls: "local-ir-doc-title",
        text: truncate(annotation.currentText || annotation.selectedText, 80)
      });
      row.createDiv({
        cls: "local-ir-doc-meta",
        text: `${annotation.markKind === "cloze" ? "挖空 · " : ""}${annotation.renderMode === "virtual_decoration" ? "特殊格式 · " : ""}${ANNOTATION_LABELS[annotation.type]} · ${displayHierarchy.scope !== "selection" ? "包含子层级 · " : ""}${annotation.hasRewrite ? "有改写" : "无改写"} · ${annotation.archived ? "已归档" : "未归档"}`
      });
      row.addEventListener("click", async () => {
        await this.plugin.openRecord(annotation.path, false);
        this.plugin.openAnnotationModal(annotation);
      });
    }

    for (const legacy of legacyHighlights) {
      const row = section.createDiv({ cls: "local-ir-doc-row local-ir-annotation-row" });
      row.createDiv({
        cls: "local-ir-doc-title",
        text: truncate(legacy.text, 80)
      });
      row.createDiv({
        cls: "local-ir-doc-meta",
        text: "旧高亮 · 未加工"
      });
      row.addEventListener("click", () => {
        this.plugin.openAnnotationModal(this.plugin.createAnnotation(createAnnotationId(), legacy.path, legacy.text, "legacy", legacy.startOffset));
      });
    }

    if (orphanedAnnotations.length > 0) {
      section.createEl("h3", { text: "孤立记录" });
      for (const annotation of orphanedAnnotations) {
        const row = section.createDiv({ cls: "local-ir-doc-row local-ir-annotation-row local-ir-orphaned" });
        row.createDiv({
          cls: "local-ir-doc-title",
          text: truncate(annotation.currentText || annotation.selectedText, 80)
        });
      row.createDiv({
        cls: "local-ir-doc-meta",
        text: `${annotation.markKind === "cloze" ? "挖空 · " : ""}${annotation.renderMode === "virtual_decoration" ? "特殊格式 · " : ""}${ANNOTATION_LABELS[annotation.type]} · ${annotation.hasRewrite ? "有改写" : "无改写"} · 原高亮已不存在`
      });
        row.addEventListener("click", () => this.plugin.openAnnotationModal(annotation));
      }
    }
  }

  action(container: Element, label: string, handler: () => Promise<void>) {
    const button = container.createEl("button", { text: label, cls: "local-ir-button" });
    button.addEventListener("click", () => void handler());
  }
}

class NoRemnoteContentConfirmationModal extends Modal {
  entries: NoRemnoteContentPreflight[];
  resolveConfirmation: (confirmed: boolean) => void;
  resolved = false;

  constructor(app: App, entries: NoRemnoteContentPreflight[], resolveConfirmation: (confirmed: boolean) => void) {
    super(app);
    this.entries = entries;
    this.resolveConfirmation = resolveConfirmation;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "确认生成无 RemNote 内容的导出包" });
    contentEl.createDiv({
      cls: "local-ir-muted",
      text: "以下文章没有可写入 RemNote 的批注、已解析 QA、挖空或随想。已有高亮/提问仍会保留在 refined/question 派生产物中；确认不会伪造 RemNote 内容，也不代表正式归档成功。"
    });
    const list = contentEl.createEl("ul", { cls: "local-ir-confirmation-list" });
    for (const entry of this.entries) {
      const missing = entry.missingElementKinds.map((kind) => ARCHIVE_ELEMENT_LABELS[kind] || kind).join("、");
      list.createEl("li", { text: `${entry.title}：缺少 ${missing}` });
    }
    const buttons = contentEl.createDiv({ cls: "local-ir-modal-buttons" });
    const cancel = buttons.createEl("button", { text: "取消，保持待生成", cls: "local-ir-button" });
    cancel.addEventListener("click", () => this.finish(false));
    const confirm = buttons.createEl("button", { text: "确认并生成导出包", cls: "local-ir-button local-ir-primary" });
    confirm.addEventListener("click", () => this.finish(true));
  }

  finish(confirmed: boolean) {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveConfirmation(confirmed);
    this.close();
  }

  onClose() {
    if (!this.resolved) {
      this.resolved = true;
      this.resolveConfirmation(false);
    }
    this.contentEl.empty();
  }
}

class LocalIRSettingTab extends PluginSettingTab {
  plugin: LocalIncrementalReadingPlugin;

  constructor(app: App, plugin: LocalIncrementalReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Local Incremental Reading" });

    containerEl.createEl("h3", { text: "阅读池文件夹" });
    containerEl.createDiv({
      cls: "setting-item-description",
      text: "可以设置多个阅读池；第一项用于自动移入当前文件。"
    });
    for (const folder of this.plugin.getReadingFolders()) {
      new Setting(containerEl)
        .setName(folder === this.plugin.getPrimaryReadingFolder() ? `${folder}（第一阅读池）` : folder)
        .addButton((button) => {
          button
            .setButtonText("设为第一")
            .onClick(async () => {
              await this.plugin.setPrimaryReadingFolder(folder);
              this.display();
            });
        })
        .addButton((button) => {
          button
            .setButtonText("移除")
            .onClick(async () => {
              await this.plugin.removeReadingFolder(folder);
              this.display();
            });
        });
    }

    new Setting(containerEl)
      .setName("添加阅读池文件夹")
      .setDesc("输入时可按目录名搜索，也可以点右侧按钮选择。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          text.setValue(folder.path);
        });
        text.setPlaceholder(DEFAULT_FOLDER);
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void this.plugin.addReadingFolder(text.getValue()).then(() => this.display());
        });
      })
      .addButton((button) => {
        button
          .setButtonText("选择并添加")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              await this.plugin.addReadingFolder(folder.path);
              this.display();
            }, "搜索并添加阅读池文件夹").open();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("添加当前文件夹")
          .onClick(async () => {
            const folder = this.plugin.getActiveFolderPath();
            if (!folder) {
              new Notice("当前没有打开的 Markdown 文件。");
              return;
            }
            await this.plugin.addReadingFolder(folder);
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("排除今日已访问")
      .setDesc("开启后，今天打开过的文档不会被继续阅读再次抽中。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.excludeVisitedToday)
          .onChange(async (value) => {
            this.plugin.settings.excludeVisitedToday = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("绝对优先级概率")
      .setDesc("0.2 表示 20% 概率直接打开最高优先级文档，其余按轮盘赌。")
      .addSlider((slider) => {
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.absolutePriorityProbability)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.absolutePriorityProbability = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("默认推迟天数")
      .setDesc("当前文档点 Later 自定义默认值。")
      .addText((text) => {
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.defaultDeferDays))
          .onChange(async (value) => {
            this.plugin.settings.defaultDeferDays = Math.max(1, Math.round(Number(value) || 7));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("RemNote 导出队列目录")
      .setDesc("归档文档会在这里生成本地 Markdown 导出包，当前版本不直接写入 RemNote。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.archiveFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_ARCHIVE_FOLDER)
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = normalizePath(value.trim() || DEFAULT_ARCHIVE_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.archiveFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择导出队列文件夹").open();
          });
      });

    new Setting(containerEl)
      .setName("已归档原文目录")
      .setDesc("这里只是正式归档的目标目录。批量生成导出包不会移动原文；只有工程五成功 receipt 后才可移动到这里。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.sourceArchiveFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_SOURCE_ARCHIVE_FOLDER)
          .setValue(this.plugin.settings.sourceArchiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.sourceArchiveFolder = normalizePath(value.trim() || DEFAULT_SOURCE_ARCHIVE_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.sourceArchiveFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择已归档原文目录").open();
          });
      });

    new Setting(containerEl)
      .setName("待归档原文目录")
      .setDesc("点击完成阅读后，原始 Markdown 会先移到这里，等待批量归档生成导出包。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.completedSourceFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_COMPLETED_SOURCE_FOLDER)
          .setValue(this.plugin.settings.completedSourceFolder)
          .onChange(async (value) => {
            this.plugin.settings.completedSourceFolder = normalizePath(value.trim() || DEFAULT_COMPLETED_SOURCE_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.completedSourceFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择待归档原文目录").open();
          });
      });

    new Setting(containerEl)
      .setName("移出阅读池目录")
      .setDesc("没有原路径记录的文件，点击移出阅读池后会放到这里。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.removedReadingFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_REMOVED_READING_FOLDER)
          .setValue(this.plugin.settings.removedReadingFolder)
          .onChange(async (value) => {
            this.plugin.settings.removedReadingFolder = normalizePath(value.trim() || DEFAULT_REMOVED_READING_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.removedReadingFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择移出阅读池目录").open();
          });
      });

    new Setting(containerEl)
      .setName("二次阅读目录")
      .setDesc("归档时，仅高亮内容会提取成精炼稿放到这里，并重新进入阅读池。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.refinedReadingFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_REFINED_READING_FOLDER)
          .setValue(this.plugin.settings.refinedReadingFolder)
          .onChange(async (value) => {
            this.plugin.settings.refinedReadingFolder = normalizePath(value.trim() || DEFAULT_REFINED_READING_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.refinedReadingFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择二次阅读文件夹").open();
          });
      });

    new Setting(containerEl)
      .setName("Codex 提问队列目录")
      .setDesc("归档时，提问类型会写到这里，不进入 RemNote。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.questionQueueFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_QUESTION_QUEUE_FOLDER)
          .setValue(this.plugin.settings.questionQueueFolder)
          .onChange(async (value) => {
            this.plugin.settings.questionQueueFolder = normalizePath(value.trim() || DEFAULT_QUESTION_QUEUE_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.questionQueueFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择 Codex 提问队列文件夹").open();
          });
      });

    new Setting(containerEl)
      .setName("链接导入根目录")
      .setDesc("旧链接导入脚本的兼容目录；新的标准导入固定复用浏览器“导入本地”工作流并写入阅读区/浏览器高亮。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.linkImportFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_LINK_IMPORT_FOLDER)
          .setValue(this.plugin.settings.linkImportFolder)
          .onChange(async (value) => {
            this.plugin.settings.linkImportFolder = normalizePath(value.trim() || DEFAULT_LINK_IMPORT_FOLDER);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("选择文件夹")
          .onClick(() => {
            new FolderPickerModal(this.app, this.plugin, async (folder) => {
              this.plugin.settings.linkImportFolder = folder.path;
              await this.plugin.saveSettings();
              this.display();
            }, "搜索并选择链接导入根目录").open();
          });
      });

    new Setting(containerEl)
      .setName("浏览器加工状态目录")
      .setDesc("浏览器高亮的 Local IR 状态保存在这里；目录位于阅读区外，阅读区只保留可直接阅读的 Markdown。")
      .addText((text) => {
        new FolderInputSuggest(this.app, text.inputEl, (folder) => {
          this.plugin.settings.documentStateFolder = folder.path;
          void this.plugin.saveSettings();
          text.setValue(folder.path);
        });
        text
          .setPlaceholder(DEFAULT_DOCUMENT_STATE_FOLDER)
          .setValue(this.plugin.settings.documentStateFolder)
          .onChange(async (value) => {
            this.plugin.settings.documentStateFolder = normalizePath(value.trim() || DEFAULT_DOCUMENT_STATE_FOLDER);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("高亮后自动打开评论")
      .setDesc("开启后，加工模式下选中文本会自动高亮并打开评论结构选择。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoOpenAnnotationModal)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenAnnotationModal = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

class FolderInputSuggest extends AbstractInputSuggest<TFolder> {
  app: App;
  onChoose: (folder: TFolder) => void;

  constructor(app: App, inputEl: HTMLInputElement, onChoose: (folder: TFolder) => void) {
    super(app, inputEl);
    this.app = app;
    this.onChoose = onChoose;
  }

  getSuggestions(query: string): TFolder[] {
    const normalizedQuery = normalizePath(query.trim()).toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => !normalizedQuery || folder.path.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement) {
    el.setText(folder.path || "/");
  }

  selectSuggestion(folder: TFolder) {
    this.setValue(folder.path);
    this.onChoose(folder);
    this.close();
  }
}

class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  plugin: LocalIncrementalReadingPlugin;
  onChoose: (folder: TFolder) => Promise<void>;
  placeholder: string;

  constructor(app: App, plugin: LocalIncrementalReadingPlugin, onChoose: (folder: TFolder) => Promise<void>, placeholder = "搜索并选择阅读池文件夹") {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
    this.placeholder = placeholder;
    this.setPlaceholder(this.placeholder);
  }

  getItems(): TFolder[] {
    return this.plugin.getVaultFolders();
  }

  getItemText(folder: TFolder): string {
    return folder.path || "/";
  }

  onChooseItem(folder: TFolder) {
    void this.onChoose(folder);
  }
}

class NumberInputModal extends Modal {
  title: string;
  defaultValue: number;
  onSubmit: (value: number) => Promise<void>;

  constructor(app: App, title: string, defaultValue: number, onSubmit: (value: number) => Promise<void>) {
    super(app);
    this.title = title;
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("local-ir-modal");
    contentEl.createEl("h2", { text: this.title });

    let value = this.defaultValue;
    new Setting(contentEl)
      .setName("天数")
      .addText((text) => {
        text
          .setValue(String(this.defaultValue))
          .onChange((nextValue) => {
            value = Math.max(1, Math.round(Number(nextValue) || this.defaultValue));
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void this.submit(value);
          }
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("取消")
          .onClick(() => this.close());
      })
      .addButton((button) => {
        button
          .setButtonText("确认")
          .setCta()
          .onClick(() => void this.submit(value));
      });
  }

  async submit(value: number) {
    await this.onSubmit(value);
    this.close();
  }
}

class QaCardModal extends Modal {
  plugin: LocalIncrementalReadingPlugin;
  card: QaCardRecord;

  constructor(app: App, plugin: LocalIncrementalReadingPlugin, card: QaCardRecord) {
    super(app);
    this.plugin = plugin;
    this.card = { ...card };
  }

  onOpen() {
    const { contentEl } = this;
    const isFrozen = this.card.archived || this.plugin.isRecordFrozenForExport(this.card.path);
    contentEl.empty();
    this.modalEl.addClass("local-ir-wide-modal");
    contentEl.addClass("local-ir-modal");
    contentEl.createEl("h2", { text: isFrozen ? "查看问答卡" : "编辑问答卡" });
    contentEl.createDiv({
      cls: "local-ir-muted",
      text: isFrozen ? "导出输入已冻结或已正式归档；当前只读。" : "生成导出包前可以修改问题和答案；未解析卡片会阻止 package commit。"
    });

    const grid = contentEl.createDiv({ cls: "local-ir-processing-grid local-ir-qa-edit-grid" });
    const questionColumn = grid.createDiv({ cls: "local-ir-processing-column" });
    questionColumn.createEl("h3", { text: "问题" });
    const questionInput = questionColumn.createEl("textarea");
    questionInput.value = this.card.questionMarkdown;
    questionInput.disabled = isFrozen;

    const answerColumn = grid.createDiv({ cls: "local-ir-processing-column" });
    answerColumn.createEl("h3", { text: "答案" });
    const answerInput = answerColumn.createEl("textarea");
    answerInput.value = this.card.answerMarkdown;
    answerInput.placeholder = "留空时，归档后的 qa:resolve 会基于文章生成答案。";
    answerInput.disabled = isFrozen;

    const previewColumn = grid.createDiv({ cls: "local-ir-processing-column" });
    previewColumn.createEl("h3", { text: "RemNote 多行卡预览" });
    const preview = previewColumn.createEl("pre", { cls: "local-ir-qa-modal-preview" });
    const updatePreview = () => {
      preview.setText(renderRemNoteMultiLineCard(questionInput.value || "待生成问题", answerInput.value || this.card.answerSourceText || "待生成答案"));
    };
    updatePreview();
    questionInput.addEventListener("input", updatePreview);
    answerInput.addEventListener("input", updatePreview);

    const optionRow = contentEl.createDiv({ cls: "local-ir-toolbar" });
    const generateLabel = optionRow.createEl("label", { cls: "local-ir-toggle" });
    const generateInput = generateLabel.createEl("input", { type: "checkbox" });
    generateInput.checked = this.card.needsAnswerGeneration || !this.card.answerMarkdown.trim();
    generateInput.disabled = isFrozen;
    generateLabel.createSpan({ text: "导入前用 AI 生成/补全答案" });

    const buttons = contentEl.createDiv({ cls: "local-ir-modal-buttons" });
    this.modalButton(buttons, "关闭", () => this.close());
    if (!isFrozen) {
      this.modalButton(buttons, "保存", () => {
        void this.plugin.updateQaCard({
          ...this.card,
          questionMarkdown: questionInput.value,
          answerMarkdown: answerInput.value,
          needsAnswerGeneration: generateInput.checked
        }).then((saved) => {
          if (saved) this.close();
        });
      }, true);
    }
  }

  modalButton(container: HTMLElement, label: string, onClick: () => void, primary = false) {
    const button = container.createEl("button", {
      text: label,
      cls: primary ? "mod-cta" : ""
    });
    button.addEventListener("click", onClick);
  }
}

class AnnotationModal extends Modal {
  plugin: LocalIncrementalReadingPlugin;
  annotation: AnnotationRecord;
  flushDraftSave: (() => Promise<void>) | null = null;

  constructor(app: App, plugin: LocalIncrementalReadingPlugin, annotation: AnnotationRecord) {
    super(app);
    this.plugin = plugin;
    this.annotation = { ...annotation };
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("local-ir-wide-modal");
    contentEl.empty();
    contentEl.addClass("local-ir-modal");
    contentEl.createEl("h2", { text: this.annotation.markKind === "cloze" ? "挖空加工" : "高亮加工" });

    let type = this.annotation.type === "highlight" ? "comment" as AnnotationType : normalizeModalAnnotationType(this.annotation.type);
    let currentText = this.annotation.currentText || this.annotation.selectedText;
    let commentMarkdown = this.annotation.commentMarkdown;
    let rewriteMarkdown = this.annotation.rewriteMarkdown || "";
    let draftTimer: number | null = null;

    const topBar = contentEl.createDiv({ cls: "local-ir-modal-topbar" });
    const typeGroup = topBar.createDiv({ cls: "local-ir-field local-ir-type-field" });
    typeGroup.createEl("label", { text: "加工类型" });
    const typeButtons = typeGroup.createDiv({ cls: "local-ir-type-buttons" });
    const typeButtonMap: Partial<Record<AnnotationType, HTMLButtonElement>> = {};
    const saveStatus = topBar.createDiv({ cls: "local-ir-modal-meta" });

    const saveDraftNow = async () => {
      if (draftTimer !== null) {
        window.clearTimeout(draftTimer);
        draftTimer = null;
      }
      await this.plugin.saveAnnotationDraft({
          ...this.annotation,
          type,
          commentMarkdown,
          rewriteMarkdown
      });
      saveStatus.setText(`${this.annotation.sourceFormat === "legacy" ? "旧高亮，首次保存时绑定" : "已自动保存"} · ${this.annotation.orphaned ? "孤立记录" : "已绑定"}`);
    };
    this.flushDraftSave = saveDraftNow;

    const scheduleDraftSave = () => {
      if (draftTimer !== null) window.clearTimeout(draftTimer);
      saveStatus.setText("保存中...");
      draftTimer = window.setTimeout(() => {
        void saveDraftNow();
      }, 700);
    };

    const renderTypeButtons = () => {
      for (const [value, button] of Object.entries(typeButtonMap) as Array<[AnnotationType, HTMLButtonElement]>) {
        button.toggleClass("is-active", value === type);
      }
    };

    for (const value of ANNOTATION_MODAL_TYPES) {
      const button = typeButtons.createEl("button", {
        text: ANNOTATION_LABELS[value],
        cls: "local-ir-type-button"
      });
      typeButtonMap[value] = button;
      button.addEventListener("click", () => {
        const nextType = normalizeModalAnnotationType(value);
        if (!commentMarkdown.trim() || commentMarkdown === annotationTemplate(type)) {
          commentMarkdown = annotationTemplate(nextType);
          commentInput.value = commentMarkdown;
        }
        type = nextType;
        renderTypeButtons();
        scheduleDraftSave();
      });
    }
    renderTypeButtons();

    saveStatus.setText(`${this.annotation.sourceFormat === "legacy" ? "旧高亮，首次保存时绑定" : "已自动保存"} · ${this.annotation.orphaned ? "孤立记录" : "已绑定"}`);

    const grid = contentEl.createDiv({ cls: "local-ir-processing-grid" });
    const sourceColumn = grid.createDiv({ cls: "local-ir-processing-column" });
    sourceColumn.createEl("h3", { text: "当前高亮文本" });
    sourceColumn.createDiv({
      cls: "local-ir-muted",
      text: "保存后会同步修改 Markdown 中对应高亮块内部文本。"
    });
    const currentInput = sourceColumn.createEl("textarea");
    currentInput.value = currentText;
    currentInput.addEventListener("input", () => {
      currentText = currentInput.value;
    });

    const commentColumn = grid.createDiv({ cls: "local-ir-processing-column" });
    commentColumn.createEl("h3", { text: "评论/结构化加工" });
    commentColumn.createDiv({
      cls: "local-ir-muted",
      text: "只保存在插件数据里，不写入原文。"
    });
    const commentInput = commentColumn.createEl("textarea");
    commentInput.placeholder = annotationTemplate(type);
    commentInput.value = commentMarkdown;
    commentInput.addEventListener("input", () => {
      commentMarkdown = commentInput.value;
      scheduleDraftSave();
    });

    const rewriteColumn = grid.createDiv({ cls: "local-ir-processing-column" });
    rewriteColumn.createEl("h3", { text: "改写稿" });
    rewriteColumn.createDiv({
      cls: "local-ir-muted",
      text: "默认只保存；点击替换按钮才改原文高亮文本。"
    });
    const rewriteInput = rewriteColumn.createEl("textarea");
    rewriteInput.placeholder = "把这段材料改写成你自己的表述，或补充新的观点。";
    rewriteInput.value = rewriteMarkdown;
    rewriteInput.addEventListener("input", () => {
      rewriteMarkdown = rewriteInput.value;
      scheduleDraftSave();
    });

    const buttonRow = contentEl.createDiv({ cls: "local-ir-modal-buttons" });
    this.modalButton(buttonRow, "关闭", () => {
      void saveDraftNow().then(() => this.close());
    });
    this.modalButton(buttonRow, "删除记录", () => {
      void this.plugin.deleteAnnotation(this.annotation.id).then(() => this.close());
    });
    this.modalButton(buttonRow, "绑定到当前选区", () => {
      void this.plugin.rebindAnnotationToSelection({
        ...this.annotation,
        type,
        currentText,
        selectedText: currentText,
        commentMarkdown,
        rewriteMarkdown
      }).then(() => this.close());
    });
    this.modalButton(buttonRow, "用改写稿替换高亮文本", () => {
      const rewrite = rewriteMarkdown.trim();
      if (!rewrite) {
        new Notice("改写稿为空。");
        return;
      }
      currentText = rewrite;
      currentInput.value = currentText;
      void this.plugin.updateAnnotation({
        ...this.annotation,
        type,
        currentText,
        selectedText: currentText,
        commentMarkdown,
        rewriteMarkdown
      }, { applyRewrite: true }).then(() => this.close());
    });
    this.modalButton(buttonRow, "保存并关闭", () => {
      void this.plugin.updateAnnotation({
        ...this.annotation,
        type,
        currentText,
        selectedText: currentText,
        commentMarkdown,
        rewriteMarkdown
      }).then(() => this.close());
    }, true);
  }

  modalButton(container: HTMLElement, label: string, onClick: () => void, primary = false) {
    const button = container.createEl("button", {
      text: label,
      cls: primary ? "mod-cta" : ""
    });
    button.addEventListener("click", onClick);
  }

  onClose() {
    if (this.flushDraftSave) void this.flushDraftSave();
  }
}

function getNormalizedSelection(editor: Editor): EditorSelection | null {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const text = editor.getRange(from, to);
  if (!text.trim()) return null;
  return {
    from,
    to,
    fromOffset: editor.posToOffset(from),
    toOffset: editor.posToOffset(to),
    text
  };
}

function createWrappedHighlightText(id: string, selectedText: string, markKind: AnnotationMarkKind = "highlight"): { wrappedText: string; fragments: AnnotationFragment[] } {
  const protectedRanges = findProtectedMarkdownRanges(selectedText);
  const parts: { text: string; protect: boolean }[] = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    if (range.start > cursor) parts.push({ text: selectedText.slice(cursor, range.start), protect: false });
    parts.push({ text: selectedText.slice(range.start, range.end), protect: true });
    cursor = range.end;
  }
  if (cursor < selectedText.length) parts.push({ text: selectedText.slice(cursor), protect: false });
  if (parts.length === 0) parts.push({ text: selectedText, protect: false });

  const fragments: AnnotationFragment[] = [];
  const kindAttr = markKind === "cloze" ? ' data-ir-kind="cloze"' : "";
  const wrappedParts = parts.flatMap((part) => {
    if (!part.text) return [part.text];
    if (part.protect) return [part.text];
    return part.text.split(/(\r?\n[ \t]*\r?\n+)/g).map((chunk) => {
      if (!chunk) return chunk;
      if (/^\r?\n[ \t]*\r?\n+$/.test(chunk)) return chunk;
      if (!chunk.trim()) return chunk;
      const index = fragments.length;
      fragments.push({ index, text: chunk });
      return `<mark data-ir-id="${id}" data-ir-fragment="${index}"${kindAttr}>${chunk}</mark>`;
    });
  });

  if (fragments.length === 0) {
    fragments.push({ index: 0, text: selectedText });
    return {
      wrappedText: selectedText,
      fragments
    };
  }

  return {
    wrappedText: wrappedParts.join(""),
    fragments
  };
}

function findProtectedMarkdownRanges(text: string): TextRange[] {
  return findProtectedMarkdownRangesInContent(text).map((range) => ({ start: range.start, end: range.end }));
}

function findProtectedMarkdownRangesInContent(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const addMatches = (regex: RegExp) => {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length, kind: detectProtectedMatchKind(match[0]) });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  };

  addMatches(/```[\s\S]*?```/g);
  addMatches(/~~~[\s\S]*?~~~/g);
  addMatches(/\$\$[\s\S]*?\$\$/g);
  addMatches(/<style\b[\s\S]*?<\/style>/gi);
  addMatches(/<script\b[\s\S]*?<\/script>/gi);
  addMatches(/`+[\s\S]*?`+/g);
  addMatches(/!\[\[[\s\S]*?\]\]/g);
  addMatches(/\[\[[\s\S]*?\]\]/g);
  addMatches(/!\[[^\]]*?\]\([^)\n]+?\)/g);
  addMatches(/\[[^\]]+?\]\([^)\n]+?\)/g);
  addMatches(/\[[^\]]+?\]\[[^\]\n]*?\]/g);
  addMatches(/\$[^$\n]+?\$/g);
  ranges.push(...findHtmlBlockRanges(text));

  return mergeProtectedRanges(ranges, text.length);
}

function detectProtectedMatchKind(value: string): ProtectedKind {
  if (/^```|^~~~/m.test(value)) return "code_fence";
  if (/^\$\$/.test(value)) return "math_block";
  if (/^!\[|^!\[\[/i.test(value)) return "image";
  if (/^\[|\[\[/.test(value)) return "link";
  if (/^<style/i.test(value)) return "style_block";
  if (/^<script/i.test(value)) return "html_block";
  if (/^`/.test(value)) return "code_fence";
  if (/^\$/.test(value)) return "math_block";
  return "mixed";
}

function findHtmlBlockRanges(content: string): ProtectedRange[] {
  const lines = getMarkdownLines(content);
  const ranges: ProtectedRange[] = [];
  const blockTag = /<\/?(div|section|article|table|thead|tbody|tr|td|th|style|script|iframe|details|summary|ul|ol|li|p|h[1-6]|span)\b[^>]*>/gi;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*<([a-z][\w-]*)(\s|>|$)/i.test(line.text)) continue;
    const firstTag = /^\s*<([a-z][\w-]*)/i.exec(line.text);
    const tag = firstTag?.[1]?.toLowerCase();
    if (!tag || tag === "mark") continue;
    let depth = 0;
    let endIndex = index;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const text = lines[cursor].text;
      let match: RegExpExecArray | null;
      blockTag.lastIndex = 0;
      while ((match = blockTag.exec(text)) !== null) {
        const token = match[0];
        const tokenTag = match[1].toLowerCase();
        if (tokenTag !== tag) continue;
        if (/^<\//.test(token)) depth -= 1;
        else if (!/\/>$/.test(token)) depth += 1;
      }
      endIndex = cursor;
      if (depth <= 0 && cursor > index) break;
      if (cursor > index && !text.trim()) break;
    }
    if (endIndex > index) {
      ranges.push({ start: line.start, end: lines[endIndex].breakEnd, kind: tag === "style" ? "style_block" : "html_block" });
      index = endIndex;
    }
  }
  return ranges;
}

function mergeTextRanges(ranges: TextRange[], maxEnd: number): TextRange[] {
  const sorted = ranges
    .map((range) => ({ start: clampRangeIndex(range.start, maxEnd), end: clampRangeIndex(range.end, maxEnd) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function mergeProtectedRanges(ranges: ProtectedRange[], maxEnd: number): ProtectedRange[] {
  const sorted = ranges
    .map((range) => ({ start: clampRangeIndex(range.start, maxEnd), end: clampRangeIndex(range.end, maxEnd), kind: range.kind }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ProtectedRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      if (last.kind !== range.kind) last.kind = "mixed";
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function detectProtectedKindForSelection(content: string, fromOffset: number, toOffset: number, selectedText: string): ProtectedKind | null {
  const ranges = findProtectedMarkdownRangesInContent(content).filter((range) => rangesOverlap(range, { start: fromOffset, end: toOffset }));
  const directKinds: ProtectedKind[] = [];
  if (/```|~~~/.test(selectedText)) directKinds.push("code_fence");
  if (/<style\b|<\/style>/i.test(selectedText)) directKinds.push("style_block");
  if (/<[a-z][\w-]*\b[^>]*>|<\/[a-z][\w-]*>/i.test(selectedText)) directKinds.push("html_block");
  if (/\$\$[\s\S]*?\$\$/.test(selectedText)) directKinds.push("math_block");
  if (/!\[[^\]]*?\]\([^)\n]+?\)|!\[\[[\s\S]*?\]\]/.test(selectedText)) directKinds.push("image");
  if (/\[[^\]]+?\]\([^)\n]+?\)|\[\[[\s\S]*?\]\]/.test(selectedText)) directKinds.push("link");
  const kinds = [...ranges.map((range) => range.kind), ...directKinds].filter(Boolean);
  if (kinds.length === 0) return null;
  const unique = kinds.filter((kind, index, array) => array.indexOf(kind) === index);
  return unique.length === 1 ? unique[0] : "mixed";
}

function getLineRangeForOffsets(content: string, fromOffset: number, toOffset: number): LineRange {
  const lines = getMarkdownLines(content);
  const startLine = lines.find((line) => fromOffset >= line.start && fromOffset <= line.breakEnd)?.index ?? 0;
  const endLine = lines.find((line) => toOffset >= line.start && toOffset <= line.breakEnd)?.index ?? startLine;
  return { startLine, endLine };
}

function clampRangeIndex(value: number, maxEnd: number): number {
  return Math.max(0, Math.min(maxEnd, Math.round(Number(value) || 0)));
}

function createAnnotationAnchor(
  content: string,
  fromOffset: number,
  toOffset: number,
  selectedText: string,
  fragments: AnnotationFragment[]
): AnnotationAnchor {
  return {
    sectionPath: getSectionPathAtOffset(content, fromOffset),
    paragraphIndex: getParagraphIndexAtOffset(content, fromOffset),
    sourceOffset: fromOffset,
    contextBefore: stripIrMarkup(content.slice(Math.max(0, fromOffset - 120), fromOffset)).trim(),
    contextAfter: stripIrMarkup(content.slice(toOffset, Math.min(content.length, toOffset + 120))).trim(),
    contextHash: shortHash(`${selectedText}\n${fromOffset}\n${toOffset}`),
    fragmentCount: Math.max(1, fragments.length),
    crossedBlankLines: /\r?\n[ \t]*\r?\n/.test(selectedText)
  };
}

function createSelectionHierarchy(text: string): HierarchyContext {
  return {
    scope: "selection",
    headingPath: [],
    expandedText: stripIrMarkup(text).trim(),
    expandedAnswerText: stripIrMarkup(text).trim(),
    subtreeRange: null
  };
}

function resolveSelectionHierarchy(content: string, fromOffset: number, toOffset: number, selectedText: string): HierarchyContext {
  const lines = getMarkdownLines(content);
  const line = lines.find((item) => fromOffset >= item.start && fromOffset <= item.breakEnd);
  if (!line) return createSelectionHierarchy(selectedText);

  const heading = parseHeadingLine(line.text);
  if (heading && selectionMatchesNodeText(selectedText, heading.title, line, fromOffset, toOffset)) {
    return createHeadingHierarchy(content, lines, line.index, heading.level, heading.title);
  }

  const listItem = parseListLine(line.text);
  if (listItem && selectionMatchesNodeText(selectedText, listItem.text, line, fromOffset, toOffset)) {
    return createListHierarchy(content, lines, line.index, listItem.indent, listItem.text);
  }

  return createSelectionHierarchy(selectedText);
}

function resolveAnnotationHierarchy(content: string, annotation: AnnotationRecord): HierarchyContext {
  const markRange = annotation.sourceFormat === "mark" ? findFirstMarkRangeById(content, annotation.id) : null;
  const virtualRange = annotation.renderMode === "virtual_decoration" ? annotation.range : null;
  const sourceOffset = markRange?.start ?? virtualRange?.start ?? annotation.sourceOffset ?? annotation.anchor?.sourceOffset ?? null;
  if (typeof sourceOffset === "number") {
    const selected = annotation.currentText || annotation.selectedText || annotation.originalText;
    return resolveSelectionHierarchy(content, sourceOffset, markRange?.end ?? virtualRange?.end ?? sourceOffset + selected.length, selected);
  }
  if (annotation.scope !== "selection" && annotation.expandedText.trim()) {
    return {
      scope: annotation.scope,
      headingPath: annotation.headingPath,
      expandedText: annotation.expandedText,
      expandedAnswerText: annotation.expandedAnswerText || annotation.expandedText,
      subtreeRange: annotation.subtreeRange
    };
  }
  return createSelectionHierarchy(annotation.currentText || annotation.selectedText || annotation.originalText);
}

function getMarkdownLines(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const regex = /.*(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[0];
    if (!raw && match.index === content.length) break;
    const text = raw.replace(/\r?\n$/, "");
    lines.push({
      index,
      text,
      start: match.index,
      end: match.index + text.length,
      breakEnd: match.index + raw.length
    });
    index += 1;
  }
  return lines;
}

function parseHeadingLine(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(stripIrMarkup(line));
  if (!match) return null;
  return {
    level: match[1].length,
    title: stripIrMarkup(match[2]).replace(/\s+#+$/, "").trim()
  };
}

function parseListLine(line: string): { indent: number; text: string } | null {
  const match = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(stripIrMarkup(line));
  if (!match) return null;
  return {
    indent: countIndent(match[1]),
    text: stripIrMarkup(match[2]).trim()
  };
}

function selectionMatchesNodeText(selectedText: string, nodeText: string, line: MarkdownLine, fromOffset: number, toOffset: number): boolean {
  const selected = normalizeComparableText(selectedText);
  const node = normalizeComparableText(nodeText);
  if (!selected || !node) return false;
  if (selected === node) return true;

  const firstNonWhitespace = line.text.search(/\S/);
  const trimmedLineStart = line.start + (firstNonWhitespace < 0 ? 0 : firstNonWhitespace);
  const trimmedLineEnd = line.start + line.text.trimEnd().length;
  const coversWholeLine = fromOffset <= trimmedLineStart && toOffset >= trimmedLineEnd;
  return coversWholeLine && normalizeComparableText(line.text).includes(node);
}

function createHeadingHierarchy(content: string, lines: MarkdownLine[], lineIndex: number, level: number, title: string): HierarchyContext {
  let end = content.length;
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const heading = parseHeadingLine(lines[index].text);
    if (heading && heading.level <= level) {
      end = lines[index].start;
      break;
    }
  }
  const line = lines[lineIndex];
  const expandedText = stripIrMarkup(content.slice(line.start, end)).trim();
  const expandedAnswerText = stripIrMarkup(content.slice(line.breakEnd, end)).trim();
  return {
    scope: expandedAnswerText ? "heading_subtree" : "selection",
    headingPath: getHeadingPathForLine(lines, lineIndex),
    expandedText: expandedText || title,
    expandedAnswerText: expandedAnswerText || title,
    subtreeRange: expandedAnswerText ? { start: line.start, end } : null
  };
}

function createListHierarchy(content: string, lines: MarkdownLine[], lineIndex: number, indent: number, text: string): HierarchyContext {
  let end = lines[lineIndex].breakEnd;
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text.trim()) {
      end = line.breakEnd;
      continue;
    }
    const nextList = parseListLine(line.text);
    const nextIndent = nextList ? nextList.indent : countIndent((/^([ \t]*)/.exec(line.text)?.[1]) || "");
    if (nextIndent <= indent) break;
    end = line.breakEnd;
  }
  const line = lines[lineIndex];
  const expandedText = stripIrMarkup(content.slice(line.start, end)).trim();
  const expandedAnswerText = stripIrMarkup(content.slice(line.breakEnd, end)).trim();
  return {
    scope: expandedAnswerText ? "list_subtree" : "selection",
    headingPath: getHeadingPathForLine(lines, lineIndex),
    expandedText: expandedText || text,
    expandedAnswerText: expandedAnswerText || text,
    subtreeRange: expandedAnswerText ? { start: line.start, end } : null
  };
}

function getHeadingPathForLine(lines: MarkdownLine[], lineIndex: number): string[] {
  const path: string[] = [];
  for (let index = 0; index <= lineIndex; index += 1) {
    const heading = parseHeadingLine(lines[index].text);
    if (!heading) continue;
    path.splice(heading.level - 1);
    path[heading.level - 1] = heading.title;
  }
  return path.filter(Boolean);
}

function countIndent(value: string): number {
  return value.replace(/\t/g, "    ").length;
}

function getSectionPathAtOffset(content: string, offset: number): string[] {
  const path: string[] = [];
  const lines = content.slice(0, Math.max(0, offset)).split(/\r?\n/);
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    path.splice(level - 1);
    path[level - 1] = match[2];
  }
  return path.filter(Boolean);
}

function getParagraphIndexAtOffset(content: string, offset: number): number | null {
  const paragraphs = extractParagraphs(content, 0, false);
  const found = paragraphs.find((paragraph) => offset >= paragraph.start && offset <= paragraph.end);
  return found?.index ?? null;
}

function resolveBilingualMatch(content: string | null, annotation: AnnotationRecord): BilingualMatch {
  const empty = createEmptyBilingualMatch(annotation.currentText || annotation.selectedText);
  if (!content) return empty;

  const sections = detectBilingualSections(content);
  if (!sections.zh || !sections.en) return empty;

  const zhParagraphs = extractParagraphs(sections.zh.text, sections.zh.start, false);
  const enParagraphs = extractParagraphs(sections.en.text, sections.en.start, true);
  if (zhParagraphs.length === 0 || enParagraphs.length === 0) return empty;

  const markRange = findFirstMarkRangeById(content, annotation.id);
  const offset = markRange?.start ?? annotation.range?.start ?? annotation.anchor?.sourceOffset ?? annotation.sourceOffset;
  const zhIndex = findChineseParagraphIndex(zhParagraphs, annotation, offset);
  if (zhIndex === null) {
    return {
      ...empty,
      detected: true,
      strategy: "section-detected-no-anchor",
      warning: "检测到双语章节，但无法稳定定位中文段落。",
      needsApiResolution: true
    };
  }

  const chineseText = stripIrMarkup(zhParagraphs[zhIndex]?.text || annotation.currentText || annotation.selectedText);
  if (zhParagraphs.length === enParagraphs.length) {
    const english = enParagraphs[zhIndex]?.text || "";
    return {
      detected: true,
      strategy: "paragraph-index-exact",
      confidence: "high",
      chineseText,
      englishText: english,
      chineseParagraphIndex: zhIndex,
      englishParagraphIndex: zhIndex,
      candidates: english ? [{ index: zhIndex, text: english, score: 1 }] : [],
      warning: null,
      needsApiResolution: false
    };
  }

  const estimated = zhParagraphs.length > 1
    ? Math.round((zhIndex / (zhParagraphs.length - 1)) * Math.max(0, enParagraphs.length - 1))
    : 0;
  const candidates = enParagraphs
    .map((paragraph) => ({
      index: paragraph.index,
      text: paragraph.text,
      score: Math.max(0, 1 - Math.abs(paragraph.index - estimated) / Math.max(6, enParagraphs.length))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return {
    detected: true,
    strategy: "paragraph-index-normalized-window",
    confidence: "low",
    chineseText,
    englishText: "",
    chineseParagraphIndex: zhIndex,
    englishParagraphIndex: null,
    candidates,
    warning: "中英文段落数不一致，已生成候选，需要 API 语义对齐后再使用。",
    needsApiResolution: true
  };
}

function createEmptyBilingualMatch(text: string): BilingualMatch {
  return {
    detected: false,
    strategy: "none",
    confidence: "none",
    chineseText: text,
    englishText: "",
    chineseParagraphIndex: null,
    englishParagraphIndex: null,
    candidates: [],
    warning: null,
    needsApiResolution: false
  };
}

function detectBilingualSections(content: string): BilingualSections {
  const headings = extractMarkdownHeadingsLinear(content);

  const sectionFor = (predicate: (title: string) => boolean) => {
    const headingIndex = headings.findIndex((heading) => predicate(heading.title));
    if (headingIndex < 0) return null;
    const heading = headings[headingIndex];
    const next = headings[headingIndex + 1];
    const start = content.indexOf("\n", heading.end);
    const sectionStart = start >= 0 ? start + 1 : heading.end;
    const sectionEnd = next?.start ?? content.length;
    return {
      title: heading.title,
      text: content.slice(sectionStart, sectionEnd),
      start: sectionStart,
      end: sectionEnd
    };
  };

  return {
    zh: sectionFor((title) => /中文|Chinese/i.test(title) && !/English|英文/i.test(title)),
    en: sectionFor((title) => /English|英文/i.test(title))
  };
}

function extractParagraphs(text: string, baseOffset: number, filterEnglishTimestamps: boolean): TextParagraph[] {
  return extractParagraphsLinear(text, baseOffset, filterEnglishTimestamps, stripIrMarkup) as TextParagraph[];
}

function findChineseParagraphIndex(paragraphs: TextParagraph[], annotation: AnnotationRecord, offset: number | null | undefined): number | null {
  if (typeof offset === "number") {
    const byOffset = paragraphs.find((paragraph) => offset >= paragraph.start && offset <= paragraph.end);
    if (byOffset) return byOffset.index;
  }

  const needle = normalizeComparableText(annotation.currentText || annotation.selectedText || annotation.originalText);
  if (!needle) return null;
  const byText = paragraphs.find((paragraph) => normalizeComparableText(paragraph.text).includes(needle.slice(0, 80)));
  return byText?.index ?? null;
}

function findFirstMarkRangeById(content: string, id: string): { start: number; end: number } | null {
  const regex = createMarkRegex(id, true);
  const match = regex.exec(content);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length
  };
}

function stripIrMarkup(value: string): string {
  return value
    .replace(/<mark\b[^>]*>/gi, "")
    .replace(/<\/mark>/gi, "")
    .replace(/==([\s\S]*?)==/g, "$1")
    .replace(/\r\n/g, "\n");
}

function normalizeComparableText(value: string): string {
  return stripIrMarkup(value).replace(/\s+/g, "");
}

function replaceMarkedText(content: string, id: string, nextText: string): string {
  const range = findMarkedTextRange(content, id);
  if (!range) return content;
  const existing = content.slice(range.start, range.end);
  const markKind = existing.includes('data-ir-kind="cloze"') ? "cloze" : "highlight";
  const wrapped = createWrappedHighlightText(id, nextText, markKind).wrappedText;
  return `${content.slice(0, range.start)}${wrapped}${content.slice(range.end)}`;
}

function findMarkedTextRange(content: string, id: string): { start: number; end: number } | null {
  const regex = createMarkRegex(id, true);
  const matches = Array.from(content.matchAll(regex));
  if (matches.length === 0) return null;
  const first = matches[0];
  const last = matches[matches.length - 1];
  const start = first.index ?? 0;
  const end = (last.index ?? 0) + last[0].length;
  return { start, end };
}

function createMarkRegex(id: string, global: boolean): RegExp {
  return new RegExp(`<mark\\b(?=[^>]*data-ir-id="${escapeRegExp(id)}")[^>]*>[\\s\\S]*?<\\/mark>`, global ? "g" : "");
}

interface MarkRange extends TextRange {
  id: string;
  fullText: string;
  innerText: string;
  markKind: AnnotationMarkKind;
}

interface RepairedMarkGroup {
  id: string;
  markKind: AnnotationMarkKind;
  protectedKind: ProtectedKind;
  ranges: TextRange[];
}

function findAllMarkRanges(content: string): MarkRange[] {
  const ranges: MarkRange[] = [];
  const regex = /<mark\b([^>]*)>([\s\S]*?)<\/mark>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const attrs = match[1] || "";
    const idMatch = /data-ir-id="([^"]+)"/.exec(attrs);
    if (!idMatch?.[1]) continue;
    ranges.push({
      id: idMatch[1],
      start: match.index,
      end: match.index + match[0].length,
      fullText: match[0],
      innerText: match[2] || "",
      markKind: attrs.includes('data-ir-kind="cloze"') ? "cloze" : "highlight"
    });
  }
  return ranges;
}

function isDangerousMarkedRange(range: MarkRange, content: string): boolean {
  const protectedKind = detectProtectedKindForSelection(content, range.start, range.end, range.innerText);
  if (protectedKind) return true;
  return /<style\b|<\/style>|<script\b|<\/script>|^\s*<[a-z][\w-]*\b|```|~~~|\$\$/im.test(range.innerText);
}

function stripMarkedRangesAndTrack(content: string, ranges: MarkRange[]): { nextContent: string; groups: RepairedMarkGroup[] } {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const fragmentsById = new Map<string, RepairedMarkGroup>();
  let cursor = 0;
  let output = "";
  for (const range of sorted) {
    if (range.start < cursor) continue;
    output += content.slice(cursor, range.start);
    const start = output.length;
    output += range.innerText;
    const end = output.length;
    const protectedKind = detectProtectedKindForSelection(output, start, end, range.innerText) || detectProtectedMatchKind(range.innerText);
    const existing = fragmentsById.get(range.id);
    if (existing) {
      existing.ranges.push({ start, end });
      if (existing.protectedKind !== protectedKind) existing.protectedKind = "mixed";
    } else {
      fragmentsById.set(range.id, {
        id: range.id,
        markKind: range.markKind,
        protectedKind,
        ranges: [{ start, end }]
      });
    }
    cursor = range.end;
  }
  output += content.slice(cursor);
  return {
    nextContent: output,
    groups: Array.from(fragmentsById.values())
      .map((group) => ({ ...group, ranges: normalizeTextRanges(group.ranges) }))
      .sort((a, b) => a.ranges[0].start - b.ranges[0].start)
  };
}

function rewriteMarkIdentity(markText: string, id: string, fragmentIndex: number): string {
  let next = markText;
  if (/data-ir-id="[^"]+"/.test(next)) {
    next = next.replace(/data-ir-id="[^"]+"/, `data-ir-id="${id}"`);
  } else {
    next = next.replace("<mark", `<mark data-ir-id="${id}"`);
  }
  if (/data-ir-fragment="[^"]+"/.test(next)) {
    next = next.replace(/data-ir-fragment="[^"]+"/, `data-ir-fragment="${fragmentIndex}"`);
  } else {
    next = next.replace("<mark", `<mark data-ir-fragment="${fragmentIndex}"`);
  }
  return next;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function normalizeTextRanges(ranges: TextRange[]): TextRange[] {
  const sorted = ranges
    .map((range) => ({ start: Math.max(0, range.start), end: Math.max(0, range.end) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: TextRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

function getAnnotationVirtualRanges(annotation: AnnotationRecord): TextRange[] {
  return LocalIrDocumentCore.recordRanges(annotation);
}

function sameTextRanges(a: TextRange[], b: TextRange[]): boolean {
  return a.length === b.length && a.every((range, index) => range.start === b[index].start && range.end === b[index].end);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function cloneAnnotation(annotation: AnnotationRecord): AnnotationRecord {
  return {
    ...annotation,
    virtualRanges: annotation.virtualRanges.map((range) => ({ ...range })),
    anchor: annotation.anchor ? { ...annotation.anchor, sectionPath: [...annotation.anchor.sectionPath] } : null,
    fragments: annotation.fragments.map((fragment) => ({ ...fragment })),
    headingPath: [...annotation.headingPath],
    subtreeRange: annotation.subtreeRange ? { ...annotation.subtreeRange } : null
  };
}

function createVirtualHighlightExtension(plugin: LocalIncrementalReadingPlugin) {
  const historyShortcutExtension = Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      return plugin.handleVirtualHighlightUndoShortcut(view, event) || plugin.handleVirtualHighlightRedoShortcut(view, event);
    }
  }));
  const decorationExtension = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildVirtualHighlightDecorations(plugin, view);
    }

    update(update: ViewUpdate) {
      const path = getEditorViewPath(update.view);
      if (update.docChanged && path) {
        plugin.mapVirtualRangesForEditorChange(path, update);
      }
      const shouldRefresh = update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(localIrRefreshEffect)));
      if (shouldRefresh) {
        this.decorations = buildVirtualHighlightDecorations(plugin, update.view);
      }
    }
  }, {
    decorations: (value) => value.decorations,
    eventHandlers: {
      click(event, view) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const mark = target?.closest("[data-ir-virtual-id]") as HTMLElement | null;
        const id = mark?.getAttribute("data-ir-virtual-id");
        const annotation = id ? plugin.settings.annotations[id] : null;
        if (id && annotation && event.altKey) {
          event.preventDefault();
          plugin.queueManualMergeAnnotation(id);
          view.focus();
          return true;
        }
        if (isWholeBlockHighlightGesture(event, plugin.settings.processingModeEnabled)) {
          event.preventDefault();
          event.stopPropagation();
          void plugin.highlightWholeBlockAtClick(view, event);
          view.focus();
          return true;
        }
        if (!id || !annotation) return false;
        event.preventDefault();
        plugin.openAnnotationModal(annotation);
        view.focus();
        return true;
      }
    }
  });
  return [historyShortcutExtension, decorationExtension];
}

function buildVirtualHighlightDecorations(plugin: LocalIncrementalReadingPlugin, view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const path = getEditorViewPath(view);
  if (!path) return builder.finish();
  const docLength = view.state.doc.length;
  const decorations = plugin.getAnnotationsForPath(path)
    .filter((annotation) => annotation.renderMode === "virtual_decoration" && !annotation.orphaned)
    .flatMap((annotation) => getAnnotationVirtualRanges(annotation).map((range) => ({ annotation, range })))
    .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  for (const { annotation, range } of decorations) {
    const from = clampRangeIndex(range.start, docLength);
    const to = clampRangeIndex(range.end, docLength);
    if (to <= from) continue;
    builder.add(from, to, Decoration.mark({
      class: annotation.markKind === "cloze" ? "local-ir-virtual-cloze" : "local-ir-virtual-highlight",
      attributes: {
        "data-ir-virtual-id": annotation.id,
        "data-ir-kind": annotation.markKind
      }
    }));
  }
  return builder.finish();
}

function getEditorViewPath(view: EditorView): string | null {
  try {
    const info = view.state.field(editorInfoField, false) as { file?: TFile } | null;
    return info?.file?.path || null;
  } catch {
    return null;
  }
}

function getCodeMirrorView(editor: Editor | null): EditorView | null {
  const candidate = editor as unknown as { cm?: EditorView };
  return candidate?.cm instanceof EditorView ? candidate.cm : null;
}

function roulette(records: DocRecord[]): DocRecord {
  const weights = records.map((record) => Math.max(record.priority, 0.1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = Math.random() * total;

  for (let i = 0; i < records.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return records[i];
  }

  return records[records.length - 1];
}

function todayKey(): string {
  return dateKey(new Date());
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysKey(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

function isDateOnDay(value: string | null, day: string): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.startsWith(day);
  return dateKey(parsed) === day;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeMetrics(metrics: Partial<MetricValues> | undefined): MetricValues {
  return {
    importance: snapMetricValue(metrics?.importance ?? DEFAULT_METRICS.importance),
    urgency: snapMetricValue(metrics?.urgency ?? DEFAULT_METRICS.urgency),
    difficulty: snapMetricValue(metrics?.difficulty ?? DEFAULT_METRICS.difficulty),
    interest: snapMetricValue(metrics?.interest ?? DEFAULT_METRICS.interest)
  };
}

function captureAnnotationSnapshot(
  annotations: Record<string, AnnotationRecord>,
  ids: string[]
): Record<string, AnnotationRecord | null> {
  const snapshot: Record<string, AnnotationRecord | null> = {};
  for (const id of ids.filter((item, index, array) => item && array.indexOf(item) === index)) {
    snapshot[id] = annotations[id] ? cloneAnnotation(annotations[id]) : null;
  }
  return snapshot;
}

function calculatePriorityWithWeights(metrics: MetricValues, weights: MetricWeights): number {
  const normalizedMetrics = normalizeMetrics(metrics);
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + Number(weight || 0), 0);
  if (totalWeight <= 0) return 0;

  const score =
    normalizedMetrics.importance * weights.importance +
    normalizedMetrics.urgency * weights.urgency +
    normalizedMetrics.difficulty * weights.difficulty +
    normalizedMetrics.interest * weights.interest;

  return round(score / totalWeight);
}

function normalizeRecord(path: string, raw: unknown, weights: MetricWeights): DocRecord {
  const record = typeof raw === "object" && raw ? raw as Partial<DocRecord> : {};
  const metrics = normalizeMetrics(record.metrics);
  const status = normalizeStatus(record.status);
  return {
    path: record.path || path,
    title: record.title || path.split("/").pop()?.replace(/\.md$/i, "") || path,
    status,
    metrics,
    metricsEditedByUser: inferMetricsEditedByUser(metrics, record.metricsEditedByUser),
    metricPresetCheckedMtime: Number.isFinite(record.metricPresetCheckedMtime) ? Number(record.metricPresetCheckedMtime) : null,
    priority: calculatePriorityWithWeights(metrics, weights),
    visitCount: Math.max(0, Math.round(Number(record.visitCount) || 0)),
    lastVisited: record.lastVisited || null,
    deferUntil: record.deferUntil || null,
    archivedAt: record.archivedAt || null,
    archiveExportPath: record.archiveExportPath || null,
    archivePackagePath: record.archivePackagePath || null,
    archivePackageId: record.archivePackageId || null,
    archivePackageRevision: Number.isInteger(record.archivePackageRevision) ? record.archivePackageRevision! : null,
    archiveInputHash: record.archiveInputHash || null,
    exportPackageReadyAt: record.exportPackageReadyAt || null,
    archiveAttemptCount: Math.max(0, Math.round(Number(record.archiveAttemptCount) || 0)),
    archiveLastError: record.archiveLastError || null,
    archiveLastFailure: normalizeArchiveFailureState(record.archiveLastFailure),
    originalSourcePath: record.originalSourcePath || null,
    archivedSourcePath: record.archivedSourcePath || null,
    movedIntoReadingPoolFromPath: record.movedIntoReadingPoolFromPath || null,
    movedIntoReadingPoolAt: record.movedIntoReadingPoolAt || null,
    removedFromReadingPoolAt: record.removedFromReadingPoolAt || null,
    removedToPath: record.removedToPath || null,
    readingPathBeforeCompletion: record.readingPathBeforeCompletion || null,
    completedSourcePath: record.completedSourcePath || null,
    completedAt: record.completedAt || null,
    documentStateSidecarPath: record.documentStateSidecarPath || null,
    documentStateRevision: Number.isInteger(record.documentStateRevision) ? record.documentStateRevision! : null,
    documentStateUpdatedAt: record.documentStateUpdatedAt || null,
    documentStateFingerprint: record.documentStateFingerprint || null
  };
}

function normalizeArchiveFailureState(value: unknown): ArchiveFailureState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ArchiveFailureState>;
  const errors = Array.isArray(raw.details?.errors)
    ? raw.details!.errors.map((item) => String(item || "").replace(/[\r\n]+/g, " ").trim().slice(0, 500)).filter(Boolean).slice(0, 20)
    : [];
  return {
    code: String(raw.code || "UNEXPECTED_ERROR").slice(0, 80),
    kind: raw.kind === "blocked" ? "blocked" : "failed",
    reasonCode: raw.reasonCode ? String(raw.reasonCode).slice(0, 80) : null,
    message: String(raw.message || "Unknown batch archive package generation failure").replace(/[\r\n]+/g, " ").trim().slice(0, 500),
    details: { errors },
    retryable: raw.retryable !== false,
    occurredAt: raw.occurredAt ? String(raw.occurredAt) : null
  };
}

function normalizeReadingFolders(value: unknown, legacyFolder: unknown): string[] {
  const legacy = normalizePath(String(legacyFolder || DEFAULT_FOLDER).trim() || DEFAULT_FOLDER);
  const folders = Array.isArray(value)
    ? value.map((item) => normalizePath(String(item || "").trim())).filter(Boolean)
    : [];
  return uniqueNormalizedPaths(folders.length > 0 ? folders : [legacy]);
}

function uniqueNormalizedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pathValue of paths) {
    const normalized = normalizePath(String(pathValue || "").trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : [DEFAULT_FOLDER];
}

function normalizeStatus(status: unknown): ReadingStatus {
  return typeof status === "string" && VALID_STATUSES.has(status as ReadingStatus) ? status as ReadingStatus : "inbox";
}

function normalizeAnnotation(id: string, raw: unknown): AnnotationRecord {
  const annotation = typeof raw === "object" && raw ? raw as Partial<AnnotationRecord> : {};
  const now = new Date().toISOString();
  const selectedText = annotation.selectedText || annotation.currentText || annotation.originalText || "";
  const originalText = annotation.originalText || selectedText;
  const currentText = annotation.currentText || selectedText;
  const rewriteMarkdown = annotation.rewriteMarkdown || "";
  return {
    ...annotation,
    id: annotation.id || id,
    path: annotation.path || "",
    selectedText: currentText,
    sourceFormat: normalizeSourceFormat(annotation.sourceFormat),
    renderMode: normalizeAnnotationRenderMode(annotation.renderMode, annotation.sourceFormat),
    protectedKind: normalizeProtectedKind(annotation.protectedKind),
    markKind: normalizeMarkKind(annotation.markKind),
    originalText,
    currentText,
    type: normalizeAnnotationType(annotation.type),
    commentMarkdown: annotation.commentMarkdown || "",
    rewriteMarkdown,
    hasRewrite: Boolean(annotation.hasRewrite || rewriteMarkdown.trim()),
    rewriteApplied: Boolean(annotation.rewriteApplied),
    orphaned: Boolean(annotation.orphaned),
    lastKnownPath: annotation.lastKnownPath || annotation.path || "",
    sourceOffset: typeof annotation.sourceOffset === "number" ? annotation.sourceOffset : null,
    range: normalizeTextRange(annotation.range),
    virtualRanges: LocalIrDocumentCore.recordRanges(annotation),
    lineRange: normalizeLineRange(annotation.lineRange),
    anchor: normalizeAnnotationAnchor(annotation.anchor),
    fragments: normalizeAnnotationFragments(annotation.fragments, currentText),
    scope: normalizeHierarchyScope(annotation.scope),
    headingPath: Array.isArray(annotation.headingPath) ? annotation.headingPath.map(String).filter(Boolean) : [],
    expandedText: String(annotation.expandedText || currentText),
    expandedAnswerText: String(annotation.expandedAnswerText || annotation.expandedText || currentText),
    subtreeRange: normalizeTextRange(annotation.subtreeRange),
    createdAt: annotation.createdAt || now,
    updatedAt: annotation.updatedAt || annotation.createdAt || now,
    archived: Boolean(annotation.archived)
  };
}

function normalizeQaCard(id: string, raw: unknown): QaCardRecord {
  const card = typeof raw === "object" && raw ? raw as Partial<QaCardRecord> : {};
  const now = new Date().toISOString();
  const questionMarkdown = String(card.questionMarkdown || "");
  const answerMarkdown = String(card.answerMarkdown || "");
  return {
    id: card.id || id,
    path: card.path || "",
    source: card.source === "annotation" ? "annotation" : "article",
    sourceAnnotationId: card.sourceAnnotationId || null,
    questionMarkdown,
    answerMarkdown,
    answerSourceText: String(card.answerSourceText || ""),
    needsQuestionGeneration: Boolean(card.needsQuestionGeneration || !questionMarkdown.trim()),
    needsAnswerGeneration: Boolean(card.needsAnswerGeneration || !answerMarkdown.trim()),
    createdAt: card.createdAt || now,
    updatedAt: card.updatedAt || card.createdAt || now,
    archived: Boolean(card.archived)
  };
}

function normalizeArticleMusing(id: string, raw: unknown): ArticleMusingRecord {
  const musing = typeof raw === "object" && raw ? raw as Partial<ArticleMusingRecord> : {};
  const now = new Date().toISOString();
  return {
    id: musing.id || createMusingId(),
    path: musing.path || id,
    bodyMarkdown: String(musing.bodyMarkdown || ""),
    aiStatus: normalizeMusingAiStatus(musing.aiStatus),
    createdAt: musing.createdAt || now,
    updatedAt: musing.updatedAt || musing.createdAt || now,
    archived: Boolean(musing.archived)
  };
}

function normalizePendingImports(raw: unknown): PendingImportRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: PendingImportRecord[] = [];
  const now = new Date().toISOString();

  for (const value of raw) {
    const item = typeof value === "object" && value ? value as Partial<PendingImportRecord> : {};
    const rawUrl = normalizeExternalUrl(item.url || item.normalizedUrl || "");
    const normalizedUrl = normalizePendingImportUrl(rawUrl || "");
    if (!rawUrl || !normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const wasInterrupted = item.status === "importing";
    const brokerClientRequestId = String(item.brokerClientRequestId || "").trim() || null;
    result.push({
      id: item.id || `pending-import-${shortHash(normalizedUrl)}`,
      url: rawUrl,
      normalizedUrl,
      sourcePath: item.sourcePath ? normalizePath(String(item.sourcePath)) : null,
      status: item.status === "failed" ? "failed" : wasInterrupted && brokerClientRequestId ? "importing" : "pending",
      addedAt: item.addedAt || now,
      updatedAt: item.updatedAt || item.addedAt || now,
      lastAttemptAt: item.lastAttemptAt || null,
      attemptCount: Math.max(0, Math.round(Number(item.attemptCount) || 0)),
      lastError: item.lastError || (wasInterrupted && !brokerClientRequestId ? "上次导入未确认完成，请重试。" : null),
      brokerClientRequestId
    });
  }

  return result;
}

function normalizeMusingAiStatus(value: unknown): ArticleMusingAiStatus {
  return value === "resolved" || value === "skipped" ? value : "pending";
}

function trimTrailingUrlPunctuation(value: string): string {
  let candidate = String(value || "").trim().replace(/[.,;:!?，。；：！？、]+$/g, "");
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"], ["【", "】"], ["「", "」"], ["《", "》"]]) {
    while (candidate.endsWith(closing)) {
      const openings = candidate.split(opening).length - 1;
      const closings = candidate.split(closing).length - 1;
      if (closings <= openings) break;
      candidate = candidate.slice(0, -1);
    }
  }
  return candidate;
}

function parseExternalUrlCandidate(value: string): string | null {
  try {
    const url = new URL(trimTrailingUrlPunctuation(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalizePendingImportUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const trackingKeys: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) trackingKeys.push(key);
    });
    trackingKeys.forEach((key) => url.searchParams.delete(key));
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function extractExternalUrls(value: string): string[] {
  const matches = String(value || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const normalized = parseExternalUrlCandidate(match);
    if (!normalized) continue;
    const dedupeKey = canonicalizePendingImportUrl(normalized) || normalized;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    urls.push(normalized);
  }
  return urls;
}

function normalizeExternalUrl(value: string): string | null {
  return parseExternalUrlCandidate(value) || extractExternalUrls(value)[0] || null;
}

function normalizePendingImportUrl(value: string): string | null {
  const normalized = normalizeExternalUrl(value);
  return normalized ? canonicalizePendingImportUrl(normalized) : null;
}

function normalizeHierarchyScope(value: unknown): HierarchyScope {
  return value === "heading_subtree" || value === "list_subtree" ? value : "selection";
}

function normalizeTextRange(value: unknown): TextRange | null {
  if (!value || typeof value !== "object") return null;
  const range = value as Partial<TextRange>;
  if (typeof range.start !== "number" || typeof range.end !== "number") return null;
  if (range.end < range.start) return null;
  return { start: range.start, end: range.end };
}

function normalizeLineRange(value: unknown): LineRange | null {
  if (!value || typeof value !== "object") return null;
  const range = value as Partial<LineRange>;
  if (typeof range.startLine !== "number" || typeof range.endLine !== "number") return null;
  if (range.endLine < range.startLine) return null;
  return { startLine: Math.max(0, Math.round(range.startLine)), endLine: Math.max(0, Math.round(range.endLine)) };
}

function normalizeAnnotationType(type: unknown): AnnotationType {
  return typeof type === "string" && VALID_ANNOTATION_TYPES.has(type as AnnotationType) ? type as AnnotationType : "highlight";
}

function normalizeModalAnnotationType(type: unknown): AnnotationType {
  return typeof type === "string" && ANNOTATION_MODAL_TYPES.includes(type as AnnotationType) ? type as AnnotationType : "comment";
}

function normalizeSourceFormat(sourceFormat: unknown): AnnotationSourceFormat {
  if (sourceFormat === "virtual") return "virtual";
  return sourceFormat === "legacy" ? "legacy" : "mark";
}

function normalizeAnnotationRenderMode(renderMode: unknown, sourceFormat?: unknown): AnnotationRenderMode {
  if (renderMode === "virtual_decoration" || sourceFormat === "virtual") return "virtual_decoration";
  return "inline_mark";
}

function normalizeProtectedKind(value: unknown): ProtectedKind | null {
  return value === "html_block" ||
    value === "style_block" ||
    value === "code_fence" ||
    value === "math_block" ||
    value === "link" ||
    value === "image" ||
    value === "mixed"
    ? value
    : null;
}

function normalizeMarkKind(markKind: unknown): AnnotationMarkKind {
  return markKind === "cloze" ? "cloze" : "highlight";
}

function normalizeAnnotationAnchor(value: unknown): AnnotationAnchor | null {
  if (!value || typeof value !== "object") return null;
  const anchor = value as Partial<AnnotationAnchor>;
  return {
    ...anchor,
    sectionPath: Array.isArray(anchor.sectionPath) ? anchor.sectionPath.map(String) : [],
    paragraphIndex: typeof anchor.paragraphIndex === "number" ? anchor.paragraphIndex : null,
    sourceOffset: typeof anchor.sourceOffset === "number" ? anchor.sourceOffset : null,
    contextBefore: String(anchor.contextBefore || ""),
    contextAfter: String(anchor.contextAfter || ""),
    contextHash: String(anchor.contextHash || ""),
    fragmentCount: Math.max(1, Math.round(Number(anchor.fragmentCount) || 1)),
    crossedBlankLines: Boolean(anchor.crossedBlankLines)
  };
}

function normalizeAnnotationFragments(value: unknown, fallbackText: string): AnnotationFragment[] {
  if (Array.isArray(value)) {
    const fragments = value
      .map((item, index) => {
        const fragment = item as Partial<AnnotationFragment>;
        return {
          ...fragment,
          index: typeof fragment.index === "number" ? fragment.index : index,
          text: String(fragment.text || "")
        };
      })
      .filter((fragment) => fragment.text.trim());
    if (fragments.length > 0) return fragments;
  }
  return createWrappedHighlightText("normalizer", fallbackText).fragments.map((fragment) => ({
    index: fragment.index,
    text: fragment.text
  }));
}

function annotationTemplate(type: AnnotationType): string {
  switch (type) {
    case "comment":
      return "- 评论：";
    case "myth_truth":
      return "- 迷思：\n- 真相：";
    case "rebuttal":
      return "- 对方观点：\n- 问题：\n- 反驳：";
    case "sample_quote":
      return "- 用途：sample / 引用\n- 可复用点：";
    case "later":
      return "- 稍后处理原因：";
    case "rewrite":
      return "- 改写目标：";
    case "refine":
      return "- 精炼原则：";
    case "add_viewpoint":
      return "- 原论述可取处：\n- 我补充的观点：";
    case "rebuttal_rewrite":
      return "- 原论述问题：\n- 修正后的论述方向：";
    case "question":
      return "- 问题：\n- 暂定理解：\n- 相关概念：\n- 希望后续回答的方向：";
    case "optimize":
      return "- 原内容不足：\n- 补充说明：\n- 可优化表达：";
    case "example_viewpoint":
      return "- 观点：";
    case "qa_card":
      return "- 问题：\n- 备注：";
    case "highlight":
    default:
      return "";
  }
}

function resolveQaQuestion(annotation: ArchiveAnnotationPayload): string {
  const fromComment = extractQuestionFromComment(annotation.commentMarkdown);
  if (fromComment) return fromComment;
  const heading = annotation.headingPath[annotation.headingPath.length - 1] || "";
  if (annotation.scope === "heading_subtree" && isLikelyQuestion(heading)) return heading;
  const current = stripIrMarkup(annotation.currentText || "").trim();
  if (isLikelyQuestion(current)) return current;
  return "";
}

function shouldCreateQaCardFromAnnotation(annotation: ArchiveAnnotationPayload): boolean {
  if (annotation.type === "qa_card") return true;
  if (annotation.type === "question") return false;
  const heading = annotation.headingPath[annotation.headingPath.length - 1] || annotation.currentText;
  return annotation.scope === "heading_subtree" && isLikelyQuestion(heading);
}

function extractQuestionFromComment(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^-?\s*(?:问题|Q|Question)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  const meaningful = lines.filter((line) => !/^-?\s*备注\s*[:：]?\s*$/i.test(line));
  if (meaningful.length === 1 && !/^-\s*(问题|备注)\s*[:：]?\s*$/i.test(meaningful[0])) {
    return meaningful[0].replace(/^-\s*/, "").trim();
  }
  return "";
}

function isLikelyQuestion(value: string): boolean {
  const text = stripIrMarkup(value).replace(/^#+\s*/, "").trim();
  if (!text) return false;
  return /[?？]$/.test(text) || /^(什么|为何|为什么|如何|怎么|怎样|哪些|是否|能否|何以|Where|What|Why|How|When|Which|Can|Could|Should|Is|Are)\b/i.test(text);
}

function renderRemNoteMultiLineCard(question: string, answer: string): string {
  const q = stripIrMarkup(question).replace(/\s+/g, " ").trim() || "待生成问题";
  const answerLines = renderCardAnswerLines(answer);
  return [`- ${q} >>>`, ...answerLines].join("\n");
}

function renderClozeMarkdown(contextText: string, answerText: string): string {
  const context = stripIrMarkup(contextText).trim();
  const answer = stripIrMarkup(answerText).trim();
  if (!answer) return context;
  const cloze = `{{${answer}}}`;
  if (!context) return cloze;
  const index = context.indexOf(answer);
  if (index >= 0) {
    return `${context.slice(0, index)}${cloze}${context.slice(index + answer.length)}`;
  }
  return `${context}\n\n挖空：${cloze}`;
}

function renderQaCardPreview(card: QaCardRecord): string {
  return renderRemNoteMultiLineCard(
    card.questionMarkdown || "待生成问题",
    card.answerMarkdown || card.answerSourceText || "待生成答案"
  );
}

function renderCardAnswerLines(answer: string): string[] {
  const lines = stripIrMarkup(answer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return ["    - 待生成答案"];
  return lines.map((line) => `    - ${line.replace(/^[-*+]\s+/, "")}`);
}

function createQaCardId(): string {
  return `ir-card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createMusingId(): string {
  return `ir-musing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAnnotationId(): string {
  return `ir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFileName(value: string): string {
  return (value || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function blockquote(value: string): string {
  return value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function truncate(value: string, length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= length) return normalized;
  return `${normalized.slice(0, length - 1)}…`;
}

function isSubstantiveAnnotation(annotation: AnnotationRecord): boolean {
  return Boolean(
    annotation.commentMarkdown.trim() ||
    annotation.rewriteMarkdown.trim() ||
    annotation.hasRewrite ||
    annotation.rewriteApplied
  );
}

function getAnnotationRoute(annotation: AnnotationRecord): AnnotationRoute {
  if (annotation.type === "qa_card") return "remnote_card";
  if (annotation.type === "question") return "codex_question_queue";
  if (isSubstantiveAnnotation(annotation)) return "remnote";
  return "refined_reading";
}

function getRemNoteTargetDocument(annotation: AnnotationRecord): string {
  if (annotation.type === "myth_truth") return "迷思 / 真相";
  if (annotation.type === "sample_quote") return "引用";
  if (annotation.type === "add_viewpoint") return "联想";
  if (annotation.type === "optimize") return "优化";
  if (annotation.type === "example_viewpoint") return "例子与观点";
  return "普通评论";
}

function hasAnnotationWork(annotation: AnnotationRecord): boolean {
  return Boolean(
    annotation.commentMarkdown.trim() ||
    annotation.rewriteMarkdown.trim() ||
    annotation.hasRewrite ||
    annotation.rewriteApplied ||
    annotation.type !== "highlight" ||
    annotation.archived
  );
}

function scanLegacyHighlights(path: string, content: string): LegacyHighlight[] {
  const highlights: LegacyHighlight[] = [];
  const regex = /==([\s\S]*?)==/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const text = match[1];
    if (!text.trim()) continue;
    if (match.index > 0 && content[match.index - 1] === "=") continue;
    if (content[match.index + match[0].length] === "=") continue;
    highlights.push({
      id: `legacy-${shortHash(path)}-${match.index}`,
      path,
      text,
      startOffset: match.index,
      endOffset: match.index + match[0].length
    });
  }
  return highlights;
}

function replaceMarkInnerText(content: string, id: string, nextText: string): string {
  const regex = new RegExp(`(<mark\\b(?=[^>]*data-ir-id="${escapeRegExp(id)}")[^>]*>)([\\s\\S]*?)(<\\/mark>)`);
  return content.replace(regex, (_match, open: string, _inner: string, close: string) => `${open}${nextText}${close}`);
}

function hasMarkId(content: string, id: string): boolean {
  return new RegExp(`<mark\\b(?=[^>]*data-ir-id="${escapeRegExp(id)}")[^>]*>`).test(content);
}

function findSearchOffset(content: string, search: string, expectedOffset?: number | null): number {
  if (typeof expectedOffset === "number" && content.slice(expectedOffset, expectedOffset + search.length) === search) {
    return expectedOffset;
  }
  return content.indexOf(search);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
