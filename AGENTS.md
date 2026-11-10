# Local IR 工程边界

- 代码提交、PR 合并、同步与共享边界遵守 [CONTRIBUTING.md](CONTRIBUTING.md)。历史任务授权、私人账号及生产数据权限不随源码共享转移给其他成员或 Agent。

- 唯一活动源码：`D:\Projects\ObsidianLocalIR`；`main` 跟踪独立私有仓库的 `origin/main`。旧工作区路径只是 junction，不建立第二份源码或 worktree。
- 机制与意图权威说明：`docs/ARCHITECTURE.md`；操作说明：`README.md`；历史变化：`CHANGELOG.md`。
- 本项目负责 Obsidian 本地阅读、加工与导出包。网络抓取、浏览器扩展和 RemNote 正式导入属于其他工程，不因局部优化扩大范围。
- 用户主动生成/更新导读卡只调用同级标准预处理的 semantic_only 单阶段；禁止重抓取、翻译或重写正文。生成结果校验及发布前源文件哈希检查不可绕过。
- 同级 `渐进阅读工作流/document-core` 是共享状态/标注算法权威；`remnote-formal-archive` 是正式导入 schema/receipt 权威。禁止在本项目复制一套相似实现。
- 保留用户手调指标、标注 ID、正文、层级和所有运行数据；修改阅读池不授权清理数据。
- `export_package_ready` 不等于 `archived`。package commit 后禁止重新加工；不要替用户取消队列或伪造正式 receipt。
- 默认虚拟标注，不写 Markdown；渲染不是正文修改入口。保持 `styles.css` 基线，视觉变化须有明确需求。
- 文件编辑用 apply_patch；先检查 Git 脏改动。只允许本地、可逆、范围内的精确修改。
- 构建产物、回执、Canary 默认进入 `D:\Artifacts\ObsidianLocalIR`；依赖缓存进入 `D:\Caches`；私密材料不提交。
- `npm run build` 不部署。部署要求显式 Vault，严格限制为三份运行文件，核对数据哈希并保留运行文件回滚副本。
- 代码验收：`npm test`、`npm run check`、`npm run build`、`npm run batch-archive:canary`；共享适配变更再运行同级核心的 test/adapters/handoff。
- 原生运行验收用官方 Obsidian CLI 与 `npm run native:canary`；先设置 `LOCAL_IR_VAULT`。不抢占窗口、不改变选区、不自动重启应用。
- 历史真实材料 Canary 有样本前提，不是默认测试。不要为满足它们而修改生产数据。
