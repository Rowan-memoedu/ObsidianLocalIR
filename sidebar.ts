import type LocalIncrementalReadingPlugin from "./main";
import type { DocRecord, MetricKey } from "./types";
import {
  ANNOTATION_LABELS,
  METRIC_LABELS,
  STATUS_LABELS,
  VIEW_TYPE_LOCAL_IR,
  createAnnotationId,
  extractExternalUrls,
  isDateOnDay,
  renderQaCardPreview,
  resolveAnnotationHierarchy,
  todayKey,
  truncate
} from "./model";
import { metricLevelLabel, snapMetricValue } from "./metric-presets";
import { FolderPickerModal, NumberInputModal } from "./modals";
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { isExtremePriorityMetrics } from "./priority-scheduling";
import { hasReadingGuide } from "./reading-guide";

export class LocalIRView extends ItemView {
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
      text: "撤销",
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

    toolbar.createDiv({ cls: "local-ir-muted", text: `当前抽取范围：${this.plugin.settings.activeReadingPoolFolder || "全部阅读池"}（含子文件夹）` });
    this.action(toolbar, "指定阅读池", async () => {
      new FolderPickerModal(this.app, this.plugin, folder => this.plugin.setActiveReadingPoolFolder(folder.path), "选择本次阅读的文件夹", true).open();
    });
    if (this.plugin.settings.activeReadingPoolFolder) this.action(toolbar, "恢复全部阅读池", () => this.plugin.setActiveReadingPoolFolder(null));

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
    // Rendering is read-only. Legacy markup repair is an explicit toolbar action.

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
      void this.plugin.setExtremeImportance(record.path, enabled).catch((error) => {
        console.error(`Local IR: failed to set extreme importance for ${record.path}`, error);
        new Notice("极度重要保存失败，请重试。");
      });
    });

    const actions = card.createDiv({ cls: "local-ir-toolbar" });
    if (!this.plugin.isRecordFrozenForExport(record.path)) {
      const file = this.app.workspace.getActiveFile();
      const source = this.plugin.getActiveEditorForPath(record.path)?.getValue() ?? await this.plugin.readVaultFile(record.path) ?? "";
      const metadata = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
      const busy = this.plugin.readingGuideJobs.has(record.path);
      const guide = actions.createEl("button", { text: busy ? "导读卡生成中…" : hasReadingGuide(source, metadata) ? "导读卡更新" : "生成导读卡", cls: "local-ir-button" });
      guide.disabled = busy;
      guide.addEventListener("click", () => void this.plugin.generateReadingGuide(record.path));
    }
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
      this.action(actions, "30 天", () => this.plugin.deferRecord(record.path, 30));
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
