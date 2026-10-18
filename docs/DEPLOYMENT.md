# 轻剪服务端部署

## 新闻搜索与日期缺省

新闻请求默认 `QINGJIAN_NEWS_DATE_POLICY=flexible`：优先使用真实发布日期在默认 72 小时内的正文；未指定硬性日期范围时，两家独立正文交叉支持的资讯允许缺少发布时间，成片显示“报道日期：原文未注明”。`publishedAt` 保持缺省，抓取时间不写成发布日期。只有年月日的署名行保留日期精度，不要求时分秒。明确要求今天、最近24小时或本周等时间范围仍采用严格时效核验；今天发生还需要正文中的事件日期，不能只用报道日期替代。

可通过服务端私有环境配置 `QINGJIAN_NEWS_DATE_POLICY=strict` 恢复全局严格日期，或用 `QINGJIAN_NEWS_WINDOW_HOURS=168` 调整用户未指定时的优先新鲜度范围（1–720 小时；缺省或非法值为72）。已有研究检查点保留原日期规则。新解析器会重读旧检查点的原始来源，不能直接沿用旧日期。

无需单独配置搜索 Key 即可使用已配置的官方 Ark Responses 联网检索；`QINGJIAN_OPEN_WEBSEARCH_URL` 仍是可选的本机增强通道。新闻检索会剔除已知首页、栏目、微博动态页和当前读取器不支持的文件；无可用文章时更换查询重查。热榜是可选线索，单个热榜预算5秒，Hacker News 网络失败后暂缓5分钟，不阻断新闻正文检索。搜索返回、正文可读、日期、时效及选题通过分别记录，不能把搜索调用完成当成选题已核验。

HTML 场景仍最多尝试两次作者修复和一次独立原生重绘。若首次完整检查仅有对比度错误，第二次完整检查已修复这些文字的对比度、仅剩布局遮挡，且内容、采样时间和原始证据均可核验，允许进入原生重绘；原生结果仍须通过完整检查。原失败报告、哈希和尝试次数保持原样，运行错误、未修复的对比度或缺失证据不适用此恢复。

## 问答与工具备用

新任务在启动时固定主文本模型和最多两个已启用、已配置密钥的同一 Ark 服务备用模型；后台修改配置不影响正在执行的任务。普通问答遇到空函数调用时，可在原三次请求预算中改用经过相同 schema 校验的 JSON 提交；主模型临时不可用时可启用备用模型，最终答复只发布已校验的内容。实时问题先检索并读取正文，最终答案绑定本次来源 ID 并附链接。没有有效正文时明确说明无法确认最新结论，不把搜索摘要当作原文。

联网研究按“可选本机搜索 → Ark 主模型 → 已配置备用模型”执行，保留失败与实际成功模型的诊断。单次研究总预算约120秒，本机搜索15秒，问答正文读取每页8秒；回答任务包含研究的总预算150秒。检索返回的旧 HTTP 地址会先升级到同一主机的 HTTPS 再读取，仍检查公开地址、重定向与有效 TLS。图解第二次作者尝试可使用备用模型重新布局，原脚本、旁白、来源、失败证据和完整画面检查均保留。

备用不会重复提交图片、语音或视频生成，也不会绕过鉴权、积分、停止指令、文件系统错误或成片质量检查。停止后不再切换备用。要停用某个备用模型，在后台禁用该模型；没有可用备用时仍按原主模型路径执行，无需补充新的 Key。

应用状态与评测记录采用原子替换、合并待写进度：前一轮写盘完成后才序列化下一份完整快照，避免每次进度更新都排队保留整份数据库字符串。调用方仍等待覆盖本次修改的原子写盘，写盘错误会明确返回，历史会话、任务和证据不删除。国内共享小内存服务器的运行时堆上限为 `NODE_OPTIONS=--max-old-space-size=640`；已有 `/etc/qingjian-cn/server.env` 会覆盖 service 默认值，需要同步调整。构建进程的384 MiB限制仅用于构建，不能照搬给长期运行且已有大量历史状态的 API 进程。

首次配音中的错字重录也会按该章原先分配的语音窗口重新计算变速，避免较短的新录音沿用旧比例导致整片时长漂移。仅在既定0.8–1.25安全范围内处理，并重新转写核对实际音频；超出范围则定向修改该章内容。其它已核验章节、原始录音及原时长审查门槛均保留，不用静音或元数据补足时长。

域名 `https://video.shikanon.com/` 由 Nginx 转发到本机 `127.0.0.1:8787`；原 IP 入口 `https://101.47.18.93/qingjian/` 继续可用，IP 的 `/` 仍属于服务器原有服务。域名首页公开展示 Landing，工作区与素材 API 需要轻剪帐号密码登录；管理后台使用独立 `admin` 账号，支持 Authenticator 动态验证码。IP 预览入口可继续使用 Nginx Basic Auth。

## 目录与服务

