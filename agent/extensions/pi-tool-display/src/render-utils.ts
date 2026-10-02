import { homedir } from "node:os";
import { sanitizeAnsiForThemedOutput } from "./support.js";

export { sanitizeAnsiForThemedOutput };

export function shortenPath(inputPath: string | undefined): string {
    if (!inputPath) {
        return "";
    }
    const home = homedir();
    return inputPath.startsWith(home) ? `~${inputPath.slice(home.length)}` : inputPath;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return count === 1 ? singular : plural;
}

export function previewLines(
    lines: string[],
    maxLines: number,
): { shown: string[]; remaining: number } {
    const limit = Math.max(0, maxLines);
    const shown = lines.slice(0, limit);
    const remaining = Math.max(0, lines.length - shown.length);
    return { shown, remaining };
}
