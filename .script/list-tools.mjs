#!/usr/bin/env node
/**
 * list-tools — list every tool the installed pi build loads for this setup, with
 * the descriptions declared to the model.
 *
 * Uses pi's own SDK path: `DefaultResourceLoader` (real settings, extensions,
 * skills) + `createAgentSession()` on an in-memory session, then the session's
 * `getAllTools()` / `getActiveToolNames()`. No reimplemented discovery, so the
 * inventory matches what a session really loads — extension tools included,
 * which `preview-system-prompt.mjs` cannot render (it only sees built-in tool
 * definitions and reports extension snippets as "resolve at runtime").
 *
 * Usage:
 *   node .script/list-tools.mjs [--cwd <dir>] [--agent-dir <dir>] [--pi-dir <dir>]
 *     [--active] [--full] [--json] [--grep <pattern>] [--max <n>] [--stats]
 *     [--no-builtin] [--online] [--help]
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
if (flag("--help") || flag("-h")) {
  console.log(`list-tools — list the tools pi loads for this setup

Usage:
  node .script/list-tools.mjs [options]

Options:
  --cwd <dir>        working directory for project-local discovery (default: repo root)
  --agent-dir <dir>  agent dir (default: <repo>/agent)
  --pi-dir <dir>     pi package dir (default: release from agent/install/current-version)
  --active           list only the tools declared to the model
  --full             print whole descriptions plus per-tool metadata
  --grep <pattern>   only tools whose name or description matches (regex, literal fallback)
  --max <n>          truncate descriptions to n chars (default: 160)
  --json             print the full inventory as JSON
  --stats            print counts and character totals to stderr
  --no-builtin       skip the CLI's built-in extensions (codemode, tool_search, mcp)
  --online           allow startup network operations (default: offline, PI_OFFLINE=1)
`);
  process.exit(0);
}

const cwd = resolve(opt("--cwd") ?? REPO_ROOT);
const agentDir = resolve(opt("--agent-dir") ?? join(REPO_ROOT, "agent"));

function resolvePiDir() {
  const override = opt("--pi-dir");
  if (override) return resolve(override);
  try {
    const ver = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
    if (/^[0-9A-Za-z._+-]+$/.test(ver)) {
      const p = join(agentDir, "install", "releases", ver, "node_modules", "@earendil-works", "pi-coding-agent");
      if (existsSync(join(p, "package.json"))) return p;
    }
  } catch {}
  const fallback = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(join(fallback, "package.json"))) return fallback;
  console.error("error: cannot locate pi-coding-agent package (tried install/releases/* and ./node_modules). Pass --pi-dir <dir>.");
  process.exit(1);
}
const piDir = resolvePiDir();
const mod = (rel) => import(pathToFileURL(join(piDir, rel)).href);
if (!flag("--online")) process.env.PI_OFFLINE ||= "1";

const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  createCodemodeExtension,
  createToolSearchExtension,
  createMcpExtension,
} = await mod("dist/index.js");

const pkg = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8"));

// The CLI loads codemode, tool search and MCP as built-in extensions; SDK sessions do not.
const builtinFactories = flag("--no-builtin")
  ? []
  : [
      { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
      { name: "tool_search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
      { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
    ];

const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: builtinFactories });
await loader.reload();

const { session } = await createAgentSession({
  cwd,
  agentDir,
  sessionManager: SessionManager.inMemory(),
  resourceLoader: loader,
});

try {
  const tools = session.getAllTools();
  const declared = new Set(session.getActiveToolNames());
  const snippetOf = (name) => session.getToolDefinition(name)?.promptSnippet;
  const pattern = opt("--grep") ? toRegex(opt("--grep")) : null;
  const matches = (t) => !pattern || pattern.test(t.name) || pattern.test(String(t.description ?? ""));
  const all = tools.filter(matches);
  const active = all.filter((t) => declared.has(t.name));
  const other = all.filter((t) => !declared.has(t.name));

  if (flag("--json")) {
    const dump = all.map((t) => ({
      name: t.name,
      declared: declared.has(t.name),
      exposure: t.exposure,
      namespace: t.namespace,
      annotations: t.annotations,
      reachesTools: t.reachesTools,
      source: sourceLabel(t.sourceInfo),
      snippet: snippetOf(t.name),
      description: t.description,
      parameters: t.parameters,
      promptGuidelines: t.promptGuidelines,
    }));
    process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
  } else {
    const lines = [
      `pi ${pkg.version} — ${all.length} tool(s) loaded`,
      `cwd:       ${cwd}`,
      `agent dir: ${agentDir}`,
      "",
    ];
    if (active.length) lines.push(`declared to the model (${active.length})`, ...render(active));
    if (!flag("--active") && other.length) {
      if (active.length) lines.push("");
      lines.push(`registered, not declared (${other.length})`, ...render(other));
    }
    if (!active.length && !other.length && pattern) lines.push(`no tool matches ${pattern}`);
    process.stdout.write(lines.join("\n") + "\n");
  }

  if (flag("--stats")) {
    const sum = (list) => list.reduce((n, t) => n + t.name.length + String(t.description ?? "").length, 0);
    const byExposure = {};
    for (const t of tools) byExposure[t.exposure] = (byExposure[t.exposure] ?? 0) + 1;
    console.error(`tools:     ${tools.length} (${declared.size} declared, ${tools.length - declared.size} registered-only)`);
    console.error(`exposure:  ${Object.entries(byExposure).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    console.error(`declared:  ${sum(active)} chars name+description`);
    console.error(`all:       ${sum(all)} chars name+description`);
  }

  function render(list) {
    const width = Math.min(Math.max(...list.map((t) => t.name.length)), 24);
    return list.map((t) => {
      const src = sourceLabel(t.sourceInfo);
      const head = `  ${t.name.padEnd(width)}  ${truncate(t.description)}${src ? `  (${src})` : ""}`;
      const notes = flag("--full") ? [snippetLine(t.name), metadata(t)].filter(Boolean).join("\n") : "";
      return notes ? `${head}\n${notes}` : head;
    });
  }

  /** `promptSnippet` is the line the model sees in the system prompt's tools section. */
  function snippetLine(name) {
    const snippet = snippetOf(name);
    const text = snippet ? String(snippet).replace(/\s+/g, " ").trim() : "(none — this tool is not listed in the tools section)";
    return `      snippet: ${text}`;
  }

  function metadata(t) {
    const bits = [];
    if (t.exposure !== "direct") bits.push(`exposure: ${t.exposure}`);
    if (t.namespace) bits.push(`namespace: ${t.namespace.name}`);
    if (t.annotations) bits.push(`annotations: ${Object.entries(t.annotations).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (t.reachesTools) bits.push("reachesTools: yes");
    if (t.promptGuidelines?.length) bits.push(`promptGuidelines: ${t.promptGuidelines.length}`);
    return bits.length ? `      ${bits.join(" · ")}` : "";
  }
} finally {
  session.dispose();
}

/** Build a case-insensitive regex; an invalid pattern falls back to a literal search. */
function toRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

/** Collapse a description to one line and clip it to --max. */
function truncate(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flag("--full")) return flat;
  const max = Number(opt("--max") ?? 160);
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Where a tool came from: `builtin:<name>`, `<inline:...>`, or a path relative to cwd/agentDir. */
function sourceLabel(info) {
  const path = info?.path;
  if (!path) return "";
  if (!isAbsolute(path)) return path;
  for (const base of [cwd, agentDir]) {
    const rel = relative(base, path);
    if (rel && !rel.startsWith("..")) return rel.split(sep).join("/");
  }
  return path;
}
