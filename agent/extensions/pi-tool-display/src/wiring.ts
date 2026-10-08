/**
 * Merged 2026-09-30 from per-module sources (see FORK.md). This file is now the source of truth - edit it directly.
 * Merged to cut boot cost: jiti pays ~19ms per module regardless of size.
 */
import { BoxTheme, setFullTheme } from "./pistyle/shared/index.js";
import {
    BoxedToolContext,
    renderBoxedToolForCall as renderBoxedToolCall,
    renderBoxedToolForResult as renderBoxedToolResult,
    setToolsRenderConfig,
    renderFallbackCall,
    renderFallbackResult,
    resetBashTreeRegistry,
    resetBatchRegistry,
    resetGrepRegistry,
} from "./pistyle/index.js";
import {
    isDbQueryTool,
    renderDbQueryCall,
    renderDbQueryResult,
    isOcrTool,
    renderOcrCall,
    renderOcrResult,
    isSubagentTool,
    renderSubagentCall,
    renderSubagentResult,
} from "./fork-cards.js";
import {
    ToolDisplayConfig,
    isRecord,
    logToolDisplayDebug,
    registerCleanup,
    buildPromptSnippetFromDescription,
    getTextField,
    isMcpToolCandidate,
    MCP_PROXY_PROMPT_GUIDELINES,
    MCP_PROXY_PROMPT_SNIPPET,
    toRecord,
    ANSI_SGR_PATTERN,
    sanitizeAnsiForThemedOutput,
} from "./support.js";
import {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
    ToolRenderResultOptions,
    UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { onReloadShutdown } from "./index.js";
import {
    Markdown,
    truncateToWidth,
    visibleWidth,
    type Component,
    type DefaultTextStyle,
    type MarkdownTheme,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";

// from: pistyle-bridge.ts

/**
 * Bridge between this extension and the vendored pi-style boxed renderers
 * (src/pistyle/). It normalizes the extension's config, the theme, and Pi's
 * untyped renderer arguments, so the ported renderers stay unmodified apart
 * from dead-code removal.
 */
/** Tools with a dedicated pi-style boxed renderer; powershell shares bash's arguments. */
const DEDICATED_TOOLS = new Set(["read", "write", "edit", "bash"]);
/** Resolves the dedicated renderer name for a tool, or undefined for the boxed fallback card. */
function dedicatedToolName(toolName: unknown): string | undefined {
    if (typeof toolName !== "string") {
        return undefined;
    }
    const name = toolName === "powershell" ? "bash" : toolName;
    return DEDICATED_TOOLS.has(name) ? name : undefined;
}
/** Result shape shared by the boxed and fallback result renderers. */
interface BoxedResult {
    content?: readonly unknown[];
    details?: unknown;
}
interface BoxedResultOptions {
    expanded: boolean;
    isPartial: boolean;
}
let syncedPreviewLines = -1;
let syncedExpandedMaxLines = -1;
let syncedCollapseAfterTurn = -1;
let syncedNerdFonts = -1;
let primedTheme: unknown;
/**
 * pi-style keeps per-call panel registries that its own session coordinator
 * resets; this port drives them from the extension's session lifecycle.
 */
export function resetPistyleRegistries(): void {
    resetGrepRegistry();
    resetBatchRegistry();
    resetBashTreeRegistry();
    syncedPreviewLines = -1;
    syncedExpandedMaxLines = -1;
    syncedCollapseAfterTurn = -1;
    syncedNerdFonts = -1;
    primedTheme = undefined;
}
function syncPistyleRenderConfig(config: ToolDisplayConfig): void {
    const nerdFonts = process.env.ZENTUI_NERD_FONTS !== "0" ? 1 : 0;
    const collapseAfterTurn = config.collapseAfterTurn ? 1 : 0;
    if (
        config.previewLines === syncedPreviewLines &&
        config.expandedPreviewMaxLines === syncedExpandedMaxLines &&
        collapseAfterTurn === syncedCollapseAfterTurn &&
        nerdFonts === syncedNerdFonts
    ) {
        return;
    }
    syncedPreviewLines = config.previewLines;
    syncedExpandedMaxLines = config.expandedPreviewMaxLines;
    syncedCollapseAfterTurn = collapseAfterTurn;
    syncedNerdFonts = nerdFonts;
    setToolsRenderConfig({
        maxCollapsedLines: config.previewLines,
        maxExpandedLines: config.expandedPreviewMaxLines,
        nerdFonts: nerdFonts === 1,
        batchOpenGlyph: nerdFonts === 1 ? "\u{F111}" : "●",
        collapseAfterTurn: collapseAfterTurn === 1,
    });
}
/** Theme extras are cache-guarded inside pi-style; only re-prime on a new theme instance. */
function primeTheme(theme: unknown): void {
    if (primedTheme === theme) {
        return;
    }
    primedTheme = theme;
    setFullTheme(theme);
}
function renderPistyleToolCall(
    toolName: unknown,
    args: Record<string, unknown>,
    theme: unknown,
    context: unknown,
    config: ToolDisplayConfig,
): unknown {
    syncPistyleRenderConfig(config);
    primeTheme(theme);
    const boxTheme = theme as BoxTheme;
    const boxedContext = context as BoxedToolContext;
    // db-viewer's query tools get the fork-owned card (redacted target, SQL preview).
    if (isDbQueryTool(toolName)) {
        return renderDbQueryCall(toolName, args, boxTheme, boxedContext);
    }
    // subagent gets the fork-owned card (per-agent rows, live tool calls).
    if (isSubagentTool(toolName)) {
        return renderSubagentCall(args, boxTheme, boxedContext);
    }
    // OCR review/scan get the fork-owned card (live actions, findings on settle).
    if (isOcrTool(toolName)) {
        return renderOcrCall(toolName, args, boxTheme, boxedContext);
    }
    const name = dedicatedToolName(toolName);
    if (!name) {
        return renderFallbackCall(toolName, args, boxTheme, boxedContext);
    }
    return renderBoxedToolCall(name, args, boxTheme, boxedContext);
}
function renderPistyleToolResult(
    toolName: unknown,
    result: unknown,
    options: unknown,
    theme: unknown,
    context: unknown,
    config: ToolDisplayConfig,
): unknown {
    syncPistyleRenderConfig(config);
    primeTheme(theme);
    const boxTheme = theme as BoxTheme;
    const boxedContext = context as BoxedToolContext;
    const boxedOptions = options as BoxedResultOptions;
    const boxedResult = result as BoxedResult;
    if (isDbQueryTool(toolName)) {
        return renderDbQueryResult(boxedResult, boxedOptions, boxTheme, boxedContext);
    }
    if (isSubagentTool(toolName)) {
        return renderSubagentResult(boxedResult, boxedOptions, boxTheme, boxedContext);
    }
    if (isOcrTool(toolName)) {
        return renderOcrResult(boxedResult, boxedOptions, boxTheme, boxedContext);
    }
    const name = dedicatedToolName(toolName);
    if (!name) {
        return renderFallbackResult(toolName, boxedResult, boxedOptions, boxTheme, boxedContext);
    }
    return renderBoxedToolResult(name, boxedResult, boxedOptions, boxTheme, boxedContext);
}

// from: pistyle-tool-patch.ts

// Renderer registration is native as of Pi 1.0.1: `pi.registerToolRenderer`.
// The previous implementation monkey-patched `ToolExecutionComponent.prototype`
// and reached into the live component instance to clear Pi's container fill.
// That is no longer necessary - `renderShell: "self"` selects Pi's
// `selfRenderContainer` (a bare `Container` with no paddingX/paddingY/bgFn)
// instead of `contentBox` (a `Box(1, 1, theme.bg("toolPendingBg"))`).
function withOutputPad(component: Component, outputPad: number | undefined): Component {
    if (!outputPad || outputPad <= 0) return component;
    const pad = " ".repeat(outputPad);
    return {
        invalidate() {
            component.invalidate();
        },
        render(width: number): string[] {
            const innerWidth = Math.max(1, width - outputPad * 2);
            const lines = component.render(innerWidth);
            return lines.map((line) => (line.length > 0 ? `${pad}${line}` : line));
        },
        handleInput(data: string) {
            component.handleInput?.(data);
        },
        handleMouse(event: TuiMouseEvent) {
            if (!component.handleMouse) return undefined;
            return component.handleMouse({
                ...event,
                x: Math.max(0, event.x - outputPad),
            });
        },
        get wantsKeyRelease() {
            return component.wantsKeyRelease;
        },
    };
}

export function registerPistyleToolRenderer(pi: ExtensionAPI, getConfig: ConfigGetter): void {
    pi.registerToolRenderer((toolName, next) => {
        const config = getConfig();
        if (!config.enabled) {
            return next();
        }
        return {
            renderShell: "self",
            renderCall: (args, theme, context) =>
                withOutputPad(
                    renderPistyleToolCall(
                        toolName,
                        args as Record<string, unknown>,
                        theme,
                        context,
                        config,
                    ) as Component,
                    (context as { outputPad?: number })?.outputPad,
                ),
            renderResult: (result, options, theme, context) =>
                withOutputPad(
                    renderPistyleToolResult(
                        toolName,
                        result,
                        options,
                        theme,
                        context,
                        config,
                    ) as Component,
                    (context as { outputPad?: number })?.outputPad,
                ),
        };
    });
}

// from: thinking-label.ts

interface ThemeLike {
    fg(color: string, text: string): string;
}
interface AssistantMessageLike {
    role?: unknown;
    api?: unknown;
    content?: unknown;
}
const THINKING_CHAT_PREFIX = "Thinking: ";
const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;
const LEADING_ANSI_FRAGMENT_PATTERN = /^(?:\s*;?\d{1,3}(?:;\d{1,3})*m)+\s*/;
const MAX_THINKING_CONTENT_DEPTH = 16;
const registeredThinkingApis = new WeakSet<ExtensionAPI>();
const OPENAI_REASONING_APIS = new Set([
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
]);
function normalizeApiName(api: unknown): string | undefined {
    if (typeof api !== "string") {
        return undefined;
    }
    const normalized = api.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
}
function shouldPrefixThinkingForApi(api: unknown): boolean {
    const normalizedApi = normalizeApiName(api);
    if (!normalizedApi) {
        return true;
    }
    // Most OpenAI transports do not emit thinking blocks; the reasoning APIs do.
    // Other providers are assumed to emit them.
    return !normalizedApi.startsWith("openai-") || OPENAI_REASONING_APIS.has(normalizedApi);
}
function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}
function stripLeadingAnsiFragments(text: string): string {
    let current = text;
    while (true) {
        const next = current.replace(LEADING_ANSI_FRAGMENT_PATTERN, "");
        if (next === current) {
            return current;
        }
        current = next;
    }
}
function stripThinkingPresentationArtifacts(text: string): string {
    let current = stripAnsi(text);
    let removedThinkingLabel = false;
    while (true) {
        const withoutLabel = current.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart();
        if (withoutLabel !== current) {
            current = withoutLabel;
            removedThinkingLabel = true;
            continue;
        }
        const withoutAnsiFragments = stripLeadingAnsiFragments(current).trimStart();
        if (withoutAnsiFragments !== current) {
            const fragmentExposedAnotherLabel =
                withoutAnsiFragments.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart() !==
                withoutAnsiFragments;
            if (removedThinkingLabel || fragmentExposedAnotherLabel) {
                current = withoutAnsiFragments;
                continue;
            }
        }
        return current;
    }
}
function formatThinkingLabel(theme: ThemeLike | undefined, thinkingText: string): string {
    if (!theme) {
        return `${THINKING_CHAT_PREFIX}${thinkingText}`;
    }
    const label = theme.fg("accent", THINKING_CHAT_PREFIX.trimEnd());
    const body = theme.fg("thinkingText", thinkingText);
    return `${label} ${body}`;
}
function prefixThinkingLine(text: string, theme: ThemeLike | undefined): string {
    const normalizedThinking = stripThinkingPresentationArtifacts(text).trim();
    if (!normalizedThinking) {
        return text;
    }
    return formatThinkingLabel(theme, normalizedThinking);
}
function normalizeThinkingLineForContext(text: string): string {
    return stripThinkingPresentationArtifacts(text);
}
function isThinkingBlock(value: unknown): value is Record<string, unknown> & {
    type: "thinking";
    thinking: string;
} {
    if (!isRecord(value)) {
        return false;
    }
    return value.type === "thinking" && typeof value.thinking === "string";
}
function mapThinkingContentArray(
    content: unknown[],
    mapThinkingText: (text: string) => string,
    depth = 0,
    seen: WeakSet<object> = new WeakSet<object>(),
): { content: unknown[]; changed: boolean } {
    if (depth > MAX_THINKING_CONTENT_DEPTH || seen.has(content)) {
        return { content, changed: false };
    }
    seen.add(content);
    let changed = false;
    const nextContent = content.map((block) => {
        if (Array.isArray(block)) {
            const nested = mapThinkingContentArray(block, mapThinkingText, depth + 1, seen);
            if (nested.changed) {
                changed = true;
                return nested.content;
            }
            return block as unknown[];
        }
        if (!isThinkingBlock(block)) {
            return block;
        }
        const nextThinking = mapThinkingText(block.thinking);
        if (nextThinking === block.thinking) {
            return block;
        }
        changed = true;
        return { ...block, thinking: nextThinking };
    });
    return { content: changed ? nextContent : content, changed };
}
function withThinkingLabelsForDisplay(content: unknown, theme: ThemeLike | undefined): unknown {
    if (!Array.isArray(content)) {
        return content;
    }
    const mapped = mapThinkingContentArray(content, (thinking) =>
        prefixThinkingLine(thinking, theme),
    );
    return mapped.changed ? mapped.content : content;
}
function sanitizeThinkingBlocksForContext(message: AssistantMessageLike): AssistantMessageLike {
    if (!Array.isArray(message.content)) {
        return message;
    }
    const mapped = mapThinkingContentArray(message.content, normalizeThinkingLineForContext);
    return mapped.changed ? { ...message, content: mapped.content } : message;
}
function sanitizeContextMessages(messages: unknown): unknown {
    if (!Array.isArray(messages)) {
        return messages;
    }
    const messageList = messages as unknown[];
    let changed = false;
    const nextMessages = messageList.map((message) => {
        if (!isRecord(message) || message.role !== "assistant") {
            return message;
        }
        const sanitized = sanitizeThinkingBlocksForContext(message as AssistantMessageLike);
        if (sanitized !== message) {
            changed = true;
            return sanitized;
        }
        return message;
    });
    return changed ? nextMessages : messageList;
}
function prefixThinkingBlocksForDisplay(
    message: AssistantMessageLike,
    theme: ThemeLike | undefined,
): void {
    if (!shouldPrefixThinkingForApi(message.api)) {
        return;
    }
    const displayContent = withThinkingLabelsForDisplay(message.content, theme);
    if (displayContent !== message.content) {
        message.content = displayContent;
    }
}
function extractAssistantMessage(event: unknown): AssistantMessageLike | undefined {
    if (!isRecord(event)) {
        return undefined;
    }
    const maybeMessage = event.message;
    if (!isRecord(maybeMessage)) {
        return undefined;
    }
    if (maybeMessage.role !== "assistant") {
        return undefined;
    }
    return maybeMessage as AssistantMessageLike;
}
function processThinkingEvent(
    event: unknown,
    ctx: ExtensionContext | undefined,
    notifyPrefix: string,
): void {
    try {
        const message = extractAssistantMessage(event);
        if (!message) {
            return;
        }
        prefixThinkingBlocksForDisplay(message, ctx?.ui?.theme);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        ctx?.ui?.notify(`${notifyPrefix}: ${errorMessage}`, "warning");
    }
}
function handleThinkingMessageUpdateEvent(event: unknown, ctx: ExtensionContext | undefined): void {
    // Render-only labeling: update the transient message_update payload while
    // leaving canonical session/LLM context content untouched.
    processThinkingEvent(event, ctx, "Thinking label formatting failed");
}
function handleThinkingMessageEndEvent(event: unknown, ctx: ExtensionContext | undefined): void {
    // Persist themed labels on final assistant messages so the label remains
    // visible after streaming ends and across session reloads.
    // Context sanitization strips these presentation artifacts before each LLM call.
    processThinkingEvent(event, ctx, "Thinking label finalization failed");
}
function handleThinkingContextEvent(event: unknown, ctx: ExtensionContext | undefined): void {
    try {
        if (!isRecord(event) || !Array.isArray(event.messages)) {
            return;
        }
        const sanitizedMessages = sanitizeContextMessages(event.messages);
        if (sanitizedMessages !== event.messages && Array.isArray(sanitizedMessages)) {
            event.messages.splice(0, event.messages.length, ...(sanitizedMessages as unknown[]));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        ctx?.ui?.notify(`Thinking context sanitization failed: ${message}`, "warning");
    }
}
export function registerThinkingLabeling(pi: ExtensionAPI): void {
    if (registeredThinkingApis.has(pi)) {
        return;
    }
    registeredThinkingApis.add(pi);
    onReloadShutdown(pi, () => {
        registeredThinkingApis.delete(pi);
    });
    pi.on("message_update", async (event, ctx) => {
        handleThinkingMessageUpdateEvent(event, ctx);
    });
    pi.on("message_end", async (event, ctx) => {
        handleThinkingMessageEndEvent(event, ctx);
    });
    pi.on("context", async (event, ctx) => {
        handleThinkingContextEvent(event, ctx);
    });
}

// from: tool-decoration.ts

/**
 * Tool decoration for MCP and custom tools.
 *
 * Rendering is owned entirely by the vendored pi-style boxed renderers, installed
 * by `pistyle-tool-patch.ts` at Pi's renderer-resolution point. That path covers
 * every tool, so this module keeps only the two concerns rendering does not:
 *
 *   1. model-facing metadata for MCP tools (label, description, prompt snippet,
 *      prompt guidelines, parameters, prepareArguments), which improves what the
 *      model knows about a tool rather than what the user sees;
 *   2. the `pi-tool-display.api.v1` global, so other extensions can attach their
 *      own renderers to their tools.
 *
 * `wrapToolRenderersForPistyle` routes the renderers a decorated tool already
 * carries through the boxed path, so decorated and undecorated tools present the
 * same way.
 */
type ConfigGetter = () => ToolDisplayConfig;
interface RuntimeToolDefinition {
    name?: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    prepareArguments?: unknown;
    renderCall?: (
        args: Record<string, unknown>,
        theme: RenderTheme,
        context?: ToolRenderContextLike,
    ) => unknown;
    renderResult?: (
        result: Record<string, unknown>,
        options: ToolRenderResultOptions,
        theme: RenderTheme,
        context?: ToolRenderContextLike,
    ) => unknown;
    renderShell?: unknown;
    [key: string]: unknown;
}
interface RenderTheme {
    fg(color: string, text: string): string;
    bg?(color: string, text: string): string;
    bold(text: string): string;
    getBgAnsi?(color: string): string;
}
interface ToolRenderContextLike {
    args?: unknown;
    toolCallId?: string;
    state?: unknown;
    cwd?: string;
    argsComplete?: boolean;
    executionStarted?: boolean;
    isError?: boolean;
    isPartial?: boolean;
    expanded?: boolean;
    invalidate?: () => void;
}
const pistyleWrappedTools = new WeakSet<RuntimeToolDefinition>();
/**
 * Replaces a tool's renderers with the boxed ones. Tools with no renderer of
 * their own keep `undefined`, which lets Pi fall back to its default card.
 */
function wrapToolRenderersForPistyle(tool: RuntimeToolDefinition, getConfig: ConfigGetter): void {
    if (pistyleWrappedTools.has(tool)) {
        return;
    }
    pistyleWrappedTools.add(tool);
    const ownRenderCall = tool.renderCall;
    const ownRenderResult = tool.renderResult;
    const toolName = typeof tool.name === "string" ? tool.name : undefined;
    tool.renderCall = (args, theme, context) => {
        if (context) {
            return renderPistyleToolCall(toolName, args, theme, context, getConfig());
        }
        return ownRenderCall?.(args, theme, context);
    };
    tool.renderResult = (result, options, theme, context) => {
        if (context) {
            return renderPistyleToolResult(toolName, result, options, theme, context, getConfig());
        }
        return ownRenderResult?.(result, options, theme, context);
    };
}
const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");
const TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY = Symbol.for(
    "pi-tool-display.registerToolInterceptor.v1",
);
const TOOL_DISPLAY_DECORATED_PROPERTIES = [
    "renderCall",
    "renderResult",
    "renderShell",
    "label",
    "description",
    "promptSnippet",
    "promptGuidelines",
    "parameters",
    "prepareArguments",
] as const;
type ToolDisplayKind = "read" | "edit" | "mcp" | "generic";
export interface ToolDisplayAdapter {
    id?: string;
    toolName?: string;
    kind?: ToolDisplayKind;
    overrideExistingRenderers?: boolean;
    pathFields?: string[];
    getPath?: (args: unknown) => string | undefined;
    getEditLineCount?: (args: unknown) => number;
    renderCall?: (args: unknown, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
    renderResult?: (
        result: unknown,
        options: ToolRenderResultOptions,
        theme: RenderTheme,
        context?: ToolRenderContextLike,
    ) => unknown;
}
export interface ToolDisplayApi {
    version: 1;
    decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
    registerAdapter(adapter: ToolDisplayAdapter): string;
    unregisterAdapter(id: string): boolean;
}
interface PendingToolDisplayDecoration {
    tool: RuntimeToolDefinition;
    adapter?: ToolDisplayAdapter;
}
type DecoratedPropertyName = (typeof TOOL_DISPLAY_DECORATED_PROPERTIES)[number];
type ToolPropertyDescriptorSnapshot = Partial<Record<DecoratedPropertyName, PropertyDescriptor>>;
type GlobalWithToolDisplayApi = typeof globalThis & {
    [TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
    [TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: PendingToolDisplayDecoration[];
};
type PiWithRegisterToolInterception = ExtensionAPI & {
    [TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY]?: {
        original: ExtensionAPI["registerTool"];
        wrapped: ExtensionAPI["registerTool"];
    };
};
const decoratedToolDescriptors = new WeakMap<
    RuntimeToolDefinition,
    ToolPropertyDescriptorSnapshot
>();
const decoratedTools = new Set<RuntimeToolDefinition>();
function captureToolPropertyDescriptors(tool: RuntimeToolDefinition): void {
    if (decoratedToolDescriptors.has(tool)) {
        return;
    }
    const snapshot: ToolPropertyDescriptorSnapshot = {};
    for (const property of TOOL_DISPLAY_DECORATED_PROPERTIES) {
        const descriptor = Object.getOwnPropertyDescriptor(tool, property);
        if (descriptor) {
            snapshot[property] = descriptor;
        }
    }
    decoratedToolDescriptors.set(tool, snapshot);
    decoratedTools.add(tool);
}
function restoreToolPropertyDescriptors(): void {
    for (const tool of decoratedTools) {
        const snapshot = decoratedToolDescriptors.get(tool) ?? {};
        for (const property of TOOL_DISPLAY_DECORATED_PROPERTIES) {
            const descriptor = snapshot[property];
            if (descriptor) {
                Object.defineProperty(tool, property, descriptor);
            } else {
                delete tool[property];
            }
        }
        decoratedToolDescriptors.delete(tool);
    }
    decoratedTools.clear();
}
/**
 * Attaches `api.decorateTool`'s result to the tool in place, then routes the
 * result through the boxed renderers. Descriptors are snapshotted first so the
 * whole decoration can be undone on cleanup.
 */
function applyToolDisplayDecorationInPlace(
    tool: RuntimeToolDefinition,
    api: ToolDisplayApi,
    getConfig: ConfigGetter,
    adapter?: ToolDisplayAdapter,
): boolean {
    try {
        captureToolPropertyDescriptors(tool);
        Object.assign(tool, api.decorateTool(tool, adapter));
        wrapToolRenderersForPistyle(tool, getConfig);
        return true;
    } catch (error) {
        logToolDisplayDebug("Tool display decoration failed.", error);
        return false;
    }
}
function drainPendingToolDisplayDecorations(api: ToolDisplayApi, getConfig: ConfigGetter): void {
    const globalWithApi = globalThis as GlobalWithToolDisplayApi;
    const pendingDecorations = globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
    if (!Array.isArray(pendingDecorations) || pendingDecorations.length === 0) {
        return;
    }
    const entries = pendingDecorations.splice(0);
    for (const entry of entries) {
        if (!entry?.tool || typeof entry.tool !== "object") {
            continue;
        }
        applyToolDisplayDecorationInPlace(entry.tool, api, getConfig, entry.adapter);
    }
}
/**
 * Publishes the decoration API. Renderers come only from the caller's adapter:
 * this extension no longer ships default renderers of its own, because the
 * boxed path already renders every tool it decorates.
 */
function installToolDisplayApi(): ToolDisplayApi {
    const adapters = new Map<string, ToolDisplayAdapter>();
    let nextAdapterId = 0;
    const resolveAdapter = (
        tool: RuntimeToolDefinition,
        adapter?: ToolDisplayAdapter,
    ): ToolDisplayAdapter => {
        if (adapter) {
            return adapter;
        }
        const toolName = getTextField(tool, "name");
        if (toolName) {
            return adapters.get(toolName) ?? {};
        }
        return {};
    };
    const api: ToolDisplayApi = {
        version: 1,
        decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T {
            const resolvedAdapter = resolveAdapter(tool, adapter);
            const overrideExisting = resolvedAdapter.overrideExistingRenderers === true;
            const decorated: RuntimeToolDefinition = { ...tool };
            if (
                resolvedAdapter.renderCall &&
                (overrideExisting || typeof decorated.renderCall !== "function")
            ) {
                decorated.renderCall =
                    resolvedAdapter.renderCall as RuntimeToolDefinition["renderCall"];
            }
            if (
                resolvedAdapter.renderResult &&
                (overrideExisting || typeof decorated.renderResult !== "function")
            ) {
                decorated.renderResult =
                    resolvedAdapter.renderResult as RuntimeToolDefinition["renderResult"];
            }
            return decorated as T;
        },
        registerAdapter(adapter: ToolDisplayAdapter): string {
            const id = adapter.id || adapter.toolName || `adapter-${++nextAdapterId}`;
            adapters.set(id, { ...adapter, id });
            if (adapter.toolName) {
                adapters.set(adapter.toolName, { ...adapter, id });
            }
            return id;
        },
        unregisterAdapter(id: string): boolean {
            const adapter = adapters.get(id);
            const removed = adapters.delete(id);
            if (adapter?.toolName) {
                adapters.delete(adapter.toolName);
            }
            return removed;
        },
    };
    (globalThis as GlobalWithToolDisplayApi)[TOOL_DISPLAY_API_KEY] = api;
    return api;
}
function tryGetAllTools(pi: ExtensionAPI, debugMessage: string): unknown[] | undefined {
    try {
        return pi.getAllTools();
    } catch (error) {
        logToolDisplayDebug(debugMessage, error);
        return undefined;
    }
}
/**
 * Promotes an MCP tool to a first-class tool for the model: a readable label, a
 * one-line prompt snippet, and the proxy tool's usage guideline. Presentation is
 * left to the boxed renderers.
 */
function decorateMcpToolMetadata(tool: RuntimeToolDefinition): void {
    const toolName = getTextField(tool, "name");
    if (!toolName) {
        return;
    }
    const toolLabel =
        getTextField(tool, "label") || (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
    const toolDescription = getTextField(tool, "description") || "MCP tool";
    const prepareArgumentsDelegate =
        typeof tool.prepareArguments === "function"
            ? (tool.prepareArguments as (args: unknown) => unknown)
            : undefined;
    const promptMetadata =
        toolName === "mcp"
            ? {
                  promptSnippet: MCP_PROXY_PROMPT_SNIPPET,
                  promptGuidelines: [...MCP_PROXY_PROMPT_GUIDELINES],
              }
            : {
                  promptSnippet: buildPromptSnippetFromDescription(
                      toolDescription,
                      `Call MCP tool '${toolName}'.`,
                  ),
              };
    Object.assign(tool, {
        label: toolLabel,
        description: toolDescription,
        ...promptMetadata,
        parameters: toRecord(tool.parameters),
        prepareArguments: prepareArgumentsDelegate,
    });
}
/**
 * Installs the decoration API and watches `pi.registerTool` so MCP tools
 * registered by other extensions are decorated as they appear. Already-decorated
 * tools are left untouched, and the short retry window covers tools that bind
 * after extension load.
 */
export function registerToolDecoration(pi: ExtensionAPI, getConfig: ConfigGetter): void {
    const toolDisplayApi = installToolDisplayApi();
    drainPendingToolDisplayDecorations(toolDisplayApi, getConfig);
    registerCleanup(() => {
        restoreToolPropertyDescriptors();
        const globalWithApi = globalThis as GlobalWithToolDisplayApi;
        if (globalWithApi[TOOL_DISPLAY_API_KEY] === toolDisplayApi) {
            delete globalWithApi[TOOL_DISPLAY_API_KEY];
        }
    });
    const decoratedToolNames = new Set<string>();
    registerCleanup(() => decoratedToolNames.clear());
    const decorateCandidate = (candidate: unknown): void => {
        try {
            if (!isMcpToolCandidate(candidate)) {
                return;
            }
            const toolName = getTextField(candidate, "name");
            if (!toolName || decoratedToolNames.has(toolName)) {
                return;
            }
            applyToolDisplayDecorationInPlace(
                candidate as RuntimeToolDefinition,
                toolDisplayApi,
                getConfig,
            );
            decorateMcpToolMetadata(candidate as RuntimeToolDefinition);
            decoratedToolNames.add(toolName);
        } catch (error) {
            logToolDisplayDebug("MCP tool decoration failed.", error);
        }
    };
    const piWithInterception = pi as PiWithRegisterToolInterception;
    const existingInterception = piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
    if (existingInterception && pi.registerTool === existingInterception.wrapped) {
        pi.registerTool = existingInterception.original;
        delete piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
    }
    const originalRegisterTool = pi.registerTool;
    const wrappedRegisterTool = function registerToolWithMcpDecoration(
        this: ExtensionAPI,
        tool: ToolDefinition,
    ): void {
        originalRegisterTool.call(this, tool);
        decorateCandidate(tool);
    } as ExtensionAPI["registerTool"];
    pi.registerTool = wrappedRegisterTool;
    piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY] = {
        original: originalRegisterTool,
        wrapped: wrappedRegisterTool,
    };
    registerCleanup(() => {
        if (pi.registerTool === wrappedRegisterTool) {
            pi.registerTool = originalRegisterTool;
        }
        const currentInterception = piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
        if (currentInterception?.wrapped === wrappedRegisterTool) {
            delete piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
        }
    });
    const discoverRegisteredTools = (): void => {
        for (const candidate of tryGetAllTools(pi, "MCP tool decoration discovery failed.") ?? []) {
            decorateCandidate(candidate);
        }
    };
    const discoveryTimers = new Set<ReturnType<typeof setTimeout> & { unref?: () => void }>();
    registerCleanup(() => {
        for (const timer of discoveryTimers) {
            clearTimeout(timer);
        }
        discoveryTimers.clear();
    });
    const scheduleDiscovery = (): void => {
        for (const delayMs of [25, 75, 150, 300]) {
            const timer = setTimeout(() => {
                discoveryTimers.delete(timer);
                discoverRegisteredTools();
            }, delayMs) as ReturnType<typeof setTimeout> & { unref?: () => void };
            discoveryTimers.add(timer);
            timer.unref?.();
        }
    };
    const onToolsMayHaveBound = async (): Promise<void> => {
        discoverRegisteredTools();
        scheduleDiscovery();
    };
    pi.on("session_start", onToolsMayHaveBound);
    pi.on("before_agent_start", onToolsMayHaveBound);
}

// from: user-message-box.ts

// from: user-message-box-patch.ts
type UserMessageRenderFn = (width: number) => string[];
const USER_MESSAGE_PATCH_OWNER = {};
interface PatchableUserMessagePrototype {
    render: UserMessageRenderFn;
    __piUserMessageOriginalRender?: UserMessageRenderFn;
    __piUserMessageNativePatched?: boolean;
    __piUserMessagePatchVersion?: number;
    __piUserMessagePatchOwner?: object;
}
function unregisterUserMessageRenderPrototypePatch(prototype: PatchableUserMessagePrototype): void {
    const originalRender = prototype.__piUserMessageOriginalRender;
    if (typeof originalRender === "function") {
        prototype.render = originalRender;
    }
    delete prototype.__piUserMessageOriginalRender;
    delete prototype.__piUserMessageNativePatched;
    delete prototype.__piUserMessagePatchVersion;
    delete prototype.__piUserMessagePatchOwner;
}
function patchUserMessageRenderPrototype(
    prototype: PatchableUserMessagePrototype,
    patchVersion: number,
    buildRender: (originalRender: UserMessageRenderFn) => UserMessageRenderFn,
): void {
    if (typeof prototype.render !== "function") {
        return;
    }
    const previousOriginalRender = prototype.__piUserMessageOriginalRender;
    const hasPreviousPatch =
        typeof previousOriginalRender === "function" && previousOriginalRender !== prototype.render;
    const isCurrentPatch = prototype.__piUserMessagePatchOwner === USER_MESSAGE_PATCH_OWNER;
    let restoredStalePatch = false;
    if (hasPreviousPatch && !isCurrentPatch) {
        prototype.render = previousOriginalRender;
        delete prototype.__piUserMessageNativePatched;
        delete prototype.__piUserMessagePatchVersion;
        delete prototype.__piUserMessagePatchOwner;
        restoredStalePatch = true;
    }
    if (
        !restoredStalePatch &&
        prototype.__piUserMessageNativePatched &&
        prototype.__piUserMessagePatchVersion === patchVersion &&
        typeof prototype.__piUserMessageOriginalRender === "function"
    ) {
        return;
    }
    if (!prototype.__piUserMessageOriginalRender) {
        prototype.__piUserMessageOriginalRender = prototype.render;
    }
    const originalRender = prototype.__piUserMessageOriginalRender;
    if (!originalRender) {
        return;
    }
    prototype.render = buildRender(originalRender);
    prototype.__piUserMessageNativePatched = true;
    prototype.__piUserMessagePatchVersion = patchVersion;
    prototype.__piUserMessagePatchOwner = USER_MESSAGE_PATCH_OWNER;
}
// from: user-message-box-utils.ts
const OSC_PROMPT_CONTROL_SEQUENCE_PATTERN =
    /\x1b\](?:133|633);[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
const USER_MESSAGE_BACKGROUND = "userMessageBg";
const ANSI_BG_RESET = "\x1b[49m";
const USER_MESSAGE_VERTICAL_PADDING_LINES = 1;
interface UserMessageBackgroundTheme {
    bg?(color: string, text: string): string;
    getBgAnsi?(color: string): string;
}
function hasPromptControlOscSequence(text: string): boolean {
    return text.includes("\x1b]133;") || text.includes("\x1b]633;");
}
function stripOscPromptControlSequences(text: string): string {
    if (!text || !hasPromptControlOscSequence(text)) {
        return text;
    }
    // Strip prompt-control OSC sequences only. OSC 8 hyperlinks are intentionally
    // preserved because they carry renderable terminal hyperlink metadata.
    return text.replace(OSC_PROMPT_CONTROL_SEQUENCE_PATTERN, "");
}
function sanitizeUserMessageAnsi(text: string): string {
    return sanitizeAnsiForThemedOutput(stripOscPromptControlSequences(text));
}
function applyUserMessageBackground(
    theme: UserMessageBackgroundTheme | undefined,
    text: string,
): string {
    if (!text) {
        return text;
    }
    const sanitized = sanitizeUserMessageAnsi(text);
    if (!theme) {
        return sanitized;
    }
    try {
        if (typeof theme.getBgAnsi === "function") {
            return `${theme.getBgAnsi(USER_MESSAGE_BACKGROUND)}${sanitized}${ANSI_BG_RESET}`;
        }
    } catch (themeError) {
        void themeError;
    }
    try {
        if (typeof theme.bg === "function") {
            return theme.bg(USER_MESSAGE_BACKGROUND, sanitized);
        }
    } catch (themeError) {
        void themeError;
    }
    return sanitized;
}
function isVisuallyEmptyLine(line: string): boolean {
    const withoutControlSequences = stripOscPromptControlSequences(line).replace(
        ANSI_SGR_PATTERN,
        "",
    );
    return withoutControlSequences.trim().length === 0;
}
function trimEdgePadding(lines: string[]): string[] {
    let start = 0;
    while (start < lines.length && isVisuallyEmptyLine(lines[start] ?? "")) {
        start++;
    }
    let end = lines.length;
    while (end > start && isVisuallyEmptyLine(lines[end - 1] ?? "")) {
        end--;
    }
    return lines.slice(start, end);
}
function normalizeUserMessageContentLines(lines: string[]): string[] {
    const normalizedLines = trimEdgePadding(lines);
    if (normalizedLines.length === 0) {
        return [];
    }
    return normalizedLines;
}
function normalizeUserMessageContentLine(line: string): string {
    if (isVisuallyEmptyLine(line)) {
        return "";
    }
    return sanitizeUserMessageAnsi(line);
}
function addUserMessageVerticalPadding(lines: string[]): string[] {
    const padding = Array.from({ length: USER_MESSAGE_VERTICAL_PADDING_LINES }, () => "");
    return [...padding, ...lines, ...padding];
}
// from: user-message-box-markdown.ts
interface MarkdownLike {
    text?: unknown;
    theme?: unknown;
    defaultTextStyle?: unknown;
}
interface UserMessageLike {
    children?: unknown;
}
interface UserMessageMarkdownState {
    text: string;
    theme: unknown;
    defaultTextStyle?: Record<string, unknown>;
}
function sanitizeDefaultTextStyle(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const { bgColor: _bgColor, ...rest } = value;
    return Object.keys(rest).length > 0 ? rest : undefined;
}
function isMarkdownLike(value: unknown): value is MarkdownLike {
    return isRecord(value) && typeof value.text === "string" && value.theme !== undefined;
}
function findMarkdownChild(value: unknown): MarkdownLike | undefined {
    if (isMarkdownLike(value)) {
        return value;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const children = Array.isArray(value.children) ? value.children : [];
    for (const child of children) {
        const markdownChild = findMarkdownChild(child);
        if (markdownChild) {
            return markdownChild;
        }
    }
    return undefined;
}
function extractUserMessageMarkdownState(
    userMessage: UserMessageLike,
): UserMessageMarkdownState | undefined {
    const markdownChild = findMarkdownChild(userMessage);
    if (!markdownChild || typeof markdownChild.text !== "string") {
        return undefined;
    }
    return {
        text: markdownChild.text,
        theme: markdownChild.theme,
        defaultTextStyle: sanitizeDefaultTextStyle(markdownChild.defaultTextStyle),
    };
}
// from: user-message-box-renderer.ts
interface UserMessageTheme extends UserMessageBackgroundTheme {
    fg(color: string, text: string): string;
    bold?(text: string): string;
}
interface CachedUserMessageMarkdownRenderer {
    text: string;
    theme: unknown;
    defaultTextStyle?: Record<string, unknown>;
    renderer: { render(width: number): string[] };
    renderedWidth: number;
    renderedLines: string[];
}
interface CachedUserMessageFinalOutput {
    width: number;
    theme: UserMessageTheme | undefined;
    hasMarkdownState: boolean;
    text?: string;
    markdownTheme?: unknown;
    defaultTextStyle?: Record<string, unknown>;
    output: string[];
}
interface CachedUserMessageBodyLines {
    width: number;
    lines: string[];
}
const MIN_BORDER_WIDTH = 8;
const TITLE_TEXT = " user ";
const CONTENT_HORIZONTAL_PADDING_COLUMNS = 1;
const USER_MESSAGE_TOP_MARGIN_LINES = 1;
const USER_MESSAGE_PATCH_VERSION = 8;
const MAX_USER_MESSAGE_MARKDOWN_TEXT_LENGTH = 100_000;
const MAX_USER_MESSAGE_MARKDOWN_LINE_COUNT = 2_000;
function colorBorder(theme: UserMessageTheme | undefined, text: string): string {
    if (!text || !theme) {
        return text;
    }
    try {
        return theme.fg("border", text);
    } catch {
        return text;
    }
}
function colorTitle(theme: UserMessageTheme | undefined, title: string): string {
    if (!title) {
        return title;
    }
    const base = theme?.bold ? theme.bold(title) : title;
    if (!theme) {
        return base;
    }
    try {
        return theme.fg("accent", base);
    } catch {
        return base;
    }
}
function colorUserBackground(theme: UserMessageTheme | undefined, text: string): string {
    return applyUserMessageBackground(theme, text);
}
function computeBoxInnerWidth(totalWidth: number): number {
    return Math.max(0, totalWidth - 2);
}
function buildTopBorder(totalWidth: number, theme: UserMessageTheme | undefined): string {
    const innerWidth = computeBoxInnerWidth(totalWidth);
    const title = truncateToWidth(TITLE_TEXT, innerWidth, "");
    const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
    const row = `${colorBorder(theme, "╭")}${colorTitle(theme, title)}${colorBorder(theme, `${fill}╮`)}`;
    return colorUserBackground(theme, row);
}
function buildBottomBorder(totalWidth: number, theme: UserMessageTheme | undefined): string {
    const innerWidth = computeBoxInnerWidth(totalWidth);
    const row = `${colorBorder(theme, "╰")}${colorBorder(theme, `${"─".repeat(innerWidth)}╯`)}`;
    return colorUserBackground(theme, row);
}
function getUserMessageContentWidth(totalWidth: number): number {
    return Math.max(1, totalWidth - 2 - CONTENT_HORIZONTAL_PADDING_COLUMNS * 2);
}
function wrapContentLine(
    line: string,
    totalWidth: number,
    theme: UserMessageTheme | undefined,
): string {
    const sidePadding = " ".repeat(CONTENT_HORIZONTAL_PADDING_COLUMNS);
    const innerWidth = getUserMessageContentWidth(totalWidth);
    const normalizedLine = normalizeUserMessageContentLine(line);
    const content = truncateToWidth(normalizedLine, innerWidth, "", true);
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
    const row = `${colorBorder(theme, "│")}${sidePadding}${content}${padding}${sidePadding}${colorBorder(theme, "│")}`;
    return colorUserBackground(theme, row);
}
function createMarkdownRenderer(markdownState: UserMessageMarkdownState): {
    render(width: number): string[];
} {
    return new Markdown(
        markdownState.text,
        0,
        0,
        markdownState.theme as MarkdownTheme,
        markdownState.defaultTextStyle as DefaultTextStyle | undefined,
    );
}
function countUserMessageLines(text: string, maxLines: number): number {
    let lineCount = 1;
    for (const character of text) {
        if (character !== "\n") {
            continue;
        }
        lineCount++;
        if (lineCount > maxLines) {
            return lineCount;
        }
    }
    return lineCount;
}
function hasSameDefaultTextStyle(
    left: Record<string, unknown> | undefined,
    right: Record<string, unknown> | undefined,
): boolean {
    if (left === right) {
        return true;
    }
    if (!left || !right) {
        return left === right;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    for (const key of leftKeys) {
        if (left[key] !== right[key]) {
            return false;
        }
    }
    return true;
}
function hasSameMarkdownState(
    cached: Pick<CachedUserMessageMarkdownRenderer, "text" | "theme" | "defaultTextStyle">,
    state: UserMessageMarkdownState,
): boolean {
    return (
        cached.text === state.text &&
        cached.theme === state.theme &&
        hasSameDefaultTextStyle(cached.defaultTextStyle, state.defaultTextStyle)
    );
}
function hasSameFinalOutputState(
    cached: CachedUserMessageFinalOutput,
    width: number,
    theme: UserMessageTheme | undefined,
    markdownState: UserMessageMarkdownState | undefined,
): boolean {
    if (cached.width !== width || cached.theme !== theme) {
        return false;
    }
    if (!markdownState) {
        return !cached.hasMarkdownState;
    }
    return (
        cached.hasMarkdownState &&
        hasSameMarkdownState(
            {
                text: cached.text ?? "",
                theme: cached.markdownTheme,
                defaultTextStyle: cached.defaultTextStyle,
            },
            markdownState,
        )
    );
}
function toFinalOutputCacheEntry(
    width: number,
    theme: UserMessageTheme | undefined,
    markdownState: UserMessageMarkdownState | undefined,
    output: string[],
): CachedUserMessageFinalOutput {
    if (!markdownState) {
        return {
            width,
            theme,
            hasMarkdownState: false,
            output,
        };
    }
    return {
        width,
        theme,
        hasMarkdownState: true,
        text: markdownState.text,
        markdownTheme: markdownState.theme,
        defaultTextStyle: markdownState.defaultTextStyle,
        output,
    };
}
function shouldBypassUserMessageMarkdownRebuild(markdownState: UserMessageMarkdownState): boolean {
    if (markdownState.text.length > MAX_USER_MESSAGE_MARKDOWN_TEXT_LENGTH) {
        return true;
    }
    return (
        countUserMessageLines(markdownState.text, MAX_USER_MESSAGE_MARKDOWN_LINE_COUNT) >
        MAX_USER_MESSAGE_MARKDOWN_LINE_COUNT
    );
}
function createUserMessageMarkdownLineRenderer(
    buildRenderer: (markdownState: UserMessageMarkdownState) => {
        render(width: number): string[];
    } = createMarkdownRenderer,
): (instance: object, markdownState: UserMessageMarkdownState, width: number) => string[] {
    const cache = new WeakMap<object, CachedUserMessageMarkdownRenderer>();
    return (instance, markdownState, width) => {
        const cached = cache.get(instance);
        const canReuseRenderer = cached ? hasSameMarkdownState(cached, markdownState) : false;
        if (canReuseRenderer && cached?.renderedWidth === width) {
            return cached.renderedLines;
        }
        const renderer =
            canReuseRenderer && cached ? cached.renderer : buildRenderer(markdownState);
        const renderedLines = renderer.render(width);
        cache.set(instance, {
            text: markdownState.text,
            theme: markdownState.theme,
            defaultTextStyle: markdownState.defaultTextStyle,
            renderer,
            renderedWidth: width,
            renderedLines,
        });
        return renderedLines;
    };
}
const renderCachedUserMessageMarkdownLines = createUserMessageMarkdownLineRenderer();
function renderUserMessageBodyLines(
    instance: unknown,
    innerWidth: number,
    originalRender: (width: number) => string[],
    markdownState: UserMessageMarkdownState | undefined,
    originalBodyLineCache?: WeakMap<object, CachedUserMessageBodyLines>,
): string[] {
    if (typeof instance !== "object" || instance === null) {
        return originalRender.call(instance, innerWidth) as string[];
    }
    if (!markdownState) {
        const cached = originalBodyLineCache?.get(instance);
        if (cached?.width === innerWidth) {
            return cached.lines;
        }
        const lines = originalRender.call(instance, innerWidth) as string[];
        originalBodyLineCache?.set(instance, { width: innerWidth, lines });
        return lines;
    }
    if (shouldBypassUserMessageMarkdownRebuild(markdownState)) {
        return originalRender.call(instance, innerWidth) as string[];
    }
    try {
        return renderCachedUserMessageMarkdownLines(instance, markdownState, innerWidth);
    } catch {
        return originalRender.call(instance, innerWidth) as string[];
    }
}
function patchNativeUserMessagePrototype(
    prototype: PatchableUserMessagePrototype,
    getTheme: () => UserMessageTheme | undefined,
    isEnabled: () => boolean,
): void {
    const finalOutputCache = new WeakMap<object, CachedUserMessageFinalOutput>();
    const originalBodyLineCache = new WeakMap<object, CachedUserMessageBodyLines>();
    patchUserMessageRenderPrototype(
        prototype,
        USER_MESSAGE_PATCH_VERSION,
        (originalRender) =>
            function renderWithNativeUserBorder(this: unknown, width: number): string[] {
                const safeWidth = Math.max(0, Math.floor(width));
                if (!isEnabled() || safeWidth < MIN_BORDER_WIDTH) {
                    return originalRender.call(this, safeWidth) as string[];
                }
                const canCacheFinalOutput = typeof this === "object" && this !== null;
                const markdownState = canCacheFinalOutput
                    ? extractUserMessageMarkdownState(this as { children?: unknown[] })
                    : undefined;
                if (markdownState && shouldBypassUserMessageMarkdownRebuild(markdownState)) {
                    return originalRender.call(this, safeWidth) as string[];
                }
                const theme = getTheme();
                if (canCacheFinalOutput) {
                    const cached = finalOutputCache.get(this as object);
                    if (
                        cached &&
                        hasSameFinalOutputState(cached, safeWidth, theme, markdownState)
                    ) {
                        return cached.output;
                    }
                }
                const innerWidth = getUserMessageContentWidth(safeWidth);
                const lines = renderUserMessageBodyLines(
                    this,
                    innerWidth,
                    originalRender,
                    markdownState,
                    originalBodyLineCache,
                );
                const contentLines = normalizeUserMessageContentLines(lines);
                const paddedContentLines = addUserMessageVerticalPadding(
                    contentLines.length > 0 ? contentLines : [""],
                );
                const output = [
                    ...Array.from({ length: USER_MESSAGE_TOP_MARGIN_LINES }, () => ""),
                    buildTopBorder(safeWidth, theme),
                    ...paddedContentLines.map((renderLine) =>
                        wrapContentLine(renderLine, safeWidth, theme),
                    ),
                    buildBottomBorder(safeWidth, theme),
                ];
                if (canCacheFinalOutput) {
                    finalOutputCache.set(
                        this as object,
                        toFinalOutputCacheEntry(safeWidth, theme, markdownState, output),
                    );
                }
                return output;
            },
    );
}
// from: user-message-box-native.ts
const registeredNativeUserMessageApis = new WeakSet<ExtensionAPI>();
function getUserMessagePrototype(): PatchableUserMessagePrototype {
    return UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
}
function patchUserMessageRender(
    getTheme: () => UserMessageTheme | undefined,
    isEnabled: () => boolean,
): void {
    patchNativeUserMessagePrototype(getUserMessagePrototype(), getTheme, isEnabled);
}
function restoreUserMessageRender(): void {
    unregisterUserMessageRenderPrototypePatch(getUserMessagePrototype());
}
export function registerNativeUserMessageBox(
    pi: ExtensionAPI,
    getConfig: () => ToolDisplayConfig,
): void {
    if (registeredNativeUserMessageApis.has(pi)) {
        return;
    }
    registeredNativeUserMessageApis.add(pi);
    let activeTheme: UserMessageTheme | undefined;
    const getTheme = (): UserMessageTheme | undefined => activeTheme;
    const isEnabled = (): boolean => getConfig().enableNativeUserMessageBox;
    patchUserMessageRender(getTheme, isEnabled);
    onReloadShutdown(pi, () => {
        restoreUserMessageRender();
        activeTheme = undefined;
        registeredNativeUserMessageApis.delete(pi);
    });
    pi.on("before_agent_start", async () => {
        patchUserMessageRender(getTheme, isEnabled);
    });
    pi.on("session_start", async (_event, ctx) => {
        activeTheme = ctx?.ui?.theme as unknown as UserMessageTheme;
        patchUserMessageRender(getTheme, isEnabled);
    });
}
