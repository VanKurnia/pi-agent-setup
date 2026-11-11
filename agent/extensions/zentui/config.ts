import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ComponentColors } from "./component-colors.ts";
import type { CustomValueColors } from "./custom-value-colors.ts";
import { HOST_TEMPLATE_VARIABLES } from "./host-template-values.ts";
import {
	type IconMode,
	type ResolvedIcons,
	normalizeIconMode,
	resolveConfiguredIcons,
} from "./icons.ts";

export type ColorSpec = string;
export type ColorSource = "theme" | "terminal";
export type { IconMode } from "./icons.ts";

export type ContextStyle = "text" | "gauge" | "text+gauge";
export type SeparatorStyle = "pipe" | "dot" | "chevron" | "none";
export type ModelLabelSource = "id" | "name";
export type EditorStyle = "opencode" | "opencode-copy-friendly" | "accent-rail" | "minimalist";
export type UserMessageStyle = "framed" | "framed-copy-friendly" | "compact" | "labeled";
export type SelectorBorderStyle = "zentui";
export type FooterStyle = "native" | "starship" | "hidden";
export type WorkingLineSpinner = "braille" | "star-bloom" | "pinwheel" | "claude-inspired" | "pulse";
export type WorkingLineTextAnimation = "classic" | "kitt" | "disabled";
export type WorkingLinePlacement = "above" | "border";
export type MinimalistPathDisplayMode = "compact" | "project" | "full";
export type MinimalistContextFormat = "percent" | "percent-total";
export type MinimalistEditorSeparator = "dash" | "dot";
export type EditorBorderColorMode = "static" | "adaptive";
export type CompletionMenuStyle = "native" | "palette";
export type CompactFooterMaxLines = 1 | 2 | 3 | "unlimited";
export type ExtensionStatusPlacement = "off" | "left" | "middle" | "right";
export type ExtensionStatusColorMode = "zentui" | "original";
export type ExtensionStatusVisibility = "show" | "hide";
export type HiddenExtensionStatusPlacement = "left" | "middle" | "right";

export const DEFAULT_COMPACT_FOOTER_FORMAT =
	"$cwd$wrap(in $session_name)$wrap(on $git_branch) $git_status$wrap$context$wrap_sep$tokens";
export const DEFAULT_EDITOR_METADATA_FORMAT = "$model  $provider(  $thinking)(  $fast_mode)";

export type ContextThresholds = { warning: number; error: number };
export type PathDisplayMode = "basename" | "full" | "repository";
export type PathDisplayConfig = { mode: PathDisplayMode; depth: number };
export type GitBranchMaxLength = "full" | number;
export type GitBranchConfig = { maxLength: GitBranchMaxLength };
export type GitCommitConfig = { hashLength: number; onlyDetached: boolean; showTag: boolean };
export type GitMetricsConfig = { onlyNonzero: boolean; ignoreSubmodules: boolean };
export type ColorSourcesConfig = {
	starship: ColorSource;
	editor: ColorSource;
	userMessages: ColorSource;
};

export type FooterSegmentsConfig = {
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCounts: boolean;
	gitCommit: boolean;
	gitMetrics: boolean;
	runtime: boolean;
	modelInfo: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	sessionDuration: boolean;
	username: boolean;
	time: boolean;
	os: boolean;
	packageVersion: boolean;
};

export type TemplateVariableConfig = {
	variables?: Record<string, string>;
	extensionColorMode?: ExtensionStatusColorMode;
};

export const OPENCODE_FORMAT_VARIABLES = [
	"model",
	"model_id",
	"model_name",
	"provider",
	"thinking",
	"fast_mode",
	"session_name",
	"context",
	"tokens",
	"cache_hit",
	"sep",
	"join_sep",
	"separator",
	...HOST_TEMPLATE_VARIABLES,
] as const;

export type PolishedEditorStyleConfig = TemplateVariableConfig & {
	metadataFormat: string;
	completionMenu: CompletionMenuStyle;
};

export type PolishedCopyFriendlyEditorStyleConfig = PolishedEditorStyleConfig;

export type AccentRailEditorStyleConfig = {
	rail: string;
	asciiRail: string;
	transparent: boolean;
};

export type MinimalistEditorStyleConfig = {
	formats?: Record<string, string>;
	variables?: Record<string, string>;
	extensionColorMode?: ExtensionStatusColorMode;
	pathDisplay: MinimalistPathDisplayMode;
	contextFormat: MinimalistContextFormat;
	contextGauge: boolean;
	showSessionName: boolean;
	showTimer: boolean;
	showCost: boolean;
	showCacheHit: boolean;
	showGit: boolean;
	contextThresholds: ContextThresholds;
	separator: MinimalistEditorSeparator;
};

