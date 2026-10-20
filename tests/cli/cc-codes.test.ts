/** CCLIVE1 (ompkit-fp72.120.16.11.9): kit-emitted CC codes fit the contract alphabet. */
import { expect, test } from "bun:test";
import { ccActionSurface, ccCode } from "../../src/cli.ts";

const ALPHABET = /^[A-Za-z0-9_.-]+$/;

test("ccCode folds separators into the contract alphabet", () => {
	expect(ccCode("kit:custody check")).toBe("kit-custody-check");
	expect(ccCode("kit:63726-01ab23cd")).toBe("kit-63726-01ab23cd");
	expect(ccCode("kit:help")).toBe("kit-help");
	expect(ccCode("launchd:omp-watch")).toBe("launchd-omp-watch");
	const help = ccActionSurface({ request: { command: { name: "help" }, flags: new Map() } } as never);
	expect(help).toBe("kit-help");
	expect(ALPHABET.test(help)).toBe(true);
	const flag = ccActionSurface({ request: { command: { name: "--version" }, flags: new Map() } } as never);
	expect(flag).toBe("kit-version");
});

test("ccActionSurface emits contract-safe surfaces", () => {
	const help = ccActionSurface({ request: { command: { name: "help" }, flags: new Map() } } as never);
	expect(help).toBe("kit-help");
	expect(ALPHABET.test(help)).toBe(true);
});
