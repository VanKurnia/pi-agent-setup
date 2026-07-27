import { spawn } from "node:child_process";

export function runGit(
    repoPath: string,
    args: string[],
    options?: { signal?: AbortSignal }
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (options?.signal?.aborted) {
            return reject(new DOMException("Operation aborted", "AbortError"));
        }

        const proc = spawn("git", args, {
            cwd: repoPath,
            stdio: ["ignore", "pipe", "pipe"],
            signal: options?.signal,
        });

        let stdout = "";
        let stderr = "";
        let done = false;

        const onAbort = () => {
            done = true;
            reject(new DOMException("Operation aborted", "AbortError"));
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });

        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        proc.on("close", (code) => {
            if (done) return;
            done = true;
            options?.signal?.removeEventListener("abort", onAbort);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || stdout.trim() || `git exited with code ${code}`));
        });

        proc.on("error", (err) => {
            if (done) return;
            done = true;
            options?.signal?.removeEventListener("abort", onAbort);
            reject(new Error(`Failed to spawn git: ${err.message}`));
        });
    });
}

export function ok(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
}

export function fail(message: string) {
    return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true as const,
        details: {},
    };
}
