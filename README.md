# 渐进阅读 Local IR

Obsidian 桌面端本地渐进阅读插件。它负责把已经整理好的 Markdown 放入本地阅读队列，支持低摩擦高亮加工、挖空标注、文章问答卡、文章随想，并把完成阅读的文章批量生成 RemNote 导出队列。

## 当前版本

- 插件版本：`0.9.0`
- 插件 ID：`local-ir`
- 安装目录：`.obsidian/plugins/local-ir/`
- 初次安装默认阅读池：`00 Inbox/IR 工作台/00 原文队列`；已有安装保留自己的 `readingFolders`，不会被默认值覆盖。
- 默认导出队列：`04 Projects/渐进阅读工作流/RemNote 导出队列`
- 默认待归档原文目录：`04 Projects/渐进阅读工作流/待归档原文`
- 默认已归档原文目录：`04 Projects/渐进阅读工作流/已归档原文`
- 默认移出阅读池目录：`04 Projects/渐进阅读工作流/移出阅读池`

实现职责、开发意图、差异修复与验证范围统一见 [实现机制与意图对照](docs/ARCHITECTURE.md)。
唯一活动源码为 `D:\Projects\ObsidianLocalIR`；旧工作区入口仅为兼容 junction。

## 核心工作流

1. 把 Markdown 放入阅读池，或打开任意 Markdown 后点击 `当前文件放入阅读池`。也可以在设置页配置多个阅读池。
2. 在右侧 Local IR 面板点击 `刷新阅读池`。
3. 点击 `继续阅读`：四项全高的“极度重要”文章会先进入排期；没有满档候选时，插件按现有最高分概率和加权轮盘打开下一篇。
4. 阅读中可以用“极低 / 低 / 中 / 高 / 极高”五档调整价值判断、信息密度判断、难度、兴趣；勾选“极度重要”会把四项直接设为“极高”。
5. 需要加工时开启 `加工模式`；需要生成挖空材料时开启 `挖空模式`。
6. 选中文本后插件自动标注，但默认不弹窗；点击标注再进入加工弹窗。
7. 可添加普通评论、迷思 / 真相、引用、联想、提问、优化、例子与观点、问答卡等加工类型。
8. 可在“文章问答卡”区保存文章级问题和答案。
9. 可在“文章随想”区记录全文批注或随想；native-v2 会完整携带随想，正式导入由工程五写入 `文章随想` 文档并回读。
10. 读完后点击 `完成阅读`，文章进入 `待生成导出包`，原文先移到 `待归档原文` staging。
11. 在 `待生成导出包` 列表可点击单篇 `生成导出包`；也可点击 `批量生成 RemNote 导出包`。批量入口默认按本轮独立候选数自适应并发：12 篇启动 12 路、53 篇启动 53 路，不设固定三路上限。归一化后没有 RemNote import item 的文章会先弹窗列出缺失的批注/QA/挖空/随想；取消则保持 `done` 且不计失败，确认后写入版本化 `localArchive.noRemnoteContentConfirmation` 并继续生成，不伪造 RemNote 内容。成功只表示 `export_package_ready`，原文仍留在 staging。
12. 在 `04 Projects/渐进阅读工作流` 运行工程五的 dry-run/正式入口；只有 RemNote 写入、回读和成功 receipt 完成后，工程五才可移动原文并回写 `archived`。
13. 在 Obsidian 1.5.1 或更高版本中，外部链接的原生右键菜单可选择 `加入待导入列表` 或 `立即导入到渐进阅读`；待导入列表位于阅读池管理区之前，同时保留来源文档路径，失败项会保留以便重试。

右侧栏按当前文档控制、阅读加工工具、当前文档详情、待导入列表、阅读池管理/统计/列表的顺序排列，阅读池相关内容统一收在最下方。

新 Markdown 首次进入阅读池时，插件会读取标准化文本中的 `## 阅读前置卡`，兼容列表式 `价值判断：极高` / `信息密度判断：中` 和旧式三级标题；也可读取 frontmatter 中的 `value_judgment`、`information_density` 等兼容字段。五档依次映射为 0 / 2.5 / 5 / 7.5 / 10；旧产物中的“跳过”继续兼容为“极低”。如果 sidecar 先于 Markdown 建立默认记录，最终 Markdown 可读后会对仍处于默认初始化态且从未人工调节的记录补读一次；任何人工调节都会永久阻止自动覆盖。

