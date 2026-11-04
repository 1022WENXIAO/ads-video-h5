# 可复用的游戏特效

Defold游戏与动画Agent内置[pixelfx](https://github.com/patch-gg/pixelfx)的244个特效、21个分类。固定上游提交为`a84159688af3ca37a4be05a0d422b94451b2e24e`；源码约2.3MB，随应用发布，运行时不下载依赖。仅纳入MIT代码、效果及必要导出函数，未纳入gallery、展示GIF、Claude插件或不属于MIT的Patch Pixel展示字体。

## Agent流程

1. `search_pixelfx_effects(query,limit)`按中英文检索，只返回匹配的少量元数据。
2. `read_pixelfx_effect(id)`返回默认参数、时长、循环、角色绑定信息、来源与Defold调用方法。
3. `preview_pixelfx_effect(id,fps?,seed?,palette?)`返回真实渲染帧接触表，不请求生成模型。
4. `use_pixelfx_effect(expectedRevision,name,id,fps?,seed?,palette?)`将资源加入当前工程；同名修改参数。`remove_pixelfx_effect`移除清单引用。
5. 在玩法脚本中触发短调用，再真实编译、试玩并进行独立模型自检。仅导出已有工程时禁止新增或移除特效。

例如，要求`@Defold游戏 制作一个包含火焰、冰霜新星与金币拾取反馈的游戏场景`时，Agent先查`fire/torch`、`ice/frost-nova`、`pickups/collect-burst`，随后按需要导入，而不是重写这些特效的像素绘制算法。

清单`assets/pixelfx.json`是普通版本化文本，可继续用文件CRUD工具编辑。默认15fps，可指定6–30fps，调色板接受2–16个十六进制颜色；随机种子固定。工程至多8个binding，同一binding可多次播放。导入参数、文件及节点改变都会使原自检凭据失效。

```lua
local pixelfx = require('lib.pixelfx')
-- init(self)
self.fx = pixelfx.new()
-- 拾取、命中、施法等事件中；x/y是原特效锚点，不是图片左下角
local handle = self.fx:play('pickup', x, y, {scale=2, flip=false, angle=0})
-- update(self, dt)
self.fx:update(dt)
-- 需要跟随角色时
self.fx:follow(handle, x, y)
-- reset/final；也可stop(handle)
self.fx:clear()
```

构建器自动生成`lib/pixelfx.lua`、`lib/pixelfx_data.lua`和`assets/pixelfx/<binding>/`，不能用自编文件覆盖这些保留路径。GUI节点自动注册纹理；GameObject/Sprite也可在自己的资源中引用生成的`.tilesource`。当前导出特效层，角色的动作、击停与玩法由自己的脚本驱动。部分状态素材本身包含上游灰色角色，应先预览后决定是否适合自己的角色。

## 原生资源与缓存

固定Node worker只导入已锁定的第三方源码，不执行模型工程里的JS或Lua。逐帧透明RGBA导出为不超过2048×2048的分页精灵图，保留源锚点、光晕与透明度；随后由Defold编译为原生纹理。运行时支持分页、循环、单次清理、翻转和旋转。纹理预算192MiB，活跃特效实例最多32个；超出资源预算时明确失败，不把未导出的资源描述为存在。

缓存键包含固定库、导出器及适配器摘要、特效ID、fps、种子和配色，不包含当前binding名。相同参数可跨任务复用，改色或改参数产生新缓存。源码锁、PNG摘要和帧元数据变化会拒绝复用并重验；同键并发导出用持久化锁串行处理。取消与执行超时可终止worker，父进程环境不传给导出器。

源工程与HTML5产物都附MIT许可、NOTICE和选用资源的上游版本、参数及摘要。技术通过、模型自检与用户视觉接受分别记录；素材被导入并不证明它已经在画面中正确触发。

## 接口与验证

管理员模板页的`pixelfx现成特效复用`用例可一键运行上述检索、预览、导入、玩法触发、编译试玩及自检流程，结果仍需分别查看技术记录与实际画面。

已登录用户可通过`GET /api/creative/effects?query=冰霜&limit=6`检索目录，`GET /api/creative/capabilities`包含实际库版本、分类和数量。没有新增对外模型密钥或任意资源下载接口。

`tests/pixelfx.test.ts`覆盖中英文检索、真实透明帧、无外部生成请求、缓存复用/篡改重建、改色、版本冲突、只导出保护及原生资源/许可打包。`tests/pixelfxNative.test.ts`在Defold环境可用时实际编译并试玩，通过画布像素比较特效开关与连续采样验证可见性和运动；无引擎的CI会明确跳过该原生用例。

第三方文件与摘要见[`third_party/pixelfx/vendor.lock.json`](../third_party/pixelfx/vendor.lock.json)，许可见[`LICENSE`](../third_party/pixelfx/LICENSE)与[`NOTICE.md`](../third_party/pixelfx/NOTICE.md)。升级上游须审阅源码、重建catalog与锁文件，再运行上述行为测试；Agent不能自行更新受信库。