- 代码：`/opt/ads-video-h5`
- 持久数据：`/data/qingjian`（用户与管理员密码哈希、登录会话、Authenticator 加密密钥与恢复码哈希、加密模型配置、素材、成片）
- 对象存储：阿里云 OSS 新加坡地域 `qingjian-shikanon-media-sg-2026`，Bucket 为公开读；素材和产物以帐号 ID 分目录保存，H5 直接从 OSS 加载预览，`/data/qingjian` 保留处理缓存和状态。旧北京私有 Bucket `qingjian-shikanon-media-2026` 暂留作回退。
- systemd：`qingjian.service`
- Nginx：`/etc/nginx/sites-enabled/video-posttrain-lab` 中的 `/qingjian/` 路由
- 域名站点：[`ops/nginx/video.shikanon.com.conf`](../ops/nginx/video.shikanon.com.conf) 安装为 `/etc/nginx/sites-enabled/qingjian-domain`，不改动 IP 站点
- 域名证书：`/etc/letsencrypt/live/video.shikanon.com/`，由服务器现有 `vpl-cert-renew.timer` 续期并在成功续期后重载 Nginx

服务只监听 loopback，不直接开放 8787。`PUBLIC_BASE_PATH=/qingjian` 为 API 返回的素材与成片链接加前缀，`VITE_BASE_PATH=/qingjian/` 控制构建产物的资源路径。`pnpm build` 分别构建手机 H5 和 `apps/admin/` 管理控制台，再把后台打包到 `dist/admin/`；两者拥有独立入口、资源包和样式。线上后台入口 `/qingjian/admin/`、资源 `/qingjian/admin/assets/` 与 API `/qingjian/api/admin/` 由现有 Nginx 前缀代理继续提供。发布前同时检查 `dist/index.html` 和 `dist/admin/index.html`。

域名 DNS 的 A 记录指向 `101.47.18.93`。HTTP 的 `/.well-known/acme-challenge/` 从 `/var/www/acme` 提供证书验证，其余 HTTP 请求跳转到 HTTPS。域名专用 HTTPS server block 对公众开放 Landing 与帐号入口；根路径只显示轻剪，`/qingjian/` 保持资源和 API 路径。更新 Nginx 前先备份现有配置并执行 `nginx -t`，成功后再 `systemctl reload nginx`；检查证书 SAN、域名根路径、登录状态、受保护 API、原 IP 入口及原有站点。

## 更新

管理员账号首次升级会生成 `admin-auth.json`、`admin-auth-key` 和一次性 `admin-initial-password`，均为 `0600`；已有 `admin-token` 作为升级初始密码，继续保留用于解密模型配置。旧长期 Bearer 令牌不再访问管理接口。部署管理员在服务器本地读取初始密码，首次通过页面登录并修改，随后自行扫码绑定 Authenticator、保存恢复码。可在首次初始化前通过服务器私有环境变量 `QINGJIAN_ADMIN_PASSWORD` 指定初始密码；已有账号不会被该变量覆盖。不要把初始密码、二维码、恢复码或管理员会话写入部署日志、代码或工单。完整迁移与备份说明见 [ADMIN_AUTH.md](ADMIN_AUTH.md)。

在服务器上确认 Git SHA 后，执行 `git fetch`、切换到目标 SHA、`pnpm install --frozen-lockfile`、`VITE_BASE_PATH=/qingjian/ pnpm build`，再 `systemctl restart qingjian`。更新后检查 `systemctl status qingjian`、`curl http://127.0.0.1:8787/api/health`，并确认未登录的 `/qingjian/api/state` 返回 401。不要把 `/data/qingjian` 放进 Git，也不要在日志里打印 API Key 或临时密码。

HTML 视频特效渲染还需要 Chrome Headless Shell。首次部署或 HyperFrames 升级后，以服务帐号在 `/opt/ads-video-h5` 执行 `runuser -u qingjian -- env HOME=/data/qingjian HYPERFRAMES_SKIP_SKILLS=1 ./node_modules/.bin/hyperframes browser ensure`。浏览器缓存在 `/data/qingjian/.cache/hyperframes`，与持久数据同盘，不随代码部署删除；系统需能找到 `ffmpeg` 和 `ffprobe`。用线上后台渲染一个模板并检查 MP4 画幅、时长、下载，才算该功能可用。

### 自动部署（CD）

服务器使用 `qingjian-cd.timer` 每分钟检查公开仓库的 `origin/main`，由 root 拥有的 `/usr/local/sbin/qingjian-cd` 执行部署。脚本只接受当前部署提交的快进更新，先把目标提交解包到临时目录，再用无权读取 `/data/qingjian` 的 `qingjian-build` 用户安装依赖并构建。构建成功后切换源码、`dist/` 和 `node_modules/`，重启服务并检查本机 API 与 H5；失败时一并恢复先前提交、静态产物和依赖。模型密钥、素材和成片始终留在 `/data/qingjian`。这条链路不需要把服务器密码或 SSH 私钥放进 GitHub Secrets。

