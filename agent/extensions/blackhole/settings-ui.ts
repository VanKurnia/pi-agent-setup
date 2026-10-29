import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPicker } from "../shared/picker.ts";
import {
    isModelTarget,
    loadBlackholeConfig,
    setBlackholeConfigValue,
    type BlackholeConfig,
} from "./config.ts";

/**
 * A settings row: the config key it edits, its label, and how the editor edits
 * it. `choices` and `max` live on the kind that uses them, so a row cannot carry
 * data its editor ignores.
 */
type SettingsField =
    | { key: ModelKey; label: string; kind: "model" }
    | { key: keyof BlackholeConfig; label: string; kind: "number"; max?: number }
    | {
          key: keyof BlackholeConfig;
          label: string;
          kind: "choice";
          choices: Array<{ label: string; value: string | boolean }>;
      };

type ModelKey = "model" | "observerModel" | "reflectorModel";

type FieldOf<K extends SettingsField["kind"]> = Extract<SettingsField, { kind: K }>;

/**
 * Rows for the keys `pi-blackhole-config.json` supports, in menu order. Add a row
 * for every new config key, or the menu cannot reach it.
 */
const SETTINGS_FIELDS: SettingsField[] = [
    { key: "model", label: "Model (worker fallback)", kind: "model" },
    { key: "observerModel", label: "Observer model", kind: "model" },
    { key: "reflectorModel", label: "Reflector model", kind: "model" },
    {
        key: "compaction",
        label: "Compaction trigger",
        kind: "choice",
        choices: [
            { label: "auto", value: "auto" },
            { label: "manual", value: "manual" },
            { label: "off", value: "off" },
        ],
    },
    {
        key: "compactionEngine",
        label: "Compaction engine",
        kind: "choice",
        choices: [
            { label: "blackhole", value: "blackhole" },
            { label: "pi-default", value: "pi-default" },
        ],
    },
    {
        key: "memory",
        label: "Observational memory (workers)",
        kind: "choice",
        choices: [
            { label: "on", value: true },
            { label: "off", value: false },
        ],
    },
    {
        key: "showWorkerMessages",
        label: "Worker notices",
        kind: "choice",
        choices: [
            { label: "on", value: true },
            { label: "off", value: false },
        ],
    },
    { key: "compactAfterTokens", label: "Auto-compact after tokens", kind: "number" },
    { key: "compactAfterRatio", label: "Auto-compact after ratio", kind: "number", max: 1 },
    { key: "compactReserveTokens", label: "Auto-compact reserve tokens", kind: "number" },
    { key: "observeAfterTokens", label: "Observe after tokens", kind: "number" },
    { key: "reflectAfterTokens", label: "Reflect after tokens", kind: "number" },
    { key: "observationsPoolMaxTokens", label: "Observations pool max", kind: "number" },
    { key: "observationsPoolTargetTokens", label: "Observations pool target", kind: "number" },
    { key: "reflectionsPoolMaxTokens", label: "Reflections pool max", kind: "number" },
    { key: "observerChunkMaxTokens", label: "Observer chunk max", kind: "number" },
    {
        key: "dropperPressureThreshold",
        label: "Dropper pressure threshold",
        kind: "number",
        max: 1,
    },
    { key: "recallResponseMaxChars", label: "Recall response max chars", kind: "number" },
];

/** Current effective value of a field, as the menu shows it. */
function fieldValue(config: BlackholeConfig, field: SettingsField): string {
    if (field.kind === "model") {
        const model = config[field.key];
        return isModelTarget(model) ? `${model.provider}/${model.id}` : "unset (worker off)";
    }
    const value = config[field.key];
    if (value === undefined) return "default";
    if (field.kind === "choice") {
        const choice = field.choices.find((c) => c.value === value);
        if (choice) return choice.label;
    }
    return String(value);
}

