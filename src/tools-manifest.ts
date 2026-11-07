import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tarMembers, type Member } from "./kit-release.ts";
import type { Command } from "./commands.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";

export type ToolArtifact = {
	readonly name: string;
	readonly url: string;
	readonly publisher_sha256: string;
	readonly binary_path: string;
	readonly binary_sha256: string;
	readonly signature: null; // Seed release publishes no detached signature.
};

// Maintainer-approved pins, not live release metadata or installation authority.
export const TOOL_MANIFEST = {
	ovnfs: {
		name: "ovnfs", version: "0.1.1",
		release_url: "https://github.com/stencil-hq/ovnfs/releases/tag/v0.1.1",
		publisher_checksums_url: "https://github.com/stencil-hq/ovnfs/releases/download/v0.1.1/ovnfs_0.1.1_checksums.txt",
		publisher_checksums_sha256: "25ddb6248218230b861251fce2e018260cd263f7717ad7f0960cecb90d0c3136",
		canary_command: ["ovnfs", "--version"], // Recorded only; never executed by verify.
		platforms: {
			darwin_arm64: {
				name: "ovnfs_0.1.1_darwin_arm64.tar.gz",
				url: "https://github.com/stencil-hq/ovnfs/releases/download/v0.1.1/ovnfs_0.1.1_darwin_arm64.tar.gz",
				publisher_sha256: "314a09c3b002c83f2b950f53b7f72061f90cbb2a6c1383dd05a0218a92723873",
				binary_path: "ovnfs",
				binary_sha256: "78d5a8290b293c8a80ac85d754096a1464682f6a1a2239efb1c051ced08340b9",
				signature: null,
			} satisfies ToolArtifact,
		},
	},
} as const;

export type ToolVerification = {
	overall: "VERIFIED" | "REFUSED";
	field: string | null;
	expected: string | null;
	actual: string | null;
};
const refused = (field: string, expected: string | null, actual: string | null): ToolVerification => ({ overall: "REFUSED", field, expected, actual });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Hash before parsing. The shared bounded tar reader neither extracts nor executes. */
export function verifyToolArtifact(bytes: Buffer, pin: ToolArtifact): ToolVerification {
	const archiveHash = sha256(bytes);
	if (archiveHash !== pin.publisher_sha256) return refused("publisher_sha256", pin.publisher_sha256, archiveHash);
	let members: Member[];
	try { members = tarMembers(bytes); }
	catch (error) { return refused("archive", "safe tar archive", error instanceof Error ? error.message : String(error)); }
	const binary = members.find(member => member.path === pin.binary_path && member.kind === "file");
	if (!binary) return refused("binary_path", pin.binary_path, null);
	const binaryHash = sha256(binary.bytes);
	if (binaryHash !== pin.binary_sha256) return refused("binary_sha256", pin.binary_sha256, binaryHash);
	return { overall: "VERIFIED", field: null, expected: null, actual: null };
}

export async function verifyTool(name: string, options: { artifact?: string; platform?: string } = {}): Promise<ToolVerification> {
	if (name !== "ovnfs") return refused("name", Object.keys(TOOL_MANIFEST).join(", "), name);
	const platform = options.platform ?? `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
	if (platform !== "darwin_arm64") return refused("platform", Object.keys(TOOL_MANIFEST.ovnfs.platforms).join(", "), platform);
	const pin = TOOL_MANIFEST.ovnfs.platforms[platform];
	try {
		const bytes = options.artifact ? await readFile(options.artifact) : await download(pin.url);
		return verifyToolArtifact(bytes, pin);
	} catch (error) {
		return refused(options.artifact ? "artifact" : "download", options.artifact ?? pin.url, error instanceof Error ? error.message : String(error));
	}
}

async function download(url: string): Promise<Buffer> {
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

export async function toolsVerifyCommand(request: ParsedCommand): Promise<CliResult> {
	const artifact = request.flags.get("--artifact"), platform = request.flags.get("--platform");
	const result = await verifyTool(request.argument ?? "", {
		...(typeof artifact === "string" ? { artifact } : {}),
		...(typeof platform === "string" ? { platform } : {}),
	});
	return { code: result.overall === "VERIFIED" ? 0 : 2,
		data: { ...result, text: `${result.overall}${result.field ? ` ${result.field}: expected ${result.expected}; actual ${result.actual}` : " pinned archive and binary sha256 match (no code executed)"}` },
		verification: "PERFORMED" };
}

export const TOOLS_COMMAND: Command = {
	name: "tools", description: "Read-only pinned external-tool provenance; no install or execution authority",
	usage: "tools verify NAME [--artifact PATH] [--platform OS_ARCH]", flags: [],
	example: "omp-kit tools verify ovnfs --platform darwin_arm64 --json", runnable: false,
	subcommands: [{ name: "verify", description: "Verify downloaded or local archive and binary hashes against kit-owned pins; never executes the canary",
		usage: "tools verify NAME [--artifact PATH] [--platform OS_ARCH]", argument: "NAME", flags: [
			{ name: "--artifact", value: "PATH", description: "Read this local artifact instead of downloading the pinned release" },
			{ name: "--platform", value: "OS_ARCH", description: "Select a pinned artifact independently of the host (default: current platform)" },
		], example: "omp-kit tools verify ovnfs --platform darwin_arm64 --json", runnable: false,
		dataSchema: { type: "object", required: ["overall", "field", "expected", "actual", "text"], properties: {
			overall: { enum: ["VERIFIED", "REFUSED"] }, field: { type: ["string", "null"] },
			expected: { type: ["string", "null"] }, actual: { type: ["string", "null"] }, text: { type: "string" },
		} },
	}],
};
