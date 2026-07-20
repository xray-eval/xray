import { createHash, createHmac } from "node:crypto";

/**
 * AWS credentials for SigV4 signing. `sessionToken` is present for
 * temporary credentials (assumed roles, instance/task profiles) and is
 * carried in the `x-amz-security-token` header, which is also signed.
 */
export interface AwsCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
}

/**
 * Signed header set to send. `authorization` is always present (declared so
 * callers can read it without an index-signature cast); every other entry —
 * `x-amz-date`, the caller's headers, and `x-amz-security-token` for
 * temporary credentials — rides the string index signature.
 */
export interface AwsSignedHeaders {
	authorization: string;
	[header: string]: string;
}

export interface SignAwsRequestOptions {
	readonly method: string;
	readonly url: string;
	readonly region: string;
	readonly service: string;
	/** Exact request body string that will be sent (empty string for none). */
	readonly body: string;
	/** Request headers the caller will send (e.g. content-type). Host and
	 *  x-amz-date are managed by the signer and must not be passed here. */
	readonly headers?: Readonly<Record<string, string>>;
	readonly credentials: AwsCredentials;
	/** Injectable clock for deterministic signing in tests. */
	readonly now?: Date;
}

/**
 * Sign an HTTP request with AWS Signature Version 4 and return the full
 * header set to send (the caller's headers plus `authorization`,
 * `x-amz-date`, and — for temporary credentials — `x-amz-security-token`).
 *
 * Hand-rolled over `node:crypto` on purpose: the alternative is the
 * `@aws-sdk/*` signer, whose transitive tree is exactly the supply-chain
 * surface the Bedrock providers avoid (see `.claude/rules/supply-chain.md`).
 * SigV4 is a fixed HMAC-SHA256 derivation with published test vectors, so a
 * ~50-line implementation is both auditable and stable.
 */
export function signAwsRequest(opts: SignAwsRequestOptions): AwsSignedHeaders {
	const url = new URL(opts.url);
	const amzDate = toAmzDate(opts.now ?? new Date());
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;

	// Header set to sign: caller headers + host + x-amz-date (+ token).
	const signedHeaderMap: Record<string, string> = { host: url.host, "x-amz-date": amzDate };
	for (const [k, val] of Object.entries(opts.headers ?? {})) {
		signedHeaderMap[k.toLowerCase()] = val.trim();
	}
	if (opts.credentials.sessionToken !== undefined) {
		signedHeaderMap["x-amz-security-token"] = opts.credentials.sessionToken;
	}
	const sortedNames = Object.keys(signedHeaderMap).sort();
	const signedHeaders = sortedNames.join(";");
	const canonicalHeaders = sortedNames.map((n) => `${n}:${signedHeaderMap[n]}\n`).join("");

	const payloadHash = sha256Hex(opts.body);
	const canonicalRequest = [
		opts.method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQuery(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

	const signingKey = deriveSigningKey(
		opts.credentials.secretAccessKey,
		dateStamp,
		opts.region,
		opts.service,
	);
	const signature = hmac(signingKey, stringToSign).toString("hex");

	const out: AwsSignedHeaders = {
		...(opts.headers ?? {}),
		"x-amz-date": amzDate,
		authorization:
			`AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, ` +
			`SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
	if (opts.credentials.sessionToken !== undefined) {
		out["x-amz-security-token"] = opts.credentials.sessionToken;
	}
	return out;
}

function toAmzDate(now: Date): string {
	return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

// The canonical URI is the URI-encoded path, encoded a SECOND time for
// every service except S3. Decode each segment to its raw form, then encode
// twice: a Bedrock model id's colon becomes `:` → `%3A` → `%253A`, which is
// what AWS signs over. A single encode (the earlier bug) left `%3A` and
// produced SignatureDoesNotMatch for any model id containing a colon (Nova
// ids, inference-profile / provisioned-throughput ARNs).
function canonicalUri(pathname: string): string {
	if (pathname === "") return "/";
	return pathname
		.split("/")
		.map((seg) => encodeRfc3986(encodeRfc3986(decodeURIComponent(seg))))
		.join("/");
}

function canonicalQuery(params: URLSearchParams): string {
	const pairs: [string, string][] = [];
	for (const [k, val] of params) pairs.push([encodeRfc3986(k), encodeRfc3986(val)]);
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
	return pairs.map(([k, val]) => `${k}=${val}`).join("&");
}

// AWS requires RFC 3986 encoding: encodeURIComponent leaves !'()* unescaped,
// so escape those too.
function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function deriveSigningKey(
	secretAccessKey: string,
	dateStamp: string,
	region: string,
	service: string,
): Buffer {
	const kDate = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	return hmac(kService, "aws4_request");
}

function hmac(key: Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}
