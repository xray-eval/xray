# Supply-chain stance

**Threat model.** Following Shai-Hulud (Sep 2025), Shai-Hulud 2.0 (Nov 2025), and Mini Shai-Hulud (May 2026), treat npm as an actively hostile registry. Most malicious releases are caught within 24h. Our defaults assume any package published in the last 7 days could be compromised.

The repo enforces this in four places — local config, CI, dependency-add discipline, and Action pinning. **Do not relax any of these without a written justification in the commit message.**

---

## 1 · Local config

### `package.json`
- `"packageManager": "pnpm@11.1.2"` (or newer 11.x) — pinned, activated via `corepack enable`.
- `"engines": { "node": ">=24.0.0", "pnpm": ">=11.0.0" }` — bump to whichever LTS line `.nvmrc` pins.
- `"private": true` until publishing is intentional.
- `preinstall` runs `npx -y only-allow pnpm` — rejects `npm`/`yarn`/`bun install`.

### `pnpm-workspace.yaml` — non-negotiable values
| Setting | Value | Why |
|---|---|---|
| `minimumReleaseAge` | `10080` (7 days) | Stricter than v11 default of 1d. Most malicious releases caught within 24h; 7d is cheap insurance. |
| `minimumReleaseAgeStrict` | `true` | Fail loudly when a target is too new — never silently downgrade to an older version. |
| `allowBuilds` | `{}` (deny-by-default) | Lifecycle scripts blocked unless explicitly allowlisted with a justification comment. |
| `strictDepBuilds` | `true` | Pin the v11 default so future config drift can't disable it. |
| `blockExoticSubdeps` | `true` | No transitive deps from git URLs or raw tarballs. |
| `trustPolicy` | `no-downgrade` | Reject a release whose publish-time trust dropped (e.g. lost 2FA) vs. the prior one. |
| `verifyDepsBeforeRun` | `install` | Re-verify `node_modules` matches the lockfile before any script runs. |

### `.npmrc`
- `registry=https://registry.npmjs.org/` — alternate registries must be added per-scope here, explicitly.
- `engine-strict=true` — wrong Node/pnpm version fails install.
- `ignore-scripts=true` — belt-and-braces over `allowBuilds`.
- `provenance=true` — Sigstore attestation on anything we publish.
- `audit-level=moderate`.
- **Never** add `//registry.npmjs.org/:_authToken=…` here. Tokens live in CI secrets, never on disk.

---

## 2 · CI — `.github/workflows/supply-chain.yml`

Runs on every PR and every push to `main`. The job is the enforcement arm of section 1: section 1 is the policy, this job verifies the committed lockfile obeys it.

Steps, in order:
1. `step-security/harden-runner` — egress monitoring (audit mode now, flip to `block` once stable).
2. `actions/checkout` with `persist-credentials: false`.
3. `actions/setup-node` + `corepack prepare --activate` → pinned pnpm.
4. `pnpm install --frozen-lockfile` — fails on lockfile drift AND applies every setting in `pnpm-workspace.yaml`. The single most important step.
5. `pnpm audit --audit-level=moderate`.
6. Lockfile grep — rejects `resolution: { tarball | repo | directory: … }` and any non-`registry.npmjs.org` registry.
7. `actions/dependency-review-action` (PR only) — fails on new moderate+ vuln deps and disallowed licenses; comments on PR.

