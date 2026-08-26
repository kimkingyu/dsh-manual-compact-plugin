# dsh-manual-compact-plugin

手动上下文压缩插件（DeepSeek Harness / DSH）。

> 点击上下文圆圈（或输入框旁的"压缩"按钮）→ 选择保留最近 N 条 → 停止或分批压缩 → 每次压缩都有存档可查。

## 功能

- **保留最近 N 条**：1 / 3 / 5（推荐）/ 10 / 20 / 50 / 自定义
- **处理方式**：
  - 完成一批后停止
  - 分批处理直到完成
- **压缩存档**：每次压缩显示时间、条数、约计 tokens，点击展开完整摘要
- 调用 DSH 官方 compaction API（`compaction.compactRegion`）：不拆开工具调用对、会话忙时自动拒绝、失败不改动会话

## 安装

```bash
dsh plugin --profile web add dsh-manual-compact-plugin
```

安装后重启一次 DSH。

## 界面位置

- 如果 DSH 带有 `conversation.input.contextMeterPanel` Slot（对应上游补丁），控件嵌入**上下文圆圈弹窗**内
- 否则自动降级为**输入框工具行右侧的"压缩"按钮**（弹窗面板）

## 工作原理

- 浏览器端通过 `manual-compact` 设置命名空间写入 `request`（会话、保留数、模式）
- 宿主端读取请求，经当前会话的 compaction 服务执行，把结果写回 `lastRun`
- 存档来自会话日志中已落地的 `compaction/summary` 事件，随会话持久化

## License

MIT
