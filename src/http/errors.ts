import type { BaseIssue } from "valibot";

export class HttpClientError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HttpClientError";
	}
}

export class HttpRequestFailedError extends HttpClientError {
	readonly url: string;
	readonly status: number;
	readonly body: string;

	constructor(url: string, status: number, body: string) {
		super(`HTTP ${status} on ${url}`);
		this.name = "HttpRequestFailedError";
		this.url = url;
		this.status = status;
		this.body = body;
	}
}

export class HttpResponseShapeError extends HttpClientError {
	readonly url: string;
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(url: string, issues: readonly BaseIssue<unknown>[]) {
		super(`Response from ${url} did not match the expected schema`);
		this.name = "HttpResponseShapeError";
		this.url = url;
		this.issues = issues;
	}
}

export class HttpTimeoutError extends HttpClientError {
	readonly url: string;

	constructor(url: string, options?: ErrorOptions) {
		super(`Request to ${url} timed out`, options);
		this.name = "HttpTimeoutError";
		this.url = url;
	}
}

export class HttpNetworkError extends HttpClientError {
	readonly url: string;

	constructor(url: string, options?: ErrorOptions) {
		super(`Network failure on request to ${url}`, options);
		this.name = "HttpNetworkError";
		this.url = url;
	}
}
