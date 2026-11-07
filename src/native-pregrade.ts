import { nativeIdentity, type NativeContext, type NativeExec } from "../extensions/native-identity.ts";

/** Native callers use their own host identity, not an inherited seat actor. */
export async function checkNativeClose(ctx: NativeContext, bead: { id: string; assignee: string | null; acceptance: string | null; comments: readonly { author: string; text: string }[] }, _repo: string, _reason: string | null, _exec: NativeExec): Promise<void> {
	const identity = nativeIdentity(ctx);
	if (!identity) throw new Error("NATIVE_IDENTITY_UNBOUND");
	const authors = [bead.assignee, ...bead.comments.filter(comment => comment.text.trimStart().startsWith("DONE ")).map(comment => comment.author)];
	if (authors.some(author => author?.trim().toLowerCase() === identity.id.toLowerCase())) throw new Error("NATIVE_SELF_REFUSED: caller is the bead assignee or filer");
}
