# dsh-proxy v0.2.4 gap-fix plan — acceptance contract

Baseline: `master` @ v0.2.3 (clean). Source of commitments: upstream discussion
[deepseek-ai/deepseek-harness#5877 (comment 18614234)](https://github.com/deepseek-ai/deepseek-harness/discussions/5877#discussioncomment-18614234).

Scope split — **implement in v0.2.4**: Req 1 (loopback bypass), Req 2 (doc honesty), Req 3 (UI copy). **Defer (spike only)**: Req 4 (connection test + host→client status channel). No public release actions in this round; only produce the v0.2.4 candidate.

Settled design decisions (do not relitigate):

- `bypassLoopback` defaults to `true`.
- Spike probe target leans toward "current LLM base URL + bare CONNECT handshake"; validated inside the spike, not pre-committed.
- No new `proxyEnv` config knob.

---

## Req 1 — Loopback traffic bypasses the proxy by default

### Problem

`matchesNoProxy` (lib/index.js) only does curl-style host/suffix/port matching. A proxy at `127.0.0.1:7890` + LLM endpoint or MCP server on `localhost:xxxx` routes loopback traffic through the proxy unless the user hand-writes `localhost` etc. into `noProxy`. Env export side has the same hole: exported `NO_PROXY` contains only user rules.

### Requirements

1.1 **Built-in loopback classification in the matcher path.** `matchesNoProxy` (or a wrapper both call sites use) must classify as loopback-and-bypass: hostname `localhost`, `127.0.0.0/8` (any `127.x.x.x` IPv4 literal), `::1`, bracketed `[::1]` (already normalized by `originParts`), and `0.0.0.0`. Implementation constraint: **IP-literal checks only** — no CIDR wildcard string matching, no adding rules to the user list. This classification applies inside `RoutingDispatcher.dispatch`, so both `buildDispatcher` (manual mode) and `buildSystemDispatcher` (system mode) paths inherit it. `matchesNoProxy(hostname, port, rules)` may keep its current signature; an additional internal helper (e.g. `isLoopbackHost(hostname)`, exported for tests) is acceptable.

1.2 **Config switch.** New boolean config `bypassLoopback`, schema `z.boolean().default(true)`, added to `Config` and `resolveConfig` (default `true` when absent, backward compatible). When `false`, loopback hosts route through the proxy exactly as today (user `noProxy` rules still work on them). `lib/index.d.ts` types updated (`bypassLoopback?: boolean` in config, `bypassLoopback: boolean` in resolved).

1.3 **RoutingDispatcher plumbing.** The loopback decision must be wired so it works even when `noProxy` is empty (today `withBypass` skips the RoutingDispatcher entirely with zero rules — with `bypassLoopback: true` a RoutingDispatcher must still be installed when the default loopback set applies). Manual mode and system mode both.

1.4 **Env export side.** In `createEnvManager.sync` (manual mode + `exportEnv`): synthesized `NO_PROXY` must include the loopback default set (`localhost,127.0.0.1,::1` — `0.0.0.0` may be included; bracket forms are not needed in env values). Merge rule: if the user `noProxy` list is non-empty → union of user rules and default set, deduplicated (preserve user order, append missing defaults); if empty → use the default set alone (replacing today's "delete the key" behavior). When `bypassLoopback: false`, env export keeps today's behavior (user list only; empty → key deleted). Snapshot/adopt/restore semantics unchanged.

### Acceptance criteria

- A1.1 Unit tests: `localhost`, `127.0.0.1`, `127.199.0.5`, `::1`, `[::1]`, `0.0.0.0` (as origin/URL forms) all bypass with empty `noProxy`; non-loopback hosts still proxied; `127.0.0.2` NOT matching loopback via string tricks (e.g. `not127.0.0.1`, `xlocalhost`) must not bypass.
- A1.2 `bypassLoopback: false` → loopback routed via proxy (dispatch-level test); default/`true` → bypassed.
- A1.3 System-mode dispatcher test: loopback origin bypasses even when detected system `noProxy` is empty.
- A1.4 Env export tests: user list `["a.com"]` → exported `NO_PROXY` contains `a.com` plus loopback defaults, no duplicates; empty user list → exported `NO_PROXY` equals default set (key present, not deleted); `bypassLoopback: false` → old behavior preserved.
- A1.5 Existing test suite (`client.test.mjs`, `switch.test.mjs`) stays green.

---

## Req 2 — Documentation honesty (README.md + README.zh.md)

### Requirements

2.1 **Plaintext credentials note.** Both READMEs must state, in a clearly visible place (a security note near Install/Use): proxy URLs with `user:pass@` are stored **in plaintext** on disk (profile `cordis.patch.yml` / settings persistence), and when `exportEnv` is on, the credentials are propagated **into child-process env vars** (visible e.g. via `ps`/shell inspection on some platforms).

2.2 **Switch-interruption note.** Both READMEs must state: switching the proxy (or mode) while streaming requests are in flight gives them a 30-second grace period (`RETIRE_DESTROY_MS`), after which the retired dispatcher's sockets are force-destroyed — i.e. in-flight streaming requests are killed ~30s after a switch. Place near the hot-switch/log section.

2.3 **Coverage mention of loopback.** The "What is covered / not covered" table (and zh equivalent) gains a row/note: loopback destinations (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) are direct by default, with the `bypassLoopback` switch mentioned.

2.4 The two READMEs stay content-equivalent (zh mirrors en).

### Acceptance criteria

- A2.1 Each README contains both notes; grep-able keywords: credentials/plaintext (凭据/明文) and the 30s kill (30 秒 / 30-second / RETIRE_DESTROY_MS reference acceptable).
- A2.2 Neither README claims anything contradicted by code (no "credentials are encrypted", no "switch is seamless").
- A2.3 zh/en parity: every added en statement has a zh counterpart.

---

## Req 3 — UI copy (lib/client.js `COPY`, zh + en)

### Requirements

3.1 **Settings-row hint (`description` key)** gains, concisely: (a) coverage scope — controls DSH in-process requests, child processes via exported env; (b) saves apply immediately, no restart (保存即生效、无需重启); (c) loopback (`localhost` / `127.0.0.1` etc.) is direct by default. Keep the existing pointer that the profile `cordis.patch.yml` remains editable.

3.2 **Tooltip texts stay honest for system mode**: `systemUnknown` keeps the "see DSH logs for the effective route" framing (以 DSH 日志为准). No claim of live status — the host→client status channel is out of scope this round. Do not add a connection-test button or any new interactive elements; copy-only change.

3.3 Both locales updated; no changes to component logic, CSS classes, or registration (copy strings only, `description` primarily; other keys only if needed for the loopback mention).

### Acceptance criteria

- A3.1 zh `description` mentions 覆盖范围要点 + 保存即生效/无需重启 + 本地回环默认直连; en `description` covers the same three points in English.
- A3.2 `systemUnknown` (zh+en) still defers to DSH logs — unchanged semantics.
- A3.3 `npm test` green; no behavior/keys removed from COPY that existing components reference.

---

## Req 4 — Deferred: connection test & host→client status channel (spike only)

### Boundary (hard)

- **No production behavior change.** No connection-test UI, no host→client state messages, no new exports used at runtime by client.js in this round.
- Deliverable is a single document: `docs/status-channel-spike.md`.

### Spike content requirements

4.1 **Connection test design baseline.** Evaluate the settled lean: probe target = **current LLM base URL** (from the active provider route) + a **bare CONNECT handshake** through the candidate proxy, no payload. Document: how to reach the base URL from the host side (pi-ai route registry / settings), how to issue a raw CONNECT via undici dispatcher, what outcomes map to what errors (proxy unreachable, CONNECT refused, TLS ok, auth failure), and latency/timeout budget. Compare against a plain `fetch` HEAD alternative; recommend one.

4.2 **Error taxonomy.** Classify failure modes (direct-unreachable vs proxy-unreachable vs proxy-auth vs target-blocked) with user-facing zh/en message sketches.

4.3 **Status channel options.** Sketch how host-side proxy state could reach client.js (e.g. reusing settings snapshot revision, a dedicated settings namespace key, or an event/slot), with trade-offs and a recommendation — implementation deferred to a later release.

4.4 **Verdict & effort estimate** for pulling each into v0.2.5+.

### Acceptance criteria

- A4.1 `docs/status-channel-spike.md` exists, covers 4.1–4.4 with a concrete recommendation each.
- A4.2 No runtime code paths added for connection testing or status push (verified by diff: only `docs/status-channel-spike.md` from this requirement).

---

## Cross-cutting

- Version bump to `0.2.4` happens in the release-prep task, not here.
- Tests for Req 1 live alongside existing suites; Req 3 verified by existing client tests + manual copy review.
- Commit style: Conventional Commits on `master` (solo repo, no branch protection constraints known beyond default).