export type EditorComponentConfig = {
	colors?: ComponentColors<"editor">;
	customValueColors?: CustomValueColors;
	enabled: boolean;
	rail?: string;
	asciiRail?: string;
	style: EditorStyle;
	colorSource: ColorSource;
	borderColorMode: EditorBorderColorMode;
	modelLabel: ModelLabelSource;
	viewportIndicators: boolean;
	styles: {
		opencode: PolishedEditorStyleConfig;
		"opencode-copy-friendly": PolishedCopyFriendlyEditorStyleConfig;
		"accent-rail": AccentRailEditorStyleConfig;
		minimalist: MinimalistEditorStyleConfig;
	};
};

export type UserMessagesComponentConfig = {
	colors?: ComponentColors<"userMessages">;
	enabled: boolean;
	rail?: string;
	asciiRail?: string;
	style: UserMessageStyle;
	colorSource: ColorSource;
	styles: {
		framed: Record<string, never>;
		"framed-copy-friendly": Record<string, never>;
		compact: Record<string, never>;
		labeled: Record<string, never>;
	};
};

export type SelectorBordersComponentConfig = {
	colors?: ComponentColors<"selectorBorders">;
	enabled: boolean;
	style: SelectorBorderStyle;
	colorSource: ColorSource;
};

export type StarshipFooterStyleConfig = TemplateVariableConfig & {
	format: string;
	responsive: boolean;
	compactFormat: string;
	compactMaxLines: CompactFooterMaxLines;
	separator: SeparatorStyle;
	contextStyle: ContextStyle;
	contextThresholds: ContextThresholds;
	pathDisplay: PathDisplayConfig;
	segments: FooterSegmentsConfig;
	gitBranch: GitBranchConfig;
	gitCommit: GitCommitConfig;
	gitMetrics: GitMetricsConfig;
};

export type FooterComponentConfig = {
	colors?: ComponentColors<"footer">;
	customValueColors?: CustomValueColors;
	style: FooterStyle;
	colorSource: ColorSource;
	modelLabel: ModelLabelSource;
	styles: { starship: StarshipFooterStyleConfig };
};

export type ComponentsConfig = {
	editor: EditorComponentConfig;
	userMessages: UserMessagesComponentConfig;
	selectorBorders: SelectorBordersComponentConfig;
	footer: FooterComponentConfig;
};

export type PolishedTuiColors = {
	cwd: ColorSpec;
	sessionName: ColorSpec;
	gitBranch: ColorSpec;
	gitStatus: ColorSpec;
	contextNormal: ColorSpec;
	contextWarning: ColorSpec;
	contextError: ColorSpec;
	tokens: ColorSpec;
	cacheHit?: ColorSpec;
	cost: ColorSpec;
	separator: ColorSpec;
	runtimePrefix: ColorSpec;
	extensionStatus: ColorSpec;
	sessionDuration: ColorSpec;
	packageVersion: ColorSpec;
	gitCommit: ColorSpec;
	gitMetricsAdded: ColorSpec;
	gitMetricsDeleted: ColorSpec;
	username: ColorSpec;
	time: ColorSpec;
	os: ColorSpec;
	editorAccent?: ColorSpec;
	editorShellRail?: ColorSpec;
	editorRail?: ColorSpec;
	editorPrompt?: ColorSpec;
	editorBorder?: ColorSpec;
	editorGitBranch?: ColorSpec;
	editorModel?: ColorSpec;
	editorProvider?: ColorSpec;
	editorThinking?: ColorSpec;
	editorThinkingMinimal?: ColorSpec;
	editorThinkingLow?: ColorSpec;
	editorThinkingMedium?: ColorSpec;
	editorThinkingHigh?: ColorSpec;
	editorThinkingXhigh?: ColorSpec;
	editorThinkingMax?: ColorSpec;
	workingLineLow?: ColorSpec;
	workingLineMid?: ColorSpec;
	workingLineHigh?: ColorSpec;
};

export type ZentuiConfig = {
	projectRefreshIntervalMs: number;
	icons: ResolvedIcons;
	colors: PolishedTuiColors;
	components: ComponentsConfig;
};

export type PolishedTuiConfig = ZentuiConfig;

export const FOOTER_FORMAT_VARIABLES = [
	"cwd",
	"session_name",
	"git_branch",
	"git_status",
	"git_state",
	"runtime",
	"model",
	"provider",
	"thinkingLevel",
	"fast_mode",
	"session_duration",
	"username",
	"os",
	"time",
	"context",
	"tokens",
	"cache_read",
	"cache_write",
	"cost",
	"subscription",
	"auto_compaction",
	"package",
	"package_version",
	"git_commit",
	"git_tag",
	"git_metrics",
	"git_added",
	"git_deleted",
	"sep",
	"join_sep",
	...HOST_TEMPLATE_VARIABLES,
] as const;