/** Persist one field and report whether it reached disk. */
function applyField(
    ctx: ExtensionCommandContext,
    field: SettingsField,
    value: unknown,
    shown: string,
): void {
    const saved = setBlackholeConfigValue(field.key, value);
    ctx.ui.notify(
        saved
            ? `${field.label} → ${shown}`
            : `${field.label} → ${shown} (could not write the config file)`,
        saved ? "info" : "warning",
    );
}

// ── Settings editor ─────────────────────────────────────────────────────────

async function editModelField(
    ctx: ExtensionCommandContext,
    config: BlackholeConfig,
    field: FieldOf<"model">,
): Promise<void> {
    const unset = "__unset__";
    const models = ctx.modelRegistry.getAvailable();
    const picked = await showPicker(
        ctx,
        `${field.label} (current: ${fieldValue(config, field)})`,
        "type to filter • enter select • esc back",
        () => [
            { value: unset, label: "[unset]", description: "turns that worker off" },
            ...models.map((m) => ({
                value: `${m.provider}/${m.id}`,
                label: `${m.provider}/${m.id}`,
            })),
        ],
    );
    if (picked === null) return;
    if (picked === unset) {
        applyField(ctx, field, undefined, "unset");
        return;
    }
    const slash = picked.indexOf("/");
    // Only provider and id are edited, so unexposed sub-keys carry forward. The
    // note documenting the model just replaced would be stale, so drop it.
    const next: Record<string, unknown> = {
        ...((config[field.key] as Record<string, unknown> | undefined) ?? {}),
        provider: picked.slice(0, slash),
        id: picked.slice(slash + 1),
    };
    delete next._comment;
    applyField(ctx, field, next, picked);
}

async function editChoiceField(
    ctx: ExtensionCommandContext,
    config: BlackholeConfig,
    field: FieldOf<"choice">,
): Promise<void> {
    const picked = await showPicker(
        ctx,
        `${field.label} (current: ${fieldValue(config, field)})`,
        "↑↓ navigate • enter select • esc back",
        () => field.choices.map((c) => ({ value: String(c.value), label: c.label })),
    );
    if (picked === null) return;
    const choice = field.choices.find((c) => String(c.value) === picked);
    if (choice) applyField(ctx, field, choice.value, choice.label);
}

async function editNumberField(
    ctx: ExtensionCommandContext,
    config: BlackholeConfig,
    field: FieldOf<"number">,
): Promise<void> {
    const answer = await ctx.ui.input(
        `${field.label} (current: ${fieldValue(config, field)})`,
        "a number, or leave empty to unset",
    );
    if (answer === undefined) return;
    const trimmed = answer.trim();
    if (trimmed === "") {
        applyField(ctx, field, undefined, "unset");
        return;
    }
    const parsed = Number(trimmed);
    if (
        !Number.isFinite(parsed) ||
        parsed <= 0 ||
        (field.max !== undefined && parsed > field.max)
    ) {
        const bound = field.max === undefined ? "" : ` up to ${field.max}`;
        ctx.ui.notify(`${field.label}: enter a positive number${bound}.`, "warning");
        return;
    }
    applyField(ctx, field, parsed, String(parsed));
}

export async function editBlackholeSettings(ctx: ExtensionCommandContext): Promise<void> {
    for (;;) {
        const config = loadBlackholeConfig();
        const picked = await showPicker(
            ctx,
            "Blackhole settings",
            "type to filter • enter edit • esc close",
            () =>
                SETTINGS_FIELDS.map((field) => ({
                    value: field.key,
                    label: field.label,
                    description: fieldValue(config, field),
                })),
        );
        if (picked === null) return;
        const field = SETTINGS_FIELDS.find((f) => f.key === picked);
        if (!field) return;
        if (field.kind === "model") await editModelField(ctx, config, field);
        else if (field.kind === "choice") await editChoiceField(ctx, config, field);
        else await editNumberField(ctx, config, field);
    }
}
