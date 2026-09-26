# Spike：DSH host→client 状态通道 + 连接测试可行性

状态：**结论性调研文档（v0.2.4 候选的一部分），不改任何运行时代码。**
调研基线：本机全局安装树
`/Users/bytedance/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@deepseek-ai/dsh`
（`@deepseek-ai/dsh` 实测版本 **0.1.5-rc.3**；本仓 peerDependencies 声明 `dsh >=0.1.7-rc.1`，
client 侧语义由本仓 fixture 测试按 0.1.7 行为锁定。下文 API 面取自该安装树内
`node_modules/@deepseek-ai/*` 各包源码，0.1.7 正式树发布后应复核导出名——目前两版本间
该通道 API 无已观察到的差异，风险低）。

---

## 1. 结论（TL;DR）

| 问题 | 结论 |
|---|---|
| client 插件能否调用 host 侧代码 | **可行**。`dsh-client-connection` 提供双向拼装：host 侧 `ctx.connection.rpc.handle('/dsh-proxy', handler)` 注册私有 RPC 通道；client 侧 `inject: ['connection']` 后 `ctx.connection.rpc.call('/dsh-proxy', 'endpoint', payload, signal)` 调用。请求/响应 JSON 封包，带 Host/Origin fence + 浏览器鉴权。 |
| host 能否主动推送（host→client 事件） | **无通用推送通道**。`rpc.open` 流仅限共享 `/api` 通道的 worker-local Gateway 流（`dsh-api-gateway` 内部 `$events`），第三方通道没有流端点。状态刷新建议走「按需拉取」：client 在 Test 按钮 / 设置面板打开时 `rpc.call` 一次，可选低频轮询。 |
| 连接测试在 host 侧做 | **可行**。host 插件进程内已有 undici 与 engine 构造器；用一次性 dispatcher（不碰 global dispatcher）+ `AbortSignal.timeout` 探测，结果按错误分类表归一。 |
| 与 settings 快照机制冲突 | **无冲突**。RPC 通道独立于 `remote.settings`/`configForms` 快照路径；测试只读当前 resolved config，不写 settings。 |

## 2. 证据（包名 / 导出面 / 调用点）

### 2.1 host 半边 — `@deepseek-ai/dsh-client-connection`（lib/index.js）

- `HostConnectionService extends Service`，服务名 `"connection"`，构造于 dsh web 启动时。
- 导出面：`API_PATH, Config, HostConnectionService, RpcId, apply, clientRequestSchema,
  inject, name, rpcErrorSchema, rpcIdSchema, rpcMessageSchema, rpcResultSchema,
  serverResponseSchema, transportError`。
- 注册私有通道（我们的用法）：
  ```js
  // host 插件（lib/index.js）
  ctx.inject(['connection'], (conn) => {
    conn.effect(() => conn.connection.rpc.handle('/dsh-proxy', async (endpoint, payload, signal) => {
      // endpoint: 'test' | 'status'；返回 {ok:true,value} 或 {ok:false,error:{code,message,details}}
    }));
  });
  ```
  通道名约束 `/^[A-Za-z0-9._~-]+$/`（带前导斜杠）；路由挂到 `owner.webServer.register(route)`，
  请求先过 `requestRejection`（Host/Origin fence 403 / 浏览器鉴权 401）。
- 备选：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 注册原生
  Fetch 路由（`dsh-client-file-upload` 即此用法，见其 `lib/index.js` 的
  `ctx.connection.fetch.register({...})`）。RPC 封包对我们足够，不需要 raw fetch。
- 共享 `/api` 通道被 `dsh-api-gateway` 独占 intercept
  （`connectionCtx.connection.rpc.intercept("/api", ...)`），**不要**往 `/api` 挂东西。

### 2.2 client 半边 — 同包 `lib/client.js`（浏览器侧 cordis 插件）

- `apply(ctx)` 里 `ctx.provide("connection", handle)`；handle 含：
  - `rpc.call(channel, endpoint, payload, signal)` → `POST {origin}{channel}/{endpoint}`，
    JSON 封包 `{type:'client-request', rpcId, method, payload}`，响应校验
    `server-response` 封包后返回 `{ok:true,value}` / 抛 `{ok:false,error:{code,message,details}}`。
  - `rpc.open(channel, endpoint, ...)` — 仅 `/api`（`"worker-local streams require the
    /api channel"`），**第三方不可用** ⇒ 无通用 host→client 流/推送。
  - `state` / `generation` 快照（连接状态）+ `reconnect()`。
- client 插件声明 `inject: ['connection']` 即可（先例：`dsh-api-gateway/lib/client.js`
  `const inject = ["typert", "connection"]`）。dsh-proxy 的 `lib/client.js` 现有
  `inject = ['slots','locale','configForms']`，追加 `'connection'` 即可。
- 通道可用性边界：`ctx.connection` 由 dsh web 页面提供；TUI/无浏览器场景 host 半边
  的 `ctx.inject(['connection'])` 不会激活（服务不存在）——须保持 opportunistic inject，
  与现有 `ctx.inject?.(['settings'], ...)` 同风格，**不得**变成硬依赖。

### 2.3 dsh-quote-followup 先例

`~/workspace/opensource/dsh-quote-followup`（0.2.x）已验证「client-only 插件 + DSH 注入面
（inputTriggers/locale/versioned state）」路径，但它**没有**用 connection RPC；本 spike 的
RPC 用法以 `dsh-api-gateway`（client `rpc.call`）与 `dsh-client-file-upload`（host
`fetch.register`）为准。