Workflow-level invariants:
- `permissions: {}` at root; each job re-grants the minimum.
- `concurrency` cancels superseded runs (stale PR can't quietly pass on old code).
- `timeout-minutes` set on every job.
- **No** `workflow_dispatch` / `repository_dispatch` triggers without a written reason.
- **No** `continue-on-error`, `if: github.actor == …` skips, or `[skip ci]` workarounds. A failing supply-chain check is fixed, never bypassed.
- Branch protection MUST require the `Supply-chain audit` check before merge (configure once repo is on GitHub).

---

## 3 · Adding a dependency

Before `pnpm add <pkg>`:
1. **Do we need it?** Every dep is attack surface. Prefer stdlib / existing utilities.
2. **Maintainer plausibility.** Real GitHub repo linked from npm page? Weekly downloads vs. package age plausible?
3. **Provenance.** `npm view <pkg> --json | jq .dist.attestations` — provenance attestation present?
4. **Install scripts.** `npm view <pkg> scripts` — any `preinstall` / `install` / `postinstall`? If yes, the package needs an `allowBuilds` entry with a justification comment, after auditing the script.
5. **Run** `pnpm add <pkg>`. If it fails the 7-day cooldown, **do not** bypass with `minimumReleaseAgeExclude` unless this is a CVE-driven urgent patch documented in the commit message.

### Allowing a build script

```yaml
allowBuilds:
  esbuild: true   # native binary download, audited 2026-05-16 — sha256 verified against release
```

Always include date + reason. Never add a package to `allowBuilds` "to make install work" without auditing the script.

---

## 4 · GitHub Action pinning

**Every `uses:` MUST reference a 40-char commit SHA**, with the tag in a trailing comment. Tags can be re-pointed by a compromised maintainer; SHAs cannot.

**Runtimes are pinned to a specific patch version**, never a floating major. `node-version: '24'` resolves to whichever 24.x patch the runner happens to have today — a perfect dependency-injection vector if any 24.x build is ever compromised. Pin via `.nvmrc` / `.tool-versions` (single source of truth that local dev and CI both read). Same rule for Bun and pnpm — the pinned version lives in `.tool-versions`, `package.json#packageManager`, and the Dockerfile, never on a floating tag. Docker base images are pinned by **manifest digest** (`FROM node@sha256:…`) with the human-readable tag in a trailing comment, same pattern as GitHub Actions.

To upgrade:
```bash
gh api repos/<owner>/<repo>/releases/latest --jq '.tag_name'
gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'
# If .object.type == "tag" (annotated), resolve one more hop:
gh api repos/<owner>/<repo>/git/tags/<sha> --jq '.object.sha'
```

Bulk upgrades: `pnpm dlx pin-github-action` or Renovate's `helpers:pinGitHubActionDigests` preset.

---

## 5 · Tokens & secrets

- No `NPM_TOKEN` on developer machines. Publishing is CI-only with short-lived OIDC tokens.
- A `_authToken=…` line in any `.npmrc` is a bug — remove and rotate the token.

---

## 6 · Python deps (examples + SDK image deps)

`pnpm-workspace.yaml#minimumReleaseAge` only covers npm. PyPI carries the same Shai-Hulud-class threat surface but has no equivalent registry-side cooldown, and `pip install` inside a Docker layer resolves whatever PyPI serves at build time. Treat PyPI as actively hostile too.

Until a hash-pinned `requirements.txt` (via `uv pip compile --generate-hashes`) is wired into CI, every PyPI dependency referenced from a `Dockerfile` or `pyproject.toml` in this repo MUST be:

- **Exact-pinned** — `livekit-agents==1.5.9`, never `livekit-agents>=1.5,<2`. Ranges resolve at build time and re-introduce the cooldown gap.
- **Manually cooldown-checked** at the time of pinning — only pin a version whose PyPI upload date is at least 7 days before today. The same rationale as `minimumReleaseAge=10080`.
- **Audited as a pair** — the same exact pins appear in both the `pyproject.toml` and the `Dockerfile` of the slice. The Dockerfile is what actually runs in CI/prod; the `pyproject.toml` is what local dev resolves. Drift between them means one of the two is unaudited.

When bumping a Python pin, re-run the cooldown check against PyPI's JSON API (`https://pypi.org/pypi/<pkg>/json` → `releases[v][0].upload_time`) and update both files in one commit.

This is a stricter posture than what `pip` enforces by default — there's no `--require-cooldown` flag. The rule is the audit; CI doesn't catch a regression here yet. Adding a CI check that greps `requires-python` / `pip install` lines for `>=` / `<` /  `~=` is a tractable follow-up.

---

## What's not yet covered

- **GHCR publish workflow.** Target registry is `ghcr.io/xray-eval/xray`. Add `publish.yml` triggered on tag push: build the multi-stage Dockerfile, push to GHCR using the workflow's `GITHUB_TOKEN` (no static PAT), sign with cosign keyless (OIDC, no static cosign key), attach build-provenance attestation via `actions/attest-build-provenance`, optionally an SBOM via `actions/attest-sbom`. Pin every action to a SHA per section 4.
- **npm publish workflow** with OIDC + `--provenance` — only if/when this repo starts publishing JS packages (not currently planned).
- **Renovate / Dependabot cooldown** mirroring `minimumReleaseAge` — add `renovate.json5` with `minimumReleaseAge: "7 days"` when bots are enabled.
