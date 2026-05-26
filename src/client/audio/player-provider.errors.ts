export class PlayerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PlayerError";
	}
}

export class PlayerProviderMissingError extends PlayerError {
	constructor() {
		super("usePlayer / useRegisterPlayer called outside <PlayerProvider>");
		this.name = "PlayerProviderMissingError";
	}
}
