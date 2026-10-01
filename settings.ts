import type LocalIncrementalReadingPlugin from "./main";
import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TFolder, normalizePath } from "obsidian";
import {
  DEFAULT_ARCHIVE_FOLDER,
  DEFAULT_COMPLETED_SOURCE_FOLDER,
  DEFAULT_DOCUMENT_STATE_FOLDER,
  DEFAULT_FOLDER,
  DEFAULT_LINK_IMPORT_FOLDER,
  DEFAULT_QUESTION_QUEUE_FOLDER,
  DEFAULT_REFINED_READING_FOLDER,
  DEFAULT_REMOVED_READING_FOLDER,
  DEFAULT_SOURCE_ARCHIVE_FOLDER
} from "./model";
import { FolderPickerModal } from "./modals";

export class LocalIRSettingTab extends PluginSettingTab {
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

    new Setting(containerEl)
      .setName("标准预处理工程目录")
      .setDesc("生成/更新导读卡复用此本地工程的 standard-preprocessing 单阶段接口；不重新抓取或翻译正文。")
      .addText(text => text.setValue(this.plugin.settings.preprocessingProjectPath).onChange(async value => {
        this.plugin.settings.preprocessingProjectPath = value.trim();
        await this.plugin.saveSettings({ flushDocumentStateSidecars: false });
      }));
  }
}

export class FolderInputSuggest extends AbstractInputSuggest<TFolder> {
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
