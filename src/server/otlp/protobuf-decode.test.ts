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

function writeFixed64(value: bigint): Uint8Array {
	const buf = new ArrayBuffer(8);
	new DataView(buf).setBigUint64(0, value & ((1n << 64n) - 1n), true);
	return new Uint8Array(buf);
}

function writeFixed32(value: number): Uint8Array {
	const buf = new ArrayBuffer(4);
	new DataView(buf).setUint32(0, value >>> 0, true);
	return new Uint8Array(buf);
}

function writeDouble(value: number): Uint8Array {
	const buf = new ArrayBuffer(8);
	new DataView(buf).setFloat64(0, value, true);
	return new Uint8Array(buf);
}

function lenField(fieldNumber: number, payload: Uint8Array): Uint8Array {
	return concat(tag(fieldNumber, 2), writeLengthDelimited(payload));
}

function stringField(fieldNumber: number, value: string): Uint8Array {
	return lenField(fieldNumber, new TextEncoder().encode(value));
}

function varintField(fieldNumber: number, value: bigint): Uint8Array {
	return concat(tag(fieldNumber, 0), writeVarint(value));
}

function fixed64Field(fieldNumber: number, value: bigint): Uint8Array {
	return concat(tag(fieldNumber, 1), writeFixed64(value));
}

function fixed32Field(fieldNumber: number, value: number): Uint8Array {
	return concat(tag(fieldNumber, 5), writeFixed32(value));
}

function anyValueInt(value: bigint): Uint8Array {
	// AnyValue.int_value = field 3, wire type 0 (varint)
	return concat(tag(3, 0), writeVarint(value & ((1n << 64n) - 1n)));
}

function anyValueString(value: string): Uint8Array {
	// AnyValue.string_value = field 1, wire type 2
	return stringField(1, value);
}

function anyValueBool(value: boolean): Uint8Array {
	// AnyValue.bool_value = field 2, wire type 0
	return varintField(2, value ? 1n : 0n);
}

function anyValueDouble(value: number): Uint8Array {
	// AnyValue.double_value = field 4, wire type 1 (fixed64)
	return concat(tag(4, 1), writeDouble(value));
}

function anyValueKvlist(entries: Uint8Array[]): Uint8Array {
	// AnyValue.kvlist_value = field 6, wire type 2
	// KeyValueList.values   = field 1, wire type 2 (length-delimited KeyValue)
	const kvlist = concat(...entries.map((entry) => lenField(1, entry)));
	return lenField(6, kvlist);
}

function anyValueBytes(value: Uint8Array): Uint8Array {
	// AnyValue.bytes_value = field 7, wire type 2
	return lenField(7, value);
}

function anyValueArrayWrapping(inner: Uint8Array): Uint8Array {
	// AnyValue.array_value = field 5, wire type 2 (length-delimited)
	// ArrayValue.values   = field 1, wire type 2 (length-delimited AnyValue)
	const arrayValue = concat(tag(1, 2), writeLengthDelimited(inner));
	return concat(tag(5, 2), writeLengthDelimited(arrayValue));
}

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

/**
 * Wrap a Span message in the minimum nesting needed to reach the
 * decoder: ResourceSpans → ScopeSpans → Span.
 *
 * ExportTraceServiceRequest.resource_spans = field 1 (length-delim)
 * ResourceSpans.scope_spans                = field 2 (length-delim)
 * ScopeSpans.spans                         = field 2 (length-delim Span)
 */
function wrapAsSpan(span: Uint8Array): Uint8Array {
	return lenField(1, lenField(2, lenField(2, span)));
}

function firstSpan(body: Uint8Array) {
	return decodeExportTraceServiceRequest(body).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
}

