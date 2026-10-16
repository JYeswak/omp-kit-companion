import data from './catalog.json';
export type Context = 'host' | 'window' | 'carly' | 'host-effect' | 'host-block' | 'host-lens';
export type Member = {
    symbol: string;
    kind: string;
    contexts: string[];
    awaitable: boolean;
    read_only: boolean;
    source: string;
    declaration: string;
    declaring_type: string | null;
    route: string;
    runtime_verified: boolean;
};
export const CATALOG = data;
export const MEMBERS = data.members as Member[];
export const bySymbol = new Map(MEMBERS.map(m => [m.symbol, m]));
export class TernError extends Error {
    code: string;
    exit: number;
    details: unknown;
    constructor(code: string, message: string, exit = 2, details: unknown = null) {
        super(message);
        this.name = 'TernError';
        this.code = code;
        this.exit = exit;
        this.details = details;
    }
}
export function member(symbol: string): Member {
    const value = bySymbol.get(symbol);
    if (!value)
        throw new TernError('UNKNOWN_SDK_MEMBER', `Not in the reviewed SDK: ${symbol}`);
    return value;
}
export function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function fail(code: string, message: string): never { throw new TernError(code, message); }
export function string(value: unknown, name: string): string {
    if (typeof value !== 'string')
        fail('INVALID_ARGUMENT', `${name} must be a string`);
    return value;
}
export function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
    const extra = Object.keys(value).filter(k => !allowed.includes(k));
    if (extra.length)
        fail('UNKNOWN_FIELDS', `${label}: ${extra.join(', ')}`);
}
