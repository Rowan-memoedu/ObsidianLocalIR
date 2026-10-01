import type LocalIncrementalReadingPlugin from "./main";
import type { AnnotationRecord, AnnotationType, NoRemnoteContentPreflight, QaCardRecord } from "./types";
import {
  ANNOTATION_LABELS,
  ANNOTATION_MODAL_TYPES,
  ARCHIVE_ELEMENT_LABELS,
  annotationTemplate,
  normalizeModalAnnotationType,
  renderRemNoteMultiLineCard
} from "./model";
import { App, FuzzySuggestModal, Modal, Notice, Setting, TFolder } from "obsidian";
import { isPlainUndoShortcut, isPlainRedoShortcut } from "./editor-gestures";

export class NoRemnoteContentConfirmationModal extends Modal {
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

export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  plugin: LocalIncrementalReadingPlugin;
  onChoose: (folder: TFolder) => Promise<void>;
  placeholder: string;

  constructor(app: App, plugin: LocalIncrementalReadingPlugin, onChoose: (folder: TFolder) => Promise<void>, placeholder = "搜索并选择阅读池文件夹", private readingOnly = false) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
    this.placeholder = placeholder;
    this.setPlaceholder(this.placeholder);
  }

  getItems(): TFolder[] {
    return this.plugin.getVaultFolders().filter(folder => !this.readingOnly ||
      this.plugin.getReadingFolders().some(root => folder.path === root || folder.path.startsWith(`${root}/`)));
  }

  getItemText(folder: TFolder): string {
    return folder.path || "/";
  }

  onChooseItem(folder: TFolder) {
    void this.onChoose(folder);
  }
}

export class NumberInputModal extends Modal {
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

export class QaCardModal extends Modal {
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

export class AnnotationModal extends Modal {
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

    let type = this.annotation.type;
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
      button.addEventListener("click", async () => {
        await saveDraftNow();
        const nextType = normalizeModalAnnotationType(value);
        if (!commentMarkdown.trim() || commentMarkdown === annotationTemplate(type)) {
          commentMarkdown = annotationTemplate(nextType);
          commentInput.value = commentMarkdown;
        }
        type = nextType;
        renderTypeButtons();
        await saveDraftNow();
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

    this.modalEl.addEventListener("keydown", event => {
      const undo = isPlainUndoShortcut(event);
      if ((!undo && !isPlainRedoShortcut(event)) || event.target === currentInput) return;
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        await saveDraftNow();
        if (undo) await this.plugin.undoRecentHighlight();
        else await this.plugin.redoRecentVirtualHighlight(this.annotation.path);
        const restored = this.plugin.settings.annotations[this.annotation.id];
        if (!restored) { this.flushDraftSave = null; this.close(); return; }
        this.annotation = { ...restored };
        type = restored.type;
        commentMarkdown = restored.commentMarkdown;
        rewriteMarkdown = restored.rewriteMarkdown;
        currentText = restored.currentText;
        commentInput.value = commentMarkdown;
        rewriteInput.value = rewriteMarkdown;
        currentInput.value = currentText;
        renderTypeButtons();
        saveStatus.setText(undo ? "已撤销一步" : "已重做一步");
      })();
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
    if (this.flushDraftSave) void this.flushDraftSave().then(() => this.plugin.refreshViews());
  }
}
