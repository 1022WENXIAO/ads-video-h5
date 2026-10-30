# 独立桌面工作台与对话能力

## 客户端边界

| 客户端 | 源码 | 开发入口 | 发布入口 |
| --- | --- | --- | --- |
| 移动 H5 | `src/` | `pnpm dev:web`，5173 | `/qingjian/` |
| 桌面工作台 | `apps/desktop/` | `pnpm dev:desktop`，5175 | `/qingjian/desktop/` |
| 微信小程序 | `apps/miniprogram/` | 微信开发者工具 | 独立小程序包 |
| 管理后台 | `apps/admin/` | `pnpm dev:admin`，5174 | `/qingjian/admin/` |

桌面端的组件、样式、登录页和构建产物独立。移动 H5 和小程序的界面文件没有因桌面端重写。
`pnpm build:desktop` 可单独构建；`pnpm build` 构建并打包三个 Web 入口。缺失桌面资源返回 404，不会回退显示手机页面。
桌面端沿用已有网页邮箱登录与同域 Cookie；本次未增加微信网页扫码登录，原生小程序仍使用自己的微信登录流程。

## 能力现状

| 能力 | 原有实现 | 本次增加 |
| --- | --- | --- |
| 工具并发 | 应用显式配置 `sequential` | 当前会话选择并行/顺序，只读扩展工具全局限 1–6 个并行；默认 3。未标记的原有工具和浏览器操作保持顺序 |
| 持久化 | `app-state.json` 原子保存，重启恢复任务，工作流检查点 | 桌面自动恢复、单条消息/整个会话分叉、来源关系和独立消息 ID |
| Skill | 内置制作技能按场景自动加载 | 目录、检索、导入 SKILL.md、会话显式选择并注入真实 Agent 上下文 |
| MCP | 未接入 | Streamable HTTP，JSON/SSE、初始化、会话、工具发现/调用、Bearer 凭据、只读并行入口与顺序写入口 |
| 插件 | 未接入 | 导入声明式插件，组合技能与 MCP；会话开关会一并加载组件 |
| 浏览器 | 未接入 | 同机 Ant-Browser Launch API + CDP，账号独立实例、读取/打开/点击/填写/状态/停止 |

并行设置控制单个任务内的工具调用，不改变现有的后台制作任务队列。同一实例的浏览器操作按顺序执行。停止任务传播取消信号；已发出的外部写入结果不明时不自动重放。
入队时保存 `Job.capabilities`；每次执行保存 `JobAttempt.capabilities`。重试采纳当前会话的新设置，历史尝试的设置保持不变。
分叉不复制正在执行的任务、未完成的消息或半成品方案；从指定消息分叉也不继承其后的方案。已有素材和产物仍按原账号鉴权。

## 设置和接口

扩展保存在 `QINGJIAN_DATA_DIR/extensions.json`，原子替换、0600 权限，按账号隔离；公开目录只返回 `hasToken`，不返回凭据或技能全文。

- `GET /api/capabilities`：当前账号目录及浏览器连接状态。
- `POST /api/capabilities/skills`：`{name,description?,content}`。
- `POST /api/capabilities/mcp`：`{name,url,token?}`。
- `POST /api/capabilities/mcp/:id/test`：执行真实的初始化与工具发现。
- `POST /api/capabilities/plugins`：声明式清单，见下例。
- `PATCH /api/sessions/:id/capabilities`：`{toolMode,maxParallel,skillIds,mcpIds,pluginIds,browserProfile}`；该会话有活动任务时返回 409。
- `POST /api/sessions/:id/fork`：`{messageId?}`；保留原会话并激活新会话。
- `GET /api/sessions/:id/executions`：当前账号的执行记录。
- `GET/POST /api/capabilities/browser/profiles`：列出/创建属于当前账号的实例。
- `POST /api/capabilities/browser/stop`：`{profile}`；只停止当前账号实例，有运行任务时拒绝直接关闭。

```json
{
  "name": "资料核验",
  "description": "先核验再写作",
  "skills": [{"name":"引用规则","content":"# 引用要求\n优先引用一手资料。"}],
  "mcpServers": [{"name":"资料服务","url":"https://example.com/mcp"}]
}
```

MCP 仅连接 `QINGJIAN_MCP_ALLOWED_HOSTS` 中精确匹配的 HTTPS 主机（含自定义端口）。本地测试可显式设 `QINGJIAN_LOCAL_MCP=1` 允许 loopback HTTP。禁止 URL 内嵌凭据及重定向；输入输出有界。当前未包含 stdio、旧版独立 SSE endpoint、OAuth 登录或 MCP Apps Widget。
插件支持技能和 HTTP MCP 的声明式组合，不运行安装脚本、hooks 或任意本地命令，也未实现插件市场。

## Ant-Browser 同机部署

后台读取 `ANT_BROWSER_API_URL=http://127.0.0.1:19876`、`ANT_BROWSER_API_KEY`、`ANT_BROWSER_MAX_RUNNING=1`。
浏览器 API Key 只进入服务端配置。Ant 的 API、CDP 和虚拟显示不对公网开放；账号只能操作本服务分配给自己的实例，不能通过猜测别人的 launch code 接管。
使用 Ant 原有的用户数据目录保留登录态；断开对话不关闭实例。选择实例后，真实 `ant_browser` 工具会加入当前任务。页面文字仅作为工具结果，不作为系统指令。

实际资源、固定下载版本、已执行的旧版本清理清单、原生测试结果与回退方式见 [`ops/cn/ant-browser/README.md`](../ops/cn/ant-browser/README.md)。Ant V1.8.0 已在同机受限服务中通过原生与真实后台适配器测试；页面连接状态仍以实际探测为准，未验证时显示“尚未验证”。

参考：[Codex 功能](https://developers.openai.com/codex/app/features)、[WorkBuddy 插件](https://www.codebuddy.cn/docs/workbuddy/Plugins)、[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[Ant-Browser API 合约](https://github.com/black-ant/Ant-Browser/blob/master/skills/ant-chrome-openclaw-automation-plan/references/api-contract.md)。

画面分析会保留同一组真实抽帧，格式或临时请求失败最多发起两次逻辑请求。备用仅来自任务开始时冻结的、同服务中已配置的画面理解模型；没有备用时只重试当前模型。原始返回脱敏后以 0600 权限留存，仅合法的事实描述、top/bottom 区域及匹配帧时间可进入缓存。未完成的实际画面分析不会使用虚构默认区域继续渲染。