function firstAttributeValue(body: Uint8Array) {
	return decodeExportTraceServiceRequest(body).resourceSpans?.[0]?.resource?.attributes?.[0]?.value;
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

describe("decodeExportTraceServiceRequest — AnyValue variants", () => {
	it("decodes boolValue true and false", () => {
		expect(firstAttributeValue(wrapAsTopLevelAttribute(keyValue("k", anyValueBool(true))))).toEqual(
			{
				boolValue: true,
			},
		);
		expect(
			firstAttributeValue(wrapAsTopLevelAttribute(keyValue("k", anyValueBool(false)))),
		).toEqual({
			boolValue: false,
		});
	});

	it("decodes doubleValue from little-endian IEEE-754 bits", () => {
		expect(
			firstAttributeValue(wrapAsTopLevelAttribute(keyValue("k", anyValueDouble(3.25)))),
		).toEqual({
			doubleValue: 3.25,
		});
		expect(
			firstAttributeValue(wrapAsTopLevelAttribute(keyValue("k", anyValueDouble(-1234.5678)))),
		).toEqual({ doubleValue: -1234.5678 });
	});

	it("decodes kvlistValue into nested key/value pairs", () => {
		const kvlist = anyValueKvlist([
			keyValue("inner_string", anyValueString("v")),
			keyValue("inner_int", anyValueInt(7n)),
		]);
		expect(firstAttributeValue(wrapAsTopLevelAttribute(keyValue("k", kvlist)))).toEqual({
			kvlistValue: {
				values: [
					{ key: "inner_string", value: { stringValue: "v" } },
					{ key: "inner_int", value: { intValue: "7" } },
				],
			},
		});
	});

	it("decodes bytesValue as base64 (OTLP/JSON represents bytes as base64)", () => {
		const raw = new Uint8Array([0x00, 0x01, 0xff, 0x10]);
		expect(firstAttributeValue(wrapAsTopLevelAttribute(keyValue("k", anyValueBytes(raw))))).toEqual(
			{
				bytesValue: "AAH/EA==",
			},
		);
	});
});

describe("decodeExportTraceServiceRequest — spans", () => {
	it("decodes trace/span/parent ids as zero-padded lowercase hex", () => {
		const traceId = new Uint8Array([
			0x00, 0x0f, 0x10, 0xff, 0x00, 0x0f, 0x10, 0xff, 0x00, 0x0f, 0x10, 0xff, 0x00, 0x0f, 0x10,
			0xff,
		]);
		const spanId = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
		const parentSpanId = new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x00, 0xff]);
		const span = firstSpan(
			wrapAsSpan(concat(lenField(1, traceId), lenField(2, spanId), lenField(4, parentSpanId))),
		);
		expect(span?.traceId).toBe("000f10ff000f10ff000f10ff000f10ff");
		expect(span?.spanId).toBe("0102030405060708");
		expect(span?.parentSpanId).toBe("0a0b0c0d0e0f00ff");
	});

	it("decodes unix-nano timestamps past 2^32 without dropping the high word", () => {
		// Every real OTLP span timestamp is unix-nanos, i.e. ~1.7e18 —
		// always above 2^32, so the hi-word composition is the hot path,
		// not an edge case.
		const span = firstSpan(
			wrapAsSpan(
				concat(fixed64Field(7, 1748822400123456789n), fixed64Field(8, 1748822401987654321n)),
			),
		);
		expect(span?.startTimeUnixNano).toBe("1748822400123456789");
		expect(span?.endTimeUnixNano).toBe("1748822401987654321");
	});

	it("decodes a fixed64 below 2^32 as a plain decimal string", () => {
		const span = firstSpan(wrapAsSpan(fixed64Field(7, 4294967295n)));
		expect(span?.startTimeUnixNano).toBe("4294967295");
	});

	it("decodes kind, flags and the three dropped counts", () => {
		const span = firstSpan(
			wrapAsSpan(
				concat(
					varintField(6, 3n),
					varintField(10, 11n),
					varintField(12, 22n),
					varintField(14, 33n),
					fixed32Field(16, 0x0000_0301),
				),
			),
		);
		expect(span?.kind).toBe(3);
		expect(span?.droppedAttributesCount).toBe(11);
		expect(span?.droppedEventsCount).toBe(22);
		expect(span?.droppedLinksCount).toBe(33);
		expect(span?.flags).toBe(0x0000_0301);
	});

	it("decodes traceState, name, attributes and status", () => {
		const span = firstSpan(
			wrapAsSpan(
				concat(
					stringField(3, "vendor=xray"),
					stringField(5, "llm.completion"),
					lenField(9, keyValue("xray.replay.id", anyValueString("rep_1"))),
					lenField(15, concat(stringField(2, "boom"), varintField(3, 2n))),
				),
			),
		);
		expect(span?.traceState).toBe("vendor=xray");
		expect(span?.name).toBe("llm.completion");
		expect(span?.attributes).toEqual([{ key: "xray.replay.id", value: { stringValue: "rep_1" } }]);
		expect(span?.status).toEqual({ message: "boom", code: 2 });
	});

	it("decodes span events with their own timestamp, attributes and dropped count", () => {
		const event = concat(
			fixed64Field(1, 1234n),
			stringField(2, "exception"),
			lenField(3, keyValue("exception.type", anyValueString("ValueError"))),
			varintField(4, 5n),
		);
		const span = firstSpan(wrapAsSpan(lenField(11, event)));
		expect(span?.events).toEqual([
			{
				timeUnixNano: "1234",
				name: "exception",
				attributes: [{ key: "exception.type", value: { stringValue: "ValueError" } }],
				droppedAttributesCount: 5,
			},
		]);
	});

	it("decodes span links including traceState, attributes, dropped count and flags", () => {
		const link = concat(
			lenField(1, new Uint8Array(16).fill(0xab)),
			lenField(2, new Uint8Array(8).fill(0xcd)),
			stringField(3, "vendor=up"),
			lenField(4, keyValue("link.kind", anyValueString("follows"))),
			varintField(5, 2n),
			fixed32Field(6, 1),
		);
		const span = firstSpan(wrapAsSpan(lenField(13, link)));
		expect(span?.links).toEqual([
			{
				traceId: "abababababababababababababababab",
				spanId: "cdcdcdcdcdcdcdcd",
				traceState: "vendor=up",
				attributes: [{ key: "link.kind", value: { stringValue: "follows" } }],
				droppedAttributesCount: 2,
				flags: 1,
			},
		]);
	});

	it("omits empty repeated fields and falls back to zeroed defaults", () => {
		const span = firstSpan(wrapAsSpan(stringField(5, "bare")));
		expect(span).toEqual({
			traceId: "",
			spanId: "",
			name: "bare",
			startTimeUnixNano: "0",
			endTimeUnixNano: "0",
		});
	});
});

