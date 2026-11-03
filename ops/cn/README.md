# 国内测试服务部署

域名为 `video.tensorbytes.com`，服务器为阿里云 `8.134.24.116`。SSH 私钥只在操作者本机使用，不复制到服务器或仓库。

## 单机布局

- Node 24.21.0：`/opt/qingjian-cn/node`，独立于服务器原有 Node 和其他应用。
- pnpm 11.25.0：`/opt/qingjian-cn/pnpm/node_modules/.bin/pnpm`。
- 不可变源码与构建：`/opt/qingjian-cn/releases/<40位Git提交号>`；`current` 为当前版本软链接。
- 运行用户 `qingjian-cn`，构建用户 `qingjian-cn-build`；运行进程只监听 `127.0.0.1:8787`。
- 正式持久数据 `/data/qingjian`，运行进程 HOME 也使用此路径；配置和模型密钥不进入源码包，构建用户不能读取此目录。
- `qingjian-cn.service` 为运行服务；`/etc/qingjian-cn/server.env` 可存放服务器私有设置；微信 AppID/AppSecret 使用 `/etc/qingjian-cn/wechat.env`（root 拥有、0600），重启服务加载。密钥不写入客户端、Git、发布包或日志。
- Nginx 仅新增 `video.tensorbytes.com` 专用站点；证书位于 `/etc/letsencrypt/live/video.tensorbytes.com`。

用户已明确：保留原国外站 `video.shikanon.com`，停止迁移；国内站 `video.tensorbytes.com` 的账号、素材和积分与国外站独立。国内 H5 和国内小程序在同一域名下使用同一 API 与持久存储，按账号身份持久保存国内素材、会话、任务与积分。小程序现为独立微信账号体系，H5 保留邮箱账号，二者不自动合并。原 [`SHARED_DATA_CUTOVER.md`](SHARED_DATA_CUTOVER.md) 为已停止的历史方案，不再执行。

## 安装与激活

