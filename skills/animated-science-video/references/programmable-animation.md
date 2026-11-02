# 可编程动效 V2

制作目标以分享包中的《四图-大模型压缩原理对照V3》为基线：物体沿路径持续传输、动作改变数据和结构、结果逐轮更新、到达时给出接收反馈。固定标题与图框可以稳定，主体不能退化成轮流变色的文本卡片。

## 制作与修订

1. 逐图定义输入、核心操作、输出、持续运动和动作反馈。默认16秒；复杂主题可24/32秒。每图有可观察的机制动作，不用字幕改字代替全部过程。
2. 调用 `read_animation_capabilities` 读取接口；需要参考时调用 `read_animation_reference`。参考压缩场景保留了真实剪刀、断线退去、稀疏传输、分布更新和矩阵重建代码。对标压缩使用`start_animation_reference(name="compression")`，LLM Prompt原理使用`start_animation_reference(name="llm-prompt")`，先实际预览已验证的可编辑场景，再按用户要求coding；其他主题自行编写。
3. 使用 `write_animation_scene` 提交完整元数据和 JavaScript 程序。函数库不够时，在 `createScene` 内主动编写自己的绘图、轨迹、粒子、矩阵或状态模型函数。
4. 工具会实际执行、检查全部帧的文字布局、确定性定位、结果断言和运动覆盖率，并返回真实预览图。读到错误后使用 `patch_animation_scene` 精确替换代码或元数据，再检查；不能用“预期有动画”代替可执行代码。
5. 查看预览与检查结果，调用 `finish_animation_scene` 确认采用当前版本。渲染器还会独立检查编码后视频的连续帧变化。技术与运动检查不能代替用户审阅。

## 程序接口

`program.apiVersion=2`；`program.source` 是以下函数的完整源码，无 import/export：

```js
function createScene(api) {
  // 可定义自己的纯函数和固定数据。api.config可读；此时尚没有Canvas。
  return {
    stateAt(t, panelIndex, cfg) {
      // 任意t均可重算；返回JSON可序列化状态，stage为面板下方的短步骤说明。
      return { stage: '输入 → 操作 → 结果', local: api.loop(t, 4) };
    },
    paintPanel(ui, x, y, state, panelIndex, t, rect) {
      // x/y为面板左上角；rect.w/h为尺寸，rect.body为正文的绝对坐标矩形。
      // 六图时每图450×约332，正文约410×187；四图正文约410×365。所有正文必须在rect.body中布局，不得占用顶部94px标题区或底部34px步骤区。
      // 所有可见字使用ui.text或ui.typeText，以进入真实字体布局检查。
    },
    checkModels(cfg) {
      // 至少每图一项实际计算的不变量，不能无条件返回passed:true。
      return [{ name: '本例概率之和为1', passed: Math.abs([.2,.3,.5].reduce((a,b)=>a+b,0)-1)<1e-9 }];
    }
  };
}
```

`program.motionPlan`按面板填写`panel`（1起）、`mechanism`、`objects`、`continuousMotion`、`feedback`；`capabilities`记录实际使用或新写的能力。面板元数据保留name/english/sub/color/difference；程序模式不需要nodes/steps/transfers。

## 时间与数学

- `api.clamp(v,min=0,max=1)`、`api.mix(a,b,u)`。
- `api.progress(t,start,duration,ease='smooth')`：有界进度。ease支持`linear/smooth/inOutCubic/outCubic/outBack`。
- `api.loop(t,period,offset=0)`、`api.seeded(seed,index)`：固定可重现的循环/样本。
- `api.pointAt([[x,y],...],u)`：按距离沿折线运动。
- `api.bezier(a,b,c,d,u)`：三次贝塞尔点。需要更复杂路径、弹簧、掩码或物理效果时可自行coding。

动作分别设置时长、重复与错峰；短传输通常0.3–1秒，复杂操作按可读性延长，不再把全部视频等分为几次慢动作。传输到达、参数/形状改变及接收反馈使用同一事件时刻。保留结果时继续输入下一批可复现数据，让过程持续演化。

## 绘图与特效接口

所有坐标为1080×1920画布的绝对像素，t为秒，角度为弧度。color使用`#RRGGBB`，避免过暗颜色。字体不做非等比缩放。正文有效字号至少18px，关键文字22px以上；不要为了塞入六图而缩成微小文字。四图能讲清时优先四图。少文字、大实体；Token卡、矩阵、结构、路径和结果要可读。

