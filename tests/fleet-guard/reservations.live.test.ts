import { expect, test } from "bun:test";
import { check, clearReservationCache } from "../../src/fleet-guard/reservations.ts";

const projectKey = process.cwd();
const agentName = process.env.AGENT_NAME ?? "CobaltJaguar";
const live = process.env.FLEET_GUARD_LIVE === "1";
const targetPath = "src/fleet-guard/git.ts";
const liveTest = live ? test : test.skip;

async function callAgentMail(toolName: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
	const token = process.env.AGENTMAIL_HTTP_BEARER_TOKEN ?? process.env.AGENT_MAIL_TOKEN;
	if (!token) throw new Error("Agent Mail token is required for the live probe");
	const response = await fetch(process.env.AGENTMAIL_HTTP_URL ?? "http://127.0.0.1:8765/api", {
		method: "POST",
		headers: { authorization: "Bearer " + token, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: argumentsValue } }),
	});
	if (!response.ok) throw new Error("Agent Mail HTTP " + response.status);
	const body = await response.json() as { error?: { message?: string }; result?: { content?: Array<{ type?: string; text?: string }> } };
	if (body.error) throw new Error(body.error.message ?? "Agent Mail call failed");
	const text = body.result?.content?.find((entry) => entry.type === "text")?.text;
	if (!text) throw new Error("Agent Mail call returned no text");
	return JSON.parse(text);
}

liveTest("live reservation permits an edit, then blocks after release", async () => {
	const reservation = await callAgentMail("file_reservation_paths", {
		project_key: projectKey,
		agent_name: agentName,
		paths: [targetPath],
		exclusive: true,
		ttl_seconds: 120,
	});
	expect(reservation).toMatchObject({ granted: expect.any(Array) });
	try {
		clearReservationCache();
		expect(await check({ toolName: "write", arguments: { path: targetPath } }, { cwd: projectKey, agentName, projectKey })).toBeUndefined();
	} finally {
		await callAgentMail("release_file_reservations", { project_key: projectKey, agent_name: agentName, paths: [targetPath] });
	}
	clearReservationCache();
	expect(await check({ toolName: "write", arguments: { path: targetPath } }, { cwd: projectKey, agentName, projectKey })).toMatchObject({ block: true });
});