## 浏览器高亮输入

浏览器扩展与 Obsidian 插件现在共用同一份 Local IR 文档核心。浏览器保存时，阅读区只写入可直接阅读的 Markdown；版本化 `.browser-ir.json` 状态保存在项目内部目录。Local IR 会监听新状态文件，并在插件加载时通过底层 adapter 枚举隐藏状态目录完成兜底扫描；sidecar 和关联 Markdown 都可直接经 adapter 读取，不依赖 Obsidian 文件索引是否收录隐藏目录或外部移动到位的文件。插件会自动导入其中的高亮、评论、加工类型、挖空、问答卡、文章随想和阅读状态；外部生产者还可在 `document.status=later` 时提供 ISO 日期 `document.deferUntil`，插件会把它作为真实 Later 到期日导入并回写。状态为 `done` 且原文位于 `待归档原文/` 的浏览器文档也会按同一合同导入并保留为待批量归档记录。

```text
04 Projects/渐进阅读工作流/阅读区/浏览器高亮
```

状态文件是这类浏览器文档的状态权威，Markdown 正文不写入浏览器高亮语法：

```text
阅读区/浏览器高亮/文章.md
.local-ir/browser-document-state/文章.md--路径哈希.browser-ir.json
```

新迁移的状态文件使用完整 Markdown 路径的哈希区分同名文章；已有平铺 sidecar 仍兼容，但读取前必须核对 `document.path`。移动文档时保留已核验的 sidecar 文件身份，并同步其内部路径。浏览器文本坐标在保存时会重新锚定到最终 Markdown；无法可靠定位的标注保留内容并标记为 orphan，不会把错误坐标写入正文。导入后，本地修改会递增 sidecar revision 并原子回写，因此可以在 Obsidian 中从浏览器保存点继续加工。

待导入列表顶部提供批量链接输入框，可从混合文字、换行和 Markdown 链接中识别多个 `http/https` URL，去除常见追踪参数后去重。点击“标准导入链接”后，Obsidian 向本地共享接口 `POST /api/browser-import/requests` 提交 URL，通过 `GET /api/browser-import/requests/:requestId` 查询逐条回执。本地后端以 `background_fetch` 采集并统一执行标准预处理、质量校验、Markdown 落盘与状态保存；常规路径不再依赖扩展领取任务或打开临时抓取标签页。成功条目从列表移除，质量警告保持可见，失败条目保留原因和重试入口；HTTP 202 只表示受理，登录或 JS 渲染要求不能冒充成功。计划中的简洁网页导入页复用同一后端，并对齐此处的链接输入行为。

使用浏览器扩展前，在 `D:\Projects\渐进阅读工作流` 运行 `npm run app`；扩展 popup 会自动探测 `37829-37849`，并可在普通网页上主动注入高亮脚本。

扩展更新后需要在 Edge/Chrome 的扩展页点击 `重新加载`。真实浏览器重载和页面 canary 必须在明确授权后执行；离线检查不会读取浏览器存储或操作现有标签页。

## 状态语义

- `待读`：已进入阅读池，尚未开始处理。
- `阅读中`：正在阅读或最近打开处理。
- `Later`：暂时推迟，到期前不进入继续阅读队列。
- `搁置`：暂停处理，不进入继续阅读队列。
- `待生成导出包`：已经完成阅读，原文位于 staging，等待批量生成导出包。
- `导出包已准备（尚未正式归档）`：native-v2 JSON 和派生产物已准备，原文仍在 staging；不能声称已写入 RemNote。
- `正式归档成功`：仅由工程五成功 receipt/状态合同证明；插件生产者不会自行写入此状态。

`完成阅读` 不会立即写导出包。它只把原文从阅读池归入 `待归档原文`，状态变为 `待生成导出包`。导出包可由该列表的单篇按钮生成，也可由批量按钮统一生成；两类入口互斥，同一文章重复点击不会启动第二次执行。

生成失败时，插件记录并展示生产者的结构化 `code/kind/reasonCode/details.errors`；正文不会进入失败诊断。缺少显式确认属于可解释的 `blocked`，关闭确认框属于用户取消，两者都不再冒充未知生产者故障。

