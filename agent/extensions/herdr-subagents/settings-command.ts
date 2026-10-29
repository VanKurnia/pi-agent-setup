import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    discoverAgents,
    loadSubagentsSettings,
    substituteEnv,
    THINKING_LEVELS,
    writeAgentModel,
    writeAgentThinking,
    type ThinkingLevel,
} from "./agents.ts";
import { showPicker } from "../shared/picker.ts";

/** Body of the `herdr-subagent:settings` command. Lazy-loaded: it is command-only. */
export async function runSettingsCommand(ctx: ExtensionCommandContext): Promise<void> {
    const agentDir = getAgentDir();
    const readState = () => ({
        agents: discoverAgents(ctx.cwd, "user").agents,
        models: ctx.modelRegistry.getAvailable(),
        settings: loadSubagentsSettings(agentDir),
    });
    let state = readState();
    while (true) {
        const options = state.agents.map((agent) => {
            const model = state.settings.agentModels?.[agent.name];
            const thinking = state.settings.agentThinking?.[agent.name];
            const base = model ? `${agent.name} — ${model}` : agent.name;
            return thinking ? `${base} · thinking: ${thinking}` : base;
        });
        const selected = await ctx.ui.select("Select agent to configure:", options);
        // Labels are UI text, not identifiers: resolve the pick back to
        // an agent by position.
        const target = selected === undefined ? undefined : state.agents[options.indexOf(selected)];
        if (!target) return;

        const storedModel = state.settings.agentModels?.[target.name];
        const pickedModel = await showPicker(
            ctx,
            storedModel
                ? `Model for "${target.name}" (current: ${storedModel})`
                : `Model for "${target.name}":`,
            "type to filter • ↑↓ navigate • enter select • esc close",
            () => [
                {
                    value: "__reset__",
                    label: "[reset to default]",
                    description: "Use agent file's default model",
                },
                ...state.models.map((model) => ({
                    value: `${model.provider}/${model.id}`,
                    label: `${model.provider}/${model.id}`,
                })),
            ],
        );
        if (pickedModel !== null) {
            const reset = pickedModel === "__reset__";
            const label = reset ? "default" : pickedModel;
            const saved = writeAgentModel(agentDir, target.name, reset ? undefined : pickedModel);
            ctx.ui.notify(
                saved
                    ? `Model for "${target.name}" set to ${label}`
                    : `Failed to save model for "${target.name}" (not applied)`,
                saved ? "info" : "warning",
            );
            state = readState();
        }

        const effectiveModel = substituteEnv(
            state.settings.agentModels?.[target.name] ?? target.model,
        );
        // Registry entry for the effective model; its map marks
        // unsupported levels with null, and a model without a map
        // supports every level.
        const entry = state.models.find(
            (model) => `${model.provider}/${model.id}` === effectiveModel,
        );
        const storedLevel = state.settings.agentThinking?.[target.name];
        const pickedLevel = await showPicker(
            ctx,
            storedLevel
                ? `Thinking for "${target.name}" (current: ${storedLevel})`
                : `Thinking for "${target.name}":`,
            "↑↓ navigate • enter select • esc close",
            () => [
                {
                    value: "__default__",
                    label: "[model default]",
                    description: "Use model default",
                },
                ...THINKING_LEVELS.filter((level) => entry?.thinkingLevelMap?.[level] !== null).map(
                    (level) => ({ value: level, label: level }),
                ),
            ],
        );
        if (pickedLevel !== null) {
            const reset = pickedLevel === "__default__";
            const label = reset ? "model default" : pickedLevel;
            // Picker values are plain strings; the writer revalidates
            // the cast before storing.
            const saved = writeAgentThinking(
                agentDir,
                target.name,
                reset ? undefined : (pickedLevel as ThinkingLevel),
            );
            ctx.ui.notify(
                saved
                    ? `Thinking for "${target.name}" set to ${label}`
                    : `Failed to save thinking for "${target.name}" (not applied)`,
                saved ? "info" : "warning",
            );
            state = readState();
        }
    }
}
