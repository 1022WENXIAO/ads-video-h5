# 交给其他人复刻

## 安装与调用

将完整`animated-science-video/`文件夹放进个人`~/.codex/skills/`或目标项目`.agents/skills/`，刷新技能列表。其他支持SKILL.md的Agent可直接读取该文件夹；普通聊天工具不具备执行本地代码的能力时，只能按规范生成代码，仍需要本地渲染环境。

给对方的示例请求：

> 使用 $animated-science-video 制作《大模型注意力机制对照》。6图同屏，用同一输入展示各自计算或数据读取路径，文字随数据流逐步出现，光点到达时给接收反馈，正常字体比例，单页循环，无口播、带循环BGM。先做一个视频给我审阅。保留可编辑源码、事实依据和检查记录。

“复刻当前样例”的最低路径是`create_project.py` → 安装/复用依赖 → 渲染两个给定配置。制作新主题还需Agent实现新的状态模型和动效，不是改标题即完成。

## 运行条件

- Node.js 20或以上，Python3仅用于复制工程；可不用Python而手动复制assets/starter。
- FFmpeg可执行文件，具备libx264和AAC编码。默认从PATH找，不在PATH时设置`ANIMATED_VIDEO_FFMPEG`。
- Node Canvas固定为`@napi-rs/canvas@0.1.100`，项目内`npm install`安装。它包含平台原生组件，不要把Mac的node_modules复制给Windows/Linux。
- 已安装的中文字体。脚本自动查找常见系统位置；没找到则设置`ANIMATED_VIDEO_FONT`为实际TTF/OTF/TTC文件。分享包不分发系统字体。

```bash
python3 /path/to/animated-science-video/scripts/create_project.py ./my-science-video --scene compression --author "by张三制作"
cd my-science-video
npm install
npm run preview
# 命令会输出本机预览地址；打开该地址可拖动时间轴、切换四图/六图示例
npm run render -- configs/compression.json
npm run verify -- configs/compression.json
node check-models.mjs
npm run render -- configs/activations.json
npm run verify -- configs/activations.json
```

输出在`output/compression/`、`output/activations/`，包含独立MP4、封面、检查帧、布局/媒体记录和MP4审阅页。渲染器拒绝覆盖已有MP4；修订时用`--out output/compression-v2`并在验证时传同一`--out`。

## 已有依赖可直接复用

不执行安装，设置`ANIMATED_VIDEO_NODE_MODULES`为现成的node_modules目录，`ANIMATED_VIDEO_FFMPEG`为现成FFmpeg。变量只用于当前命令/终端；脚本不改系统设置。PowerShell使用`$env:ANIMATED_VIDEO_FFMPEG="C:\\tools\\ffmpeg.exe"`等对应语法。

字体发生变化会使行宽变化。即使同一代码，换电脑也要重跑全帧布局与手机检查，不能承诺不同平台输出逐字节一致。共享包已在macOS的独立迁移目录以现有依赖验证；没有声称已在Windows/Linux实机验收。

## 音乐与署名

`audio/default-loop-16s.wav`是原项目现用默认循环母带，来源/哈希见同目录provenance.json。配置中的bgm相对配置JSON解析。换自己的音乐可用`create_project.py --bgm /path/to/music.wav`；时长较长时FFmpeg循环音乐并按配置增益混音，不变速不变调。设`bgm: null`可导出无音轨版本。

原项目署名为“by轻喵制作”。其他作者使用自己的署名可通过`--author`或配置author设置；不要把原作者专属目录或账号带给别人。

## 新主题与发布

扩展方式见[工程接口](project-api.md)。分享包只包括制作代码、示例和音乐，不包含发布会话、cookies、参考人声或平台账号；不会启动投稿或定时任务。
