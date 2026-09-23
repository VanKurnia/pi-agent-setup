/**
 * Shared ANSI-stripping helper. Handles OSC/extended sequences the
 * narrower `\u001b\[[0-9;]*[a-zA-Z]` pattern misses.
 */
// Kept module-private: global-flag regexes carry stateful lastIndex,
// so sharing the raw pattern invites unsafe direct .test()/.exec() use.
const ANSI_PATTERN =
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_PATTERN, "");
}
