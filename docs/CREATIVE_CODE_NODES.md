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