1. 创建两个系统用户、独立目录，安装 Node 与仓库指定的 pnpm；Node 下载包按官方 SHA-256 核验。已存在的应用、运行时及 Nginx 站点不覆盖。
2. 当前 2 GiB 共享主机优先使用 [Linux 发布构建](../../.github/workflows/cn-release.yml)：在 Ubuntu 22.04、Node 24.21.0 下安装冻结依赖、运行原生传输回归并构建 H5/后台，生成带完整 Linux 依赖的提交号 tar.gz 和 SHA-256 文件。确认实际工作流成功、提交号和包哈希后，再上传、解包；包不包含生产数据、密钥或 Git 凭证。
3. 也可在操作者本机执行 [`package-release`](package-release) 导出准确 HEAD、构建 H5/后台、按冻结锁文件安装 Linux x64 依赖并生成包及 SHA-256。打包使用 [pnpm 的目标平台选项](https://pnpm.io/cli/install#--osname)，跳过安装脚本，核对 Linux 原生模块，移除 macOS 扩展属性；构建过程不读取生产数据。上传后核对哈希，并在 Linux 检查 esbuild、Sharp、FFmpeg/ffprobe。解包时用受限临时单元，将提交号目录设为 root 拥有、0755、其他用户不可写。不要在当前小内存服务器现场重装依赖。
4. 首次独立部署使用 [`init-data`](init-data) 显式初始化全新的国内账号、积分与会话；脚本拒绝已存在的数据目录，不导入开发/验收账号。国内模型密钥重新加密、管理员凭证独立生成。国内素材使用广州区域私有桶 `qingjian-tensorbytes-cn-20261006`，`OSS_REGION=oss-cn-guangzhou`、`OSS_PREFIX=qingjian-cn`、`OSS_PUBLIC_READ=false`；注册邮件配置单独保存在国内私有目录。所有凭证均不进入 Git。后续升级只激活新代码，不重复初始化。
5. 将 [`qingjian-cn.service`](qingjian-cn.service) 和 [`activate-release`](activate-release) 安装到 systemd 与 `/usr/local/sbin/qingjian-cn-activate`。执行 `systemctl daemon-reload` 后，运行 `qingjian-cn-activate /opt/qingjian-cn/releases/<sha>`；脚本先检查正式账号、积分和会话 JSON 已准备且运行用户可读取解析，拒绝未准备的数据目录，再检查发布号、H5、后台和未登录 401，失败恢复前一版本。
6. 先配置 HTTP ACME 验证站点，再用服务器现有 Certbot 账号获取本域名证书。安装 [`video.tensorbytes.com.conf`](../nginx/video.tensorbytes.com.conf)，执行 `nginx -t` 后重载。证书自动续期后需 nginx reload hook。
7. 从公网检查 `/qingjian/api/health` 的实际 SHA、`/qingjian/release.json`、未登录状态 401，再使用隔离验收账号验证签到、上传、原生识别和 Agent。检查原有站点仍健康。

服务配置变更不由代码推送自动安装；本部署不启用海外站点的 CD 定时器。更新时重复导出、构建、校验和激活步骤，保留旧版本供回滚，不替换持久数据目录。

### 小程序素材能力兼容

服务端通过 `/api/state` 的 `limits.maxAttachments` 声明每条创作指令最多附加 20 个自有素材；逐文件上传及每次 multipart 最多 6 个文件的限制保持不变。新小程序读取此能力，旧客户端继续兼容原有响应。图片素材增加需登录且校验所有者的 `/api/media/:id/thumbnail`，按需生成最长边 320px 的 JPEG，复用本地缓存并在删除原素材时清理；不公开原图或鉴权凭证。该后端发布不上传或替换微信代码包，客户端品牌、主题和分享设置仍按独立小程序发布流程更新。

发布验收的内部持久任务使用本例剩余的执行时限，排队及多轮指令共用同一个截止时间，避免用例允许 45 分钟而内部任务提前按默认 30 分钟停止。普通用户仍使用 `QINGJIAN_TASK_TIMEOUT_MS` 或原默认值；用例停止信号、整轮时限和全部成片质量检查仍然生效。

同一画面保留要求包含多个部分时，审查可单独列出实际成片中已出现部分的 `preserveFrameTimes`。返修会把这些真实抽帧映射到唯一的原素材时间，与遗漏部分一起约束完整原句选择；转场重叠或来源哈希无法绑定时停止重选。该字段只保护已有观察，不改变整项未满足状态、原始评分或最多两次渲染的限制，新成片仍须独立审查。

国内发布统一使用 `VITE_BASE_PATH=/qingjian/ pnpm build`，让路径前缀传递到 H5、管理后台和桌面端的全部构建进程。若分开构建 workspace，也须对每个命令传入同一前缀。`tooling/package-frontends.mjs` 汇总产物后会校验三端版本号、实际脚本/样式 URL 的路径前缀，以及所引用的文件是否存在；漏传前缀、混入旧版或资源缺失会直接使打包失败。仅验证入口 HTML 返回 200 不能替代公网浏览器检查。

服务器内存较小时，构建 Node 堆限制为 384 MiB，安装时单独限制各 V8 堆为 192 MiB，安装网络并发为 2，pnpm 工作线程上限为 1，禁止重复构建。缓存与发布目录必须位于同一文件系统，依赖采用硬链接导入，避免复制缓冲与磁盘重复读取。当前国内服务器系统盘为 `/dev/vda`，主机配置 1 GiB 交换文件并设置 `vm.swappiness=10`；临时构建单元使用 `MemoryHigh=infinity`、`MemoryMax=900M`、`MemorySwapMax=512M`、`CPUQuota=75%`，磁盘读写分别限制为 8 MB/s、4 MB/s 与各 200 IOPS，并设置 `OOMPolicy=kill` 和 15 分钟运行上限。限额是对单个构建的约束，仍须监测整机和原有业务；不能将软限制设得过低而使代码页面反复回收。其他主机需先核对实际块设备再设置 I/O 限额。连接中断时先核查原进程和服务器负载，再决定续装；不要同时启动重复安装或重启整台共享服务器。

## 原生接口验收脚本

[`tooling/smoke-miniprogram.mjs`](../../tooling/smoke-miniprogram.mjs) 使用实际原生客户端网络封装和真实 HTTP，使用专用邮箱测试账号检查国内 API 的通用网络封装和 H5 兼容性，不代表微信登录验收。覆盖发布 SHA、鉴权、同邮箱账号双向会话同步、签到去重、PNG/MP4/MP3 二进制上传与私有下载、真实 Agent 视频导出、全帧解码和同步账本。启用语音选项还会生成测试语音，先识别，再提交同一任务；它不是微信设备模拟器。微信身份链路使用 `tests/wechatAuth.test.ts` 的隔离供应商集成测试，随后在微信开发者工具中用真实 `wx.login` 联调；不能用邮箱 smoke 结果代替微信认证通过。国内与国外站保持独立，不进行跨站共用验收。

管理员须先在隔离测试环境准备专用账号。凭证 JSON 仅保存在服务器私有目录，含 `purpose: "qingjian-deployment-qa"`、以 `mini-deploy-` 开头且以 `@example.invalid` 结尾的测试邮箱，以及至少 24 位随机密码。脚本拒绝使用普通生产账号，不会打印凭证或登录 Cookie。以下命令只引用文件路径，不包含密钥值：

需要隔离测试时，可在独立数据目录、独立端口运行仅监听回环地址的服务，并设置 `QINGJIAN_MINI_QA_ISOLATED_API=http://127.0.0.1:8789/api`。报告明确标记 `isolated-loopback`；此模式拒绝外部 HTTP 地址及混用国外 H5 域名，发布小程序的 HTTPS 配置不变。隔离联调不能代替国内公网共用和微信真机验收。

```bash
cd /opt/qingjian-cn/current
QINGJIAN_DATA_DIR=/data/qingjian \
QINGJIAN_MINI_QA_CREDENTIALS=/data/qingjian/deploy-qa-credentials.json \
QINGJIAN_MINI_QA_REPORT=/data/qingjian/deploy-qa-report.json \
QINGJIAN_MINI_QA_VOICE=1 \
/opt/qingjian-cn/node/bin/node --import tsx tooling/smoke-miniprogram.mjs
```

合成测试素材及识别、生成请求会产生正常的模型和存储用量。测试报告必须依据真实执行结果，不能将脚本存在或本地专项测试通过写成线上验收通过。

本次操作状态见 [`DEPLOYMENT_20261006.md`](DEPLOYMENT_20261006.md)。

## 微信体验版

原生项目已绑定 `wxf5dfb5d144bcd684`。微信域名配置、开发者/体验者权限、隐私指引、开发者工具上传及设为体验版仍由发布者完成；服务器上线与代码包构建不代表微信体验版已发布。具体清单见 [`apps/miniprogram/README.md`](../../apps/miniprogram/README.md)。