`恢复阅读中` 会把尚未生成 package 的 staging 原文移回阅读池。package commit 后输入冻结；插件不会静默删除仍在正式导入队列中的 package，也不会自行撤销工程五 receipt。

## 阅读池管理

- 支持多个阅读池文件夹；设置页可添加、移除、设为第一阅读池。
- 第一阅读池用于自动移入当前文件。
- 打开不在阅读池里的 Markdown 并进行加工时，插件会自动把它移入第一阅读池，不再弹窗阻断。
- `当前文件夹加入阅读池` 只追加文件夹，不覆盖已有阅读池。
- `当前文件移出阅读池` 会优先把自动移入的文件移回原路径；没有原路径记录时，放到 `移出阅读池`。
- 移除阅读池配置或索引暂时缺失不再清除文章加工数据；这类记录保留，但不参与“继续阅读”。

## 加工模式

`加工模式` 默认使用虚拟高亮：插件只保存选区坐标并通过编辑器装饰层显示，不会向 Markdown 写入 `<mark>` 或改写正文。这样斜体、下划线、链接、公式与代码的源符号不会干扰高亮范围。按住 Ctrl 单击正文中的某一段，只会高亮点击所在的单个 Obsidian 编辑器逻辑行；不会依赖可能包含相邻行的 Markdown section，也不会扩展到上下行。普通单击不会触发整段高亮。新建虚拟高亮后可直接按 Ctrl+Z 撤销、按 Ctrl+Y 重做，装饰会立即从当前页面消失或恢复；经典高亮仍使用编辑器原生撤销与重做。

```html
<mark data-ir-id="...">文本</mark>
```

加工内容保存在插件数据中，不把长评论写回原文 Markdown。只有关闭“全部虚拟高亮”并采用经典模式时，普通正文才使用上面的轻量标记。

如果选区触及代码块、HTML 块、`<style>`、公式块、图片或链接，插件会改用“特殊格式高亮”：不向原文写入 `<mark>`，只保存插件数据，并通过编辑器装饰层显示高亮，避免破坏 Markdown 渲染。

右侧栏的 `全部虚拟高亮` 默认开启。新建高亮全部不写入 Markdown；已有 `<mark>` 不会自动迁移。

支持旧 Obsidian 高亮 `==文本==`：点击旧高亮后可以加工，首次保存时才升级为插件标记。

### 高亮合并

- Markdown 链接、图片、wiki link、代码、公式、HTML、style 等特殊格式会被保护，插件不会在这些结构内部强行插入 `<mark>`。
- 重叠或相邻高亮会自动合并，避免嵌套高亮。
- 右侧栏的 `自动合并` 默认关闭；开启后，同一 block 内的多个高亮会合并为一个加工记录，但仍保持为多个离散选区，不会高亮它们之间的正文。
- 手动合并：按住左 Alt 连续点击多个高亮，松开后合并。
- `修复当前文件高亮` 会清理已经包住 HTML、style、代码块或公式块的危险 `<mark>`，并转换为特殊格式高亮。

### 例子与观点

`例子与观点` 用于把高亮内容当作“例子”，把手写评论当作“观点”。归档包和 RemNote 导入会按这两个字段分流到 `例子与观点`。

## 层级高亮规则

标题或列表父项可以作为层级加工入口，但触发条件是严格的：

- 完整选中标题文本或整行标题，才识别为 `heading_subtree`。
- 完整选中列表父项文本或整行列表项，才识别为 `list_subtree`。
- 只选中标题或列表项的一部分时，只按普通选区处理，不包含子层级，也不会自动生成标题问答卡。

归档和侧栏显示都会按当前 Markdown 内容重新判定层级范围，避免旧版本误判继续影响导出。

## 挖空模式

`挖空模式` 和加工模式互斥。默认仍是虚拟挖空；关闭“全部虚拟高亮”且选区不含受保护格式时，经典模式才生成：

```html
<mark data-ir-id="..." data-ir-kind="cloze">文本</mark>
```

Obsidian 内只显示为另一种高亮样式；归档 JSON 会生成 `clozeCards`，RemNote 导入时写入 `挖空卡` 文档，使用 `{{答案}}` 语法。

