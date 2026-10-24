/** CC registry interpreter. The generated table is shared with cclib.Registry, not a second field allowlist.
 * Refresh with scripts/generate-cc-schema.py; validate before construction returns and again before append.
 * Refusal strings contain fixed codes only, never producer-supplied field names or values.
 */
import { createHash } from "node:crypto";
import events from "./cc-events.v1.json";
import { isRecord } from "./type-guards.ts";

type Row = Record<string, unknown>;
export interface CcValidationIssue {
	code: string;
	/** Declared field path or a fixed scope marker; never an untrusted extra field name. */
	field: string | null;
}
interface Field {
	type: string;
	required?: boolean;
	nullable?: boolean;
	enum?: unknown[];
	enum_ref?: string;
	minimum?: number;
	maximum?: number;
	min_length?: number;
	max_length?: number;
	code?: boolean;
	items?: Field;
	fields?: Record<string, Field>;
}
interface EventSpec {
	version: number;
	data: Record<string, Field>;
	seat_scoped?: boolean;
	requires?: string[];
	requires_data?: string[];
}
interface Registry {
	schema_version: string;
	envelope: Record<string, Field>;
	types: Record<string, EventSpec>;
	producers: Record<string, { owner: string }>;
	tool_categories: string[];
	unknown_classes: string[];
	cost_authorities: { provider_receipts: Record<string, Row>; pricing: Record<string, Row> };
}
const registry: Registry = events;
const enums: Record<string, unknown[]> = { tool_categories: registry.tool_categories, unknown_classes: registry.unknown_classes };
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const costBuckets = ["input", "output", "cache_read", "cache_write"] as const;