- `ui.text(text,x,y,size=26,color,align='center',weight=400)`：y为基线，align可left/center/right。
- `ui.box(x,y,w,h,stroke,fill,radius=8,lineWidth=1.5)`：左上角坐标。
- `ui.dot(x,y,r,color,alpha=1)`；`ui.line(points,color,width=2,alpha=1)`；`ui.arrow(points,color,width=2,reveal=1)`。
- `ui.layer({x,y,scale=1,rotate=0,opacity=1},()=>{...})`：独立的位移、等比缩放、旋转、透明度作用域。绘制坐标为该层局部坐标。
- `ui.chip(text,cx,cy,w,h,color,{fontSize:23,fill,textColor,glow,strokeWidth,weight})`：有实体尺寸的Token/数据块，cx/cy为中心。
- `ui.packet(points,t,{start:0,duration:.65,repeat:0,color,radius:4,trail:5,feedback:true})`：独立传输、拖尾与到达反馈；repeat>0表示重复周期。
- `ui.stream(points,t,{start:0,duration:.65,period:1.2,count:3,stagger:.18,color,radius:4,trail:5})`：多粒子连续数据流。
- `ui.glow(cx,cy,radius,color,strength=.3)`；`ui.flash(cx,cy,u,color)`：后者u为0–1的扩散反馈进度。
- `ui.typeText(text,x,y,t,{start:0,duration:1,fontSize:24,color,align:'left'})`：逐字输出。
- `ui.matrix(values,x,y,{cell:24,gap:2,color,numbers:false,active:-1,max:1,fontSize:20,decimals:0})`：真实数值矩阵与选中单元格。
- `ui.bars(values,x,y,w,h,{max:1,color,labels:[],gap:12,fontSize:21})`：连续更新的数值条，范围可比较。
- `ui.scissors(cx,cy,angle,u,color)`：剪刀随u闭合。
- 原始接口`ui.node/ui.heat/ui.pulse/ui.tint/ui.C`继续可用；原始`ui.pulse`使用整条视频的时间，新动作优先用独立t参数的packet/stream。
- `ui.c`提供Canvas2D完整几何、裁剪、渐变与合成接口。用`save/restore`限定作用域。文字必须走ui.text，不能绕过字体检查。

例如连续Token流：

```js
const col = api.config.panels[panelIndex].color;
const route = [[x+35,y+150],[x+210,y+150],[x+390,y+210]];
ui.arrow(route,col,1.5);
ui.stream(route,t,{duration:.7,period:1.1,count:4,stagger:.18,color:col,trail:7});
```

复刻压缩参考时可使用`const original=api.references.compression`，其stateAt/paintPanel/checkModels接口与上面一致，绘图使用与用户参考视频同源的代码。新主题要实现自己的模型与绘图，不能复用压缩画面只改标题。

LLM Prompt样片选择最能解释原理的4图，例如上下文组装、示例匹配、逐Token生成、约束输出，让Token序列、指令插入、上下文取用、字段填充实际发生。不要把六种方法强行塞入六块微型文字卡。模型内部注意力或概率若没有真实数据，只能明确标为教学示意，不能伪造推理记录或性能比较。

## 执行边界与交付

场景源码只在无账号的隔离浏览器iframe内运行；没有Node、文件系统、网络或服务端凭证。程序必须同步、有限、由t决定，不使用Math.random、系统时钟、异步取数或额外浏览器上下文。

保存每次源码版本、预览图、模型断言、编码后连续帧运动检查与最终源码哈希。工程包包含源代码、固定版本的运动库和预览/重渲染命令；扩展能力保存在本工程，不在生产服务中直接执行或安装任意生成代码。


## 工程编辑与独立模型自检 V3

首次创建后，优先`list_project_files`、`read_project_file`、`search_project_files`读取最新revision、SHA和行号，再用`create/update/delete_project_file`编辑。按行修改支持重复文本，避免猜测search补丁。元数据在animation.meta.json；模块在独立.js/.ts文件。错误会一次返回；修复后调用validate_animation_project实际预览，再调用self_check_animation_project。独立模型必须读完最新脚本并看预览，针对具体文件和行号给建议；发现错误后由作者通过编辑工具修正、重验。任何修改都使旧自检失效；finish仅接受当前版本预览与自检均通过。restore_project_revision可恢复历史为新版本。

通过create/update/delete_project_node注册、启用/禁用或删除Canvas和animation节点。节点文件导出`createNode(api)`，返回`paint(ui,x,y,state,panelIndex,t,rect)`及可选`sample(t,panelIndex)`。sample返回{x,y,scale,rotate,opacity}，绘图前会实际应用该变换；可定义自己的状态机、路径、弹簧、粒子和几何函数。节点的checkModels可追加真实断言。模块只允许相对导入工程文件；Node仅做静态检查和编译，不执行生成代码。多文件工程交付source/及可信编译器，修改source/后build:preview会重建scene.authored.js。

Defold真实游戏与原生动画节点使用独立`@Defold游戏`模板；可编写Lua、GameObject、Sprite、ParticleFX等场景，编译HTML5并实际试玩、自检。不要把Canvas效果标成Defold引擎输出。
