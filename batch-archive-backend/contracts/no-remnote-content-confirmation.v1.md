# 无 RemNote 内容显式确认合同 v1

仅当工程五归一化语义下 `importItems=0` 时，生产者要求用户在 Obsidian 单篇或批量入口显式确认。关闭或取消弹窗时，记录保持 `done`、不增加失败次数、不写 package。

确认后，native-v2 package 在 `localArchive` 中写入：

```json
{
  "noRemnoteContentConfirmation": {
    "schema": "progressive-reading.no-remnote-content-confirmation/v1",
    "confirmed": true,
    "confirmedAt": "2026-08-23T00:00:00.000Z",
    "missingElementKinds": ["annotations", "articleMusings", "cards", "clozeCards"]
  }
}
```

`missingElementKinds` 只能使用 `annotations/cards/clozeCards/articleMusings`，必须非空、去重，并按字符串升序确定排序且与冻结输入实际空集合一致。生产者把确认写入 package、冻结 snapshot、journal 与本地验证 receipt；工程五可审计该对象，但不得把它转换成 RemNote item。

确认不会补造批注、QA、挖空或随想。only-highlight 和 only-question 的 refined/question dispositions 必须保留；没有确认的零远端条目输入继续 fail closed。