export const FOOTER_FORMAT_ALIASES: Record<string, string> = {
	directory: "cwd",
	branch: "git_branch",
	status: "git_status",
	state: "git_state",
	commit: "git_commit",
	tag: "git_tag",
	duration: "session_duration",
	separator: "sep",
};

export const configPath = join(getAgentDir(), "zentui.json");

const defaultFooterSegments: FooterSegmentsConfig = {
	cwd: true,
	sessionName: true,
	gitBranch: true,
	gitStatus: true,
	gitCounts: false,
	gitCommit: false,
	gitMetrics: false,
	runtime: true,
	modelInfo: false,
	context: true,
	tokens: true,
	cost: true,
	sessionDuration: false,
	username: false,
	time: false,
	os: false,
	packageVersion: false,
};

const defaultStarshipStyle: StarshipFooterStyleConfig = {
	format: "",
	responsive: true,
	compactFormat: DEFAULT_COMPACT_FOOTER_FORMAT,
	compactMaxLines: 2,
	separator: "pipe",
	contextStyle: "text",
	contextThresholds: { warning: 70, error: 90 },
	pathDisplay: { mode: "basename", depth: 0 },
	segments: defaultFooterSegments,
	gitBranch: { maxLength: "full" },
	gitCommit: { hashLength: 7, onlyDetached: true, showTag: true },
	gitMetrics: { onlyNonzero: true, ignoreSubmodules: false },
};

const defaultComponents: ComponentsConfig = {
	editor: {
		enabled: true,
		style: "opencode",
		colorSource: "terminal",
		borderColorMode: "static",
		modelLabel: "id",
		viewportIndicators: true,
		styles: {
			opencode: {
				metadataFormat: DEFAULT_EDITOR_METADATA_FORMAT,
				completionMenu: "palette",
			},
			"opencode-copy-friendly": {
				metadataFormat: DEFAULT_EDITOR_METADATA_FORMAT,
				completionMenu: "palette",
			},
			"accent-rail": { rail: "▎", asciiRail: "|", transparent: false },
			minimalist: {
				formats: { bottomLeft: "$session_name$join_sep($git_branch)" },
				pathDisplay: "compact",
				contextFormat: "percent-total",
				contextGauge: false,
				showSessionName: false,
				showTimer: false,
				showCost: true,
				showCacheHit: false,
				showGit: true,
				contextThresholds: { warning: 70, error: 90 },
				separator: "dash",
			},
		},
	},
	userMessages: {
		enabled: true,
		style: "framed",
		colorSource: "terminal",
		styles: { framed: {}, "framed-copy-friendly": {}, compact: {}, labeled: {} },
	},
	selectorBorders: { enabled: true, style: "zentui", colorSource: "terminal" },
	footer: {
		style: "starship",
		colorSource: "terminal",
		modelLabel: "id",
		styles: { starship: defaultStarshipStyle },
	},
};

export const defaultConfig: PolishedTuiConfig = {
	projectRefreshIntervalMs: 30_000,
	icons: resolveConfiguredIcons("auto"),
	colors: {
		cwd: "bold cyan",
		sessionName: "bold green",
		gitBranch: "bold purple",
		gitStatus: "bold red",
		contextNormal: "bright-black",
		contextWarning: "bold yellow",
		contextError: "bold red",
		tokens: "bright-black",
		cost: "bold green",
		separator: "bright-black",
		runtimePrefix: "",
		extensionStatus: "bright-black",
		sessionDuration: "yellow",
		packageVersion: "208",
		gitCommit: "bold green",
		gitMetricsAdded: "bold green",
		gitMetricsDeleted: "bold red",
		username: "bold yellow",
		time: "bold yellow",
		os: "bold white",
	},
	components: defaultComponents,
};

type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON values override defaults only where the default already declares that key with the same type. */
function mergeKnown(base: unknown, override: unknown): unknown {
	if (!isRecord(base)) {
		if (typeof base === "string") return typeof override === "string" ? override : base;
		if (typeof base === "boolean") return typeof override === "boolean" ? override : base;
		if (typeof base === "number") {
			return typeof override === "number" && Number.isFinite(override) ? override : base;
		}
		return base;
	}
	if (!isRecord(override)) return base;
	const merged: ConfigRecord = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (key in base) merged[key] = mergeKnown(base[key], value);
	}
	return merged;
}

function readConfig(): ConfigRecord {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function loadConfig(): PolishedTuiConfig {
	const raw = readConfig();
	const merged = mergeKnown(structuredClone(defaultConfig), raw) as PolishedTuiConfig;
	const iconMode = normalizeIconMode(isRecord(raw.icons) ? raw.icons.mode : undefined);
	merged.icons = resolveConfiguredIcons(iconMode satisfies IconMode);
	return merged;
}

export function ensureConfigExists(): void {
	if (existsSync(configPath)) return;
	try {
		writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
	} catch {
		// A read-only agent directory keeps the in-memory defaults.
	}
}
