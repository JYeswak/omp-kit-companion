// G4 qualifies the source-admission component independently of unrelated fleet
// filesystem/branch policies. The full fleet entry is exercised by native guard
// qualification; this adapter uses the same predicate and real repository opt-in.
import { check } from "../../src/fleet-guard/durability.ts";
import { fleetPolicyState } from "../../extensions/fleet-policy.ts";
import { resolve } from "node:path";

export const guardName = "scratch-is-not-a-home";

export default function admissionExtension(pi) {
	pi.setLabel("tool-admission-conformance");
	pi.on("tool_call", async (event, context) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		if (typeof context?.cwd !== "string") return { block: true, reason: "tool-admission conformance: native caller cwd unavailable" };
		const policy = await fleetPolicyState(context.cwd);
		if (policy.kind === "off") return undefined;
		if (policy.kind === "unavailable") return { block: true, reason: `tool-admission conformance: ${policy.reason}` };
		const artifacts = context.localProtocolOptions?.getArtifactsDir?.();
		return check(event, { cwd: context.cwd, localRoot: artifacts ? resolve(artifacts, "local") : undefined });
	});
}
