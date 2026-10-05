# Issue tracker: Local Markdown

工单和规格保存在本仓库 `.scratch/` 下。

## 文件约定

- 每个功能使用 `.scratch/<feature-slug>/`。
- 规格使用该目录的 `spec.md`。
- 每张工单使用 `issues/<NN>-<slug>.md`，从 01 编号。
- 分诊状态使用文件顶部的 `Status:` 行，名称见 `triage-labels.md`。
- 评论追加到文件末尾的 `## Comments` 下。
- 读取工单时，使用用户提供的路径或编号；编号须在指定功能目录内解析。

## 发布工单

在对应功能的 `issues/` 下创建独立文件；规格写入 `spec.md`。
更新现有工单时保留原有内容和历史。

## Wayfinding

- 工作地图使用 `.scratch/<effort>/map.md`。
- 子工单使用 `issues/<NN>-<slug>.md`，顶部记录 `Type:` 和 `Status:`。
- `Type:` 为 research、prototype、grilling 或 task。
- Wayfinding 的 claimed/resolved 是工作进度，区别于分诊标签。
- `Blocked by: NN, NN` 指向同一目录内的依赖；全部 resolved 后解除阻塞。
- 按编号选择开放、无阻塞且未认领的工单；工作前写入 claimed。
- 完成后追加 `## Answer`，写入 resolved，并在地图中追加结论和工单链接。