describe("decodeExportTraceServiceRequest — scope and schema urls", () => {
	it("decodes InstrumentationScope name, version, attributes and dropped count", () => {
		const scope = concat(
			stringField(1, "xray.sdk"),
			stringField(2, "1.2.3"),
			lenField(3, keyValue("scope.attr", anyValueBool(true))),
			varintField(4, 9n),
		);
		const body = lenField(1, lenField(2, lenField(1, scope)));
		expect(
			decodeExportTraceServiceRequest(body).resourceSpans?.[0]?.scopeSpans?.[0]?.scope,
		).toEqual({
			name: "xray.sdk",
			version: "1.2.3",
			attributes: [{ key: "scope.attr", value: { boolValue: true } }],
			droppedAttributesCount: 9,
		});
	});

	it("decodes schemaUrl on both ResourceSpans and ScopeSpans, plus Resource dropped count", () => {
		const resource = concat(varintField(2, 4n));
		const scopeSpans = stringField(3, "https://example.test/schema/scope");
		const resourceSpans = concat(
			lenField(1, resource),
			lenField(2, scopeSpans),
			stringField(3, "https://example.test/schema/resource"),
		);
		const rs = decodeExportTraceServiceRequest(lenField(1, resourceSpans)).resourceSpans?.[0];
		expect(rs?.schemaUrl).toBe("https://example.test/schema/resource");
		expect(rs?.resource?.droppedAttributesCount).toBe(4);
		expect(rs?.scopeSpans?.[0]?.schemaUrl).toBe("https://example.test/schema/scope");
	});
});

describe("decodeExportTraceServiceRequest — wire-type robustness", () => {
	it("skips an unknown fixed64 field without shifting the following field", () => {
		const span = concat(
			concat(tag(50, 1), writeFixed64(0xffff_ffff_ffff_ffffn)),
			stringField(5, "after-fixed64"),
		);
		expect(firstSpan(wrapAsSpan(span))?.name).toBe("after-fixed64");
	});

	it("skips an unknown fixed32 field without shifting the following field", () => {
		const span = concat(
			concat(tag(51, 5), writeFixed32(0xffff_ffff)),
			stringField(5, "after-fixed32"),
		);
		expect(firstSpan(wrapAsSpan(span))?.name).toBe("after-fixed32");
	});

	it("returns an empty object for an empty body", () => {
		expect(decodeExportTraceServiceRequest(new Uint8Array())).toEqual({});
	});

	it("throws UnsupportedWireTypeError when skipping an unknown wire type", () => {
		// Tag with field 99 + wire type 3 (group start — never emitted by
		// OTLP, never supported by the skipper). Append to a valid prefix
		// so the decoder reaches the skip path.
		const badTag = writeVarint(BigInt((99 << 3) | 3));
		const body = concat(badTag);
		expect(() => decodeExportTraceServiceRequest(body)).toThrow(UnsupportedWireTypeError);
	});
});
