/**
 * skills-hint: variant autocomplete for the builtin `/skill:name` commands.
 *
 * Pi completes `/skill:<name>` itself but offers nothing for the arguments
 * after it. This extension plugs into that builtin mechanism with
 * `ctx.ui.addAutocompleteProvider` (same hook as the
 * `github-issue-autocomplete` example): when the input looks like
 * `/skill:<name> <partial>`, it suggests the skill's hint variants and
 * delegates everything else to pi untouched.
 *
 * Variants come from an `argument-hint` in the skill frontmatter
 * (`metadata.argument-hint` first — spec-safe, top-level fallback):
 *   metadata:
 *     argument-hint: "[quick | deep | plan <description>] [--issues]"
 *
 * shortcut: only the first argument token completes; further args fall back
 * to pi's default (file) completion.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { safeReadText } from "./shared/safe-read.js";

// First `argument-hint:` line in frontmatter (covers nested metadata form too).
function extractHint(frontmatter: string): string | null {
	const m = frontmatter.match(/^[ \t]*argument-hint[ \t]*:[ \t]*["']?(.+?)["']?[ \t]*$/m);
	return m ? m[1].trim() : null;
}

// "[quick | plan <desc>] [--issues]" -> ["quick", "plan", "--issues"].
function hintToTokens(hint: string): string[] {
	const cleaned = hint.replace(/<[^>]*>/g, " ");
	return [...new Set(cleaned.match(/-{0,2}[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [])];
}

function parseSkill(file: string): { name: string; tokens: string[] } | null {
	const text = safeReadText(file);
	if (!text) return null;
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return null;
	const name = fm[1].match(/^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m)?.[1].trim();
	const hint = extractHint(fm[1]);
	if (!name || !hint) return null;
	const tokens = hintToTokens(hint);
	return tokens.length > 0 ? { name, tokens } : null;
}

function loadHintedSkills(cwd: string): Map<string, string[]> {
	const dirs = [
		join(getAgentDir(), "skills"),
		join(homedir(), ".agents", "skills"),
		join(cwd, ".pi", "skills"),
		join(cwd, ".agents", "skills"),
	];

	const out = new Map<string, string[]>();
	const walk = (dir: string, depth: number): void => {
		if (depth < 0 || !existsSync(dir)) return;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			const parsed = parseSkill(join(dir, e.name, "SKILL.md"));
			if (parsed && !out.has(parsed.name)) out.set(parsed.name, parsed.tokens);
			walk(join(dir, e.name), depth - 1);
		}
	};
	for (const d of dirs) walk(d, 2);
	return out;
}

// `/skill:improve re|` -> { name: "improve", partial: "re" }; else null.
// Requires the space after the skill name, so plain `/skill:imp` name
// completion stays entirely on the builtin path.
function matchSkillInput(textBeforeCursor: string): { name: string; partial: string } | null {
	const m = textBeforeCursor.match(/\/skill:([A-Za-z0-9_-]+)\s+(\S*)$/);
	return m ? { name: m[1], partial: m[2] } : null;
}

function createSkillHintProvider(
	current: AutocompleteProvider,
	skills: Map<string, string[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const match = matchSkillInput((lines[cursorLine] ?? "").slice(0, cursorCol));
			if (!match || options.signal.aborted) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const hits = skills.get(match.name)?.filter((t) => t.startsWith(match.partial)) ?? [];
			if (hits.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const items: AutocompleteItem[] = hits.map((value) => ({ value, label: value }));
			return { items, prefix: match.partial };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const skills = loadHintedSkills(ctx.cwd);
		if (skills.size === 0) return;
		ctx.ui.addAutocompleteProvider((current) => createSkillHintProvider(current, skills));
	});
}
