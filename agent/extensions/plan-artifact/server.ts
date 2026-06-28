import * as http from "node:http";
import * as crypto from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanProposal, PlanComment } from "./types.ts";

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' data:;";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, "page.html"), "utf-8");
const CSS = readFileSync(join(__dirname, "page.css"), "utf-8");
const JS = readFileSync(join(__dirname, "page.js"), "utf-8");


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
    const lines = p.comments.map(c => {
      const sectionTitle = p.sections[c.sectionIndex]?.title || `section ${c.sectionIndex + 1}`;
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
          res.writeHead(200, { "Content-Type": "text/css", "Content-Security-Policy": CSP });
          res.end(CSS);
          return;
        }

        if (path === "/page.js" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/javascript", "Content-Security-Policy": CSP });
          res.end(JS);
          return;
        }

        // Everything else requires a valid token
        const tok = url.searchParams.get("token");
        if (tok !== token) {
          res.writeHead(401, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
          res.end("Unauthorized");
          return;
        }

        // GET / → HTML page
        if (path === "/" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": CSP });
          res.end(HTML);
          return;
        }

        // GET /api/plan → JSON
        if (path === "/api/plan" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": CSP });
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
              res.writeHead(413, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
                  if (!existsSync(join(__dirname, "..", "..", "..", ".plans"))) mkdirSync(join(__dirname, "..", "..", "..", ".plans"), { recursive: true });
                  appendFileSync(join(__dirname, "..", "..", "..", ".plans", "comments.jsonl"), JSON.stringify({ ts: Date.now(), planId: proposal.id, planSummary: proposal.summary, sectionIndex: data.sectionIndex, text: data.text }) + "\n");
                } catch {}
                // Comment saved; no individual notification — batched on accept/review
                res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": CSP });
                res.end(JSON.stringify(comment));
              } else {
                res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
                res.end("No proposal");
              }
            } catch {
              res.writeHead(400, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
              res.writeHead(413, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
                const comment = proposal.comments.find(c => c.id === data.id);
                if (!comment) {
                  res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
                  res.end("Comment not found");
                  return;
                }
                comment.text = data.text;
                // Persist edit to disk
                try {
                  if (!existsSync(join(__dirname, "..", "..", "..", ".plans"))) mkdirSync(join(__dirname, "..", "..", "..", ".plans"), { recursive: true });
                  appendFileSync(join(__dirname, "..", "..", "..", ".plans", "comments.jsonl"), JSON.stringify({ ts: Date.now(), planId: proposal.id, planSummary: proposal.summary, type: "comment-edit", commentId: comment.id, sectionIndex: comment.sectionIndex, text: data.text }) + "\n");
                } catch {}
                // Edit saved; no individual notification — batched on accept/review
                res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": CSP });
                res.end(JSON.stringify(comment));
              } else {
                res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
                res.end("No proposal");
              }
            } catch {
              res.writeHead(400, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
              res.writeHead(413, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
                const idx = proposal.comments.findIndex(c => c.id === data.id);
                if (idx === -1) {
                  res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
                  res.end("Comment not found");
                  return;
                }
                const [removed] = proposal.comments.splice(idx, 1);
                // Persist delete to disk
                try {
                  if (!existsSync(join(__dirname, "..", "..", "..", ".plans"))) mkdirSync(join(__dirname, "..", "..", "..", ".plans"), { recursive: true });
                  appendFileSync(join(__dirname, "..", "..", "..", ".plans", "comments.jsonl"), JSON.stringify({ ts: Date.now(), planId: proposal.id, planSummary: proposal.summary, type: "comment-delete", commentId: removed.id, sectionIndex: removed.sectionIndex }) + "\n");
                } catch {}
                // Delete done; no individual notification — batched on accept/review
                res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": CSP });
                res.end(JSON.stringify({ deleted: true, id: removed.id }));
              } else {
                res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
                res.end("No proposal");
              }
            } catch {
              res.writeHead(400, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
              { deliverAs: "followUp" }
            );
            res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": CSP });
            res.end(JSON.stringify({ status: "accepted" }));
            res.on("finish", () => setTimeout(() => { try { stop(); } catch {} }, 15000));
          } else {
            res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
              res.writeHead(413, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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
                  if (!existsSync(join(__dirname, '..', '..', '..', '.plans'))) mkdirSync(join(__dirname, '..', '..', '..', '.plans'), { recursive: true });
                  appendFileSync(join(__dirname, '..', '..', '..', '.plans', 'comments.jsonl'), JSON.stringify({ ts: Date.now(), planId: proposal.id, planSummary: proposal.summary, type: 'feedback', text: data.feedback || 'No feedback provided.' }) + '\n');
                } catch {}
                pi.sendUserMessage(
                  `**Plan needs revision**: "${proposal.summary}"${formatComments(proposal)}\n\n**Feedback:**\n${data.feedback || "No feedback provided."}`,
                  { deliverAs: "followUp" }
                );
                res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": CSP });
                res.end(JSON.stringify({ status: "revising" }));
                res.on("finish", () => setTimeout(() => { try { stop(); } catch {} }, 15000));
              } else {
                res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
                res.end("No proposal");
              }
            } catch {
              res.writeHead(400, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
              res.end("Bad request");
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": CSP });
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

  return { start, stop, getProposal() { return proposal; }, isRunning, getUrl, onStop };
}
