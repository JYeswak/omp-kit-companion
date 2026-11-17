// The exact SDK source versions the two native suites consume. Shared by the
// test files and scripts/seed-sdk-source.ts so the requested version has one
// source of truth; behavioral assertions and version checks stay in the tests.
export type SdkSourceKind = "lifecycle" | "pty";
export const LIFECYCLE_SDK_DEFAULT_VERSION = "18.21.0";
export const PTY_SDK_VERSION = "18.22.0";
/** Requested SDK source version: lifecycle honors KIT_SDK_LIFECYCLE_VERSION, PTY is pinned. */
export function sdkSourceVersion(kind: SdkSourceKind, env: Record<string, string | undefined>): string {
	if (kind === "pty") return PTY_SDK_VERSION;
	return env.KIT_SDK_LIFECYCLE_VERSION ?? LIFECYCLE_SDK_DEFAULT_VERSION;
}
