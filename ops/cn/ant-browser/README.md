# Ant-Browser 同机部署预案

此目录包含部署预案、明确批准的清理清单和安装脚本。原生安装与验证结果记录如下；后台新版本的发布结果另行核对。

## 2026-10-31 执行结果

- 经用户明确确认，只清理清单中的 26 个旧 release，保留 `e86f833...` 和 `021b26f...`。归档排除可重新安装的 `node_modules`、`.git`，逐文件验证 12,352 项及符号链接后才删除。归档 SHA-256 为 `b74ead972427eae4a7586f39f667c1a86059f78228dc79ecdceb9813c0c0a6cc`。
- 私有备份与逐文件校验记录：`/opt/qingjian-cn/operator-evidence/ant-browser-install-20261031/approved-old-releases.tar.gz`、`backup-verification.json`、`cleanup-result.json`。清理后空闲 8.41 GiB，安装后约 7 GiB；三个轻剪持久化 store 的哈希均未改变，安装过程未重启轻剪。
- 固定 Ant V1.8.0 和 fingerprint-chromium 150.0.7871.186，两个制品均已核对以下 SHA-256。实际二进制依赖 WebKitGTK **4.1**，Ubuntu 22.04 库已安装；Chromium 正常运行，未加入 `--no-sandbox`。
- `qingjian-ant-browser.service` 使用独立账号、Xvfb、768 MiB cgroup 内存上限、512 MiB swap 上限和 1 CPU 配额。Launch API 只监听 `127.0.0.1:19876`，未认证 401、认证 200；私钥只保存在服务器私有配置中。
- 真实原生测试通过：打开 HTTPS 页面、中文填写/点击/读取、实际 Noto Sans CJK SC 字体、Cookie 在停止重开后保留。真实后台适配器已连接原生 Ant，通过全局单实例限制及停止操作；该轮采样内存峰值 543,703,040 字节（约 519 MiB），未发生 OOM。此为有限试运行结果，不代表重网页或视频渲染并发下的容量保证。
- 证据：同一私有目录中的 `native-qa.json`、`native-chinese-input.png`、`adapter-qa.json`。Ant 自带图形界面未开放公网；当前支持公开页面及已有登录态实例，没有增加远程交互式登录界面。

2026-10-31 检查目标 `8.134.24.116`：Ubuntu 22.04 x86_64、2 vCPU、总内存 1685 MiB、可用约 880 MiB、1 GiB swap；40 GiB 根盘剩余约 1.8 GiB（96%）。已有 GTK，未发现 Ant-Browser、Xvfb 和 WebKitGTK。当前轻剪版本 `e86f833f8651b8caeba40eedecfe2643eff6bb03` 正常运行。

Ant 官方建议内存至少 8 GB。优先扩容至 8 GB，并确保安装与暂存后仍有至少 3 GiB 空间供渲染。若选择在现有主机试部署，则限制为单个浏览器实例、768 MiB 服务内存、512 MiB swap、1 个 CPU 配额；原生内核、中文页面和峰值资源验证不通过时停止 Ant，不把它标记为可用。

## 安装范围

1. `qingjian-ant-browser` 独立系统账号；程序置于 `/opt/ant-browser/`，用户数据置于 `/data/ant-browser/`，私有配置置于 `/etc/ant-browser/`。
2. 使用 Xvfb 提供虚拟显示，Chromium 使用 `--headless=new`。安装所需 Xvfb/WebKitGTK/字体依赖；不安装完整桌面环境。
3. 固定下载并校验以下官方制品，总下载约 214.4 MiB，另有系统依赖；解压空间另外预留。先验证 Ubuntu 22.04 的动态库/GLIBC 兼容性，再启动服务。
4. Ant 首次启动完成自己的数据库迁移后，配置独立的默认指纹内核；如通过 SQLite 初始化，仅操作全新 Ant 数据库并先备份，使用官方 `browser_cores` 表字段。通过 Launch API 创建测试实例，不写入轻剪用户数据。
5. 只监听/接收 loopback；启用 `X-Ant-Api-Key`，随机 Key 仅落在私有配置。不开公网 CDP 或远程桌面端口。
6. 原生验证包括 API 鉴权、实例创建、CDP 就绪、打开页面、点击/填写、中文字体、停止/重启、登录态目录保留及单实例内存峰值。通过后再把后台的 Ant URL/Key 接到新代码版本。
7. 新的桌面入口独立发布到 `/qingjian/desktop/`，移动 H5 和小程序 UI 保持各自构建。发布分支从线上 `e86f833...` 单独整理，不包含本地原有的移动端、定时任务未发布改动；桌面的定时任务入口仅在后台提供对应能力时出现。

| 制品 | SHA-256 |
| --- | --- |
| [Ant-Browser V1.8.0 linux-amd64.zip](https://github.com/black-ant/Ant-Browser/releases/download/V1.8.0/ant-browser-linux-amd64.zip) | `79aa5a51e7fd30ea9f783e0f8d53ab49d3e630243056f8d14b8f40a24cf66d25` |
| [fingerprint-chromium 150.0.7871.186 x86_64 Linux](https://github.com/adryfish/fingerprint-chromium/releases/download/150.0.7871.186/ungoogled-chromium-150.0.7871.186-1-x86_64_linux.tar.xz) | `48eff860053efd9ad498d51370f0a1f59f983df39c02a72ad2a8682cdead4055` |

固定制品以官方 Release API 当次返回的 digest 为依据；不把 master README 的未发布版本当成已发布安装包。

## 若通过清理旧版本腾出空间

精确目标为 [`cleanup-plan-20261031.json`](cleanup-plan-20261031.json) 的 26 个目录，全部位于 `/opt/qingjian-cn/releases/`。此清单已执行，不可原样重复运行。保留当时当前 `e86f833...` 和此前运行过的 `021b26f...` 两个版本，不删除 `/data/qingjian/`、用户视频、积分、模型配置、检查点或 operator evidence。

执行前获得对这个清单的确认，持有现有部署锁，重新核对 current、所有服务运行目录及活动制作任务。先把这些旧版本的源码/构建产物（排除可重装的 node_modules）打成 root 私有归档并校验，再逐项删除清单目录；不扩大为包缓存、日志或其他项目清理。实际回收空间受硬链接影响，以删除后 df 为准；不足则停止安装并等待扩容。

## 回退

停止/禁用 `qingjian-ant-browser.service`，撤销新后台的 Ant 配置或回退轻剪 release。Ant 状态目录保留以便恢复；不自动删除浏览器用户数据或全局卸载系统依赖。原有当前版和回滚版保持可用，旧源码另有归档。

## 低资源主机的验收时限

2026-10-31 同机试运行中，新闻用例经历数字/单位复听、重录和内置图解回退后，已渲染两章，但触发原单例 1800 秒时限。该结果保留为失败，不能改成通过。

此主机后续试运行使用 `QINGJIAN_RELEASE_CASE_TIMEOUT_SECONDS=2700 bash ops/cn/activate-release <prepared-release>`，将未来用例限时设为 45 分钟；整轮仍为 7200 秒、三个用例和原有质量门槛。默认部署不设置此变量，沿用已有配置。该参数只调整发布验收的限时，不修改用户任务或媒体内容。

配置写入在部署锁内、服务停止后执行；原文件备份至 `/opt/qingjian-cn/operator-evidence/evaluation-settings-backups/`，历史 release、尝试记录及其原始时限均保持不变。备份和新文件使用 0600，原服务账号的文件所有权保留。格式、范围或并发写入检查失败时停止并恢复原服务。
