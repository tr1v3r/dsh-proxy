# dsh-proxy — agent notes

`@tr1v3r/dsh-proxy`: runtime-switchable outbound proxy for the DeepSeek
Harness (undici global-dispatcher takeover; HTTP(S) CONNECT / SOCKS5; direct /
system / manual modes). This file records the repo's working conventions for
coding agents; user-facing docs live in `README.md` / `README.zh.md`.

## Development

```sh
npm install
npm test        # unit + local e2e (loopback servers only — no network egress)
```

The real-boot probe needs **DSH >= 0.1.7-rc.1** and an install anchor with
`node_modules`; see the Development section of the READMEs for the
copy-pasteable `DSH_ROOT` scratch-install example (run from the repo root).

## Release process (publishing is GitHub-Action-gated, never manual npm)

```
① version-bump commit   package.json + package-lock.json,
                         README.md / README.zh.md install snippets (^x.y.z)
② squash-merge PR       master, Conventional Commits, title gets (#N) suffix
③ tag                   git tag -a vX.Y.Z -m "…" && git push origin master --tags
④ publish               GitHub → Actions → Publish → Run workflow → tag: vX.Y.Z
                         (human-gated workflow_dispatch; the push of the tag
                          alone publishes NOTHING)
⑤ post-publish          bump the profile dependency and run
                         dsh plugin --profile web install --no-frozen-lockfile
                         in the actual runtime target, then restart the web
                         service and reopen old pages (client bundle is cached
                         at boot)
```

`.github/workflows/publish.yml` uses npm Trusted Publishing (OIDC, no stored
token): it checks out the tag, asserts tag == `package.json` version, runs
`npm ci` + `npm test`, then `npm publish --provenance --access public`.

## Conventions

- **Git identity**: this is a personal repo — commit as `tr1v3r
  <tr1v3r@outlook.com>` (set repo-local if the machine default differs).
- **Commits**: Conventional Commits (`feat:` / `fix:` / `docs:` / `chore:`);
  merge via squash.
- **Docs policy**: the repo stores only project-facing docs (READMEs,
  `docs/assets/*`). Acceptance plans, spike/research reports, and release-note
  drafts are process artifacts and never committed — archive research into the
  relevant issue comment and put release notes in the PR body.
- **Packed-files whitelist**: CI asserts the exact `npm pack` file list
  (see the `pack` job in `.github/workflows/ci.yml`). Adding or removing a
  shipped file requires updating that expected list in the same change.
- **Follow-up tracking**: known deferred work lives in issues (#8 connection
  test & effective-route status, #9 boot-probe preflight, #10 loopback
  NO_PROXY canonicalization) — check them before re-reporting a known gap.
