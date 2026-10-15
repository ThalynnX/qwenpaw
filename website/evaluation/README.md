# 评测结果格式

本目录保存网站接受的 v2 成绩契约。评测执行、凭据、镜像、原始轨迹和计费用量证据
由外部评测系统管理；网站构建不会创建任务或调用模型。

## 提交成绩

1. 复制 `example.json`，测试结果保存为 `results/testing/<id>.json`，正式评测保存为
   `results/official/<id>.json`。`kind` 必须与目录相同，`id` 必须与文件名相同，且跨目录唯一。
2. 填写 SDK 版本、来源仓库、分发包 SHA256、UTC 时间、数据版本和模型结果。
   已知源码提交时填写完整 `source_sha`，未知时为 `null`，不要虚构源码 SHA。
3. 填写 benchmark 的真实 ID、展示名称、领域标签、期望题数和 judge 元数据。
   ID 与领域标签不限定固定列表，可直接添加 PawBench 或其他评测集。
4. 运行 `pnpm --dir website evaluation:build` 校验数据，或运行
   `pnpm --dir website build` 完成网站构建，再提交 PR。

每个运行、SDK 构建或独立试验使用独立文件，保留历史。一个文件可以包含使用同一 SDK
构建的多个模型。更正、删除或重命名结果后，CI 校验最终数据，不强制历史文件不可修改。
不要编辑生成的 `public/evaluation/data/index.json`。

## 测试与正式评测

`kind` 为 `testing` 或 `official`。网站默认展示正式评测，测试成绩必须显式切换后查看，
不会混入正式排名、最佳记录或 Pareto 前沿。两类数据都属于公开成绩，分类不是访问控制。
`/evaluation/demo/` 是独立的模拟数据页面，不参与真实成绩。

每个 JSON 声明 `board: { "id": "acp-agents", "name": "ACP Agents", "group_by":
"model_harness" }`。同类成绩中的相同 board ID 使用相同名称与分组方式。
`model` 按模型比较 SDK 版本，`model_harness` 按模型和执行器比较。

同一类别、board 与 `index_version` 内，benchmark ID、名称、数据修订、领域、
judge 元数据和期望题数必须一致；改变评测协议时使用新的 `index_version`。
领域与 benchmark 选择项均从数据生成，无需为新评测集修改前端枚举。

## 分数与费用

分数为 **0–100**，耗时为每题秒数，模型和 judge 费用分别记录为每题美元均值。
只有 `scored === expected` 时可以发布该 benchmark 分数；缺失任务或基础设施异常
不计作零分。模型正常完成但评分为零的任务按零分记录。
综合成绩和领域子榜按 benchmark 等权计算，不按题目数加权；缺项时不计算完整综合成绩。

`exchange_rate` 明确记录固定展示汇率，例如
`{ "cny_per_usd": 7.0, "basis": "fixed" }`，不是实时市场汇率。
`original_model_cost` 与 `original_judge_cost` 保留原始币种和每题均值；
人民币费用除以固定汇率，美元费用保持原值。构建时校验原金额与美元金额一致。
网站不调用汇率或价格 API，也不推算原始 token 费用。

未知费用及原金额均为 `null`；模型费用未知时，`cost_source`、`cost_basis` 均为 `unknown`。
零只表示确认的零费用。按实际用量与价格快照计算的费用标记 `snapshot_estimated`；
保守上界标记 `upper_bound`，会显示但不进入费用/能力前沿。

judge 元数据记录实际评分方式、模型或程序评分器、官方模型、提示词修订及可比性说明。
不同 judge、任务包装、工具、依赖和预算可能改变成绩，不能只凭评测集名称宣称官方对齐。

## 公开数据与链接

`trajectory_url` 和 `workflow_url` 可选，必须是永久公开 HTTPS 地址，不能带凭据、
查询参数或 fragment。不要提交签名链接、密钥、原始轨迹、数据附件或内部运行快照。
Schema 校验结构与一致性，不能替代真实成绩证据的审查。

本契约只接受 `schema_version: 2`，不提供旧格式兼容层。
