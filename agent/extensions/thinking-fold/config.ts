import { readSettingsNamespace, writeSettingsNamespace } from "@99percentpeople/pi-shared-settings";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_THINKING_FOLD_OPTIONS,
  type ThinkingCompletedBehavior,
  type ThinkingFoldOptions,
  type ThinkingStreamingBehavior,
} from "./renderer.ts";

export interface ThinkingFoldConfig {
  foldThreshold: number;
  streamingBehavior: ThinkingStreamingBehavior;
  completedBehavior: ThinkingCompletedBehavior;
  showCursorLabel: boolean;
}

export const DEFAULT_THINKING_FOLD_CONFIG: ThinkingFoldConfig = {
  foldThreshold: DEFAULT_THINKING_FOLD_OPTIONS.previewLines,
  streamingBehavior: DEFAULT_THINKING_FOLD_OPTIONS.streamingBehavior,
  completedBehavior: DEFAULT_THINKING_FOLD_OPTIONS.completedBehavior,
  showCursorLabel: true,
};

export const THINKING_FOLD_SETTINGS_NAMESPACE = "thinking-fold";

const THINKING_FOLD_CONFIG_FILE = "thinking-fold.json";
const LEGACY_SHARED_SETTINGS_PATH = join(getAgentDir(), "99extensions.json");

export function getThinkingFoldConfigPath(): string {
  return join(getAgentDir(), THINKING_FOLD_CONFIG_FILE);
}

function isFoldThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20;
}

function isStreamingBehavior(value: unknown): value is ThinkingStreamingBehavior {
  return value === "auto" || value === "preview" || value === "collapse";
}

function isCompletedBehavior(value: unknown): value is ThinkingCompletedBehavior {
  return value === "auto" || value === "collapse" || value === "preview" || value === "full";
}

export function normalizeThinkingFoldConfig(value: unknown): ThinkingFoldConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_THINKING_FOLD_CONFIG };
  const input = value as {
    foldThreshold?: unknown;
    previewLines?: unknown;
    streamingBehavior?: unknown;
    completedBehavior?: unknown;
    autoCollapse?: unknown;
    showCursorLabel?: unknown;
  };

  return {
    // previewLines and autoCollapse are legacy settings. Preserve their visible
    // behavior when migrating an existing user configuration.
    foldThreshold: isFoldThreshold(input.foldThreshold)
      ? input.foldThreshold
      : isFoldThreshold(input.previewLines)
        ? input.previewLines
        : DEFAULT_THINKING_FOLD_CONFIG.foldThreshold,
    streamingBehavior: isStreamingBehavior(input.streamingBehavior)
      ? input.streamingBehavior
      : DEFAULT_THINKING_FOLD_CONFIG.streamingBehavior,
    completedBehavior: isCompletedBehavior(input.completedBehavior)
      ? input.completedBehavior
      : input.autoCollapse === false
        ? "preview"
        : input.autoCollapse === true
          ? "collapse"
          : DEFAULT_THINKING_FOLD_CONFIG.completedBehavior,
    showCursorLabel:
      typeof input.showCursorLabel === "boolean"
        ? input.showCursorLabel
        : DEFAULT_THINKING_FOLD_CONFIG.showCursorLabel,
  };
}

export function loadThinkingFoldConfig(path = getThinkingFoldConfigPath()): ThinkingFoldConfig {
  // Read the old shared file as a fallback so existing settings survive the
  // move. Any subsequent change is written to thinking-fold.json.
  const configPath = existsSync(path)
    ? path
    : path === getThinkingFoldConfigPath() && existsSync(LEGACY_SHARED_SETTINGS_PATH)
      ? LEGACY_SHARED_SETTINGS_PATH
      : path;
  return readSettingsNamespace(
    THINKING_FOLD_SETTINGS_NAMESPACE,
    normalizeThinkingFoldConfig,
    configPath,
  );
}

export function saveThinkingFoldConfig(
  config: ThinkingFoldConfig,
  path = getThinkingFoldConfigPath(),
): void {
  writeSettingsNamespace(
    THINKING_FOLD_SETTINGS_NAMESPACE,
    normalizeThinkingFoldConfig(config),
    path,
  );
}

export function configToRenderOptions(
  config: ThinkingFoldConfig,
): Pick<
  ThinkingFoldOptions,
  "previewLines" | "streamingBehavior" | "completedBehavior"
> {
  return {
    previewLines: config.foldThreshold,
    streamingBehavior: config.streamingBehavior,
    completedBehavior: config.completedBehavior,
  };
}
