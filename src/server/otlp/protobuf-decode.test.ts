import { OtlpProtobufNestingTooDeepError, UnsupportedWireTypeError } from "./otlp.errors.ts";
import { decodeExportTraceServiceRequest } from "./protobuf-decode.ts";
import { describe, expect, it } from "bun:test";

/**
 * Tiny protobuf wire encoders — just enough to build a payload with
 * the exact attribute shape each test needs. We intentionally do NOT
 * pull in a real proto library: the decoder under test is hand-rolled,
 * so the test should exercise the same wire bytes a real exporter
 * would emit, not the same library it would emit them through.
 */

function tag(fieldNumber: number, wireType: number): Uint8Array {
	return writeVarint(BigInt((fieldNumber << 3) | wireType));
}

function writeVarint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let v = value & ((1n << 64n) - 1n);
	while (v > 0x7fn) {
		bytes.push(Number((v & 0x7fn) | 0x80n));
		v >>= 7n;
	}
	bytes.push(Number(v));
	return new Uint8Array(bytes);
}

function writeLengthDelimited(payload: Uint8Array): Uint8Array {
	const len = writeVarint(BigInt(payload.length));
	const out = new Uint8Array(len.length + payload.length);
	out.set(len, 0);
	out.set(payload, len.length);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** Build the bytes of an OTLP AnyValue with field 3 (intValue) holding `value`. */
function anyValueInt(value: bigint): Uint8Array {
	// AnyValue.int_value = field 3, wire type 0 (varint)
	return concat(tag(3, 0), writeVarint(value & ((1n << 64n) - 1n)));
}

/** Build an AnyValue { arrayValue: { values: [inner] } }. */
function anyValueArrayWrapping(inner: Uint8Array): Uint8Array {
	// AnyValue.array_value = field 5, wire type 2 (length-delimited)
	// ArrayValue.values   = field 1, wire type 2 (length-delimited AnyValue)
	const arrayValue = concat(tag(1, 2), writeLengthDelimited(inner));
	return concat(tag(5, 2), writeLengthDelimited(arrayValue));
}

/** Build a KeyValue { key, value }. */
function keyValue(key: string, valuePayload: Uint8Array): Uint8Array {
	const keyBytes = new TextEncoder().encode(key);
	return concat(
		tag(1, 2),
		writeLengthDelimited(keyBytes),
		tag(2, 2),
		writeLengthDelimited(valuePayload),
	);
}

/**
 * Wrap a top-level attribute in the minimum nesting needed to reach
 * the decoder: ResourceSpans → Resource → attribute (key, value).
 *
 * ExportTraceServiceRequest.resource_spans = field 1 (length-delim)
 * ResourceSpans.resource                   = field 1 (length-delim)
 * Resource.attributes                      = field 1 (length-delim KeyValue)
 */
function wrapAsTopLevelAttribute(kv: Uint8Array): Uint8Array {
	const resource = concat(tag(1, 2), writeLengthDelimited(kv));
	const resourceSpans = concat(tag(1, 2), writeLengthDelimited(resource));
	return concat(tag(1, 2), writeLengthDelimited(resourceSpans));
}

describe("decodeExportTraceServiceRequest — int64 attribute values", () => {
	it("decodes intValue = -1 as the string '-1' (10-byte two's-complement varint)", () => {
		const body = wrapAsTopLevelAttribute(keyValue("k", anyValueInt(-1n)));
		const decoded = decodeExportTraceServiceRequest(body);
		const attr = decoded.resourceSpans?.[0]?.resource?.attributes?.[0];
		expect(attr?.key).toBe("k");
		expect(attr?.value).toEqual({ intValue: "-1" });
	});

	it("decodes intValue past 2^53 without losing precision", () => {
		const big = 9007199254740993n; // 2^53 + 1 — first int that loses precision via JS number
		const body = wrapAsTopLevelAttribute(keyValue("k", anyValueInt(big)));
		const decoded = decodeExportTraceServiceRequest(body);
		const attr = decoded.resourceSpans?.[0]?.resource?.attributes?.[0];
		expect(attr?.value).toEqual({ intValue: "9007199254740993" });
	});

	it("decodes intValue near int64 min/max boundaries", () => {
		const minInt64 = -(1n << 63n);
		const maxInt64 = (1n << 63n) - 1n;
		const bodyMin = wrapAsTopLevelAttribute(keyValue("k", anyValueInt(minInt64)));
		const bodyMax = wrapAsTopLevelAttribute(keyValue("k", anyValueInt(maxInt64)));
		const decMin = decodeExportTraceServiceRequest(bodyMin);
		const decMax = decodeExportTraceServiceRequest(bodyMax);
		expect(decMin.resourceSpans?.[0]?.resource?.attributes?.[0]?.value).toEqual({
			intValue: "-9223372036854775808",
		});
		expect(decMax.resourceSpans?.[0]?.resource?.attributes?.[0]?.value).toEqual({
			intValue: "9223372036854775807",
		});
	});
});

describe("decodeExportTraceServiceRequest — nested AnyValue depth cap", () => {
	function nestedArrayValue(depth: number): Uint8Array {
		// stringValue payload at the leaf so the recursion has a base case.
		let inner = concat(tag(1, 2), writeLengthDelimited(new TextEncoder().encode("leaf")));
		for (let i = 0; i < depth; i++) {
			inner = anyValueArrayWrapping(inner);
		}
		return inner;
	}

	it("accepts a depth comfortably below the cap (30 nested arrays)", () => {
		// Each iteration adds one AnyValue layer; combined with the
		// outer KeyValue → AnyValue dispatch and the leaf stringValue,
		// 30 wraps stays well clear of the 32-cap.
		const body = wrapAsTopLevelAttribute(keyValue("k", nestedArrayValue(30)));
		expect(() => decodeExportTraceServiceRequest(body)).not.toThrow();
	});

	it("throws OtlpProtobufNestingTooDeepError past the cap", () => {
		const body = wrapAsTopLevelAttribute(keyValue("k", nestedArrayValue(100)));
		expect(() => decodeExportTraceServiceRequest(body)).toThrow(OtlpProtobufNestingTooDeepError);
	});
});

describe("decodeExportTraceServiceRequest — wire-type robustness", () => {
	it("throws UnsupportedWireTypeError when skipping an unknown wire type", () => {
		// Tag with field 99 + wire type 3 (group start — never emitted by
		// OTLP, never supported by the skipper). Append to a valid prefix
		// so the decoder reaches the skip path.
		const badTag = writeVarint(BigInt((99 << 3) | 3));
		const body = concat(badTag);
		expect(() => decodeExportTraceServiceRequest(body)).toThrow(UnsupportedWireTypeError);
	});
});
