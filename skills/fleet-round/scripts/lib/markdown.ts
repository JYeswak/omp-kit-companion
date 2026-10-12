// Structural markdown reading for round reports and mission docs.
//
// Parser: Bun's built-in CommonMark/GFM parser (`Bun.markdown.render`, Bun >= 1.3) is the only
// authority on block structure: which lines are top-level paragraphs, which are headings, which are
// fenced code and in what language. Nothing here re-derives structure from raw lines. Original
// source text is used only to (a) recover exact paragraph lines and their 1-based line numbers by
// verbatim sequential lookup and (b) refuse a paragraph line the parser rewrote (inline markup,
// escapes), so a value is never taken from a rendering that differs from what the author wrote.

export type Heading = { kind: "heading"; level: number; text: string; line: number | null; nested: boolean };
export type Paragraph = { kind: "paragraph"; lines: { text: string; line: number | null }[]; nested: boolean };
export type Code = { kind: "code"; language: string | null; fenced: boolean; text: string; nested: boolean };
export type Block = Heading | Paragraph | Code;

const MARK = "\u0000";

/** Parse markdown into document-ordered blocks; `nested` marks blocks inside quotes or list items. */
export function parseBlocks(source: string): Block[] {
	const blocks: Block[] = [];
	const nested = new Set<number>();
	const token = (index: number): string => `${MARK}${index}${MARK}`;
	const container = (children: string): string => {
		const parts = children.split(MARK);
		for (let i = 1; i < parts.length; i += 2) nested.add(Number(parts[i]));
		return "";
	};
	const inline = (open: string, close = open) => (children: string): string => `${open}${children}${close}`;
	Bun.markdown.render(source, {
		heading: (children: string, meta: { level: number }) => {
			blocks.push({ kind: "heading", level: meta.level, text: children, line: null, nested: false });
			return token(blocks.length - 1);
		},
		paragraph: (children: string) => {
			blocks.push({ kind: "paragraph", lines: children.split("\n").map(text => ({ text, line: null })), nested: false });
			return token(blocks.length - 1);
		},
		code: (children: string, meta?: { language?: string }) => {
			blocks.push({ kind: "code", language: meta?.language ?? null, fenced: meta !== undefined, text: children, nested: false });
			return token(blocks.length - 1);
		},
		blockquote: container,
		listItem: container,
		list: (children: string) => children,
		codespan: inline("`"),
		emphasis: inline("*"),
		strong: inline("**"),
		strikethrough: inline("~~"),
		link: (children: string) => children,
		image: (children: string) => children,
	});
	for (const index of nested) {
		const block = blocks[index];
		if (block) block.nested = true;
	}
	locate(source, blocks);
	return blocks;
}

/** Leading-indent-stripped (at most 3 spaces, CommonMark's paragraph allowance) and trailing-trimmed source line. */
function normalized(line: string): string {
	let start = 0;
	while (start < 3 && line[start] === " ") start++;
	return line.slice(start).trimEnd();
}

/** ATX heading text of a source line at `level`, or null. Mirrors CommonMark's ATX rule without a regex. */
function atxText(line: string, level: number): string | null {
	const body = normalized(line);
	let hashes = 0;
	while (body[hashes] === "#") hashes++;
	if (hashes !== level) return null;
	const rest = body.slice(hashes);
	if (rest !== "" && rest[0] !== " " && rest[0] !== "\t") return null;
	let text = rest.trim();
	let end = text.length;
	while (end > 0 && text[end - 1] === "#") end--;
	if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
	return text;
}

/** Assign 1-based source lines to headings and paragraph lines by verbatim sequential lookup. */
function locate(source: string, blocks: Block[]): void {
	const lines = source.split("\n").map(line => (line.endsWith("\r") ? line.slice(0, -1) : line));
	let cursor = 0;
	for (const block of blocks) {
		if (block.kind === "code") {
			const first = block.text.split("\n")[0] ?? "";
			if (first === "") continue;
			for (let i = cursor; i < lines.length; i++) {
				if (lines[i]!.includes(first)) {
					cursor = i + block.text.split("\n").length - 1;
					break;
				}
			}
			continue;
		}
		if (block.kind === "heading") {
			for (let i = cursor; i < lines.length; i++) {
				const atx = atxText(lines[i]!, block.level);
				const setext = normalized(lines[i]!) === block.text && i + 1 < lines.length && isSetextUnderline(lines[i + 1]!, block.level);
				if (atx === block.text || setext) {
					block.line = i + 1;
					cursor = i + 1;
					break;
				}
			}
			continue;
		}
		for (const entry of block.lines) {
			for (let i = cursor; i < lines.length; i++) {
				if (normalized(lines[i]!) === entry.text) {
					entry.line = i + 1;
					cursor = i + 1;
					break;
				}
			}
		}
	}
}

function isSetextUnderline(line: string, level: number): boolean {
	const body = normalized(line);
	const char = level === 1 ? "=" : level === 2 ? "-" : "";
	return char !== "" && body.length > 0 && [...body].every(c => c === char);
}

/** Fenced code blocks tagged `json` (language compared case-insensitively), in document order. */
export function jsonFences(blocks: Block[]): Code[] {
	return blocks.filter((block): block is Code => block.kind === "code" && block.fenced && (block.language ?? "").toLowerCase() === "json");
}
