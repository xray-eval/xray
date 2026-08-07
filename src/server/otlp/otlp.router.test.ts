import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as v from "valibot";

import { readJson } from "@/server/core/test-utils.ts";
import {
	createReplayForTest,
	makeCreateReplayRequest,
} from "@/server/replays/replays.test-utils.ts";
import { spans } from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createOtlpRouter } from "./otlp.router.ts";
import { makeOtlpRequest } from "./otlp.test-utils.ts";
import { MAX_OTLP_BODY_BYTES, MAX_SPANS_PER_REQUEST } from "./otlp.types.ts";
import { describe, expect, it } from "bun:test";

async function makeApp() {
	const store = makeTempStore();
	const replay = await createReplayForTest(store, makeCreateReplayRequest());
	const app = new Hono().route("/v1", createOtlpRouter(store));
	return { app, store, replayId: replay.id };
}

/**
 * Minimal protobuf writers, mirroring `protobuf-decode.test.ts`: a stock
 * OTEL exporter defaults to `application/x-protobuf`, so the router's
 * protobuf branch has to be driven with the same wire bytes it would
 * receive rather than through a proto library the decoder never sees.
 */
const utf8 = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

function writeVarint(value: bigint): Uint8Array<ArrayBuffer> {
	const bytes: number[] = [];
	let rest = value & ((1n << 64n) - 1n);
	while (rest > 0x7fn) {
		bytes.push(Number((rest & 0x7fn) | 0x80n));
		rest >>= 7n;
	}
	bytes.push(Number(rest));
	return Uint8Array.from(bytes);
}

function tag(fieldNumber: number, wireType: number): Uint8Array {
	return writeVarint(BigInt((fieldNumber << 3) | wireType));
}

/** Length-delimited (wire type 2) field: tag + varint length + payload. */
function lenField(fieldNumber: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
	return concat(tag(fieldNumber, 2), writeVarint(BigInt(payload.length)), payload);
}

/** Fixed64 (wire type 1) field, little-endian — Span.start/end_time_unix_nano. */
function fixed64Field(fieldNumber: number, value: bigint): Uint8Array {
	const buf = new Uint8Array(8);
	new DataView(buf.buffer).setBigUint64(0, value, true);
	return concat(tag(fieldNumber, 1), buf);
}

function anyValueString(value: string): Uint8Array {
	return lenField(1, utf8.encode(value));
}

function keyValue(key: string, anyValue: Uint8Array): Uint8Array {
	return concat(lenField(1, utf8.encode(key)), lenField(2, anyValue));
}

interface ProtoSpanOptions {
	name: string;
	traceId: Uint8Array;
	spanId: Uint8Array;
	startUnixNano: bigint;
	endUnixNano: bigint;
	attributes: Uint8Array[];
}

function protoSpan(o: ProtoSpanOptions): Uint8Array {
	return concat(
		lenField(1, o.traceId),
		lenField(2, o.spanId),
		lenField(5, utf8.encode(o.name)),
		fixed64Field(7, o.startUnixNano),
		fixed64Field(8, o.endUnixNano),
		...o.attributes.map((a) => lenField(9, a)),
	);
}

/** ExportTraceServiceRequest → ResourceSpans{Resource, ScopeSpans{Span…}}. */
function protoExportRequest(
	resourceAttrs: Uint8Array[],
	spanBodies: Uint8Array[],
): Uint8Array<ArrayBuffer> {
	const resource = concat(...resourceAttrs.map((a) => lenField(1, a)));
	const scopeSpans = concat(...spanBodies.map((s) => lenField(2, s)));
	const resourceSpans = concat(lenField(1, resource), lenField(2, scopeSpans));
	return lenField(1, resourceSpans);
}

function protobufTurnRequest(replayId: string): Uint8Array<ArrayBuffer> {
	return protoExportRequest(
		[keyValue("xray.replay.id", anyValueString(replayId))],
		[
			protoSpan({
				name: "xray.turn",
				traceId: new Uint8Array(16).fill(0xab),
				spanId: new Uint8Array(8).fill(0xcd),
				startUnixNano: 1_747_584_000_000_000_000n,
				endUnixNano: 1_747_584_000_500_000_000n,
				attributes: [keyValue("xray.turn.role", anyValueString("agent"))],
			}),
		],
	);
}

