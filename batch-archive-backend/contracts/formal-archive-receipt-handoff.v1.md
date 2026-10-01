# 正式归档 receipt 回写与插件展示合同 v1

## 权威边界

`batch-archive-backend` 只生产 `progressive-reading.local-ir-export-package/v2`，并把插件记录推进到 `export_package_ready`。它不连接 RemNote、不消费 MCP、不移动 staging 原文，也不写 `archived`。

工程五是 receipt 与最终状态的唯一写入者。只有工程五完成 schema/目标/幂等校验、RemNote MCP 写入、逐项回读、成功 receipt 落盘和本地原文最终移动后，才可把状态同步为 `archived`。

## 工程五回写形状

工程五继续在队列 JSON 中写入已版本化的 `formalArchive`：

```json
{
  "formalArchive": {
    "schema": "progressive-reading.formal-archive-marker/v2",
    "status": "archived",
    "packageId": "stable id",
    "packageRevision": 1,
    "payloadHash": "sha256",
    "receiptPath": "vault-relative or audited local receipt path",
    "completedAt": "ISO-8601"
  }
}
```

插件展示正式归档成功时，必须同时匹配记录的 `archivePackageId`、`archivePackageRevision` 与上述 marker，并能读取 receipt；只看到 JSON、导出路径、Rem ID 或 legacy `status: archived` 均不得升级展示。

## 当前发布边界

模块 1.4.0 已保留上述读取合同，并支持本地 `localArchive.noRemnoteContentConfirmation`；该技术确认不进入 RemNote item，也不是正式归档 receipt。模块不替工程五回写插件 `data.json` 或 sidecar。工程五尚未发布 package marker/receipt 到插件状态的完整同步入口前，插件只展示“导出包已准备（尚未正式归档）”；这是显式阻塞，不建立第二套状态库。
