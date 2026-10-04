import * as http from "node:http";
import * as crypto from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanProposal, PlanComment, PlanSection } from "./types.ts";
import { marked } from "marked";

const CSP =
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' data:;";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read lazily: this module is imported eagerly by index.ts, so the three asset
// reads used to run on every Pi boot even though the plan server is usually
// never started. Cached after the first access.
type StaticAssets = { html: string; css: string; js: string };
let staticAssets: StaticAssets | undefined;
function getStaticAssets(): StaticAssets {
    if (!staticAssets) {
        staticAssets = {
            html: readFileSync(join(__dirname, "page.html"), "utf-8"),
            css: readFileSync(join(__dirname, "page.css"), "utf-8"),
            js: readFileSync(join(__dirname, "page.js"), "utf-8"),
        };
    }
    return staticAssets;
}

// ── Inlined from markdown.ts (file deleted) ─────────────────────────
const COPY_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const renderer = {
    code({ text, lang }: { text: string; lang?: string; escaped?: boolean }) {
        if (lang === "mermaid") {
            return `<pre class="mermaid">${text}</pre>\n`;
        }
        const badge = lang ? `<span class="lang-badge">${escapeHtml(lang)}</span>` : "";
        const lines = escapeHtml(text)
            .split("\n")
            .map((l) => `<span class="line">${l || " "}</span>`)
            .join("\n");
        return `<div class="code-block"><div class="code-header">${badge}<button class="copy-btn" onclick="copyCode(this)" title="Copy code">${COPY_ICON}</button></div><pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${lines}</code></pre></div>\n`;
    },
};

marked.use({ renderer });

export function renderMarkdown(md: string): string {
    return marked.parse(md, { gfm: true, breaks: false, async: false }) as string;
}

