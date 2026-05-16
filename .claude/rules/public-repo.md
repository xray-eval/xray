# Public repo — build-in-public stance

This repo is open source. Every push lands on a public surface that is scraped within seconds by GitHub secret scanners, mirroring forks, and bots. The threat model is *not* "an internal team will spot the mistake in code review" — it's "the blob is gone the moment you press enter."

Three concrete failures keep recurring on public repos. The rules below exist because the correct response in each case is non-obvious.

---

## 1 · A leaked secret must be **rotated**, not rewritten

If a secret (API key, token, `.env` line) lands in a commit and is pushed:

1. **Rotate the credential immediately** in the issuing system (provider dashboard / cloud console). This is the only step that actually restores security.
2. Then remove it from the working tree and commit the removal.
3. **Do not** `git rebase -i … drop`, `git filter-repo`, or force-push to "hide" it.

**Why.** Once pushed, GitHub retains the dangling commit blob — reachable by SHA via `https://github.com/<owner>/<repo>/commit/<sha>` and via `git cat-file` even after rewrite. Forks, clones, scraping bots, and search-engine caches captured it in the first seconds. Rewriting history makes the leak *invisible to the repo owner* while leaving it fully exploitable. Rotation is the only fix; the rewrite is a comforting placebo.

The one exception: if the rewrite happens *before* the push, force a clean state and re-push. The bar is "did anyone outside this machine see it yet."

## 2 · Secrets are runtime-only in Docker — never build-time

In any `Dockerfile`, `compose.yaml`, or build script:

- **Never** `ARG SECRET=…` or `ARG API_KEY` (values persist in image layer history, visible via `docker history --no-trunc`).
- **Never** `ENV API_KEY=…` baked into an image (same: visible in `inspect`/`history` for anyone who pulls the image).
- **Never** `COPY .env …` or any path that pulls a real secret into a layer.
- Secrets enter only at `docker run` time via `-e VAR=…`, `--env-file`, or the orchestrator's secret mount. The operator owns them; the image does not.

For local dev, `.env` files stay on the host and are passed via `env_file:` in `compose.yaml`. The file itself is in `.gitignore` and **never** in any `COPY` instruction.

**Why.** Image layers are content-addressed and shipped to whoever pulls the image. A secret baked into a layer ships with every `docker pull`. `--squash` and multi-stage builds do *not* erase ARG history from intermediate layers. The only reliable separation is: image carries code, runtime carries secrets.

## 3 · No secrets or sensitive info in commit messages or PR metadata

Treat `git log`, commit messages, PR titles, PR descriptions, and issue bodies as **append-only public record**. Once pushed:

- A history rewrite does not scrub PR metadata. GitHub keeps PR titles/descriptions/comments even after force-push.
- The GitHub Events API surfaces commit messages publicly within seconds.
- Issue/PR text is indexed by search engines and AI training scrapers within hours.

So: no API keys, no internal hostnames, no customer names, no exploit details in any commit message, PR body, or issue body — even on a private branch, because branches get pushed and PRs get opened.

If something sensitive is needed to explain a change, link to a private doc (Notion, Linear) rather than paste it.

**Why.** The leak vector here is wider than the code itself: commit metadata is plain text in dozens of mirrors (gh archive, GHTorrent, every fork, every cached PR view) that no amount of rewriting reaches.

---

## 4 · Leaked-key detection — defense in depth, ordered by leverage

A leaked credential is stopped at whichever layer catches it first. **The layers are not equivalent — earlier layers prevent the leak; later layers can only mitigate.** Add them in order; do not skip an earlier one because a later one exists.

| Layer | What it catches | When it runs | Stops the leak? |
|---|---|---|---|
| Pre-commit hook (`gitleaks`) | Anything matching gitleaks patterns | Locally, before `git commit` | Yes — file never enters history |
| GitHub Push Protection | ~200 known provider token formats | Server-side, at `git push` | Yes — push is rejected, blob never lands |
| CI `secret-scan` on PR | Anything matching gitleaks patterns in a PR diff | After push, before merge | No — blob is public; only blocks merge |
| GitHub Secret Scanning | ~200 known formats | After push, alerts repo owner | No — alert + provider notification (some auto-revoke) |

**Push Protection** (free, automatic on public repos once enabled in repo settings → Code security → Push protection) is the load-bearing control. It runs server-side at the git protocol level and rejects the push. **Verify Push Protection is enabled the moment the repo is published on GitHub.** Without it, the rest is mitigation, not prevention.

The CI `secret-scan` job exists because Push Protection cannot enforce on **PRs from forks** — outside contributors push to their own fork (which we don't admin), and the PR diff lands in our CI before merge. CI gitleaks is the only layer that catches a fork-PR-introduced secret before we'd accept it.

**Why a CI job is NOT sufficient on its own.** A CI scan runs *after* the push. By the time it flags the secret, the blob is reachable by SHA from forks, mirrors, and the GitHub Events API. The §1 rule still applies: rotate, do not rewrite. A CI scan is a merge gate, not a leak prevention mechanism. Treat it as one.

---

## What's NOT a rule here

- "Keep the Hono proxy small and auditable" — design preference, lives in the README's security section, not here.
- "Always squash-merge PRs" — preference.
- "Sign commits with GPG" — would belong here once enforced by branch protection; until then, preference.
