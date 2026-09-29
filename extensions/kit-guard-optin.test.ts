import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitGuardOptIn, { CONFIG_REL_PATH, optInState, PROJECT_COPY_REL_PATH } from "./kit-guard-optin";

type Handler = (...args: unknown[]) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const labels: string[] = [];
	const pi = {
		setLabel: (label: string) => void labels.push(label),
		registerCommand: () => undefined,
		sendMessage: () => undefined,
		on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	};
	return { pi, handlers, labels };
}

/** A throwaway git root with optional opt-in marker and project-local guard copy. */
function repo(opts: { config?: boolean; projectCopy?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "kit-guard-optin-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, ".omp"));
	if (opts.config) writeFileSync(join(root, CONFIG_REL_PATH), "{}\n");
	if (opts.projectCopy) mkdirSync(join(root, PROJECT_COPY_REL_PATH), { recursive: true });
	return root;
}

const startCwd = process.cwd();
const startSrc = process.env.KIT_GUARD_SRC;
afterEach(() => {
	process.chdir(startCwd);
	if (startSrc === undefined) delete process.env.KIT_GUARD_SRC;
	else process.env.KIT_GUARD_SRC = startSrc;
});

async function toolCall(handlers: Map<string, Handler[]>, toolName: string, input: Record<string, unknown>) {
	const results = await Promise.all((handlers.get("tool_call") ?? []).map(h => h({ toolName, input })));
	return results.find(r => r !== undefined);
}

describe("opt-in decision", () => {
	test("a repo without .omp/kit-guard.json is off and registers nothing", async () => {
		const root = repo();
		expect(optInState(root, undefined).kind).toBe("off");
		process.chdir(root);
		const { pi, handlers } = fakePi();
		await kitGuardOptIn(pi);
		expect(handlers.size).toBe(0);
	});

	test("a repo that ships its own kit-guard is left to that copy", async () => {
		const root = repo({ config: true, projectCopy: true });
		expect(optInState(root, undefined).kind).toBe("project-copy");
		process.chdir(root);
		const { pi, handlers } = fakePi();
		await kitGuardOptIn(pi);
		expect(handlers.size).toBe(0);
	});

	test("a subdirectory resolves to the repo root that holds the config", () => {
		const root = repo({ config: true });
		const deep = join(root, "src", "deep");
		mkdirSync(deep, { recursive: true });
		expect(optInState(deep, undefined)).toEqual({ kind: "on", root, src: undefined });
	});
});

describe("opted in", () => {
	test("an explicitly supplied guard loads and handles tool calls", async () => {
		const root = repo({ config: true });
		const guard = join(root, "guard.ts");
		writeFileSync(
			guard,
			`export default (pi: { setLabel(label: string): void; on(event: string, handler: (call: { toolName: string }) => unknown): void }) => {
				pi.setLabel("external-guard");
				pi.on("tool_call", async ({ toolName }) => toolName === "edit" ? { block: true, reason: "guard refused edit" } : undefined);
			};`,
		);
		process.chdir(root);
		process.env.KIT_GUARD_SRC = guard;
		const { pi, handlers, labels } = fakePi();
		await kitGuardOptIn(pi);
		expect(labels).toContain("external-guard");
		expect(await toolCall(handlers, "edit", { path: "foundation/gates.sh" })).toMatchObject({
			block: true,
			reason: "guard refused edit",
		});
		expect(await toolCall(handlers, "read", { path: "notes/today.md" })).toBeUndefined();
	});

	test("a configured repo without KIT_GUARD_SRC refuses every tool call", async () => {
		const root = repo({ config: true });
		process.chdir(root);
		delete process.env.KIT_GUARD_SRC;
		const { pi, handlers, labels } = fakePi();
		await kitGuardOptIn(pi);
		expect(labels).toEqual(["kit-guard-optin"]);
		expect(await toolCall(handlers, "read", { path: "notes/today.md" })).toMatchObject({
			block: true,
			reason: expect.stringContaining("KIT_GUARD_SRC"),
		});
	});

	test("a guard that does not load refuses every tool call and says why", async () => {
		const root = repo({ config: true });
		process.chdir(root);
		process.env.KIT_GUARD_SRC = join(root, "missing", "index.ts");
		const { pi, handlers, labels } = fakePi();
		await kitGuardOptIn(pi);
		expect(labels).toEqual(["kit-guard-optin"]);
		expect(await toolCall(handlers, "read", { path: "README.md" })).toMatchObject({
			block: true,
			reason: expect.stringContaining("did not load"),
		});
	});
});
