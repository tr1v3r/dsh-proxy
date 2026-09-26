# v0.2.4 (draft release notes)

Loopback traffic stays direct by default, docs tell the truth about
credentials and switch semantics, and the Web UI copy explains what the
setting actually controls. Prepared from discussion
[deepseek-ai/deepseek-harness#5877](https://github.com/deepseek-ai/deepseek-harness/discussions/5877).

## Features

- **Loopback is direct by default.** Requests to `localhost`, `127.0.0.0/8`,
  `::1` (including `[::1]` and the trailing-dot form `localhost.`), and
  `0.0.0.0` bypass the proxy in both `manual` and `system` modes, even with
  an empty `noProxy` list. New `bypassLoopback` config (default `true`) turns
  this off. Exported `NO_PROXY` merges the user rules with the loopback
  default set, deduplicated; with `bypassLoopback: false` env export keeps
  the old behavior.
- **UI copy** (Web Settings → General → Network proxy, zh + en): the row hint
  now states the coverage scope (in-process requests; child processes via
  exported env), that loopback stays direct by default, and that saves apply
  immediately with no restart. The `system` tooltip continues to defer to DSH
  logs — no live-status claim.

## Documentation

- New bilingual **Credential security** section: `user:pass@` in proxy URLs
  is stored in plaintext (profile `cordis.patch.yml` / settings) and, with
  `exportEnv: true` (default), propagates into child-process env vars
  readable by the same user (privileged users may read them too, platform
  dependent). Recommends a local unauthenticated proxy entry for sensitive
  credentials.
- **Switch semantics** stated honestly: in-flight requests get a 30-second
  grace period (`RETIRE_DESTROY_MS`) after a switch; longer streaming
  responses are interrupted.
- Coverage table notes the loopback-direct default; YAML examples list
  `bypassLoopback`.
- Dev section documents the boot-probe DSH ≥ 0.1.7-rc.1 requirement with a
  copy-pasteable `DSH_ROOT` scratch-install example (verified verbatim).

## Spike (no runtime change)

- `docs/status-channel-spike.md`: connection-test design (LLM base URL +
  bare CONNECT probe) and host→client status channel options with a
  recommendation — deferred to a later release.

## Compatibility

- `mode`/`enabled` semantics unchanged; `bypassLoopback` defaults to `true`
  (loopback previously proxied unless hand-listed in `noProxy`). npm test
  40/40; real-DSH boot probe 14/14 (DSH 0.1.7-rc.1).
