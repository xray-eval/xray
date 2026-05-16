-- xray store schema. Applied on every `openStore` via `db.exec(schemaSql)` —
-- everything is `IF NOT EXISTS` so reopening is idempotent.
--
-- One `user_version` bump per schema change. There's intentionally no
-- migration framework yet — see ../../../CLAUDE.md and
-- ../../../.claude/rules/single-image-distribution.md: SQLite is the product,
-- not a placeholder, and at this scale a single `schema.sql` file is enough.

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT    PRIMARY KEY,
    -- 'adapter' (REST-polled from a provider) or 'ingest' (POSTed by a custom loop).
    source       TEXT    NOT NULL CHECK (source IN ('adapter', 'ingest')),
    -- ProviderId when source='adapter'; NULL when source='ingest'.
    provider     TEXT,
    agent_id     TEXT    NOT NULL,
    started_at   TEXT    NOT NULL,
    ended_at     TEXT,
    duration_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

CREATE TABLE IF NOT EXISTS turns (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Ordinal position within the session (0-based). UNIQUE so repeat appends
    -- with the same idx are caught by the DB, not by application code.
    idx             INTEGER NOT NULL,
    role            TEXT    NOT NULL CHECK (role IN ('user', 'agent', 'tool', 'system')),
    text            TEXT    NOT NULL,
    ts              TEXT    NOT NULL,
    active_node_id  TEXT,
    edge_fired_id   TEXT,
    edge_reasoning  TEXT,
    prompt_seen     TEXT,
    llm_latency_ms  INTEGER,
    UNIQUE(session_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_turns_session_idx ON turns(session_id, idx);

CREATE TABLE IF NOT EXISTS tool_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id      TEXT    NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    idx          INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    args_json    TEXT    NOT NULL,
    result_json  TEXT,
    latency_ms   INTEGER,
    UNIQUE(turn_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_idx ON tool_calls(turn_id, idx);

PRAGMA user_version = 1;
