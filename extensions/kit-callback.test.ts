import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeTempRoot } from "../src/runtime.ts";
import { dispatchAgentCallback, resetCallbackDedupe, type AgentEndEvent } from "./kit-callback.ts";

const fixtures: string[] = [];

afterEach(() => {
	resetCallbackDedupe();
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function homeWithConfig(workerPanes: string[], coordinatorPane = "%54"): string {
	const home = mkdtempSync(join(runtimeTempRoot(), "kit-callback-"));
	fixtures.push(home);
	const configDir = join(home, ".config", "omp-kit");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "fleet-watch.json"), JSON.stringify({ enabled: true, sessions: [{ session: "omp-test", coordinatorPane, coordinatorSession: "omp-test", workerPanes }] }));
	return home;
}

function doneEvent(text: string, willContinue?: boolean): AgentEndEvent {
	return { willContinue, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

test("agent_end sends one verbatim DONE callback and dedupes the next identical event", async () => {
	const sent: Array<{ session: string; pane: string; text: string; tmp: string }> = [];
	const home = homeWithConfig(["%37"]);
	const event = doneEvent("DONE ompkit-h1ws 74e0b84 evidence; NEXT ready");
	const send = (session: string, pane: string, text: string, tmp: string) => { sent.push({ session, pane, text, tmp }); };
	expect(await dispatchAgentCallback(event, { home, pane: "%37", agent: "CobaltJaguar", tmuxTmpDir: "/socket", send })).toBe(true);
	expect(await dispatchAgentCallback(event, { home, pane: "%37", agent: "CobaltJaguar", tmuxTmpDir: "/socket", send })).toBe(false);
	expect(sent).toEqual([{ session: "omp-test", pane: "%54", text: "DONE ompkit-h1ws 74e0b84 evidence; NEXT ready", tmp: "/socket" }]);
});

test("agent_end sends IDLE with a bounded excerpt when no DONE line exists", async () => {
	const sent: string[] = [];
	const home = homeWithConfig(["%37"]);
	const event = doneEvent("No callback here\n" + "x".repeat(400));
	expect(await dispatchAgentCallback(event, { home, pane: "%37", agent: "CobaltJaguar", send: (_session, _pane, text) => { sent.push(text); } })).toBe(true);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toBe(`IDLE %37 CobaltJaguar: No callback here ${"x".repeat(200 - "No callback here ".length)}`);
});

test("agent_end is fail-silent for missing config, coordinator panes, and continuations", async () => {
	const sent: string[] = [];
	const send = (_session: string, _pane: string, text: string) => { sent.push(text); };
	const missing = mkdtempSync(join(runtimeTempRoot(), "kit-callback-missing-"));
	fixtures.push(missing);
	expect(await dispatchAgentCallback(doneEvent("DONE x"), { home: missing, pane: "%37", send })).toBe(false);
	const coordinator = homeWithConfig(["%54"], "%54");
	expect(await dispatchAgentCallback(doneEvent("DONE x"), { home: coordinator, pane: "%54", send })).toBe(false);
	const worker = homeWithConfig(["%37"]);
	expect(await dispatchAgentCallback(doneEvent("DONE x", true), { home: worker, pane: "%37", send })).toBe(false);
	expect(sent).toEqual([]);
});
