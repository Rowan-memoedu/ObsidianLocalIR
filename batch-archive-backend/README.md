# Local IR Batch Archive Backend

这是 Obsidian Local IR 的独立批量归档生产者后端，当前模块版本 `1.4.0`。本轮插件优化未改动生产者合同或并发策略。

## 边界

- 用户触发入口仍只在插件 UI：待生成列表提供单篇按钮，工具栏提供批量按钮；UI 只触发模块并展示逐篇结果。
- 模块选择 `done` 记录、冻结输入哈希、校验完整去向、原子写入 Markdown/派生产物/native-v2 JSON，并把成功记录推进到 `export_package_ready`。
- JSON 使用 `progressive-reading.local-ir-export-package/v2`，package 是最后写入的 commit marker。
- 原文保留在 staging。模块不连接 RemNote、不写 `archived`、不移动原文到最终目录。
- `.batch-archive/*.input.json` 与 `*.state.json` 是冻结快照和崩溃恢复日志，不是第二套状态库；正式状态权威仍是插件记录、队列 package 与工程五 receipt 合同。

## 稳定入口

```powershell
npm run batch-archive:check
npm run batch-archive:canary
npm run batch-archive:canary:real
npm run batch-archive:canary:button
npm run batch-archive:diagnose:production
npm run build
```

`batch-archive:canary:real` 只在明确授权后使用，并要求显式设置绝对路径 `LOCAL_IR_VAULT`。它读取已安装插件的 `data.json` 和待归档原文，确定性选择 12 篇丰富度较高的记录，把正文副本和全部输出重定向到 `D:\Artifacts\ObsidianLocalIR\private-canaries\<run-id>`，并使用正式插件的 `createBatchArchiveInput` 与后端 `runBatchArchive({ concurrency: "auto" })`。正式队列、插件数据和原文均为只读；执行前后哈希不一致时 Canary fail closed。归一化后没有 RemNote import item 的文章只有在收到显式确认对象后才可生成；refined/question dispositions 原样保留。

`batch-archive:canary:button` 调用已部署构建中的真实 `batchArchiveDoneRecords` 按钮处理器，把取消与确认两条路径的全部输出隔离到 `D:\Artifacts\ObsidianLocalIR\private-canaries`。它不会写生产 `data.json` 或正式队列；回执会明确区分按钮处理器验证与真实 Obsidian 可视 Modal 点击。此脚本与 `diagnose:production` 保留了原“7 篇特定失败”的前置条件，仅用于历史诊断，不属于通用回归测试。

离线合成 Canary 每次在 `D:\Artifacts\ObsidianLocalIR\canaries` 新建独立目录，不清空旧结果。所有 Canary 回执和生产诊断均不写回源码仓库。

运行时入口：Obsidian `local-ir` 单篇按钮调用 `prepareExportPackage`，批量按钮调用 `runBatchArchive({ concurrency: "auto" })`。`auto` 把本轮每个独立候选分配到一条异步任务通道，不设固定路数；例如 12 篇即 12 路。调用方仍可传正整数临时限流。无论实际完成顺序如何，输出结果都按候选路径确定排序。工程 Thread 不参与日常运行。

## 写入顺序与恢复

1. 写 `writing` journal；
2. 写输入快照（正文只存 SHA-256 与字节数，不复制私密正文）；
3. 原子写人类 Markdown、精炼阅读和问题队列派生产物；
4. 最后原子写 native-v2 package；
5. journal 与插件记录推进到 `export_package_ready`。

重复输入重放保持同一 `packageId/packageRevision`。进程在 package 前崩溃时，重试根据同一快照接管已写产物；已有非本 package 文件时 fail closed 为 `PATH_CONFLICT`。单篇失败不阻断其他篇，失败记录保持 `done` 并持久化无正文的 `code/kind/reasonCode/details.errors`。零 RemNote item 的确认合同见 `contracts/no-remnote-content-confirmation.v1.md`。

## receipt 展示

插件不得把 `export_package_ready` 显示为正式归档成功。工程五成功 receipt 回写合同见 `contracts/formal-archive-receipt-handoff.v1.md`。当前模块不会替工程五修改插件状态或 sidecar。

## 发布与回滚

插件 `npm run deploy -- --vault <绝对路径>` 会保存旧 `main.js/manifest.json/styles.css` 至 D 盘部署产物目录，再写入新版本并核验哈希。Git 与 `CHANGELOG.md` 保存源码版本；回滚只恢复运行文件，保留 data.json、原文、队列、快照和 receipt，不复制长期源码版本目录。