describe("POST /v1/otlp/v1/traces", () => {
	it("returns 200 + partialSuccess body on a valid OTLP/JSON request", async () => {
		const { app, replayId } = await makeApp();
		const body = makeOtlpRequest({
			replayId,
			spans: [
				{
					name: "xray.turn",
					attributes: {
						"xray.turn.idx": 0,
						"xray.turn.role": "agent",
					},
				},
			],
		});
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(200);
		const json = await readJson(
			res,
			v.object({
				partialSuccess: v.optional(v.object({ rejectedSpans: v.optional(v.number()) })),
			}),
		);
		expect(json.partialSuccess?.rejectedSpans).toBe(0);
	});

	it("returns 200 and persists the span for an OTLP/Protobuf body", async () => {
		const { app, store, replayId } = await makeApp();
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: protobufTurnRequest(replayId),
		});
		expect(res.status).toBe(200);
		const json = await readJson(
			res,
			v.object({
				partialSuccess: v.optional(v.object({ rejectedSpans: v.optional(v.number()) })),
			}),
		);
		expect(json.partialSuccess?.rejectedSpans).toBe(0);

		const rows = store.db.select().from(spans).where(eq(spans.replayId, replayId)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("xray.turn");
		expect(rows[0]?.vocabulary).toBe("xray");
		// Decoded from the wire, not echoed: trace/span ids come back hex.
		expect(rows[0]?.traceId).toBe("ab".repeat(16));
		expect(rows[0]?.spanId).toBe("cd".repeat(8));
	});

	it("accepts an OTLP/Protobuf content-type carrying parameters", async () => {
		const { app, replayId } = await makeApp();
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf; charset=utf-8" },
			body: protobufTurnRequest(replayId),
		});
		expect(res.status).toBe(200);
	});

	it("returns 400 with unsupported_wire_type shape when the protobuf body uses wire type 3", async () => {
		const { app } = await makeApp();
		// Field 99, wire type 3 (group start) — never emitted by OTLP and
		// unsupported by the skipper, so the decoder throws a typed
		// UnsupportedWireTypeError the router must pass through unwrapped.
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: writeVarint(BigInt((99 << 3) | 3)),
		});
		expect(res.status).toBe(400);
		const json = await readJson(
			res,
			v.object({ error: v.literal("unsupported_wire_type"), wire_type: v.number() }),
		);
		expect(json.wire_type).toBe(3);
	});

	it("returns 400 with protobuf_nesting_too_deep shape past the AnyValue depth cap", async () => {
		const { app, store, replayId } = await makeApp();
		// AnyValue.array_value = field 5; ArrayValue.values = field 1.
		let nested = anyValueString("leaf");
		for (let i = 0; i < 100; i++) nested = lenField(5, lenField(1, nested));
		const body = protoExportRequest([keyValue("deep", nested)], []);
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body,
		});
		expect(res.status).toBe(400);
		const json = await readJson(
			res,
			v.object({ error: v.literal("protobuf_nesting_too_deep"), max_depth: v.number() }),
		);
		expect(json.max_depth).toBe(32);
		// A body that fails to decode persists nothing.
		expect(store.db.select().from(spans).where(eq(spans.replayId, replayId)).all()).toEqual([]);
	});

	it("returns 500 for a failure that isn't an OtlpError", async () => {
		const { app, store, replayId } = await makeApp();
		// Closing the store makes the ingest transaction throw a raw
		// bun:sqlite error — the generic `P.instanceOf(Error)` arm, not
		// any of the typed OTLP mappings above it.
		store.close();
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeOtlpRequest({ replayId, spans: [{ name: "xray.turn" }] })),
		});
		expect(res.status).toBe(500);
		await readJson(res, v.object({ error: v.literal("internal_error") }));
	});

	it("returns 415 for an unsupported content-type", async () => {
		const { app, replayId } = await makeApp();
		const body = makeOtlpRequest({ replayId, spans: [{ name: "xray.turn" }] });
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(415);
	});

	it("returns 400 for unparseable JSON body", async () => {
		const { app } = await makeApp();
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(res.status).toBe(400);
	});

	it("returns 413 with body_too_large shape when the body exceeds MAX_OTLP_BODY_BYTES", async () => {
		const { app } = await makeApp();
		const oversize = "x".repeat(MAX_OTLP_BODY_BYTES + 1);
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": String(oversize.length) },
			body: oversize,
		});
		expect(res.status).toBe(413);
		const json = await readJson(
			res,
			v.object({ error: v.literal("body_too_large"), max_bytes: v.number() }),
		);
		expect(json.max_bytes).toBe(MAX_OTLP_BODY_BYTES);
	});

	it("returns 400 with too_many_spans_per_request shape when > MAX_SPANS_PER_REQUEST spans are sent", async () => {
		const { app, replayId } = await makeApp();
		const overCap = Array.from({ length: MAX_SPANS_PER_REQUEST + 1 }, (_, i) => ({
			name: "xray.turn",
			attributes: {
				"xray.turn.idx": i,
				"xray.turn.role": "agent",
			},
		}));
		const body = makeOtlpRequest({ replayId, spans: overCap });
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(400);
		const json = await readJson(
			res,
			v.object({
				error: v.literal("too_many_spans_per_request"),
				max_spans: v.number(),
				received: v.number(),
			}),
		);
		expect(json.max_spans).toBe(MAX_SPANS_PER_REQUEST);
		expect(json.received).toBe(MAX_SPANS_PER_REQUEST + 1);
	});
});
