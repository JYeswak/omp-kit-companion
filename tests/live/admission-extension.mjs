// G4 qualifies the source-admission component independently of unrelated fleet
// filesystem/branch policies. The full fleet entry is exercised by native guard
// qualification; this adapter uses the same predicate and real repository opt-in.
import { check } from "../../src/fleet-guard/durability.ts";
import { fleetPolicyState } from "../../extensions/fleet-policy.ts";
import { resolve } from "node:path";
import { appendFileSync, existsSync } from "node:fs";

export const guardName = "scratch-is-not-a-home";

export default function admissionExtension(pi) {
	pi.setLabel("tool-admission-conformance");
	// Prep opts into native call/execution/result capture for tool assertions.
	const record = (context, row) => {
		if (typeof context?.cwd !== "string") return;
		const log = resolve(context.cwd, ".omp-kit-tool-events.jsonl");
		if (existsSync(log)) appendFileSync(log, JSON.stringify(row) + "\n");
	};
	pi.on("message_update", (event, context) => {
		const update = event.assistantMessageEvent;
		if (update.type !== "toolcall_delta") return;
		const call = event.message.content[update.contentIndex];
		if (call?.type === "toolCall") {
			record(context, { event: "call", timestamp: event.message.timestamp, id: call.id, name: call.name, args: call.arguments });
		}
	});
	pi.on("message_end", (event, context) => {
		const message = event.message;
		if (message.role === "assistant" && message.stopReason === "aborted") {
			record(context, { event: "stop", timestamp: message.timestamp, reason: message.stopReason, error: message.errorMessage });
		} else if (message.role === "toolResult") {
			record(context, { event: "result", id: message.toolCallId, content: message.content, isError: message.isError, details: message.details });
		}
	});
	pi.on("agent_end", (_event, context) => record(context, { event: "end" }));
	pi.on("tool_call", async (event, context) => {
		record(context, { event: "execution", id: event.toolCallId });
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		if (typeof context?.cwd !== "string") return { block: true, reason: "tool-admission conformance: native caller cwd unavailable" };
		const policy = await fleetPolicyState(context.cwd);
		if (policy.kind === "off") return undefined;
		if (policy.kind === "unavailable") return { block: true, reason: `tool-admission conformance: ${policy.reason}` };
		const artifacts = context.localProtocolOptions?.getArtifactsDir?.();
		return check(event, { cwd: context.cwd, localRoot: artifacts ? resolve(artifacts, "local") : undefined });
	});
}
