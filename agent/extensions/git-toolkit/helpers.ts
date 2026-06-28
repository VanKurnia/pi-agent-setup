import { spawn } from "node:child_process";

// Helper to run git commands in a specific repository path using spawn (no shell)
export function runGit(repoPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("git", args, {
            cwd: repoPath,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d: Buffer) => {
            stdout += d.toString();
        });
        proc.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
        });

        proc.on("close", (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim() || stdout.trim() || `git exited with code ${code}`));
            }
        });

        proc.on("error", (err) => {
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
