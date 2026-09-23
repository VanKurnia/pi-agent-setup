import { readFileSync } from "node:fs";

/** Read a text file, returning null on any error (missing, EACCES, etc.). */
export function safeReadText(path: string): string | null {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}