function isHeading(line: string): [number, string] | null {
    const m = line.match(/^(#{1,3})\s+(.+)/);
    return m ? [m[1].length, m[2].trim()] : null;
}

export function extractSections(md: string): PlanSection[] {
    const lines = md.split("\n");
    const sections: PlanSection[] = [];
    let currentTitle = "";
    let currentLevel = 0;
    let currentContentLines: string[] = [];
    let sectionStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const hd = isHeading(lines[i]);
        if (hd) {
            if (currentLevel > 0) {
                sections.push({
                    title: currentTitle,
                    level: currentLevel,
                    content: renderMarkdown(currentContentLines.join("\n")),
                    startLine: sectionStart,
                    endLine: i,
                });
            }
            currentTitle = hd[1];
            currentLevel = hd[0];
            currentContentLines = [];
            sectionStart = i;
        } else {
            currentContentLines.push(lines[i]);
        }
    }

    if (currentLevel > 0) {
        sections.push({
            title: currentTitle,
            level: currentLevel,
            content: renderMarkdown(currentContentLines.join("\n")),
            startLine: sectionStart,
            endLine: lines.length,
        });
    }

    return sections;
}

export interface PlanServer {
    start(proposal: PlanProposal): Promise<string>;
    stop(): void;
    getProposal(): PlanProposal | null;
    isRunning(): boolean;
    getUrl(): string | null;
    onStop(cb: (() => void) | null): void;
}

export function createPlanServer(pi: ExtensionAPI): PlanServer {
    let server: http.Server | null = null;
    let token: string | null = null;
    let port: number | null = null;
    let proposal: PlanProposal | null = null;

    function getUrl(): string | null {
        return port && token ? `http://127.0.0.1:${port}/?token=${token}` : null;
    }

    let onStopCb: (() => void) | null = null;

    function onStop(cb: (() => void) | null) {
        onStopCb = cb;
    }

    function formatComments(p: PlanProposal): string {
        if (!p.comments || p.comments.length === 0) return "";
        const lines = p.comments.map((c) => {
            const sectionTitle =
                p.sections[c.sectionIndex]?.title || `section ${c.sectionIndex + 1}`;
            return `- [${sectionTitle}] "${c.text}"`;
        });
        return "\n\n**Review comments:**\n" + lines.join("\n");
    }

    function stop() {
        if (server) {
            server.close(() => {});
            server = null;
        }
        token = null;
        port = null;
        proposal = null;
        onStopCb?.();
    }

    function isRunning(): boolean {
        return server !== null;
    }

    async function start(newProposal: PlanProposal): Promise<string> {
        stop();

        token = crypto.randomBytes(16).toString("hex");
        proposal = newProposal;

        return new Promise((resolve) => {
            server = http.createServer((req, res) => {
                const url = new URL(req.url || "/", `http://${req.headers.host}`);
                const path = url.pathname;

                // Static assets — no token required
                if (path === "/page.css" && req.method === "GET") {
                    res.writeHead(200, {
                        "Content-Type": "text/css",
                        "Content-Security-Policy": CSP,
                    });
                    res.end(getStaticAssets().css);
                    return;
                }

                if (path === "/page.js" && req.method === "GET") {
                    res.writeHead(200, {
                        "Content-Type": "application/javascript",
                        "Content-Security-Policy": CSP,
                    });
                    res.end(getStaticAssets().js);
                    return;
                }

                // Everything else requires a valid token
                const tok = url.searchParams.get("token");
                if (tok !== token) {
                    res.writeHead(401, {
                        "Content-Type": "text/plain",
                        "Content-Security-Policy": CSP,
                    });
                    res.end("Unauthorized");
                    return;
                }

                // GET / → HTML page
                if (path === "/" && req.method === "GET") {
                    res.writeHead(200, {
                        "Content-Type": "text/html",
                        "Content-Security-Policy": CSP,
                    });
                    res.end(getStaticAssets().html);
                    return;
                }

                // GET /api/plan → JSON
                if (path === "/api/plan" && req.method === "GET") {
                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Content-Security-Policy": CSP,
                    });
                    res.end(JSON.stringify(proposal));
                    return;
                }

                // POST /api/proposal/comment
                if (path === "/api/proposal/comment" && req.method === "POST") {
                    let body = "";
                    let bodySize = 0;
                    const MAX_BODY = 100 * 1024;
                    req.on("data", (chunk) => {
                        bodySize += chunk.length;
                        if (bodySize > MAX_BODY) {
                            res.writeHead(413, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Request entity too large");
                            req.destroy();
                            return;
                        }
                        body += chunk;
                    });
                    req.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            if (proposal) {
                                const comment: PlanComment = {
                                    id: crypto.randomUUID(),
                                    sectionIndex: data.sectionIndex,
                                    text: data.text,
                                };
                                proposal.comments.push(comment);
                                // Persist comment to disk so the assistant can read it
                                try {
                                    if (!existsSync(join(__dirname, "..", "..", "..", ".plans")))
                                        mkdirSync(join(__dirname, "..", "..", "..", ".plans"), {
                                            recursive: true,
                                        });
                                    appendFileSync(
                                        join(
                                            __dirname,
                                            "..",
                                            "..",
                                            "..",
                                            ".plans",
                                            "comments.jsonl",
                                        ),
                                        JSON.stringify({
                                            ts: Date.now(),
                                            planId: proposal.id,
                                            planSummary: proposal.summary,
                                            sectionIndex: data.sectionIndex,
                                            text: data.text,
                                        }) + "\n",
                                    );
                                } catch {}
                                // Comment saved; no individual notification — batched on accept/review
                                res.writeHead(200, {
                                    "Content-Type": "application/json",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end(JSON.stringify(comment));
                            } else {
                                res.writeHead(404, {
                                    "Content-Type": "text/plain",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end("No proposal");
                            }
                        } catch {
                            res.writeHead(400, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Bad request");
                        }
                    });
                    return;
                }

                // POST /api/proposal/comment/edit
                if (path === "/api/proposal/comment/edit" && req.method === "POST") {
                    let body = "";
                    let bodySize = 0;
                    const MAX_BODY = 100 * 1024;
                    req.on("data", (chunk) => {
                        bodySize += chunk.length;
                        if (bodySize > MAX_BODY) {
                            res.writeHead(413, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Request entity too large");
                            req.destroy();
                            return;
                        }
                        body += chunk;
                    });
                    req.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            if (proposal) {
                                const comment = proposal.comments.find((c) => c.id === data.id);
                                if (!comment) {
                                    res.writeHead(404, {
                                        "Content-Type": "text/plain",
                                        "Content-Security-Policy": CSP,
                                    });
                                    res.end("Comment not found");
                                    return;
                                }
                                comment.text = data.text;
                                // Persist edit to disk
                                try {
                                    if (!existsSync(join(__dirname, "..", "..", "..", ".plans")))
                                        mkdirSync(join(__dirname, "..", "..", "..", ".plans"), {
                                            recursive: true,
                                        });
                                    appendFileSync(
                                        join(
                                            __dirname,
                                            "..",
                                            "..",
                                            "..",
                                            ".plans",
                                            "comments.jsonl",
                                        ),
                                        JSON.stringify({
                                            ts: Date.now(),
                                            planId: proposal.id,
                                            planSummary: proposal.summary,
                                            type: "comment-edit",
                                            commentId: comment.id,
                                            sectionIndex: comment.sectionIndex,
                                            text: data.text,
                                        }) + "\n",
                                    );
                                } catch {}
                                // Edit saved; no individual notification — batched on accept/review
                                res.writeHead(200, {
                                    "Content-Type": "application/json",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end(JSON.stringify(comment));
                            } else {
                                res.writeHead(404, {
                                    "Content-Type": "text/plain",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end("No proposal");
                            }
                        } catch {
                            res.writeHead(400, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Bad request");
                        }
                    });
                    return;
                }

                // POST /api/proposal/comment/delete
                if (path === "/api/proposal/comment/delete" && req.method === "POST") {
                    let body = "";
                    let bodySize = 0;
                    const MAX_BODY = 100 * 1024;
                    req.on("data", (chunk) => {
                        bodySize += chunk.length;
                        if (bodySize > MAX_BODY) {
                            res.writeHead(413, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Request entity too large");
                            req.destroy();
                            return;
                        }
                        body += chunk;
                    });
                    req.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            if (proposal) {
                                const idx = proposal.comments.findIndex((c) => c.id === data.id);
                                if (idx === -1) {
                                    res.writeHead(404, {
                                        "Content-Type": "text/plain",
                                        "Content-Security-Policy": CSP,
                                    });
                                    res.end("Comment not found");
                                    return;
                                }
                                const [removed] = proposal.comments.splice(idx, 1);
                                // Persist delete to disk
                                try {
                                    if (!existsSync(join(__dirname, "..", "..", "..", ".plans")))
                                        mkdirSync(join(__dirname, "..", "..", "..", ".plans"), {
                                            recursive: true,
                                        });
                                    appendFileSync(
                                        join(
                                            __dirname,
                                            "..",
                                            "..",
                                            "..",
                                            ".plans",
                                            "comments.jsonl",
                                        ),
                                        JSON.stringify({
                                            ts: Date.now(),
                                            planId: proposal.id,
                                            planSummary: proposal.summary,
                                            type: "comment-delete",
                                            commentId: removed.id,
                                            sectionIndex: removed.sectionIndex,
                                        }) + "\n",
                                    );
                                } catch {}
                                // Delete done; no individual notification — batched on accept/review
                                res.writeHead(200, {
                                    "Content-Type": "application/json",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end(JSON.stringify({ deleted: true, id: removed.id }));
                            } else {
                                res.writeHead(404, {
                                    "Content-Type": "text/plain",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end("No proposal");
                            }
                        } catch {
                            res.writeHead(400, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Bad request");
                        }
                    });
                    return;
                }

                // POST /api/proposal/accept
                if (path === "/api/proposal/accept" && req.method === "POST") {
                    if (proposal) {
                        proposal.status = "accepted";
                        pi.sendUserMessage(
                            `**Plan accepted**: "${proposal.summary}". Proceed with implementation.${formatComments(proposal)}`,
                            { deliverAs: "followUp" },
                        );
                        res.writeHead(200, {
                            "Content-Type": "application/json",
                            "Content-Security-Policy": CSP,
                        });
                        res.end(JSON.stringify({ status: "accepted" }));
                        res.on("finish", () =>
                            setTimeout(() => {
                                try {
                                    stop();
                                } catch {}
                            }, 15000),
                        );
                    } else {
                        res.writeHead(404, {
                            "Content-Type": "text/plain",
                            "Content-Security-Policy": CSP,
                        });
                        res.end("No proposal");
                    }
                    return;
                }

                // POST /api/proposal/review
                if (path === "/api/proposal/review" && req.method === "POST") {
                    let body = "";
                    let bodySize = 0;
                    const MAX_BODY = 100 * 1024;
                    req.on("data", (chunk) => {
                        bodySize += chunk.length;
                        if (bodySize > MAX_BODY) {
                            res.writeHead(413, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Request entity too large");
                            req.destroy();
                            return;
                        }
                        body += chunk;
                    });
                    req.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            if (proposal) {
                                proposal.status = "revising";
                                try {
                                    if (!existsSync(join(__dirname, "..", "..", "..", ".plans")))
                                        mkdirSync(join(__dirname, "..", "..", "..", ".plans"), {
                                            recursive: true,
                                        });
                                    appendFileSync(
                                        join(
                                            __dirname,
                                            "..",
                                            "..",
                                            "..",
                                            ".plans",
                                            "comments.jsonl",
                                        ),
                                        JSON.stringify({
                                            ts: Date.now(),
                                            planId: proposal.id,
                                            planSummary: proposal.summary,
                                            type: "feedback",
                                            text: data.feedback || "No feedback provided.",
                                        }) + "\n",
                                    );
                                } catch {}
                                pi.sendUserMessage(
                                    `**Plan needs revision**: "${proposal.summary}"${formatComments(proposal)}\n\n**Feedback:**\n${data.feedback || "No feedback provided."}`,
                                    { deliverAs: "followUp" },
                                );
                                res.writeHead(200, {
                                    "Content-Type": "application/json",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end(JSON.stringify({ status: "revising" }));
                                res.on("finish", () =>
                                    setTimeout(() => {
                                        try {
                                            stop();
                                        } catch {}
                                    }, 15000),
                                );
                            } else {
                                res.writeHead(404, {
                                    "Content-Type": "text/plain",
                                    "Content-Security-Policy": CSP,
                                });
                                res.end("No proposal");
                            }
                        } catch {
                            res.writeHead(400, {
                                "Content-Type": "text/plain",
                                "Content-Security-Policy": CSP,
                            });
                            res.end("Bad request");
                        }
                    });
                    return;
                }

                res.writeHead(404, {
                    "Content-Type": "text/plain",
                    "Content-Security-Policy": CSP,
                });
                res.end("Not found");
            });

            server.listen(0, "127.0.0.1", () => {
                const addr = server!.address();
                if (addr && typeof addr !== "string") {
                    port = addr.port;
                }
                resolve(getUrl()!);
            });
        });
    }

    return {
        start,
        stop,
        getProposal() {
            return proposal;
        },
        isRunning,
        getUrl,
        onStop,
    };
}
