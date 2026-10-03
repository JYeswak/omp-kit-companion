/** Validate an externally supplied lowercase SHA-256 hex digest without scanning beyond its fixed width. */
export function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