## 文章问答卡

文章问答卡保存在插件数据中。归档时进入 JSON 的 `cards` 字段，导入 RemNote 时进入 `问答卡` 文档，使用多行卡语法：

```text
- 问题 >>>
    - 答案
```

生成导出包前可以编辑；package commit 后冻结为只读。当前插件不会自动删除正式导入队列中的 package，修改前须由后续取消合同安全撤回该 package。

## 文章随想

文章随想用于记录对全文的批注、判断、联想或后续处理线索。

- 保存在插件数据和 native-v2 本地归档包中。
- 归档 JSON 字段为 `articleMusings`。
- 工程五 dry-run 会验证随想 disposition；空随想会在任何 RemNote 写入前阻断该 package。
- 工程五正式导入会写入 `文章随想` 文档并回读；插件后端不直接写 RemNote。

## 批量归档输出

每篇待生成文章会由 `batch-archive-backend` 生成：

- 人类可读 `.md` 导出包；
- 机器可读 `.json` 导入包；
- 仅高亮内容的二次阅读稿；
- 提问队列文件；
- 问答卡、挖空卡、文章随想字段；
- `.batch-archive/` 中的输入哈希快照和崩溃恢复 journal；
- `progressive-reading.local-ir-export-package/v2` JSON，状态固定为 `export_package_ready`。

单篇失败不会中断整个批量任务；失败文章保留在 `待生成导出包` 并记录错误，可下次重试。package 是最后写入的 commit marker；重复点击同一冻结输入会幂等重放，崩溃后可从同一快照恢复。任何路径冲突均 fail closed，不覆盖非本 package 文件。

原始 Markdown 在工程五成功 receipt 前始终留在 `待归档原文`。`已归档原文` 只是 package 中声明的最终目标路径，本模块不会执行移动。

独立模块合同、schema 与测试见 [batch-archive-backend/README.md](batch-archive-backend/README.md)。版本变化由 Git 历史和 `CHANGELOG.md` 维护；运行文件回滚副本不进入源码仓库。

## 开发与安装

```powershell
Set-Location D:\Projects\ObsidianLocalIR
npm ci --cache D:\Caches\npm
npm test
npm run check
npm run batch-archive:canary
npm run build
```

依赖同级 `D:\Projects\渐进阅读工作流\document-core`；正式归档 schema/验证器的测试也依赖该项目。它们是外部已有工程，本仓库不复制或修改其实现。

构建只输出到 `D:\Artifacts\ObsidianLocalIR\build`，不会部署。需要部署时显式指定 Vault：

```powershell
npm run deploy -- --vault 'D:\Workspaces\新建文件夹'
$env:LOCAL_IR_VAULT = 'D:\Workspaces\新建文件夹'
npm run native:canary
```

部署只替换 `main.js / manifest.json / styles.css`，校验 SHA-256，旧运行文件及回执进入 `D:\Artifacts\ObsidianLocalIR\deployments`。不修改 `data.json`，不自动重载插件；安装版本和运行中版本要分别核验。

`native:canary` 要求 Obsidian 已运行且当前 Vault 与显式路径一致。它通过官方 CLI 在真实 DOM 中运行隔离合成材料，核验正文零写入、当前文件/选区不变、生产数据哈希不变；不点击界面，不重启应用，不触发真实导入。

可用 `LOCAL_IR_BUILD_DIR / LOCAL_IR_ARTIFACT_DIR` 显式改写产物位置。私密材料 Canary 必须另行按其说明使用，不属于默认测试；历史“7 篇失败材料”脚本仍只适用于原诊断场景，不能作为通用验收。

## 维护规则

- 每次功能变化必须同步更新 README。
- 每次版本变化必须更新 `CHANGELOG.md`。
- 每次代码修改后必须运行 `npm test`、`npm run check` 和 `npm run build`。
- 涉及共享核心适配时，设置 `LOCAL_IR_OBSIDIAN_SOURCE` 为本仓库，再运行同级 `document-core/adapters.test.mjs` 与 `handoff.test.mjs`。
- 不把“导出包已准备”视为 RemNote 已写入，不为本地插件优化自动增加正式归档或网络导入验收。
