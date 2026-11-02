# 可编程工程、自检与Defold

动态图制作继续使用`@动态图科普视频`；游戏与原生引擎动画使用`@Defold游戏`。游戏交付HTML5/WASM、Defold源工程和验证记录，在对话与管理员模板页直接试玩。游戏文件保存在当前服务器的私有数据目录，未转为普通媒体素材，也未上传公共OSS。

## 编辑和采用流程

文件工具提供list/read/search/create/update/delete/restore；节点工具提供create/update/delete及启用状态。修改必须携带当前工程revision和文件SHA，使用行范围编辑，支持重复文本。历史快照留在每次任务目录，修改不会覆盖已交付版本。

`canvas`和`animation`节点可拆分JS/TS模块，节点`createNode(api)`返回paint及可选sample，实际参与浏览器绘图。`game`和原生animation节点可引用Defold `.gui_script`、`.script`或`.go`，构建器实际加入collection；可使用GameObject、Sprite、ParticleFX和相应文本资源。

作者编写代码后，先运行静态或引擎编译检查，再真实预览/试玩。独立模型读取最新脚本、节点、运行诊断和截图，提出具体行号与修复建议；作者通过编辑工具修正后重跑。采用工具校验同一工程哈希同时通过技术检查及独立自检；任何修改使旧结果失效。模型自检和技术检查都不代表用户已验收。

Canvas导出的source/模块可编辑，build:preview重建执行程序；修改后旧模型自检凭据失效。Defold导出source/game.project可在编辑器打开，运行工程中的`node preview.mjs`可本地试玩web/成品。

## 环境

本次仅安装Defold。开发机使用独立缓存中的Bob 1.14.0及Temurin JRE25，不修改系统Java；下载来源与SHA保存在tooling/creative/defold-runtime.mjs和缓存runtime.json。显式安装：

```bash
node tooling/creative/defold-runtime.mjs install
node tooling/creative/defold-runtime.mjs doctor
```

模型不获得系统shell、任意安装或系统文件读写工具。服务端只调用固定构建命令；macOS构建限制用户目录读取、工程外写入和网络。生成的Lua脚本不会被Node导入执行；当前仅支持Defold，未安装或接入Godot。Defold运行在无账号、无同源权限的sandbox iframe中；试玩使用临时存储。

Linux部署可使用提供的容器worker，尚未在本次macOS环境执行Linux容器验证：

```bash
node tooling/creative/defold-runtime.mjs install --bob-only
docker build -t qingjian-defold-worker:1.14.0 tooling/creative/worker
export QINGJIAN_DEFOLD_WORKER=/absolute/repo/tooling/creative/worker/run-defold.sh
```

容器关闭网络、丢弃capabilities、限制CPU/内存/PID，只挂载本次工程和只读引擎缓存。没有受限worker的Linux服务明确返回环境未就绪，不回退为直接执行模型代码。配置的worker必须是可信服务端启动器。

## 接口与边界

- `GET /api/creative/capabilities`：已登录用户查询节点、编辑、自检能力及Defold实际环境状态。
- `GET /api/artifacts/:id/play`：所有权校验后签发30分钟、只读构建目录的试玩URL。
- `/api/creative-preview/:capability/*`：仅GET/HEAD；限制在指定构建目录、设置CORS/CSP，供无同源权限iframe加载WASM资源。无能力凭据或目录越界返回404；重启后重新获取试玩URL。
- 原模板API新增`defold-game / token-catcher`管理员测试。游戏结果kind为game，通过私有preview资产返回试玩URL；工程与记录仍走认证下载。
- 默认绑定方向键、A/D、W/S、Space、R和触摸；可通过assets/input.json的keys数组新增{key,action}绑定。assets JSON数据会作为custom_resources打包。默认资源为几何和内置拉丁字体；不能将缺失的图片、中文字体或外部模型资源描述为已经可用。

资料：[Defold Bob](https://defold.com/manuals/bob/)、[GUI脚本](https://defold.com/manuals/gui-script/)、[HTML5](https://defold.com/manuals/html5/)。本次行为检查记录位于data/creative-qa，包含实际源码、构建日志、预览、自检与试玩状态。

## Agent运行与恢复约束

各目标的草稿保存在独立文件中，普通讨论和其他目标不能覆盖后续修改使用的工程。后端队列为每个任务保存`TaskSpec`，记录当前目标、用户原文引用和固定约束。明确修改同一目标时增加revision，停止旧版本任务；独立新建目标不相互取消。固定约束不会随最近消息截断而丢失；新的独立任务也不会继承上一目标的限制。历史或运行中会话分叉会清除无法证明属于该历史时刻的模板、游戏草稿及任务状态。

`data/agent-runs/<jobId>/run.json`保存契约/环境指纹、执行计划、工具检查点、共享预算、外部操作收据和交付证据。视频模板按技术检查→需求自检→成片验证→交付推进，Defold按技术检查→需求自检→交付推进；各步骤绑定同一工程哈希。修改工程使依赖步骤失效。恢复后继续读取已保存的源码工作区，重新验证，不凭上一轮口头结论跳过检查。

默认整项任务及其嵌套阶段共享30分钟时限和200次工具调用预算；局部阶段可有更短时限。重启不会清零调用次数或重新延长截止时间。可用`QINGJIAN_TASK_TIMEOUT_MS`调整总时限，用`QINGJIAN_TASK_MAX_CREDITS`显式设置任务积分预算；达到预算后不再新增模型请求，用量未知时暂停追加请求。积分预算按供应商实际回报结算，不是报价或硬性的单请求最高价保证；未设置时保留原积分计费规则。

MCP写入和浏览器变更操作按目标ID、工具、参数内容生成稳定操作ID，后续修改同一目标也不会通过新Job绕过收据。已确认结果复用收据；请求发出后断线或中断，标记`outcome_unknown`并禁止自动再次提交。Agent可用`list_external_action_receipts`查询，再通过已启用的只读工具核对。通用连接器无法可靠推断任意业务操作是否落库，未能确认的操作会保留未知状态，不能用模型声明来放行重放。

自检先读取服务端生成的证据目录，使用可选证据ID逐项引用真实检查和源码，避免自由拼接字段名。自检角色只获得明确的只读代码/预览/API工具，不继承会话Skill或MCP写权限；仍使用父任务的契约、预算和取消信号。重复错误按工程内容和错误指纹计数，读取文件不会清零失败次数。

工程写入在持久化锁内重读磁盘并比较revision/SHA，历史不覆盖。锁会识别本机已退出的所有者，保留崩溃前未提交的历史快照。一个数据目录仅允许一个后端进程写队列；当前实现面向单机本地文件系统，不将它描述为跨主机数据库或任意多Worker调度系统。

Defold进程使用显式环境白名单。缓存同时校验工程、构建器环境和产物摘要；变化后重建。试玩除了检查引擎状态，还独立观察画布控制区域主体的可见位移和重启位置。此检测面向当前模板的左右移动/R重启约定；无法识别主体时拒绝自动通过，不据此宣称已测试所有自定义玩法、碰撞或移动端操作。验收后的试玩文件被改动时，能力URL返回410，须重新构建验收。

`GET /api/jobs/:id/runtime`按任务所有权返回运行计划、检查点、预算与收据状态；不返回外部工具的原始结果或凭证。技术通过、逐项需求自检、用户视觉验收分别保留，`userAccepted`不会因自动检查而变为true。
