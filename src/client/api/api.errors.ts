export class ApiError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ApiError";
	}
}

export class ApiRequestFailedError extends ApiError {
	readonly method: "GET" | "POST" | "PATCH";
	readonly path: string;
	readonly status: number;
	readonly statusText: string;
	constructor(method: "GET" | "POST" | "PATCH", path: string, status: number, statusText: string) {
		super(`${method} ${path} failed: ${status} ${statusText}`);
		this.name = "ApiRequestFailedError";
		this.method = method;
		this.path = path;
		this.status = status;
		this.statusText = statusText;
	}
}

export class ApiResponseValidationError extends ApiError {
	readonly method: "GET" | "POST" | "PATCH";
	readonly path: string;
	constructor(method: "GET" | "POST" | "PATCH", path: string) {
		super(`${method} ${path} response failed validation`);
		this.name = "ApiResponseValidationError";
		this.method = method;
		this.path = path;
	}
}
