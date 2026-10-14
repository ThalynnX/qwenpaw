# PR 1 聊天代码块与消息提交扩展

本 PR 为插件提供三个通用接口，让插件能够在 Assistant 正文中显示交互组件，并把用户操作提交到原会话。源码分支为 `feat/chat-ui-extensions`，基于本地 `main`。本 PR 不携带 OpenUI 依赖或组件目录。

## 用户行为与链路

Assistant 文本进入现有 Markdown 渲染器。指定语言的代码块若有插件注册，就显示该组件；其余内容沿用默认显示。插件组件拿到原始源码、块是否完成、消息与会话身份，以及普通代码块 fallback。

```text
Assistant 文本 → AssistantMarkdown → 按语言查注册表 → 插件组件
插件动作 → chat.submit → 当前 Chat 页面校验 → 原有消息队列
```

`chat.submit` 的成功表示入队，不表示模型已经完成回答。会话不匹配、Chat 未就绪和队列满都会报错，输入框的草稿与附件不会被消费。`host.openExternalLink` 复用已有浏览器与桌面链接工具。

## 文件职责与必要性

| 文件 | 职责与设计评价 |
| --- | --- |
| `console/src/plugins/types/qwenpaw.d.ts` | 公开代码块 props 与提交契约。通用接口，不绑定具体 UI 语言。 |
| `console/src/plugins/registry/types.ts` | 定义注册条目，复用公开 props。 |
| `console/src/plugins/registry/slotKeys.ts` | 声明统一 slot，避免新增另一套注册系统。 |
| `console/src/plugins/registry/chatExtensions.ts` | 保存代码块注册，沿用快照和按插件释放机制。后注册优先，释放后恢复之前的注册。 |
| `console/src/plugins/hostSdk/install.ts` | 将三个接口装配到 window.QwenPaw。 |
| `console/src/plugins/hostExternals.ts` | 补全链接打开器的宿主类型。 |
| `console/src/plugins/hostSdk/chatSubmit.ts` | 连接当前 Chat 页，校验输入，防止旧页面 cleanup 释放新 handler。 |
| `console/src/pages/Chat/AssistantMarkdown.tsx` | 分发代码块、保留组件身份、处理流式结束与 deferred 内容的时序、提供错误回退。 |
| `console/src/pages/Chat/HostBubbles.tsx` | 在 Assistant TEXT 入口使用新封装并传递消息 ID。 |
| `console/src/pages/Chat/pluginSubmission.ts` | 校验原会话与 Agent，捕获完整路由并入队；逻辑独立，易于测试。 |
| `console/src/pages/Chat/index.tsx` | 在活跃页面绑定桥接函数，复用现有会话解析和请求上下文。 |
| `AssistantMarkdown.test.tsx` | 实际 Markdown 的逐字符流、块完成时机、状态保持和错误隔离。 |
| `pluginSubmission.test.ts` | 会话路由、队列容量与不消费草稿。 |
| `chatSubmit.test.ts` | 参数、错误传播和 handler 生命周期。 |
| `website/public/docs/plugins.en.md` 与 `plugins.zh.md` | 为插件作者记录接口和 Promise 语义。 |

## 设计判断

边界清楚，改动集中在既有扩展点。代码块组件在模块层定义，因此文本 delta 不会不断创建新组件类型；已有 ErrorBoundary 将插件渲染错误限制在块内。消息提交复用现有队列，避免第二套 HTTP 或会话管理逻辑。

这仍依赖 vendor Markdown 的 `streamStatus` 行为，升级该依赖时应保留对应回归测试。块 ID 稳定性限于当前挂载周期，不提供跨刷新状态持久化。插件本身运行在宿主页面中，这些接口不构成第三方插件代码沙箱。

## 本地 Review

在仓库根目录执行：

```sh
git switch feat/chat-ui-extensions
git diff main...HEAD
git diff --stat main...HEAD
```

本分支提交后，普通 `git diff` 只显示未提交修改；查看整个 PR 使用上面的分支比较。PR 2 `feat/qwenpaw-openui` 也独立基于同一个 main，其 diff 只包含插件。运行插件需要先具备本 PR 的宿主接口。

## 验证

已通过：新增测试与 SDK 注册表/接口共 43 项、Console 类型检查和生产构建、全量 pre-commit。测试证明的是接口、流式挂载和提交边界；实际插件的 UI 生成质量由插件 PR 单独验证。

完整 `pytest -q` 在收集阶段遇到 12 个错误：当前环境安装 MCP 2.3.0，而本仓库要求 `<2.0`，导致 McpError 导入失败；另有两个 test_backup 文件的模块名冲突。本 PR 不修改 Python 实现，未为通过检查而改动这些无关模块。此项全量门禁不能记为通过。
