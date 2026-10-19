import { expect, test } from "bun:test";
import loopGuard, {
	type LoopGuardApi,
	type LoopGuardContext,
	type ToolResultObservation,
} from "./kit-loop-guard.ts";
import {
	directorLine,
	extractResultText,
	injectMessage,
	LOOPGUARD_INJECT_AT,
	LOOPGUARD_NOTIFY_AT,
	newLoopGuardState,
	normalizeErrorSignature,
	observeToolResult,
	JSON_PARSE_CLASS,
} from "./kit-loop-guard.ts";

const JSON_PARSE_TEXT =
	"JSON_PARSE SyntaxError: JSON Parse error: Unable to parse JSON string\n" +
	"b35c8-audit bytes 16150\nWall time: 1.24s";

function failed(text: string) {
	return { isError: true, result: { text } };
}

test("planted (a): 3 identical JSON_PARSE errors inject at the third", () => {
	const state = newLoopGuardState();
	expect(observeToolResult(state, failed(JSON_PARSE_TEXT), "s").inject).toBeUndefined();
	expect(observeToolResult(state, failed(JSON_PARSE_TEXT), "s").inject).toBeUndefined();
	const third = observeToolResult(state, failed(JSON_PARSE_TEXT), "s");
	expect(third.inject).toBeString();
	expect(third.inject!).toContain(JSON_PARSE_CLASS);
	expect(third.inject!).toContain("jq");
	expect(third.inject).toBe(injectMessage(JSON_PARSE_CLASS, LOOPGUARD_INJECT_AT));
	expect(LOOPGUARD_INJECT_AT).toBe(3);
});

test("planted (b): 3 different errors inject nothing", () => {
	const state = newLoopGuardState();
	const texts = [
		"Error: connection refused on port 8080",
		"Error: file not found: /tmp/missing.json",
		"Error: timeout after 30s waiting for lock",
	];
	for (const text of texts) {
		const action = observeToolResult(state, failed(text), "s");
		expect(action.inject).toBeUndefined();
		expect(action.notifyDirector).toBeUndefined();
	}
	expect(state.count).toBe(1);
});

test("planted (c): 6 identical errors notify the director exactly once", () => {
	const state = newLoopGuardState();
	const seen: (string | undefined)[] = [];
	for (let i = 0; i < 8; i++) seen.push(observeToolResult(state, failed(JSON_PARSE_TEXT), "pane-25").notifyDirector);
	expect(seen.filter((line) => line !== undefined)).toHaveLength(1);
	expect(seen[LOOPGUARD_NOTIFY_AT - 1]).toBe(directorLine("pane-25", JSON_PARSE_CLASS, LOOPGUARD_NOTIFY_AT));
	expect(LOOPGUARD_NOTIFY_AT).toBe(6);
});

test("planted (d): a success between failures resets the count", () => {
	const state = newLoopGuardState();
	observeToolResult(state, failed(JSON_PARSE_TEXT), "s");
	observeToolResult(state, failed(JSON_PARSE_TEXT), "s");
	expect(observeToolResult(state, { isError: false, result: { text: "ok" } }, "s").inject).toBeUndefined();
	expect(state.count).toBe(0);
	expect(observeToolResult(state, failed(JSON_PARSE_TEXT), "s").inject).toBeUndefined();
	expect(observeToolResult(state, failed(JSON_PARSE_TEXT), "s").inject).toBeUndefined();
	expect(observeToolResult(state, failed(JSON_PARSE_TEXT), "s").inject).toBeString();
});

test("extension wiring: inject at 3 via sendMessage, director line at 6 exactly once", async () => {
	const sent: { content: string; deliverAs?: string }[] = [];
	const notified: string[] = [];
	type EndHandler = (event: ToolResultObservation, ctx: LoopGuardContext) => unknown;
	let captured: EndHandler | null = null;
	const pi: LoopGuardApi = {
		on(_event, handler) {
			captured = handler;
		},
		sendMessage(message, options) {
			sent.push({ content: message.content, deliverAs: options?.deliverAs });
		},
	};
	const ctx: LoopGuardContext = {};
	await loopGuard(pi, { session: "pane-25", onDirectorNotify: (line) => notified.push(line) });
	expect(captured).not.toBeNull();
	if (captured === null) throw new Error("tool_execution_end handler was not registered");
	for (let i = 0; i < 6; i++) await captured({ isError: true, result: { text: JSON_PARSE_TEXT } }, ctx);
	expect(sent.filter((m) => m.content.includes(JSON_PARSE_CLASS))).toHaveLength(1);
	expect(sent[0]!.deliverAs).toBe("aside");
	expect(notified).toHaveLength(1);
	expect(notified[0]).toBe(directorLine("pane-25", JSON_PARSE_CLASS, 6));
});

test("normalize: same failure with different numbers/paths shares a signature", () => {
	const a = normalizeErrorSignature("Error: connection refused on port 8080");
	const b = normalizeErrorSignature("Error: connection refused on port 9090");
	expect(a).toBe(b);
	expect(normalizeErrorSignature(JSON_PARSE_TEXT)).toBe(JSON_PARSE_CLASS);
	expect(normalizeErrorSignature(null)).toBeNull();
	expect(normalizeErrorSignature("   ")).toBeNull();
});

test("extractResultText covers envelope shapes", () => {
	expect(extractResultText("raw")).toBe("raw");
	expect(extractResultText({ text: "t" })).toBe("t");
	expect(extractResultText({ content: [{ type: "text", text: "c" }] })).toBe("c");
	expect(extractResultText({ stdout: "o", stderr: "e" })).toBe("o\ne");
	expect(extractResultText(null)).toBeNull();
	expect(extractResultText(42)).toBeNull();
});
