import * as path from "path";
import LocalIrDocumentCore from "../渐进阅读工作流/document-core/index.mjs";
import type {
  AnnotationAnchor,
  AnnotationFragment,
  AnnotationMarkKind,
  AnnotationRecord,
  AnnotationSourceFormat,
  ArchiveAnnotationPayload,
  ArchiveArticleMusingPayload,
  ArchiveClozeCardPayload,
  ArchiveQaCardPayload,
  ArticleMusingRecord,
  BrowserImportRequestResponse,
  DocRecord,
  EditorSelection,
  HierarchyContext,
  HierarchyScope,
  LegacyHighlight,
  LinkImportBatchItem,
  LinkImportBatchResponse,
  LinkImportResult,
  LocalIRSettings,
  MarkRange,
  MetricKey,
  MetricValues,
  NoRemnoteContentPreflight,
  NormalizedHighlightSelection,
  PendingImportRecord,
  QaCardRecord,
  ReadingStatus,
  RecentHighlightAction,
  RecentVirtualHighlightRedoAction,
  TextRange
} from "./types";
import {
  ANNOTATION_LABELS,
  DEFAULT_ARCHIVE_FOLDER,
  DEFAULT_COMPLETED_SOURCE_FOLDER,
  DEFAULT_DOCUMENT_STATE_FOLDER,
  DEFAULT_FOLDER,
  DEFAULT_LINK_IMPORT_FOLDER,
  DEFAULT_METRICS,
  DEFAULT_QUESTION_QUEUE_FOLDER,
  DEFAULT_REFINED_READING_FOLDER,
  DEFAULT_REMOVED_READING_FOLDER,
  DEFAULT_SETTINGS,
  DEFAULT_SOURCE_ARCHIVE_FOLDER,
  DEFAULT_WEIGHTS,
  DOCUMENT_STATE_SUFFIX,
  LOCAL_IR_SERVICE_PORT_END,
  LOCAL_IR_SERVICE_PORT_START,
  METRIC_LABELS,
  PLUGIN_DATA_VERSION,
  VIEW_TYPE_LOCAL_IR,
  addDaysKey,
  blockquote,
  calculatePriorityWithWeights,
  captureAnnotationSnapshot,
  clamp,
  clampRangeIndex,
  cloneAnnotation,
  createAnnotationAnchor,
  createAnnotationId,
  createMusingId,
  createQaCardId,
  createSelectionHierarchy,
  createWrappedHighlightText,
  detectProtectedKindForSelection,
  escapeYaml,
  extractExternalUrls,
  findAllMarkRanges,
  findLastIndex,
  findMarkedTextRange,
  findSearchOffset,
  getAnnotationRoute,
  getAnnotationVirtualRanges,
  getLineRangeForOffsets,
  getNormalizedSelection,
  getRemNoteTargetDocument,
  hasAnnotationWork,
  hasMarkId,
  isDangerousMarkedRange,
  isDateOnDay,
  normalizeAnnotation,
  normalizeAnnotationType,
  normalizeArchiveFailureState,
  normalizeArticleMusing,
  normalizeExternalUrl,
  normalizeMarkKind,
  normalizeMetrics,
  normalizePendingImportUrl,
  normalizePendingImports,
  normalizeQaCard,
  normalizeReadingFolders,
  normalizeRecord,
  normalizeStatus,
  normalizeTextRanges,
  rangesOverlap,
  renderClozeMarkdown,
  renderRemNoteMultiLineCard,
  replaceMarkedText,
  resolveAnnotationHierarchy,
  resolveBilingualMatch,
  resolveQaQuestion,
  resolveSelectionHierarchy,
  roulette,
  sameTextRanges,
  sanitizeFileName,
  scanLegacyHighlights,
  shortHash,
  shouldCreateQaCardFromAnnotation,
  stripIrMarkup,
  stripMarkedRangesAndTrack,
  todayKey,
  truncate,
  uniqueNormalizedPaths
} from "./model";
import { AnnotationModal, NoRemnoteContentConfirmationModal, QaCardModal } from "./modals";
import { CoalescedAsyncTask } from "./async-work";
import {
  DEFAULT_METRIC_VALUE,
  MAX_METRIC_VALUE,
  isDefaultMetricInitialization,
  parseReadingMetricPreset,
  reconcileReadingMetricPreset,
  snapMetricValue
} from "./metric-presets";
import { Editor, Menu, Notice, Plugin, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";
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
import { LocalIRSettingTab } from "./settings";
import { LocalIRView } from "./sidebar";
import { comparePriorityRecords, findExtremePriorityRecord } from "./priority-scheduling";
import {
  createVirtualHighlightExtension,
  getCodeMirrorView,
  getEditorViewPath,
  localIrRefreshEffect
} from "./editor-integration";
import { documentStateFileName, indexByDocument } from "./document-state";
import {
  getMarkdownBlockRangeAtOffset,
  isPlainRedoShortcut,
  isPlainUndoShortcut,
  isUndoableVirtualHighlightAction
} from "./editor-gestures";
import { mapReadingText, readingDecorationRanges, readingSelectionOffsets } from "./reading-highlights";
import { promises as fs } from "fs";

if (!LocalIrDocumentCore?.normalizeDocumentState) {
  throw new Error("Local IR document core is unavailable.");
}

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
  private pendingSidecarPaths = new Set<string>();
  private dataSaveTask = new CoalescedAsyncTask(async () => { await this.saveData(this.settings); });
  private sidecarFlushTask = new CoalescedAsyncTask(() => this.flushPendingDocumentStateSidecars());
  private sidecarScanSignatures = new Map<string, string>();
  private managedRenamePaths = new Set<string>();
  private viewRefreshTask = new CoalescedAsyncTask(() => this.renderViews());
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
    this.register(() => {
      for (const timer of Object.values(this.reconcileTimers)) window.clearTimeout(timer);
      this.reconcileTimers = {};
    });

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

  async saveSettings(options?: { flushDocumentStateSidecars?: boolean; documentPaths?: string[] }) {
    await this.dataSaveTask.request();
    if (options?.flushDocumentStateSidecars !== false) {
      await this.flushDocumentStateSidecars(options?.documentPaths);
    }
  }

  getDocumentStateSidecarPath(markdownPath: string): string {
    const folder = normalizePath(this.settings.documentStateFolder || DEFAULT_DOCUMENT_STATE_FOLDER);
    return normalizePath(`${folder}/${documentStateFileName(normalizePath(markdownPath))}`);
  }

  getFlatDocumentStateSidecarPath(markdownPath: string): string {
    const folder = normalizePath(this.settings.documentStateFolder || DEFAULT_DOCUMENT_STATE_FOLDER);
    return normalizePath(`${folder}/${normalizePath(markdownPath).split("/").pop()}${DOCUMENT_STATE_SUFFIX}`);
  }

  getLegacyDocumentStateSidecarPath(markdownPath: string): string {
    return normalizePath(`${markdownPath}${DOCUMENT_STATE_SUFFIX}`);
  }

  async resolveDocumentStateSidecarPath(markdownPath: string): Promise<string | null> {
    const candidates = new Set([
      this.settings.records[markdownPath]?.documentStateSidecarPath,
      this.getDocumentStateSidecarPath(markdownPath),
      this.getFlatDocumentStateSidecarPath(markdownPath),
      this.getLegacyDocumentStateSidecarPath(markdownPath)
    ].filter(Boolean) as string[]);
    for (const candidate of candidates) {
      if (!(await this.app.vault.adapter.exists(candidate))) continue;
      try {
        await this.readDocumentStateSidecarAtPath(candidate, markdownPath);
        return candidate;
      } catch (error) {
        console.warn(`Local IR: ignoring an invalid or mismatched sidecar: ${candidate}`);
      }
    }
    return null;
  }

  async readDocumentStateSidecarAtPath(sidecarPath: string, fallbackMarkdownPath = ""): Promise<{ state: any; sidecarPath: string }> {
    const raw = await this.app.vault.adapter.read(sidecarPath);
    const parsed = JSON.parse(raw);
    const supported = parsed?.schema === LocalIrDocumentCore.DOCUMENT_STATE_SCHEMA || parsed?.schema_version === 1;
    if (!supported) throw new Error("Unsupported Local IR document state schema.");
    const documentPath = normalizePath(parsed?.document?.path || fallbackMarkdownPath);
    if (!documentPath) throw new Error("Local IR document state is missing document.path.");
    if (fallbackMarkdownPath && documentPath !== normalizePath(fallbackMarkdownPath)) {
      throw new Error("Local IR document state belongs to another document.");
    }
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
    const sidecarPath = explicitSidecarPath || await this.resolveDocumentStateSidecarPath(file.path);
    if (!sidecarPath) return false;
    const stat = await this.app.vault.adapter.stat?.(sidecarPath);
    const signature = stat ? `${sidecarPath}:${stat.mtime}:${stat.size}:${file.stat.mtime}` : null;
    if (signature && this.sidecarScanSignatures.get(file.path) === signature) return false;
    const markdown = await this.app.vault.cachedRead(file);
    const changed = await this.importDocumentStateSidecarPath(file.path, sidecarPath, markdown);
    if (signature) this.sidecarScanSignatures.set(file.path, signature);
    return changed;
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
    // Only the downstream archive transition may advance a frozen input.
    // An older/external editing sidecar must not reopen a committed package.
    if (this.isRecordFrozenForExport(markdownPath) &&
        (record.status === "archived" || state.document.status !== "archived")) return false;
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

  async flushDocumentStateSidecars(paths?: string[]) {
    for (const documentPath of paths || Object.keys(this.settings.records)) {
      if (this.settings.records[documentPath]?.documentStateSidecarPath) this.pendingSidecarPaths.add(documentPath);
    }
    if (this.pendingSidecarPaths.size === 0) return;
    await this.sidecarFlushTask.request();
  }

  private async flushPendingDocumentStateSidecars() {
    const paths = [...this.pendingSidecarPaths];
    this.pendingSidecarPaths.clear();
    const annotations = indexByDocument(this.settings.annotations);
    const qaCards = indexByDocument(this.settings.qaCards);
    let cacheChanged = false;
    try {
      for (const documentPath of paths) {
        const record = this.settings.records[documentPath];
        if (!record?.documentStateSidecarPath) continue;
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
          annotations: annotations.get(record.path) || [],
          qaCards: qaCards.get(record.path) || [],
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
      if (cacheChanged) await this.dataSaveTask.request();
    } catch (error) {
      for (const documentPath of paths) this.pendingSidecarPaths.add(documentPath);
      throw error;
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
    if (this.isRecordFrozenForExport(file.path)) {
      new Notice("导出包已冻结，不能移动或重新开启加工。");
      return null;
    }
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
    await this.renameManagedFile(file, targetPath);
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

  async handleVaultRename(file: unknown, oldPath: string, managed = false) {
    if (!(file instanceof TFile)) return;
    if (file.path.endsWith(DOCUMENT_STATE_SUFFIX)) {
      await this.handleDocumentStateSidecarArrival(file.path);
      return;
    }
    if (file.extension.toLowerCase() !== "md") return;
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(file.path);
    if (!managed && this.managedRenamePaths.has(normalizedOldPath)) return;
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

    const loaded = await this.readDocumentStateSidecar(normalizedOldPath);

    if (existingRecord) {
      delete this.settings.records[normalizedOldPath];
      // Preserve object identity for operations awaiting the managed move.
      Object.assign(existingRecord, normalizeRecord(normalizedNewPath, {
        ...existingRecord,
        path: normalizedNewPath,
        title: this.getTitle(file)
      }, this.settings.metricWeights));
      this.settings.records[normalizedNewPath] = existingRecord;
    }
    this.updateLinkedPaths(normalizedOldPath, normalizedNewPath);
    if (loaded && existingRecord) {
      // Keep the verified state-file identity, including legacy flat sidecars.
      const next = LocalIrDocumentCore.replaceDocumentCollections(loaded.state, {
        path: normalizedNewPath, title: existingRecord.title,
        status: existingRecord.status, deferUntil: existingRecord.deferUntil,
        annotations: this.getAnnotationsForPath(normalizedNewPath),
        qaCards: this.getQaCardsForPath(normalizedNewPath),
        articleMusing: this.getArticleMusing(normalizedNewPath)
      });
      await this.writeDocumentStateSidecarAtomic(loaded.sidecarPath, `${JSON.stringify(next, null, 2)}\n`);
      existingRecord.documentStateSidecarPath = loaded.sidecarPath;
      existingRecord.documentStateRevision = next.document.revision;
      existingRecord.documentStateUpdatedAt = next.document.updatedAt;
      existingRecord.documentStateFingerprint = LocalIrDocumentCore.comparableDocumentState(next);
    }
    this.sidecarScanSignatures.delete(normalizedOldPath);
    this.sidecarScanSignatures.delete(normalizedNewPath);
    if (!managed) {
      await this.saveSettings({ documentPaths: [normalizedNewPath] });
      await this.refreshViews();
    }
  }

  private async renameManagedFile(file: TFile, targetPath: string) {
    const oldPath = file.path;
    this.managedRenamePaths.add(oldPath);
    try {
      await this.app.fileManager.renameFile(file, targetPath);
      await this.handleVaultRename(file, oldPath, true);
    } finally {
      this.managedRenamePaths.delete(oldPath);
    }
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
    await this.renameManagedFile(file, finalPath);
    return finalPath;
  }

  async syncRecords(options?: { save?: boolean }): Promise<DocRecord[]> {
    const files = this.getPoolFiles();
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

    // Pool membership is a queue filter, never authorization to delete processing data.
    // A folder change, temporary index gap or external move must remain reversible.

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
    if (!this.isPathInReadingPool(record.path) || !(this.app.vault.getAbstractFileByPath(record.path) instanceof TFile)) return false;
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
    if (countVisit && !this.isRecordFrozenForExport(path)) {
      record.status = "reading";
      record.deferUntil = null;
      record.visitCount += 1;
      record.lastVisited = new Date().toISOString();
      record.priority = this.calculatePriority(record.metrics);
      this.settings.records[path] = record;
      await this.saveSettings({ documentPaths: [path] });
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  async updateRecord(path: string, updates: Partial<DocRecord>) {
    const record = this.settings.records[path];
    if (!record || this.isRecordFrozenForExport(path)) return;
    this.settings.records[path] = {
      ...record,
      ...updates,
      metrics: updates.metrics ? { ...record.metrics, ...updates.metrics } : record.metrics
    };
    this.settings.records[path].priority = this.calculatePriority(this.settings.records[path].metrics);
    await this.saveSettings({ documentPaths: [path] });
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
    if (this.isRecordFrozenForExport(path)) return;
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

    await this.saveSettings({ documentPaths: [movedPath] });
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
    if (this.isRecordFrozenForExport(path)) {
      new Notice("导出包已冻结；安全撤回完成前不能恢复阅读或移动原文。");
      return;
    }
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
    await this.saveSettings({ documentPaths: [restoredPath] });
    await this.refreshViews();
    new Notice("已恢复到阅读队列。已生成的导出包会保留，便于审计。");
  }

  async updateMetric(path: string, metric: MetricKey, value: number) {
    const record = this.settings.records[path];
    if (!record || this.isRecordFrozenForExport(path)) return;
    record.metrics[metric] = snapMetricValue(value);
    record.metricsEditedByUser = true;
    record.priority = this.calculatePriority(record.metrics);
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
  }

  async setExtremeImportance(path: string, enabled: boolean) {
    const record = this.settings.records[path];
    if (!record || this.isRecordFrozenForExport(path)) return;
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
    await this.saveSettings({ flushDocumentStateSidecars: false });
    await this.refreshViews();
    new Notice("已重置今日访问记录。");
  }

  async refreshViews() {
    await this.viewRefreshTask.request();
  }

  private async renderViews() {
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
        await this.saveSettings({ documentPaths: [path] });
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
    await this.saveSettings({ documentPaths: [path] });
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
    await this.saveSettings({ documentPaths: [path] });
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
    await this.saveSettings({ documentPaths: [existing.path] });
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
    await this.saveSettings({ documentPaths: existing ? [existing.path] : [] });
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
    await this.saveSettings({ documentPaths: [next.path] });
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
    await this.updateContentInEditorOrFile(annotation.path, () => nextContent);
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
    if (this.isRecordFrozenForExport(existing.path)) return;

    const next = normalizeAnnotation(annotation.id, {
      ...existing,
      type: normalizeAnnotationType(annotation.type),
      commentMarkdown: annotation.commentMarkdown,
      rewriteMarkdown: annotation.rewriteMarkdown,
      hasRewrite: Boolean(annotation.rewriteMarkdown.trim()),
      updatedAt: new Date().toISOString()
    });
    this.settings.annotations[next.id] = next;
    await this.saveSettings({ documentPaths: [next.path] });
    // The modal owns its draft; refresh the sidebar once on close, not per keystroke.
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
    if (this.isRecordFrozenForExport(activePath)) return;
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
    await this.saveSettings({ documentPaths: [path] });
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
    if (this.isRecordFrozenForExport(path)) return;
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
    if (this.isRecordFrozenForExport(path)) return false;
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
    if (this.isRecordFrozenForExport(path)) return;
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
    if (annotation.archived || this.isRecordFrozenForExport(annotation.path)) return;
    const active = this.app.workspace.activeEditor;
    if (!active?.editor || !active.file) {
      new Notice("当前没有可用选区。");
      return;
    }

    if (this.isRecordFrozenForExport(active.file.path)) return;
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
