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
// OVNFSTRACK1: the pin tracks the installed ovnfs release (0.4.0); `tools update`
// resolves newer releases at run time and verifies them against the publisher
// checksums, so this file no longer claims 0.1.1.
export const TOOL_MANIFEST = {
	ovnfs: {
		name: "ovnfs", version: "0.4.0",
		release_url: "https://github.com/stencil-hq/ovnfs/releases/tag/v0.4.0",
		publisher_checksums_url: "https://github.com/stencil-hq/ovnfs/releases/download/v0.4.0/ovnfs_0.4.0_checksums.txt",
		publisher_checksums_sha256: "810a43a5bb42e78b79f532eae8d55e602320955d83cc53176e46091bcea0e468",
		canary_command: ["ovnfs", "--version"], // Recorded only; never executed by verify.
		platforms: {
			darwin_arm64: {
				name: "ovnfs_0.4.0_darwin_arm64.tar.gz",
				url: "https://github.com/stencil-hq/ovnfs/releases/download/v0.4.0/ovnfs_0.4.0_darwin_arm64.tar.gz",
				publisher_sha256: "d0019aadb6842643401ab869e5f18f5237bbd15799bcedd35257055203833b0e",
				binary_path: "ovnfs",
				binary_sha256: "3922ffba5881e1808123bc9a217154bcb6b6795a549745f4e958137d8879b9e5",
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
	name: "tools", description: "Pinned external-tool provenance and ovnfs update with proven swap",
	usage: "tools verify NAME [--artifact PATH] [--platform OS_ARCH] | tools update ovnfs [--plan | --apply]", flags: [],
	example: "omp-kit tools update ovnfs --apply --json", runnable: false,
	subcommands: [{ name: "verify", description: "Verify downloaded or local archive and binary hashes against kit-owned pins; never executes the canary",
		usage: "tools verify NAME [--artifact PATH] [--platform OS_ARCH]", argument: "NAME", flags: [
			{ name: "--artifact", value: "PATH", description: "Read this local artifact instead of downloading the pinned release" },
			{ name: "--platform", value: "OS_ARCH", description: "Select a pinned artifact independently of the host (default: current platform)" },
		], example: "omp-kit tools verify ovnfs --platform darwin_arm64 --json", runnable: false,
		dataSchema: { type: "object", required: ["overall", "field", "expected", "actual", "text"], properties: {
			overall: { enum: ["VERIFIED", "REFUSED"] }, field: { type: ["string", "null"] },
			expected: { type: ["string", "null"] }, actual: { type: ["string", "null"] }, text: { type: "string" },
		} },
	},
	{ name: "update", description: "Update ovnfs from its release with checksum verification, release-tagged skill refresh and a proven daemon swap with rollback; never changes file modes under the daemon state",
		usage: "tools update ovnfs [--plan | --apply]", argument: "NAME", flags: [
			{ name: "--plan", description: "Preview the available update without changing files" },
			{ name: "--apply", description: "Download, verify, atomically install, refresh the skill and swap the daemon with rollback" },
		], example: "omp-kit tools update ovnfs --apply --json", runnable: false,
		dataSchema: { type: "object", required: ["overall", "tool"], properties: {
			overall: { enum: ["CURRENT", "UPDATE_AVAILABLE", "UPDATED", "DEFERRED_LOAD", "REFUSED", "FAILED"] }, tool: { type: "string" }, text: { type: "string" },
		} },
	}],
};
