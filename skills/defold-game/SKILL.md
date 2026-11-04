---
name: defold-game
description: 根据需求编写并修改Defold游戏场景与动画节点，交付可试玩HTML5/WASM及可编辑工程。适用于交互游戏、粒子效果、运动场景和游戏动画；普通科普视频继续使用动态图模板。
---

# Defold游戏与动画

使用真实Defold Lua与GUI节点开发，不以Canvas模拟引擎。先读取能力和实际环境，从可运行工程起步，再按用户要求编写脚本。游戏与动画节点都进入实际collection；支持新增、查询、修改、启用/禁用与删除。

游戏画面需要火焰、爆炸、刀光、法术、天气、拾取反馈、UI等特效时，优先search_pixelfx_effects检索已内置的244个pixelfx特效，再read_pixelfx_effect读参数和调用方法；需要确认观感时用preview_pixelfx_effect看真实连续帧。用use_pixelfx_effect注册资源，使用lib.pixelfx短调用连接玩法事件。不要重新生成库里已有的特效代码；未匹配到需求时才自编扩展。纹理导出和缓存由固定工具完成。

使用带revision/SHA的文件增删查改工具，先读当前行号再编辑，避免反复猜测文本补丁。编译和试玩后，独立模型读取最新源码与截图自检；发现问题由作者使用编辑工具修正，再重验。自检通过只对当前工程哈希有效。

接口、运行边界与试玩约定见[开发接口](references/development.md)。交付HTML5试玩、源工程、构建日志、截图、自检及技术记录，待用户视觉与玩法验收。
