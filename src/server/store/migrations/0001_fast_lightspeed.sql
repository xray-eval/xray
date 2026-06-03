CREATE TABLE `tts_synth_cache` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`audio_sha256` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`voice` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "tts_synth_cache_fingerprint_ck" CHECK(length("tts_synth_cache"."fingerprint") = 64),
	CONSTRAINT "tts_synth_cache_audio_sha256_ck" CHECK(length("tts_synth_cache"."audio_sha256") = 64)
);
