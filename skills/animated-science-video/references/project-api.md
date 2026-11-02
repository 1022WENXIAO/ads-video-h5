# 工程接口与验证范围

## 文件

- `configs/*.json`：标题、面板名/缩写/简介/颜色、时长、署名、音乐、出处与教学边界。默认1080×1920，不用横向压缩文字。
- `scenes/compression-model.mjs`：压缩例子的纯计算和可寻址时间线。
- `scenes/compression.mjs`：剪刀、退线、传输、量化与分布更新等绘图。
- `scenes/activations.mjs`：6个实际函数、固定种子共同样本、真实分箱和运动路径。
- `renderer.mjs`：标题/面板/署名布局、光点和接收反馈工具、循环衔接。网页与导出共用。
- `render.mjs`：所有帧的文字边界检查、任意时间确定性/循环检查、帧图与MP4导出、SHA。
- `verify.mjs`：完整解码帧数、编码/尺寸、每图主体变化、首尾差异、音轨相关性与峰值。
- `serve.mjs`和`player.mjs`：只监听127.0.0.1的网页预览，含拖动进度与播放暂停。

## 增加新主题

在scenes目录添加一个模块，导出：

```js
export const expectedPanels = 6;
export function stateAt(t, panelIndex, cfg) {
  // 从t计算全部状态；使用固定样本或种子，不能靠上次draw积累或Math.random()
  return { stage: '1 · 输入进入', /* 真实计算和阶段信息 */ };
}
export function paintPanel(ui, x, y, state, panelIndex, t, rect) {
  // rect.w / rect.h 是当前图的边界。正文从y+110附近开始，底部留给阶段说明。
  // ui.text/box/line/node/pulse/flash等可用，ui.c为Canvas2D。
}
```

在renderer.mjs的`scenes`注册该模块，为新主题建立配置。4–8图决定两列布局的行高；已有四图场景不能只改expectedPanels就挤成八图，必须重新设计绘图区。标题、英文缩写较长时调整内容或标题行排布，不做非等比缩放。

辅助函数`pulse(points,start,end,color)`按当前t移动光点，到达终点后给闪光；`flash(x,y,u,color)`中u为0到1的接收反馈进度；`text`记录布局边界，不使用fillText的maxWidth缩字。使用原始Canvas绘图时，新增文字仍应调用ui.text，否则不能进入文字边界检查。

t从0到cfg.duration循环；最后0.45秒默认渐变到初态。算法状态可能另有子循环，例如激活函数8秒一轮；复杂流程可增加时长。新增scene的结果不要用无意义A/B/C代替具体对象。

## 验证内容

每次新主题都要有其数学/流程不变量检查，选择有意义的性质，例如剪枝后连接数、概率总和、被拒绝草稿不能进入输出、同输入的输出结果一致。`check-models.mjs`展示了压缩示例的验证方式。

`render.mjs`逐帧检查文字边界，但不自动证明文字彼此无重叠，也不覆盖图片/曲线的所有遮挡；必须看真实帧和手机播放。`verify.mjs`的像素变化检测不能证明动作具有教学意义。`userAccepted: false`保留到用户实际审阅，不能用脚本通过替代。

完成后至少实际验证：页面标题及正常内容、无运行错误、正常速度完整播放、拖动查看过程、循环回起点、手机无溢出；查看实际导出MP4而不只看网页Canvas。分享时交付源码与成片，记录技术验证和用户审阅状态。