function own(object: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}
export function ccProducerOwner(producer: string): string | undefined {
	return own(registry.producers, producer) ? registry.producers[producer]!.owner : undefined;
}
export function ccTypeVersion(type: string): number | undefined {
	return own(registry.types, type) ? registry.types[type]!.version : undefined;
}
function typed(kind: string, value: unknown): boolean {
	switch (kind) {
		case "string": return typeof value === "string";
		case "integer": return typeof value === "number" && Number.isSafeInteger(value);
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "boolean": return typeof value === "boolean";
		case "array": return Array.isArray(value);
		case "object": return isRecord(value);
		default: throw new Error("REGISTRY_SPEC_UNSUPPORTED");
	}
}
function codeCharacter(char: number): boolean {
	return (char >= 65 && char <= 90) || (char >= 97 && char <= 122) ||
		(char >= 48 && char <= 57) || char === 95 || char === 46 || char === 45;
}
function stringError(spec: Field, value: string): string | null {
	let length = 0;
	let code = true;
	for (const character of value) {
		length++;
		if (spec.code && !codeCharacter(character.codePointAt(0)!)) code = false;
	}
	if (length < (spec.min_length ?? 0) || length > (spec.max_length ?? 256)) return "FIELD_LENGTH";
	if (spec.code && (length === 0 || length > 64 || !code)) return "FIELD_CODE";
	return null;
}
function valueError(spec: Field, value: unknown): string | null {
	if (value === null) return spec.nullable ? null : "FIELD_NULL";
	if (!typed(spec.type, value)) return "FIELD_TYPE";
	const choices = spec.enum ?? (spec.enum_ref ? enums[spec.enum_ref] : undefined);
	if (choices && !choices.includes(value)) return "FIELD_ENUM";
	if (typeof value === "number" && ((spec.minimum !== undefined && value < spec.minimum) ||
		(spec.maximum !== undefined && value > spec.maximum))) return "FIELD_RANGE";
	if (typeof value === "string") return stringError(spec, value);
	if (spec.fields && isRecord(value)) {
		const error = fieldsError(spec.fields, value);
		if (error) return error.code;
	}
	if (spec.items && Array.isArray(value)) {
		for (const item of value) if (valueError(spec.items, item)) return "ITEM_INVALID";
	}
	return null;
}
function fieldsError(fields: Record<string, Field>, value: Row): CcValidationIssue | null {
	for (const name in fields) {
		if (!own(fields, name)) continue;
		const spec = fields[name]!;
		if (!own(value, name)) {
			if (spec.required !== false) return { code: "FIELD_MISSING", field: name };
			continue;
		}
		const code = valueError(spec, value[name]);
		if (code) return { code, field: name };
	}
	for (const name in value) if (own(value, name) && !own(fields, name)) return { code: "FIELD_UNDECLARED", field: "#" };
	return null;
}
function digits(text: string, start: number, end: number): number {
	if (start === end) return Number.NaN;
	let value = 0;
	for (let i = start; i < end; i++) {
		const char = text.charCodeAt(i);
		if (!(char >= 48 && char <= 57)) return Number.NaN;
		value = value * 10 + char - 48;
	}
	return value;
}
/** Python 3.9 datetime.fromisoformat clock grammar; timezone components are normalized before the <24h bound. */
function clockMicros(text: string, start: number, end: number, zone: boolean): number {
	const hours = digits(text, start, start + 2);
	let minutes = 0;
	let seconds = 0;
	let fraction = 0;
	let cursor = start + 2;
	if (cursor < end) {
		if (text[cursor] !== ":") return Number.NaN;
		minutes = digits(text, cursor + 1, cursor + 3);
		cursor += 3;
	}
	if (cursor < end) {
		if (text[cursor] !== ":") return Number.NaN;
		seconds = digits(text, cursor + 1, cursor + 3);
		cursor += 3;
	}
	if (cursor < end) {
		const count = end - cursor - 1;
		if (text[cursor] !== "." || (count !== 3 && count !== 6)) return Number.NaN;
		fraction = digits(text, cursor + 1, end) * (count === 3 ? 1000 : 1);
		cursor = end;
	}
	if (cursor !== end || (!zone && (hours > 23 || minutes > 59 || seconds > 59))) return Number.NaN;
	const value = ((hours * 60 + minutes) * 60 + seconds) * 1_000_000 + fraction;
	return value < 86_400_000_000 ? value : Number.NaN;
}
function validTime(input: string): boolean {
	const z = input.indexOf("Z");
	if (z !== -1 && z !== input.length - 1) return false;
	const text = z === -1 ? input : `${input.slice(0, -1)}+00:00`;
	if (text[4] !== "-" || text[7] !== "-") return false;
	const year = digits(text, 0, 4);
	const month = digits(text, 5, 7);
	const day = digits(text, 8, 10);
	if (!(year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1)) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	if (day > monthDays[month - 1]! + (month === 2 && leap ? 1 : 0)) return false;
	const start = (text.codePointAt(10) ?? 0) > 0xffff ? 12 : 11;
	let zone = text.indexOf("-", start);
	if (zone === -1) zone = text.indexOf("+", start);
	if (zone === -1 || !Number.isFinite(clockMicros(text, start, zone, false))) return false;
	const length = text.length - zone - 1;
	if (length !== 5 && length !== 8 && length !== 15) return false;
	return Number.isFinite(clockMicros(text, zone + 1, text.length, true));
}
function legacyModelSpec(): EventSpec {
	const spec = registry.types["model.usage"]!;
	const data: Record<string, Field> = {};
	for (const key of ["provider", "model", "purpose", "input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens", "cost_usd"]) {
		const field = spec.data[key]!;
		data[key] = key === "reasoning_tokens" || key === "cost_usd" ? { ...field, nullable: false } : field;
	}
	return { ...spec, version: 1, data };
}
const modelUsageV1 = legacyModelSpec();
function eventSpec(env: Row): EventSpec | undefined {
	const type = env.type as string;
	if (!own(registry.types, type)) return undefined;
	return type === "model.usage" && env.dataschema === "model.usage@1" ? modelUsageV1 : registry.types[type];
}
function coverageError(data: Row): string | null {
	const seen = new Set<string>();
	for (const item of data.coverage as Row[]) {
		const key = JSON.stringify([item.runtime_version, item.record_type]);
		if (seen.has(key)) return "COVERAGE_DUPLICATE_KEY";
		seen.add(key);
		if ((item.disposition === "ignored" || item.disposition === "unknown" || item.disposition === "unavailable") &&
			!item.reason) return "COVERAGE_REASON_MISSING";
		if (item.disposition === "unavailable" && item.count !== 0) return "UNAVAILABLE_WITH_RECORDS";
	}
	return null;
}
function approvedReceipt(env: Row, data: Row): boolean {
	const key = data.provider_billing_sha;
	const approved = typeof key === "string" && own(registry.cost_authorities.provider_receipts, key)
		? registry.cost_authorities.provider_receipts[key] : undefined;
	if (!approved) return false;
	for (const field of ["usage_key", "provider", "model", "cost_usd"]) if (approved[field] !== (data[field] ?? null)) return false;
	return approved.producer === env.producer && approved.binding === (env.binding ?? null) &&
		approved.currency === "USD" && approved.source === "provider-billed";
}
function approvedPricing(data: Row): boolean {
	if (!isRecord(data.pricing)) return false;
	const key = data.pricing.pricing_sha;
	const approved = typeof key === "string" && own(registry.cost_authorities.pricing, key)
		? registry.cost_authorities.pricing[key] : undefined;
	if (!approved || approved.provider !== data.provider || approved.model !== data.model ||
		approved.currency !== "USD" || approved.source !== "catalog") return false;
	for (const bucket of costBuckets) {
		const field = `${bucket}_per_million`;
		if (approved[field] !== data.pricing[field]) return false;
	}
	return true;
}
function pricingError(env: Row, data: Row): string | null {
	if (!approvedPricing(data) || (data.provider_billing_sha ?? null) !== null) return "COST_AUTHORITY_MISSING";
	const pricing = data.pricing as Row;
	let expected = 0;
	for (const bucket of costBuckets) {
		expected += (pricing[`${bucket}_tokens`] as number) * (pricing[`${bucket}_per_million`] as number) / 1_000_000;
	}
	const cost = data.cost_usd as number;
	if (!Number.isFinite(expected) || Math.abs(cost - expected) > Math.max(1e-12, 1e-9 * Math.max(Math.abs(cost), Math.abs(expected)))) {
		return "COST_PRICING_MISMATCH";
	}
	if (env.type === "model.usage") for (const bucket of costBuckets) {
		if (data[`${bucket}_tokens`] !== pricing[`${bucket}_tokens`]) return "COST_PRICING_MISMATCH";
	}
	return null;
}
function costError(env: Row, data: Row): string | null {
	if (data.cost_source === "unknown" && data.cost_usd !== null) return "COST_UNKNOWN_WITH_VALUE";
	if (data.cost_source !== "unknown" && data.cost_usd === null) return "COST_NULL_WITH_SOURCE";
	if (data.cost_source === "provider") {
		if (!approvedReceipt(env, data) || (data.pricing ?? null) !== null) return "COST_AUTHORITY_MISSING";
	} else if (data.cost_source === "derived") {
		const error = pricingError(env, data);
		if (error) return error;
	} else if ((data.provider_billing_sha ?? null) !== null || (data.pricing ?? null) !== null) return "COST_AUTHORITY_MISSING";
	if (env.type === "model.usage" && ((data.reasoning_tokens === null) !== (data.reasoning_source === "unknown"))) return "REASONING_SOURCE_MISMATCH";
	return null;
}
function crossFieldError(env: Row, data: Row): string | null {
	if (env.type === "seat.binding") {
		const expected = createHash("sha256").update(`${data.block}\x1f${data.session_file}`, "utf8").digest("hex").slice(0, 32);
		if (env.binding !== expected) return "BINDING_MISMATCH";
	}
	if (env.type === "mail.sent" && data.ack_required && !data.request_id) return "DATA_KEY_REQUIRED";
	if (env.type === "mail.delivery" && env.agent !== data.recipient) return "AGENT_RECIPIENT_MISMATCH";
	if (env.type === "service.state" && data.query_ok === false && data.loaded === false) return "LOADED_FALSE_WITH_FAILED_QUERY";
	if (env.type === "service.state" && data.query_ok === true && data.loaded === null) return "LOADED_NULL_WITH_OK_QUERY";
	if (env.type === "source.tick") return coverageError(data);
	if (env.type === "session.exit") for (const key of ["reason_sha", "kind_sha"]) {
		const text = data[key] as string;
		if (text.length !== 64) return "FIELD_CODE";
		for (const char of text) if (!"0123456789abcdef".includes(char)) return "FIELD_CODE";
	}
	if ((env.type === "model.usage" || env.type === "model.usage.cost_resolution") && env.dataschema !== "model.usage@1") return costError(env, data);
	return null;
}
/** Schema validation after JSON serialization bounds are checked by cc-spool. */
export function ccEnvelopeError(env: unknown): CcValidationIssue | null {
	if (!isRecord(env)) return { code: "ENVELOPE_NOT_OBJECT", field: null };
	let error = fieldsError(registry.envelope, env);
	if (error) return { code: error.code, field: `envelope.${error.field}` };
	if (!own(registry.producers, env.producer as string)) return { code: "PRODUCER_UNDECLARED", field: "envelope.producer" };
	const spec = eventSpec(env);
	if (!spec) return { code: "TYPE_UNDECLARED", field: "envelope.type" };
	if (env.dataschema !== `${env.type}@${spec.version}`) return { code: "SCHEMA_VERSION", field: "envelope.dataschema" };
	const id = env.id as string;
	if (id.length !== 32) return { code: "ID_FORMAT", field: "envelope.id" };
	for (const char of id) if (!"0123456789abcdef".includes(char)) return { code: "ID_FORMAT", field: "envelope.id" };
	const expected = createHash("sha256").update(`${env.producer}\x1f${env.position}\x1f${env.type}`, "utf8").digest("hex").slice(0, 32);
	if (id !== expected) return { code: "ID_MISMATCH", field: "envelope.id" };
	for (const field of ["time", "observed"]) if (!validTime(env[field] as string)) return { code: "TIME_FORMAT", field: `envelope.${field}` };
	for (const key of spec.requires ?? []) if (!env[key]) return { code: "ENVELOPE_KEY_REQUIRED", field: `envelope.${key}` };
	if (spec.seat_scoped && !env.seat) return { code: "ENVELOPE_KEY_REQUIRED", field: "envelope.seat" };
	const data = env.data as Row;
	error = fieldsError(spec.data, data);
	if (error) return { code: error.code, field: `data.${error.field}` };
	for (const key of spec.requires_data ?? []) {
		const value = data[key];
		if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
			return { code: "DATA_KEY_REQUIRED", field: `data.${key}` };
		}
	}
	const code = crossFieldError(env, data);
	if (!code) return null;
	const field = code === "BINDING_MISMATCH" ? "envelope.binding" :
		code === "AGENT_RECIPIENT_MISMATCH" ? "envelope.agent" : "data";
	return { code, field };
}
