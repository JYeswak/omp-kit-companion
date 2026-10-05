import { expect, test } from "bun:test";
import { diffInfraPins, parseInfraPins } from "../../src/infra.ts";

const GOOD = `[tools.bun]
version = "1.4.0"
receipt = "ladder-2026-10-05-8eebca6f"

[tools.typescript-language-server]
version = "4.3.3"
receipt = "ladder-2026-10-05-8eebca6f"
`;

test("TOOL1: a well-formed pin file parses with versions and receipts", () => {
	const pins = parseInfraPins(GOOD);
	expect(pins?.tools["bun"]).toEqual({ version: "1.4.0", receipt: "ladder-2026-10-05-8eebca6f" });
	expect(pins?.tools["typescript-language-server"]).toEqual({ version: "4.3.3", receipt: "ladder-2026-10-05-8eebca6f" });
});

test("TOOL1: matching installs report no drift", () => {
	const pins = parseInfraPins(GOOD)!;
	expect(diffInfraPins(pins, { bun: "1.4.0", "typescript-language-server": "4.3.3" })).toEqual([]);
});

test("TOOL1 planted: a moved toolchain reports DRIFT naming tool, pin and install", () => {
	const pins = parseInfraPins(GOOD)!;
	const drift = diffInfraPins(pins, { bun: "9.9.9", "typescript-language-server": "4.3.3" });
	expect(drift).toEqual([{ tool: "bun", pinned: "1.4.0", installed: "9.9.9" }]);
});

test("TOOL1: an unreadable install reports drift with null installed", () => {
	const pins = parseInfraPins(GOOD)!;
	const drift = diffInfraPins(pins, { bun: "1.4.0", "typescript-language-server": null });
	expect(drift).toEqual([{ tool: "typescript-language-server", pinned: "4.3.3", installed: null }]);
});

test("TOOL1: malformed pins fail closed", () => {
	expect(parseInfraPins("not toml [[")).toBeNull();
	expect(parseInfraPins("[tools.bun]\nversion = \"1.4.0\"\n")).toBeNull();
	expect(parseInfraPins("[other]\nversion = \"1\"\n")).toBeNull();
	expect(parseInfraPins("")).toBeNull();
});
