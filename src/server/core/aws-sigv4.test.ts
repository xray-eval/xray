import { signAwsRequest } from "./aws-sigv4.ts";
import { describe, expect, it } from "bun:test";

// Fixed clock for deterministic signatures.
const AT = new Date("2015-08-30T12:36:00Z");

describe("signAwsRequest", () => {
	it("matches the AWS-documented get-vanilla known-answer vector", () => {
		// From the AWS SigV4 test suite (get-vanilla): GET, empty body, only
		// host + x-amz-date signed, credential AKIDEXAMPLE / service "service".
		const headers = signAwsRequest({
			method: "GET",
			url: "https://example.amazonaws.com/",
			region: "us-east-1",
			service: "service",
			body: "",
			credentials: {
				accessKeyId: "AKIDEXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			now: AT,
		});
		expect(headers.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
				"SignedHeaders=host;x-amz-date, " +
				"Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
		);
		expect(headers["x-amz-date"]).toBe("20150830T123600Z");
	});

	it("includes signed request headers (content-type) in the credential scope", () => {
		const headers = signAwsRequest({
			method: "POST",
			url: "https://bedrock-runtime.eu-central-1.amazonaws.com/model/m/converse",
			region: "eu-central-1",
			service: "bedrock",
			body: JSON.stringify({ hi: true }),
			headers: { "content-type": "application/json" },
			credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
			now: AT,
		});
		expect(headers.authorization).toContain("/eu-central-1/bedrock/aws4_request");
		expect(headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date");
		expect(headers["x-amz-date"]).toBe("20150830T123600Z");
	});

	it("double-encodes a colon in the path (Bedrock model id) — known-answer", () => {
		// SigV4 (non-S3) signs over a DOUBLE-encoded path: the model id's colon
		// is `:` → `%3A` → `%253A`. This known-answer locks that exact form; a
		// single-encode (the earlier bug) produces a different signature and
		// AWS returns SignatureDoesNotMatch for any colon-bearing model id.
		// Value cross-checked against live Bedrock (a colon model authenticates
		// past the signature stage with this signer).
		const headers = signAwsRequest({
			method: "POST",
			url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-2-lite-v1%3A0/converse",
			region: "us-east-1",
			service: "bedrock",
			body: "{}",
			headers: { "content-type": "application/json" },
			credentials: {
				accessKeyId: "AKIDEXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			now: AT,
		});
		expect(headers.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, " +
				"SignedHeaders=content-type;host;x-amz-date, " +
				"Signature=21cdb497f6551e9e359bbec0c1b24e51ab1ff889b97e8e14c30b88ddf2fe5884",
		);
	});

	it("adds x-amz-security-token and signs it when a session token is present", () => {
		const headers = signAwsRequest({
			method: "POST",
			url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse",
			region: "us-east-1",
			service: "bedrock",
			body: "{}",
			headers: { "content-type": "application/json" },
			credentials: { accessKeyId: "AKID", secretAccessKey: "secret", sessionToken: "SESSION==" },
			now: AT,
		});
		expect(headers["x-amz-security-token"]).toBe("SESSION==");
		expect(headers.authorization).toContain(
			"SignedHeaders=content-type;host;x-amz-date;x-amz-security-token",
		);
	});

	it("is deterministic for identical inputs and differs when the secret changes", () => {
		const opts = {
			method: "POST",
			url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse",
			region: "us-east-1",
			service: "bedrock",
			body: "{}",
			headers: { "content-type": "application/json" },
			now: AT,
		} as const;
		const a = signAwsRequest({
			...opts,
			credentials: { accessKeyId: "AKID", secretAccessKey: "s1" },
		});
		const b = signAwsRequest({
			...opts,
			credentials: { accessKeyId: "AKID", secretAccessKey: "s1" },
		});
		const c = signAwsRequest({
			...opts,
			credentials: { accessKeyId: "AKID", secretAccessKey: "s2" },
		});
		expect(a.authorization).toBe(b.authorization);
		expect(a.authorization).not.toBe(c.authorization);
	});
});
