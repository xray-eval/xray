import { openApiSchemaFromValibot } from "@/server/core/types.ts";
import {
	ClientFrameSchema,
	REALTIME_REPLAY_PROTOCOL_VERSION,
	ServerFrameSchema,
} from "@/server/replays/realtime/realtime.types.ts";

// Pull the wire `type` literal off each variant option directly, so AsyncAPI
// message names track the variant array order automatically. A reorder in
// `realtime.types.ts` can't desynchronize this file — the previous version
// used a hand-aligned `["session.start", ...]` table keyed by position and
// silently mismatched names↔schemas on reorder.
const CLIENT_FRAMES = new Map(
	ClientFrameSchema.options.map((opt) => [opt.entries.type.literal, opt] as const),
);
const SERVER_FRAMES = new Map(
	ServerFrameSchema.options.map((opt) => [opt.entries.type.literal, opt] as const),
);

const SEQUENCE_DIAGRAM = `\`\`\`mermaid
sequenceDiagram
    participant X as xray engine
    participant W as your webhook

    X->>W: open ws connection
    X->>W: session.start (manifest of turns)
    loop per user turn
        X->>W: user_audio.append (audio chunks)
        X->>W: user_audio.commit
        loop until turn done
            W->>X: agent_audio.delta and/or agent_transcript.delta
            opt agent invoked a tool
                W->>X: tool_called
            end
        end
        W->>X: turn.done
    end
    X->>W: session.end
    X->>W: close ws
\`\`\``;

const DESCRIPTION = `Wire contract for the realtime (V2V) replay protocol — protocolVersion ${REALTIME_REPLAY_PROTOCOL_VERSION}.

xray opens **one WebSocket per replay run** to your webhook URL and streams the recorded user audio chunk-by-chunk while consuming your agent's response audio + transcript, framed by turn boundaries. The webhook is the piece that talks to OpenAI Realtime (or Gemini Live, or any other voice-to-voice provider); xray stays format-agnostic.

### Sequence

${SEQUENCE_DIAGRAM}

### Versioning

Bumping the major in \`protocolVersion\` is a breaking change. The engine refuses to talk to a webhook whose \`session.start\` declares a different major.

### Notes

- Frames are JSON text frames, one frame per WS message.
- Audio chunks are base64-encoded inside the JSON frame (per-chunk size capped server-side to bound memory).
- Chunks within one turn MUST share the same \`contentType\` — mid-turn changes are rejected.
- The webhook satisfies in-flight tool calls using the recorded results in the manifest (\`turns[i].recordedToolResults\`) so replays don't re-execute real tool side effects.

The full Valibot schemas live in [\`src/server/replays/realtime/realtime.types.ts\`](https://github.com/basilebong/xray/blob/main/src/server/replays/realtime/realtime.types.ts).`;

/**
 * Build the AsyncAPI 3.0 document describing the realtime-replay protocol.
 *
 * Synchronous — `@valibot/to-json-schema` resolves inline. Returned as a
 * plain object so the router can `c.json()` it.
 */
export function buildAsyncApiDoc(): unknown {
	const messages: Record<string, unknown> = {};
	for (const [type, schema] of CLIENT_FRAMES) {
		messages[clientMessageName(type)] = {
			name: clientMessageName(type),
			title: `Client → server: ${type}`,
			summary: `Frame sent by xray to the webhook. \`type\` is \`"${type}"\`.`,
			contentType: "application/json",
			payload: openApiSchemaFromValibot(schema),
		};
	}
	for (const [type, schema] of SERVER_FRAMES) {
		messages[serverMessageName(type)] = {
			name: serverMessageName(type),
			title: `Server → client: ${type}`,
			summary: `Frame sent by the webhook back to xray. \`type\` is \`"${type}"\`.`,
			contentType: "application/json",
			payload: openApiSchemaFromValibot(schema),
		};
	}

	return {
		asyncapi: "3.0.0",
		info: {
			title: "xray realtime-replay WebSocket protocol",
			version: String(REALTIME_REPLAY_PROTOCOL_VERSION),
			description: DESCRIPTION,
			license: {
				name: "Elastic License 2.0",
				url: "https://www.elastic.co/licensing/elastic-license",
			},
		},
		servers: {
			webhook: {
				host: "your-webhook.example",
				protocol: "wss",
				description: "Your webhook endpoint. xray dials this on each replay run.",
			},
		},
		channels: {
			replay: {
				address: "/",
				title: "Realtime replay channel",
				description: "Single WebSocket connection per replay run.",
				messages: Object.fromEntries(
					Object.keys(messages).map((name) => [name, { $ref: `#/components/messages/${name}` }]),
				),
			},
		},
		operations: {
			sendToWebhook: {
				action: "send",
				channel: { $ref: "#/channels/replay" },
				title: "xray → webhook frames",
				summary: "All frames the xray engine emits into the WebSocket.",
				messages: [...CLIENT_FRAMES.keys()].map((type) => ({
					$ref: `#/channels/replay/messages/${clientMessageName(type)}`,
				})),
			},
			receiveFromWebhook: {
				action: "receive",
				channel: { $ref: "#/channels/replay" },
				title: "webhook → xray frames",
				summary: "All frames the webhook returns to the xray engine.",
				messages: [...SERVER_FRAMES.keys()].map((type) => ({
					$ref: `#/channels/replay/messages/${serverMessageName(type)}`,
				})),
			},
		},
		components: { messages },
	};
}

function clientMessageName(frameType: string): string {
	return `client.${frameType}`;
}

function serverMessageName(frameType: string): string {
	return `server.${frameType}`;
}