## 3. 连接测试接口草案

### 3.1 wire 契约（channel `/dsh-proxy`）

```ts
// POST /dsh-proxy/test   （client → host）
type TestRequest = { target?: string };   // 缺省 = 当前 LLM base URL
// host → client
type TestResponse = {
  mode: 'direct' | 'system' | 'manual';
  proxy?: string;              // 已 redact 的代理 URL（system 为探测结果）
  target: string;              // 实际探测的 URL
  outcome: 'reachable' | 'proxy-unreachable' | 'auth-failed'
         | 'tls-error' | 'timeout' | 'proxy-cannot-reach-target'
         | 'target-error' | 'unknown';
  detail?: string;             // 归一化前的原始错误码/HTTP 状态
  latencyMs: number;
};
```

`status` 端点（可选，同通道）：返回当前 resolved config 摘要（mode/redact proxy/bypassLoopback/
noProxy 计数）+ 最近一次 apply 的日志行，供 UI 显示「当前生效状态」。

### 3.2 host 侧执行方式

1. 取当前 resolved config（与 engine.apply 同一份），`buildDispatcher`/`buildSystemDispatcher`
   构造**一次性 dispatcher**，绝不 `setGlobalDispatcher`。
2. 目标 URL：`target ?? 当前 LLM base URL`（从 settings/llm 路由读，读不到则回落
   `https://api.deepseek.com`）。
3. `undici.request(target, { dispatcher, method: 'HEAD', signal: AbortSignal.timeout(8000) })`
   — https 目标经代理即完成真实 CONNECT 握手 + TLS；随后 `dispatcher.close()`。
4. 捕获错误/状态码 → 按下表归一 → 返回 TestResponse。

### 3.3 错误分类映射表

| 观测 | outcome | 用户文案方向 |
|---|---|---|
| 连代理/连目标时 `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`EHOSTUNREACH`（manual/system 模式） | `proxy-unreachable` | 代理地址不可达或 DNS 失败 |
| 代理对 CONNECT/请求回 **407** | `auth-failed` | 代理凭据缺失/错误（注意：proxy URL 里的密码是明文） |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_HAS_EXPIRED`、`SELF_SIGNED_CERT_IN_CHAIN`、`DEPTH_ZERO_SELF_SIGNED_CERT`、`ERR_TLS_CERT_ALTNAME_INVALID` | `tls-error` | TLS 校验失败（多为代理做 MITM 或目标证书问题） |
| `UND_ERR_CONNECT_TIMEOUT`、`ETIMEDOUT`、`UND_ERR_SOCKET`（挂起） | `timeout` | 连接超时 |
| 代理回 **502/503/504** | `proxy-cannot-reach-target` | 代理活着但到不了目标 |
| 握手成功但目标回 4xx/5xx | `target-error` | 代理链路 OK，问题在目标侧（如 401 API key —— 不属于本测试职责） |
| 2xx/3xx（HEAD 或 404/405 也算通） | `reachable` | 链路通 |
| 其它 | `unknown` | 附原始 detail |

direct 模式：同一探测直连目标，`proxy-unreachable` 类退化为「目标不可达」文案。

### 3.4 与 settings 快照机制的关系

- 现有 client.js 走 `configForms` + `remote.settings` 快照读写配置；本测试通道**只读**
  resolved config，不产生任何 settings 写入，不影响 `auto:false` presentation。
- UI 顺序：用户在设置面板改完（快照写盘 → volatile-update → engine.apply）后点 Test，
  host 读到的即最新 resolved 值，天然一致；无需订阅推送。

## 4. 限制与风险

1. **无 host→client 推送**：切换生效状态只能拉取（打开面板/点按钮时）。可接受——配置快照
   本身就是 client 发起的写，写成功即知；真正的未知数只在 system 模式，而它以日志为准的
   现状不变。
2. `ctx.connection` 仅 dsh web 存在：host/client 两侧都必须 opportunistic inject；TUI 下
   Test 入口不渲染（client 不存在）。
3. 通道名 `/dsh-proxy` 全局唯一，注册冲突会 throw（effect 内，安全失败）。
4. 版本面：证据取自 0.1.5-rc.3 安装树；peer 声明 0.1.7+。`rpc.handle`/`rpc.call` 属于
   connection 包核心面，被 api-gateway/file-upload 双向使用，预计稳定；上线前在真实
   0.1.7 树 smoke 一次（`--dump-config` 不够，需真 boot web）。
5. 连接测试的 407：我们的本地假代理 e2e 与真实代理行为差异需在真实代理上人工核对一次。

## 5. 工作量估计

| 项 | 估计 |
|---|---|
| host：`/dsh-proxy` 通道 + `test`/`status` 端点 + 错误归一（含单测） | ~0.5 天 |
| client：设置面板 Test 按钮 + 结果展示（含 COPY、locale） | ~0.5 天 |
| 真实 0.1.7 树 smoke + 真实代理人工核对 | ~0.25 天 |
| 合计 | **~1.25 天**（建议排 v0.2.5，不阻塞 v0.2.4） |

若最终放弃 RPC：降级方案为「仅日志增强」（apply 时主动打一行可达性探测结果），
工作量 ~0.25 天，但 UI 无从展示。
