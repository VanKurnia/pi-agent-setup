#!/usr/bin/env node
/**
 * preview-system-prompt — render the system prompt pi would build for this setup.
 *
 * Uses the REAL builder from the installed pi in `agent/install/releases/<ver>/`
 * (same file as `packages/coding-agent/src/core/system-prompt.ts` on GitHub,
 * compiled to `dist/core/system-prompt.js`), plus pi's own loaders for context
 * files, skills, and built-in tool definitions. No reimplemented prompt logic.
 *
 * Usage:
 *   node .script/preview-system-prompt.mjs [--cwd <dir>] [--out <file>]
 *     [--list] [--section <name>] [--show-sources] [--stats]
 *     [--agent-dir <dir>] [--pi-dir <dir>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR_NAME = ".pi";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
if (flag("--help") || flag("-h")) {
  console.log(`preview-system-prompt — render pi's system prompt from the installed build

Usage:
  node .script/preview-system-prompt.mjs [options]

Options:
  --cwd <dir>        working directory to preview for (default: repo root)
  --agent-dir <dir>  agent dir (default: <repo>/agent)
  --pi-dir <dir>     pi package dir (default: release from agent/install/current-version)
  --list             list section names + sizes instead of full prompt
  --section <name>   print one section (e.g. preamble, tools, rules, docs, addendum, project_context, skills, cwd)
  --out <file>       write prompt to file instead of stdout
  --show-sources     print resolved sources (pi build, SYSTEM.md, APPEND_SYSTEM.md, context, skills) to stderr
  --stats            print char counts per section to stderr
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

const { buildSystemPrompt, buildSystemPromptSections } = await mod("dist/core/system-prompt.js");
const { loadProjectContextFiles } = await mod("dist/core/resource-loader.js");
const { createToolDefinition } = await mod("dist/core/tools/index.js");
let loadSkills = null;
try {
  ({ loadSkills } = await mod("dist/core/skills.js"));
} catch {}
let SettingsManager = null;
try {
  ({ SettingsManager } = await mod("dist/core/settings-manager.js"));
} catch {}

const pkg = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8"));
const builderFile = join(piDir, "dist", "core", "system-prompt.js");

// Trust check mirrors DefaultResourceLoader: project .pi/* only applies when trusted.
let projectTrusted = true;
try {
  const sm = SettingsManager?.create?.(cwd, agentDir);
  if (typeof sm?.isProjectTrusted === "function") projectTrusted = sm.isProjectTrusted();
  else if (typeof sm?.reload === "function") {
    await sm.reload();
    projectTrusted = sm.isProjectTrusted();
  }
} catch {}

function pickFile(projectRel, agentName) {
  const projectPath = join(cwd, CONFIG_DIR_NAME, projectRel);
  if (projectTrusted && existsSync(projectPath)) return projectPath;
  const globalPath = join(agentDir, agentName);
  if (existsSync(globalPath)) return globalPath;
  return undefined;
}

// --system-prompt / --append-system-prompt sources (file paths; inline text also allowed upstream).
const systemPromptPath = pickFile("SYSTEM.md", "SYSTEM.md");
const appendPath = pickFile("APPEND_SYSTEM.md", "APPEND_SYSTEM.md");
const customPrompt = systemPromptPath ? readFileSync(systemPromptPath, "utf8") : undefined;
const appendSystemPrompt = appendPath ? readFileSync(appendPath, "utf8") : "";

const contextFiles = loadProjectContextFiles({ cwd, agentDir });

let skills = [];
let skillsNote = "skills loader unavailable";
try {
  if (loadSkills) {
    const res = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
    skills = res?.skills ?? res ?? [];
    skillsNote = `${skills.length} skill(s) via loadSkills()`;
  }
} catch (e) {
  skillsNote = `loadSkills failed: ${e?.message ?? e}`;
}

// selectedTools mirrors settings.md: plain names replace defaults, +/- entries mutate.
function expandTools() {
  const DEFAULTS = ["read", "bash", "edit", "write"];
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const dt = s?.defaultTools;
    if (!Array.isArray(dt)) return DEFAULTS;
    if (dt.some((e) => typeof e === "string" && !e.startsWith("+") && !e.startsWith("-"))) {
      const set = new Set(dt.filter((e) => typeof e === "string" && !e.startsWith("+") && !e.startsWith("-")));
      for (const e of dt) {
        if (typeof e !== "string") continue;
        if (e.startsWith("+")) set.add(e.slice(1));
        else if (e.startsWith("-")) set.delete(e.slice(1));
      }
      return [...set];
    }
    const set = new Set(DEFAULTS);
    for (const e of dt) {
      if (typeof e !== "string") continue;
      if (e.startsWith("+")) set.add(e.slice(1));
      else if (e.startsWith("-")) set.delete(e.slice(1));
    }
    return [...set];
  } catch {
    return DEFAULTS;
  }
}
const selectedTools = expandTools();

// Real snippets/guidelines for built-in tools; extension tools are runtime-only.
const toolSnippets = {};
const toolGuidelines = {};
for (const name of selectedTools) {
  try {
    const def = createToolDefinition(name, cwd);
    if (def?.promptSnippet) toolSnippets[name] = def.promptSnippet;
    if (Array.isArray(def?.promptGuidelines)) toolGuidelines[name] = def.promptGuidelines;
  } catch {
    // extension/custom tool: no static definition; pi adds it at runtime.
  }
}

const sections = buildSystemPromptSections({
  cwd,
  skills,
  contextFiles,
  customPrompt,
  appendSystemPrompt,
  selectedTools,
  toolSnippets,
  toolGuidelines,
});
const full = buildSystemPrompt({
  cwd,
  skills,
  contextFiles,
  customPrompt,
  appendSystemPrompt,
  selectedTools,
  toolSnippets,
  toolGuidelines,
});

if (flag("--show-sources") || flag("--stats") || flag("--list")) {
  const names = Object.keys(sections);
  console.error(`pi build:      ${pkg.name}@${pkg.version}`);
  console.error(`builder:       ${builderFile}`);
  console.error(`cwd:           ${cwd} (projectTrusted=${projectTrusted})`);
  console.error(`SYSTEM.md:     ${systemPromptPath ?? "(none — default preamble/tools/rules/docs)"}`);
  console.error(`APPEND:        ${appendPath ?? "(none)"}`);
  console.error(`context:       ${contextFiles.length} file(s) ${contextFiles.map((f) => f.path).join(", ") || ""}`);
  console.error(`skills:        ${skillsNote}`);
  console.error(`tools:         ${selectedTools.join(", ")} (snippets for: ${Object.keys(toolSnippets).join(", ") || "(none — extension tools resolve at runtime)"})`);
  console.error(`sections:      ${names.join(", ")}`);
  if (flag("--stats") || flag("--list")) {
    for (const n of names) console.error(`  ${n}: ${sections[n].length} chars`);
    console.error(`  TOTAL: ${full.length} chars`);
  }
}

const section = opt("--section");
let out;
if (section) {
  if (!sections[section]) {
    console.error(`unknown section "${section}". Available: ${Object.keys(sections).join(", ")}`);
    process.exit(1);
  }
  out = sections[section] + "\n";
} else if (flag("--list")) {
  out = "";
} else {
  out = full.endsWith("\n") ? full : full + "\n";
}

const outFile = opt("--out");
if (outFile) writeFileSync(resolve(outFile), out, "utf8");
else if (out) process.stdout.write(out);
