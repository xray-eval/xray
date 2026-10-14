export class TestServerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TestServerError";
	}
}

export class IncompatibleInterceptorError extends TestServerError {
	readonly interceptorName: string;
	constructor(interceptorName: string) {
		super(
			`${interceptorName} no longer exposes apply/dispose/on, so msw's InterceptorSource cannot drive it`,
		);
		this.name = "IncompatibleInterceptorError";
		this.interceptorName = interceptorName;
	}
}