安装文件位于 [`ops/cd`](../ops/cd/)。首次安装在服务器上创建 `qingjian-build` 系统用户和 `/var/cache/qingjian-cd/home`，将脚本以 `root:root 0755` 安装到 `/usr/local/sbin/qingjian-cd`，将 service/timer 以 `root:root 0644` 安装到 `/etc/systemd/system/`，然后执行 `systemctl daemon-reload`、`systemctl enable --now qingjian-cd.timer`。可用 `systemctl start qingjian-cd.service` 立即执行一次，并通过 `journalctl -u qingjian-cd.service`、`git -C /opt/ads-video-h5 rev-parse HEAD` 和 `curl http://127.0.0.1:8787/api/health` 验证。定时器状态可用 `systemctl list-timers qingjian-cd.timer` 查看。

### 旧数据归属

升级前备份 `/data/qingjian/app-state.json` 与 `/data/qingjian/auth.json`（若存在）。停止轻剪服务后运行 `QINGJIAN_DATA_DIR=/data/qingjian pnpm tsx scripts/provision-owner.ts <邮箱>`，脚本只认领尚未归属帐号的旧数据；若邮箱尚未注册，将输出一次性初始密码，用户登录后在用户中心修改。此操作必须在公开域名注册入口前完成，运行后调整数据文件属主为 `qingjian` 并重新启动服务。不要把临时密码写入代码、仓库、部署日志或工单。

CD 脚本的运行副本由 root 拥有，仓库推送不会自动更改脚本或 systemd 单元；更新部署机制时需单独重新安装这些文件。线上代码或定时器应由服务器管理员维护，不要让 Web 服务进程写入 `/opt/ads-video-h5`。

构建在 `dist/release.json` 写入实际提交号。CD 的 `git archive` 通过 `.gitattributes` 的 `export-subst` 将提交号注入构建源；普通 Git 工作区构建读取 HEAD。`/qingjian/api/health` 返回 `{ok:true, revision:"40位提交号"}`，启动时缺少有效构建标记则 revision 为 null，不猜测版本。公网验收应比对该 revision、origin/main 与实际静态资源，并确认未登录的状态接口仍为401。

### Resend 注册邮件

在 Resend 中验证发信域名后，将 `RESEND_API_KEY` 和 `RESEND_FROM=轻剪 <noreply@已验证域名>` 写入本机 Git 忽略的 `data/resend.env`（`0600`）和服务器 `/etc/qingjian/resend.env`（`root:root 0600`）。把 [`ops/cd/qingjian-resend.conf`](../ops/cd/qingjian-resend.conf) 安装为 `/etc/systemd/system/qingjian.service.d/resend.conf`，执行 `systemctl daemon-reload` 和 `systemctl restart qingjian`。Resend 密钥不传入前端构建，也不放入仓库或 GitHub Secrets。未配置发信邮箱时，发送验证码接口返回 503，注册不会绕过邮箱验证；已有帐号可以继续登录。

注册邮箱验证码为 6 位，仅保存加盐哈希，有效期 10 分钟，每个验证码最多尝试 5 次；同一邮箱重发至少间隔 60 秒。服务端还限制每小时每邮箱和每 IP 的发送次数。需要从经 Resend 验证的域名发信，`onboarding@resend.dev` 仅适用于受限测试。

### OSS 公开读配置与迁移

本机将 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_REGION=oss-ap-southeast-1`、`OSS_BUCKET=qingjian-shikanon-media-sg-2026`、`OSS_PREFIX=qingjian`、`OSS_PUBLIC_READ=true` 放入被 Git 忽略的 `data/oss.env`（权限 `0600`）。服务器使用 `/etc/qingjian/oss.env`（`root:root 0600`），内容同名；通过 [`ops/cd/qingjian-oss.conf`](../ops/cd/qingjian-oss.conf) 为 `qingjian.service` 配置 systemd drop-in，同时安装新版 [`qingjian-cd.service`](../ops/cd/qingjian-cd.service) 让 CD 读取同一环境文件。CD 构建子进程使用清空后的环境，仅传入 PATH/HOME/缓存路径，不向依赖安装和前端构建传递 OSS 密钥。不要把密钥写入仓库、GitHub Actions 或 Vite 的 `VITE_` 变量。

部署新代码前备份 `/data/qingjian`，检查 `media/`、`artifacts/`、`exports/` 的大小；在旧文件仍在本地时运行 `QINGJIAN_DATA_DIR=/data/qingjian pnpm tsx scripts/sync-oss.ts`，输出 `missing:0` 才视为迁移完成。脚本幂等，已在 Bucket 中的对象跳过。升级后测试上传、预览、剪辑导出、下载，并验证对象已进入 Bucket；运行时本地缓存缺失会从 OSS 恢复。新 Bucket 的“阻止公共访问”设为关闭，Bucket ACL 为 `public-read`，新对象 ACL 为 `public-read`；切换前用无凭证 HTTP GET 检查实际可读。知道对象 URL 的任何人都能读取素材、口播音频和成片；帐号鉴权只保护会话列表、上传、编辑和应用内下载接口。不得在此 Bucket 存放帐号资料或密钥。API Key 应仅由服务端环境读取。

`docs/test.mp4` 是本地验收素材，已从 Git 排除；测试时单独上传。切镜点使用 FFmpeg 的画面变化阈值，最多展示 8 段，并不分析人物或事件语义。内置配乐是确定性合成音，正式创作可上传自己的音乐素材。
