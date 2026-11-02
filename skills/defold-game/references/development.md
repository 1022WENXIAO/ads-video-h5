# Defold节点开发接口

`create_defold_project(title)`创建可运行的960×640项目：`nodes/game.gui_script`为游戏逻辑，`nodes/ambient.gui_script`为背景动画。代码不是固定模板限制：可主动新增自己的Lua模块、游戏场景与动画节点。

- `list_project_files`查询revision、文件SHA、节点与入口。
- `read_project_file(path,startLine,endLine)`返回真实行号和SHA；每次最多301行。
- `search_project_files(query)`查询所有原文引用。
- `create_project_file`、`update_project_file`、`delete_project_file`操作当前工程。修改需expectedRevision与expectedSha256，并提供不重叠行范围。空content表示删除；endLine=startLine-1表示插入。版本冲突后重新读取，不反复猜补丁。
- `create_project_node`、`update_project_node`、`delete_project_node`管理实际节点。节点kind为game或animation，file指向已存在的`.gui_script`、`.script`或`.go`。分别构建为真实GUI组件、GameObject脚本组件或GO原型实例；可调用Defold的gui动画、vmath、粒子几何、输入、碰撞计算、状态机和Lua函数。禁用/删除后构建不再执行；源码可独立删除，历史保留。
- 新增共享模块放`lib/*.lua`，通过`require('lib.module')`引用；数据放`assets/*.json`。assets还支持.go/.sprite/.atlas/.particlefx/.collisionobject/.material/.vp/.fp文本资源，可用引擎内置`/builtins/graphics/particle_blob.png`建立atlas和sprite；原生对象可使用go.animate、go.set_position、Sprite、碰撞对象与ParticleFX。工程配置、输入绑定和collection由构建器生成，不开放原生扩展、构建hooks或外部依赖下载。需要纹理/字体等二进制资产时不能伪造存在的文件，当前先用引擎内置字体与几何。
- `restore_project_revision`将历史快照恢复为新版本。
- `validate_defold_project`执行真实Bob编译HTML5/WASM，并在无登录态隔离浏览器中试玩、记录截图和日志。编译错误需按行修复，不是补充文字说明。
- `self_check_defold_project`由独立模型读完当前所有脚本与真实截图，检查变量/API/节点引用、需求、更新循环、输入、碰撞、动画与重启。问题返回具体文件、行号、修复建议。修改后必须再验证及自检。
- `finish_defold_project`只采用同一哈希下编译、试玩、自检均通过的版本。

GUI脚本使用`init(self)`、`update(self,dt)`、`on_input(self,action_id,action)`。`init`中`msg.post('.', 'acquire_input_focus')`后接收输入。默认操作为left/right/up/down/jump/touch/restart；方向键与A/D、W/S移动，Space对应jump，R重新开始。额外按键可在assets/input.json中以{"keys":[{"key":"KEY_X","action":"dash"}]}新增，保留左右键和R的基础试玩操作。assets/*.json会作为custom_resources打包，可通过sys.load_resource读取。GUI尺寸960×640；键鼠与触摸坐标使用实际action.x/action.y。对象删除时同步清理数组，不能无限累积节点。内置默认字体不包含中文字形；当前示例HUD用英文绘制，代码注释和聊天说明可中文。不要在截图缺字时声称UI已验收。默认字体名`default`；`gui.set_font(node,'default')`。

保留可观察试玩桥接：在update中通过`html5.run('window.__QJ_GAME_STATE='..json.encode({...}))`记录`time`、玩家/光标`x`、真实输入计数`inputs`和`restarts`。这些数据必须来自真实逻辑，不能为了通过检查硬编码；可补充score、碰撞数与粒子数。浏览器测试发送右键移动及R重启，截图与状态共同作为证据。不能因为编译成功声称玩法或视觉已验收。

构建只运行固定Bob编译器，生成Lua不在Node中执行；macOS worker限制读取用户目录、网络和工程外写入，Linux须配置受限构建容器启动器。产物只在sandbox iframe试玩，不向模型提供系统shell、服务器凭证或任意安装接口。

官方资料：[Bob构建](https://defold.com/manuals/bob/)、[GUI脚本](https://defold.com/manuals/gui-script/)、[属性动画](https://defold.com/manuals/property-animation/)、[HTML5](https://defold.com/manuals/html5/)。这些链接是机制资料，不能替代本次构建与试玩。


不确定API时调用`read_defold_api(module,query)`读取官方函数/枚举。GUI Pivot实际常量为gui.PIVOT_CENTER、gui.PIVOT_E、gui.PIVOT_W、gui.PIVOT_N、gui.PIVOT_S等，不是gui.PIVOT_EAST。不要靠名称相似猜测枚举。Defold已注入json、html5、gui、go、vmath等全局，json.encode无需require('json')。以编译与Lua运行错误的真实文件/行号修复；启动异常会立即返回错误及失败截图，不能仅对“等待超时”臆测修复。
