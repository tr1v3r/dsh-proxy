# dsh-proxy — DSH 运行时可切换出站代理

**English readme: [README.md](README.md)。**

[![npm](https://img.shields.io/npm/v/@tr1v3r/dsh-proxy.svg)](https://www.npmjs.com/package/@tr1v3r/dsh-proxy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

![演示：切换代理模式即时改写出站路由](docs/assets/proxy-switch-demo.gif)

`@tr1v3r/dsh-proxy` 是 DeepSeek Harness 插件，把进程内**所有出站请求**——
LLM 提供方、`web_search` / `web_fetch`、streamable-http MCP——经由
HTTP(S) CONNECT 或 SOCKS5 代理转发，并且支持**运行时随时开关、随时换代理**：
可以在 Web「设置 → 通用 → 网络代理」中操作，也可以编辑 profile 的
`cordis.patch.yml` 中的 `dsh-proxy` 条目（热加载），全程零重启。
上面的动图展示路由引擎，安装后可运行 `node scripts/demo.mjs` 复现。

## 工作原理

DSH 与 pi-ai 的请求都走 `globalThis.fetch`，而它读取的是 undici 的全局
dispatcher 槽位（`Symbol.for('undici.globalDispatcher.1')`）。本插件接管该槽位：

- `http(s)://` 代理 → `EnvHttpProxyAgent`（https 走 CONNECT 隧道）
- `socks5://` 代理 → undici 内置 `Socks5ProxyAgent`（支持 URL 内鉴权；
  `socks5h://` / `socks://` 自动归一；域名在代理端远程解析）
- `noProxy` 规则 → 两条路径统一走 `RoutingDispatcher` 分流，HTTP 与 SOCKS
  语义完全一致（undici 风格：裸条目匹配主机及点边界子域；`host:port` 锁定
  端口；`*` 全部直连；前导点 / `*.` 前缀视同裸条目等价写法）。`manual` 模式
  下 dispatcher 刻意忽略环境变量里的 `NO_PROXY`/`HTTP_PROXY`——导出的 env
  只引导子进程，进程内路由完全由 profile 条目配置决定；`system` 模式则相反，
  跟随环境代理——`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，环境变量
  缺失时再回退到 macOS 系统设置里的网络代理（`scutil --proxy`）——每次分节
  应用时重新探测一次，而非持续轮询）

`exportEnv: true`（默认）时，切换还会同步导出
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 到 dsh 进程环境——切换后
新拉起的子进程（bash 工具里的 `curl`/`git`、stdio MCP server）跟着走同一
代理。启动时由你自己设置的环境变量绝不会被覆盖；禁用/卸载时全部还原。回环直连开启
（默认）时，导出的 `NO_PROXY` 还会并入回环默认集（`localhost,127.0.0.1,::1`，与你的
规则去重合并）；`bypassLoopback: false` 时按你自己的列表原样导出。

被替换下来的旧 dispatcher 先优雅关闭、30 秒后强制销毁，确保切换真正切断
旧的 keep-alive 连接。在途请求同样只有这 30 秒宽限（`RETIRE_DESTROY_MS`）：
切换后仍持续超过约 30 秒的流式响应，会在旧 dispatcher 的 socket 被强制销毁时
被中断。

## 凭据安全

代理 URL 中内嵌的 `user:pass@` 凭据以**明文**存放在磁盘上——profile 的
`cordis.patch.yml` 与 settings 持久化中——仅靠文件权限保护。默认
`exportEnv: true` 时，凭据还会随 `HTTP(S)_PROXY` 环境变量写入 dsh 进程，
切换后拉起的子进程都会携带（同一用户可通过 `ps -E` 或
`/proc/<PID>/environ` 看到；其他用户通常需要 root 等特权才能读取，
具体取决于平台权限设置，并非所有同机用户都可见）。为此**不引入**新的配置项；凭据敏感的场景，
建议让 dsh-proxy 指向本机免鉴权的代理入口（例如 `http://127.0.0.1:7890`，
由它再对接需要鉴权的上游），而不是把 `user:pass@` 写进 URL。

## 安装

在目标 profile 目录（`~/.config/dsh/profiles/<name>/`）：

1. `package.json` 加依赖与 bundle（合并进现有 `dsh.profile.bundles` 列表）：

   ```json
   {
     "dependencies": {
       "@tr1v3r/dsh-proxy": "^0.2.4"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@tr1v3r/dsh-proxy"]
       }
     }
   }
   ```

2. 安装：

   ```sh
   dsh plugin --profile <name> install --no-frozen-lockfile
   ```

3. 重启一次 dsh 挂载插件；此后**再无需重启**——切换全在 settings 里。

## 使用

Web 主界面侧栏底部（设置上方）只有「代理状态」图标；悬浮、聚焦或打开菜单可查看
当前选择的模式，并在直连、跟随系统和手动代理之间切换。它与设置页共用同一个配置条目，外部编辑
profile 的 `cordis.patch.yml` 后也会同步更新；悬浮提示中的手动代理地址会隐藏用户名和密码。
「跟随系统」表示**已选择的模式**，不保证系统探测到了可用代理；实际出口以 DSH
日志为准。没有有效代理地址时，快捷菜单不会启用手动模式。要编辑地址、直连规则
或子进程开关，请打开「设置 → 通用 → 网络代理」。

Web profile 也可打开「设置 → 通用 → 网络代理」：从下拉列表选择直连、跟随系统或手动代理，
选择后立即生效，无需「应用」按钮。手动模式可填写 HTTP(S)/SOCKS5 URL、直连地址
（每行一个）和子进程环境变量开关；URL 与直连地址失焦后保存，开关切换后立即保存，
无效 URL 不写入文件。图形界面写入**同一个** `dsh-proxy` 配置条目，文件配置仍然完整保留：
直接编辑 profile 的 `cordis.patch.yml` 会热加载并同步到图形界面；并发修改由修订号保护，
避免覆盖新值。

![DSH Web 手动代理设置界面](docs/assets/proxy-manual-settings.png)

下拉菜单提供三种出站模式：

![网络代理模式菜单：直连、跟随系统、手动代理](docs/assets/proxy-modes.png)

也可以在 `~/.config/dsh/profiles/<name>/cordis.patch.yml` 添加如下条目
（热加载，立即生效）；如果文件已有条目，就追加到现有 YAML 列表中；已有
`dsh-proxy` 条目时直接修改该条目。`mode` 可在
`direct`（直连）、`system`（跟随系统）、`manual`（手动）间切换：

```yaml
- id: dsh-proxy
  config:
    mode: manual                           # direct | system | manual
    proxy: socks5://127.0.0.1:1080         # 仅 manual——http://…、https://…、
                                           # socks5://user:pass@host:1080、socks5h://…
    noProxy:                               # 仅 manual——可选分流规则
      - localhost
      - .internal.example
      - registry.corp:443
    bypassLoopback: true                   # manual 与 system 均生效——本地回环默认直连
                                           # （false 可改为走代理）
    exportEnv: true                        # 仅 manual——同步设置子进程的 HTTP(S)_PROXY
```

| `mode` | 行为 |
| --- | --- |
| `direct` | 直连，不走任何代理（等价于旧的 `enabled: false`）。 |
| `system` | 跟随主机代理，每次分节应用时探测一次：读取 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 环境变量；环境变量缺失时，在 macOS 上再读取系统设置里的网络代理（`scutil --proxy`）。是保存时探测、非持续轮询；Windows 注册表、Linux 桌面与 PAC 暂未覆盖。忽略 `proxy`/`noProxy`/`exportEnv`。 |
| `manual` | 走 `proxy` URL，可用 `noProxy` 分流（等价于旧的 `enabled: true`）。 |

`enabled: true/false` 仍作为旧写法兼容——未设置 `mode` 时分别映射到
`manual`/`direct`：

```yaml
- id: dsh-proxy
  config:
    enabled: true                          # ≡ mode: manual
    proxy: http://127.0.0.1:7890
```

每次保存立即重路由。插件会记录每次切换：

```
dsh-proxy: routing global fetch via socks5://***@127.0.0.1:1080, noProxy 3 rule(s)
dsh-proxy: following system proxy (http://127.0.0.1:7890, noProxy 3 rule(s))
dsh-proxy: direct (mode: direct)
```

（日志中代理 URL 的用户名密码会打码。`system` 模式只读环境/系统代理，
不会回写这些环境变量。）

## 已应用路由快照

通用设置中的代理卡片通过可选、已认证的 Connection Fetch 路由，读取 Host
**最近应用的默认路由**：所选模式、来源、分别脱敏的 HTTP/HTTPS 端点、绕过策略、
代次及稳定的应用/回退代码。保存完成不等于 Host 已应用该版本，必要时手动刷新。
不支持此能力或断连时显示“状态不可用”，不影响原有设置及快捷切换。

快照不是连接健康检查或逐请求追踪。`direct` 恢复原始 dispatcher（可能被其他插件
配置），不保证物理直连；`system` 展示上次实际安装结果，不重新探测环境/系统。
NO_PROXY 和回环策略仍可能让个别请求绕过代理。此功能不发送任意 URL 探针或
提供方请求，也不传递凭据或完整代理 URL。提供方连接诊断仍延期，等待适配器给出
明确的有效目标与安全契约。

开启回环绕过时，导出的 NO_PROXY 会对纯回环地址的大小写、单尾点和 IPv6 方括号
等价形式去重，保留首个拼写和顺序。不新增合并后缀/通配符/端口规则、不同 127/8
地址或非回环域名的尾点。`bypassLoopback: false` 仍按原用户列表导出，不注入默认值。

## 覆盖范围

| 流量 | 是否代理 |
| --- | --- |
| pi-ai 各提供方（`zai-coding-cn`、自定义 openai 兼容路由……） | ✅ |
| `dsh-llm-deepseek`（deepseek-official） | ✅ |
| `web_search` / `web_fetch` | ✅ |
| streamable-http MCP server | ✅ |
| stdio MCP、bash 工具子进程（`curl`、`git`……） | ✅ 经导出的环境变量，仅对切换后新拉起的进程生效 |
| 本地回环目标（`localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0`） | ❌ 默认直连；设置 `bypassLoopback: false` 可改为走代理 |
| pi-ai Bedrock 路由 | ⚠️ AWS SDK 自管代理（它会读 `HTTPS_PROXY` 环境变量） |
| 内置浏览器 host / 浏览器下载 | ❌ 独立进程，请在浏览器侧配置 |

另请注意：切换时已在运行的子进程保留其启动时的环境；undici 的 SOCKS5
agent 上游目前标注 experimental。

## 开发

```sh
npm install
npm test                      # 单测 + 本地 e2e：HTTP 代理、SOCKS5、noProxy、热切换、env
node scripts/boot-probe.mjs   # boot 真实 DSH 插件树，通过 Settings 热切换验证
node scripts/boot-probe.mjs --web # 加测已认证状态 GET 与 auth/Origin 拒绝路径
```

boot probe 在监听端口、创建临时 home 或启动前，先检查实际运行能力。
**DSH >= 0.1.7-rc.1** 是已验证参考，并非按版本号拒绝：安装锚点、模块导入及
所需导出（含 `createRuntimeResolution` / `PluginPackages`）必须可用。缺失根目录、
模块或导出时输出可操作的预检错误，不再到后面才抛 TypeError。不必升级全局安装，
可使用临时安装目录：

```sh
ROOT=$(mktemp -d)
npm install --prefix "$ROOT" @deepseek-ai/dsh@0.1.7-rc.1
DSH_ROOT="$ROOT" node scripts/boot-probe.mjs
```

在本仓库根目录运行上述命令。`DSH_ROOT` 指向含 `package.json` 的安装锚点；
模块解析同时支持 scratch 提升依赖与包内依赖。不指定时，probe 解析 `PATH` 上
`dsh` 可执行文件的真实路径，并对该安装执行预检。

若指定 `PROBE_HOME`，它必须是已存在的父目录。probe 仅创建并清理其下唯一的
临时子目录，不删除父目录或原有内容。probe 进程会清空继承的代理变量；路由验证
只用本地服务器，不发送提供方/模型请求。

## 许可

MIT © tr1v3r
