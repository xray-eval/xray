# Single-image distribution — SQLite is load-bearing, not a placeholder

**xray ships as one Docker image with one process and one mounted volume.** That is the product. The storage choice — SQLite via `bun:sqlite`, single file at `/data/xray.db` — is the artifact of that constraint, not a convenient default until a "real database" arrives.

The failure mode this prevents: future Claude reaches for Postgres / Redis / a managed cloud DB "for production safety" or "because SQLite isn't serious," reviews look reasonable in isolation, and the single-image promise quietly dies — `docker run` is no longer the install instruction; a second container appears in `compose.yaml`; an external service is on the critical path; the supply-chain audit gets a new dependency; the self-host story becomes "...and stand up a Postgres."

---

## 1 · Why SQLite is the right fit, not a compromise

The workload, in concrete numbers:

- **One writer.** A single Bun process owns the database. No write fan-in from multiple machines, no contended-write scenarios.
- **Local I/O.** The DB file lives on a volume mounted into the same container that writes to it. No network round-trip, no driver, no connection pool.
- **Modest data.** Voice-agent conversations are minutes long, tens to hundreds of events each, text + small JSON payloads. Tens of thousands of sessions fits comfortably in a single SQLite file; queries on indexed columns are sub-millisecond.
- **Embedded reads.** The UI reads through the same Bun process via `bun:sqlite` — no separate query service, no ORM round-trip across a wire.

`bun:sqlite` is in the Bun standard library. That means **zero added supply-chain surface for the database driver** — no `pg`, no `better-sqlite3` (with its native build step), no `mysql2`. The 7-day cooldown in `.claude/rules/supply-chain.md` does not apply to a thing we don't depend on.

SQLite is the most-deployed database engine in the world. It is the default storage for several large production systems (Expensify's primary OLTP, Tailscale's coordination database, Cloudflare D1, every iOS / Android app you've ever shipped). "SQLite isn't for prod" is not a fact; it's a vibe.

---

## 2 · The hidden cost of "Postgres for safety"

Each of these is a real cost, none of which the proposer usually accounts for:

| Cost | What happens |
|---|---|
| **Distribution model** | `docker run ghcr.io/basilebong/xray` no longer works alone. README grows a "first set up a Postgres" section. The install funnel collapses. |
| **Operator burden** | The self-host story now requires DB provisioning, schema migrations, backup of a separate system, credentials handed to xray. |
| **Supply chain** | A driver package (`pg`, `mysql2`, equivalent) gets pulled in — subject to the 7-day cooldown, version pins, audit. The driver was nominally for "safety" and is itself an attack surface. |
| **Migrations** | A second tool (Prisma, Drizzle, raw SQL files + a runner) is now in the repo. SQLite migrations are usually a single `ALTER` in code at startup; Postgres migrations need orchestration. |
| **Local dev** | `pnpm dev` now needs a Postgres running. The "one command" rule in CLAUDE.md breaks. |
| **CI** | Smoke tests need a Postgres service container. The supply-chain workflow now has a network-dependent step. |

None of these costs buy anything xray actually needs. xray is single-tenant, single-writer, self-hosted. The properties Postgres pays for — multi-machine fan-in, transactional replication, large concurrent read/write — are not in the workload.

---

## 3 · When SQLite would genuinely be wrong

For completeness — none of these apply to xray, but if they ever do, this rule is the thing to revisit:

- **Multi-tenant SaaS** with one xray instance serving many isolated customers writing concurrently. xray is self-hosted; each operator runs their own instance. Not in scope.
- **Multi-machine write fan-in.** If conversation events arrive at multiple replicas of xray simultaneously and must be merged transactionally. Single-image distribution makes this impossible by construction.
- **Native multi-master replication** required for high-availability writes. Not a stated product property; high availability for a debugging tool is overkill.

If any of those become true, the right reaction is **a product-level decision** ("xray is now a hosted multi-tenant service"), not a technical migration. The storage choice and the distribution model are coupled — you do not change one without changing the other.

---

## 4 · How to apply

- **Never propose a network database** (Postgres, MySQL, Redis, anything in a separate process) without first surfacing the distribution-model implication: *"this would mean xray no longer ships as a single image — is that the intent?"* The answer is almost always no.
- **Never propose a "real DB later" placeholder.** SQLite is not a placeholder. Code that writes "// TODO: swap for Postgres" is wrong and should be deleted.
- **The chosen ORM is Drizzle, pinned to its SQLite-only adapter** (`drizzle-orm/bun-sqlite`). Schema lives in TypeScript (`src/server/store/schema.ts`); migrations are generated by `drizzle-kit generate` and committed as SQL files under `src/server/store/migrations/`. Reasons it's allowed where the rule previously banned ORMs: it has zero runtime deps, the SQLite adapter is a separate import path (so we can't accidentally pick up the Postgres/MySQL drivers), and `drizzle-kit` solves the schema-migration gap that hand-rolled `bun:sqlite` doesn't. **What's still banned**: importing any non-SQLite Drizzle dialect (`drizzle-orm/postgres-js`, `drizzle-orm/mysql2`, etc.), and any other engine-abstracting ORM (Prisma, TypeORM, Sequelize, MikroORM). A PR that adds one of those imports is a smoke signal — same severity as adding `DATABASE_URL`.
- **If you genuinely outgrow SQLite,** that is a product-strategy conversation in an issue, not a refactor a Claude session decides on its own.
- **Cross-reference this rule** whenever a PR adds a service container to `compose.yaml`, a non-SQLite DB driver to `package.json`, or a `DATABASE_URL` environment variable. Any of those three is the smoke signal.

---

## What's NOT a rule here

- "Use `bun:sqlite` specifically" — choice of bindings is a sub-decision; if a better embedded SQLite binding for Bun ships, swap it. The rule is the *property* (embedded, single-file, no separate process), not the package name.
- "Never use any other storage system for any purpose ever" — caches in memory are fine; a future feature might legitimately use an embedded vector store. The rule is specifically about **conversation storage** and **the distribution model**.
- "SQLite is always the right answer everywhere" — it isn't. This rule is about xray's workload, not a universal claim.
