## What

<!-- One paragraph. What changed in this PR. -->

## Why

<!-- The motivation. Link to the issue, Notion doc, or user report. -->

## How to verify

- [ ] `pnpm typecheck` passes
- [ ] `pnpm check` passes
- [ ] `pnpm docker:smoke` passes locally (build → run → /healthz → kill)
- [ ] If a new dep was added: §3 of `.claude/rules/supply-chain.md` was followed (need · provenance · install scripts audited)
- [ ] If a new GitHub Action was added: pinned to a 40-char commit SHA with the tag in a trailing comment

## Notes

<!-- Anything reviewers should know. Do NOT paste secrets, internal hostnames,
     customer names, or exploit details here — PR metadata is public and stays
     in GitHub indefinitely. See .claude/rules/public-repo.md §3. -->
