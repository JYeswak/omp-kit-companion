/**
 * TERNID1: lossless `tern inspect --json` decoding, shared by extensions (mail wake) and src (plane-tern,
 * holder liveness). Library module with no extension entrypoint: it lives under extensions/ because
 * shipped extensions load unbundled and may import only extensions/, while src may import from here.
 *
 * Quote Tern's integer id tokens before JSON.parse, as rch-cycle does for build ids: block ids exceed 2^53,
 * so a bare JSON.parse rounds 9374096836001793 onto 9374096836001792 and targets a neighbour.
 * Consume whole JSON strings too: a title containing `"id":123` must remain inert.
 * Only integer tokens at a JSON value boundary qualify; fractions/exponents are not ids.
 */
export function parseTernJson(raw: string): unknown {
	return JSON.parse(raw.replace(/"((?:[^"\\]|\\.)*)"(?:([ \t\r\n]*:[ \t\r\n]*)(0|[1-9][0-9]*)(?=[ \t\r\n]*[,}]))?/g,
		(match, key: string, separator: string | undefined, id: string | undefined) =>
			id !== undefined && (key === "id" || key === "pane") ? `"${key}"${separator}"${id}"` : match)) as unknown;
}
