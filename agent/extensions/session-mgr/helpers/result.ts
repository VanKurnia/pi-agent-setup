/** Local result helper — keeps session-mgr independent of git-toolkit. */

export function ok(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
}
