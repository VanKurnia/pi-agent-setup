/**
 * Merged 2026-09-30 from per-module sources (see FORK.md). This file is now the source of truth - edit it directly.
 * Merged to cut boot cost: jiti pays ~19ms per module regardless of size.
 */
import {
    BoxTheme,
    setFullTheme,
    formatElapsedMetric,
    getTextOutput,
    formatBoxedRunningStatus,
    formatCompactCount,
    formatToolOutputLine,
    selectRenderLines,
    formatToolName,
    RUNNING_TITLE_GLYPH,
    renderBoxedToolCall,
    renderBoxedToolResult,
} from "./pistyle/shared/index.js";
import {
    BoxedToolContext,
    renderBoxedToolForCall as renderBoxedDispatchCall,
    renderBoxedToolForResult as renderBoxedDispatchResult,
    setToolsRenderConfig,
    renderFallbackCall,
    renderFallbackResult,
    resetBashTreeRegistry,
    resetBatchRegistry,
    resetGrepRegistry,
    type BoxedToolResult,
    displayPath,
    noteBoxedCallState,
    noteBoxedResultPhase,
    noteExecutionStart,
    stateElapsedMs,
    isResultSeen,
    getToolsRenderConfig,
} from "./pistyle/index.js";
import {
    TOOL_DISPLAY_CONFIG,
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
    onReloadShutdown,
} from "./index.js";
import {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
    ToolRenderResultOptions,
    UserMessageComponent,
    getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
    Markdown,
    Text,
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
let primedTheme: unknown;
/**
 * pi-style keeps per-call panel registries that its own session coordinator
 * resets; this port drives them from the extension's session lifecycle.
 */
export function resetPistyleRegistries(): void {
    resetGrepRegistry();
    resetBatchRegistry();
    resetBashTreeRegistry();
    primedTheme = undefined;
}
/** Pushes the frozen render sizing into pi-style; called once per registration. */
function applyPistyleRenderConfig(): void {
    const nerdFonts = process.env.ZENTUI_NERD_FONTS !== "0" ? 1 : 0;
    setToolsRenderConfig({
        maxCollapsedLines: TOOL_DISPLAY_CONFIG.previewLines,
        maxExpandedLines: TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
        nerdFonts: nerdFonts === 1,
        batchOpenGlyph: nerdFonts === 1 ? "\u{F111}" : "●",
        collapseAfterTurn: TOOL_DISPLAY_CONFIG.collapseAfterTurn,
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
): unknown {
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
    return renderBoxedDispatchCall(name, args, boxTheme, boxedContext);
}
function renderPistyleToolResult(
    toolName: unknown,
    result: unknown,
    options: unknown,
    theme: unknown,
    context: unknown,
): unknown {
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
    return renderBoxedDispatchResult(name, boxedResult, boxedOptions, boxTheme, boxedContext);
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

export function registerPistyleToolRenderer(pi: ExtensionAPI): void {
    applyPistyleRenderConfig();
    pi.registerToolRenderer((toolName) => ({
        renderShell: "self",
        renderCall: (args, theme, context) =>
            withOutputPad(
                renderPistyleToolCall(
                    toolName,
                    args as Record<string, unknown>,
                    theme,
                    context,
                ) as Component,
                (context as { outputPad?: number })?.outputPad,
            ),
        renderResult: (result, options, theme, context) =>
            withOutputPad(
                renderPistyleToolResult(toolName, result, options, theme, context) as Component,
                (context as { outputPad?: number })?.outputPad,
            ),
    }));
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
function wrapToolRenderersForPistyle(tool: RuntimeToolDefinition): void {
    if (pistyleWrappedTools.has(tool)) {
        return;
    }
    pistyleWrappedTools.add(tool);
    const ownRenderCall = tool.renderCall;
    const ownRenderResult = tool.renderResult;
    const toolName = typeof tool.name === "string" ? tool.name : undefined;
    tool.renderCall = (args, theme, context) => {
        if (context) {
            return renderPistyleToolCall(toolName, args, theme, context);
        }
        return ownRenderCall?.(args, theme, context);
    };
    tool.renderResult = (result, options, theme, context) => {
        if (context) {
            return renderPistyleToolResult(toolName, result, options, theme, context);
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
    adapter?: ToolDisplayAdapter,
): boolean {
    try {
        captureToolPropertyDescriptors(tool);
        Object.assign(tool, api.decorateTool(tool, adapter));
        wrapToolRenderersForPistyle(tool);
        return true;
    } catch (error) {
        logToolDisplayDebug("Tool display decoration failed.", error);
        return false;
    }
}
function drainPendingToolDisplayDecorations(api: ToolDisplayApi): void {
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
        applyToolDisplayDecorationInPlace(entry.tool, api, entry.adapter);
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
export function registerToolDecoration(pi: ExtensionAPI): void {
    const toolDisplayApi = installToolDisplayApi();
    drainPendingToolDisplayDecorations(toolDisplayApi);
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
            applyToolDisplayDecorationInPlace(candidate as RuntimeToolDefinition, toolDisplayApi);
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
        const timer = setTimeout(() => {
            discoveryTimers.delete(timer);
            discoverRegisteredTools();
        }, 100) as ReturnType<typeof setTimeout> & { unref?: () => void };
        discoveryTimers.add(timer);
        timer.unref?.();
    };
    pi.on("session_start", () => {
        discoverRegisteredTools();
        scheduleDiscovery();
    });
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
export function registerNativeUserMessageBox(pi: ExtensionAPI): void {
    if (registeredNativeUserMessageApis.has(pi)) {
        return;
    }
    registeredNativeUserMessageApis.add(pi);
    let activeTheme: UserMessageTheme | undefined;
    const getTheme = (): UserMessageTheme | undefined => activeTheme;
    const isEnabled = (): boolean => TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox;
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

// from: db-query-card.ts

/**
 * Boxed card for db-viewer's query tools (fork addition — not vendored pi-style).
 *
 * db-viewer ships only a `renderResult` (a markdown box table) for these tools and
 * this fork's renderer patch bypasses it: without this card they fall to the
 * generic fallback, which loses the table look and prints every argument —
 * including the credentials inside `connectionString`.
 */
/** db-viewer tool name → card title (mirrors the label on its tool definitions). */
const DB_QUERY_TOOL_LABELS: Record<string, string> = {
    query_sqlite: "Query SQLite",
    query_mysql: "Query MySQL",
};
/** SQL lines shown on a collapsed call card; expanding the block reveals the rest. */
const COLLAPSED_QUERY_LINES = 5;
/** Mirrors `COLLAPSED_LINES` in agent/extensions/shared/markdown.ts. */
const COLLAPSED_MARKDOWN_LINES = 10;
/** True for the db-viewer tools this card owns. */
function isDbQueryTool(toolName: unknown): toolName is string {
    return typeof toolName === "string" && Object.hasOwn(DB_QUERY_TOOL_LABELS, toolName);
}
/**
 * Strip the password out of a connection URI before it reaches the card:
 * `mysql://user:pw@host:3306/db` → `mysql://user:***@host:3306/db`. User, host
 * and database stay (they say *which* database was queried); anything that does
 * not look like a URI is returned unchanged. The userinfo/host split is the last
 * `@` — inside the authority when the URI is well formed, and the last one in the
 * URI otherwise — so a password containing `@`, `/`, `?` or `#` is masked instead
 * of returned raw.
 */
function redactConnectionTarget(raw: string): string {
    const uri = raw.trim();
    const schemeEnd = uri.indexOf("://");
    if (schemeEnd <= 0) return uri;
    const userinfoStart = schemeEnd + 3;
    const pathStart = uri.slice(userinfoStart).search(/[/?#]/);
    const authorityEnd = pathStart < 0 ? uri.length : userinfoStart + pathStart;
    const inAuthority = uri.lastIndexOf("@", authorityEnd);
    const at = inAuthority >= userinfoStart ? inAuthority : uri.lastIndexOf("@");
    if (at <= userinfoStart) return uri;
    const colon = uri.indexOf(":", userinfoStart);
    if (colon < 0 || colon > at) return uri; // no password to hide
    return `${uri.slice(0, userinfoStart)}${uri.slice(userinfoStart, colon)}:***${uri.slice(at)}`;
}
/** Card header target: the redacted connection URI, or the sqlite file path. */
function callTarget(args: Record<string, unknown>, context: BoxedToolContext): string | undefined {
    const connection = args?.connectionString;
    if (typeof connection === "string" && connection.trim()) {
        return redactConnectionTarget(connection);
    }
    const dbPath = args?.dbPath;
    if (typeof dbPath === "string" && dbPath.trim()) {
        return displayPath(dbPath, context);
    }
    return undefined;
}
function renderDbQueryCall(
    toolName: string,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    const queryLines = (typeof args?.query === "string" ? args.query : "")
        .replace(/\r/g, "")
        .split("\n");
    const shownLines = context.expanded
        ? queryLines.length
        : Math.min(queryLines.length, COLLAPSED_QUERY_LINES);
    const detailLines: string[] = [];
    for (let index = 0; index < shownLines; index++) {
        const prefix = index === 0 ? "> " : "  ";
        detailLines.push(`${theme.fg("dim", prefix)}${queryLines[index] ?? ""}`);
    }
    if (queryLines.length > shownLines) {
        detailLines.push(theme.fg("muted", `... ${queryLines.length - shownLines} more lines`));
    }
    const maxRows = args?.maxRows;
    if (typeof maxRows === "number" && Number.isFinite(maxRows)) {
        detailLines.push(`${theme.fg("dim", "Max rows: ")}${Math.floor(maxRows)}`);
    }
    return renderBoxedToolCall(theme, DB_QUERY_TOOL_LABELS[toolName], detailLines, {
        headerDetail: callTarget(args, context),
        isError: context.isError,
        isPartial: context.isPartial,
        isPending: context.isPartial,
        running: context.executionStarted,
        resultSeen: isResultSeen(context.state),
    });
}
/**
 * db-viewer's result look: pi's Markdown renderer (box tables) with the same
 * 10-line collapse. Errors and empty output stay plain text, as upstream.
 */
function markdownRows(
    text: string,
    expanded: boolean,
    isError: boolean,
): (width: number) => string[] {
    return (width) => {
        if (isError || !text.trim()) return new Text(text, 0, 0).render(width);
        const lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
        if (expanded) {
            const maxExpanded = getToolsRenderConfig().maxExpandedLines;
            if (maxExpanded > 0 && lines.length > maxExpanded) {
                const remaining = lines.length - maxExpanded;
                return [
                    ...lines.slice(0, maxExpanded),
                    `... (${remaining} more lines omitted by render budget)`,
                ];
            }
            return lines;
        }
        if (lines.length <= COLLAPSED_MARKDOWN_LINES) return lines;
        const remaining = lines.length - COLLAPSED_MARKDOWN_LINES;
        return [
            ...lines.slice(0, COLLAPSED_MARKDOWN_LINES),
            `... (${remaining} more lines, expand)`,
        ];
    };
}
/** Data rows in a `formatRowsToMarkdown` table (header and separator are not rows). */
function countTableRows(text: string): number | undefined {
    let tableLines = 0;
    let separatorSeen = false;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) continue;
        tableLines++;
        if (/^\|[\s:|-]+$/.test(trimmed)) separatorSeen = true;
    }
    return separatorSeen && tableLines >= 2 ? tableLines - 2 : undefined;
}
/** ` · N items` — the secondary metric appended after a footer's primary one. */
function countMetric(
    theme: BoxTheme,
    count: number,
    singular: string,
    plural = `${singular}s`,
): string {
    const label = `${count} ${count === 1 ? singular : plural}`;
    return `${theme.fg("dim", " · ")}${theme.fg("dim", label)}`;
}
/** `elapsed · N rows` — the word-count metric would be noise for a table. */
function dbFooter(theme: BoxTheme, context: BoxedToolContext, rows: number | undefined): string {
    const elapsedMs = stateElapsedMs(context);
    const elapsed =
        elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs);
    if (rows === undefined) return elapsed;
    return `${elapsed}${countMetric(theme, rows, "row")}`;
}
function renderDbQueryResult(
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteBoxedResultPhase(context, options.isPartial);
    const isError = context.isError;
    const text = getTextOutput(result);
    return renderBoxedToolResult(theme, markdownRows(text, options.expanded, isError), {
        dividerLabel: "Rows",
        footerLines: [dbFooter(theme, context, countTableRows(text))],
        isError,
        isPartial: options.isPartial,
    });
}

// from: ocr-card.ts

/**
 * Boxed card for the OCR tools (`ocr_review`, `ocr_scan`) (fork addition — not vendored pi-style).
 *
 * The OCR extension publishes its live run state through `details` on every
 * partial update and on the settled return. This card reads that state: live
 * action and file rows while running, severity-grouped findings with a metrics
 * footer once it settles. Without it the run falls to the generic fallback,
 * which prints the raw JSON wall and drops `details` entirely.
 */
/** Action rows shown while collapsed; expanding reveals the rest. */
const COLLAPSED_ACTIONS = 12;
/** Findings shown while collapsed; expanding reveals the rest. */
const COLLAPSED_FINDINGS = 3;
/** Call-card detail lines shown while collapsed. */
const COLLAPSED_CALL_LINES = 5;
/**
 * Braille frames for in-flight file rows, same set `bash-display.ts` uses.
 * The shared boxed ticker repaints once a second (that is what keeps elapsed
 * labels live), which is far too coarse for a spinner to read as motion, so a
 * running card drives its own faster repaint through `context.invalidate()`.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 150;
let spinnerFrameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let spinnerCleanupRegistered = false;
function startSpinnerTicker(context: BoxedToolContext): void {
    if (spinnerTimer !== undefined) return;
    if (!spinnerCleanupRegistered) {
        // Register first, then flip the flag: if the registry is already disposed,
        // registerCleanup runs the callback immediately.
        registerCleanup(stopSpinnerTicker);
        spinnerCleanupRegistered = true;
    }
    spinnerTimer = setInterval(() => {
        spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
        context.invalidate();
    }, SPINNER_INTERVAL_MS);
}
function stopSpinnerTicker(): void {
    if (spinnerTimer === undefined) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
}
interface OcrActionRow {
    tool: string;
    args?: string;
    ok: boolean;
    ms?: number;
}
interface OcrFileRow {
    path: string;
    comments?: number;
}
interface OcrFindingRow {
    path: string;
    start: number;
    end: number;
    severity: string;
    category: string;
    content: string;
    suggestion?: string;
}
interface OcrResultState {
    findings: OcrFindingRow[];
    filesReviewed: number;
    comments: number;
    totalTokens: number;
    elapsed?: string;
    model?: string;
}
interface OcrCardState {
    mode: string;
    scope?: string;
    files?: OcrFileRow[];
    actions: OcrActionRow[];
    result?: OcrResultState;
    error?: string;
}
/** True for the OCR tools this card owns (`ocr_health` keeps the fallback card). */
function isOcrTool(toolName: unknown): toolName is string {
    return toolName === "ocr_review" || toolName === "ocr_scan";
}
/**
 * Cosmetic `mode · scope` for the call header, kept local on purpose: the
 * vendored fork stays self-contained and never imports from the OCR extension.
 */
function callScope(toolName: string, args: Record<string, unknown>): string {
    const mode = toolName === "ocr_scan" ? "scan" : "review";
    let scope: string;
    if (mode === "scan") {
        scope = asString(args.path) ?? "whole repo";
    } else if (asString(args.commit)) {
        scope = `commit ${(args.commit as string).slice(0, 7)}`;
    } else {
        const from = asString(args.from);
        const to = asString(args.to);
        scope = from && to ? `${from}..${to}` : "workspace";
    }
    if (args.preview === true) scope += " · preview";
    return `${mode} · ${scope}`;
}
/** Call-card body: model, scope source and background context, max 5 lines collapsed. */
function callDetailLines(
    args: Record<string, unknown>,
    expanded: boolean,
    theme: BoxTheme,
): string[] {
    const lines: string[] = [];
    const model = asString(args.model);
    if (model) lines.push(`${theme.fg("dim", "model: ")}${model}`);
    const commit = asString(args.commit);
    const path = asString(args.path);
    const from = asString(args.from);
    const to = asString(args.to);
    const scopeSource = commit ?? path ?? (from && to ? `${from}..${to}` : undefined);
    if (scopeSource) lines.push(`${theme.fg("dim", "scope: ")}${oneLine(scopeSource, 80)}`);
    const background = asString(args.background);
    if (background) {
        if (expanded) {
            lines.push(theme.fg("dim", "context:"));
            for (const line of background.replace(/\r/g, "").split("\n")) {
                if (line.trim()) lines.push(`  ${line.trim()}`);
            }
        } else {
            lines.push(`${theme.fg("dim", "context: ")}${oneLine(background, 80)}`);
        }
    }
    return expanded ? lines : lines.slice(0, COLLAPSED_CALL_LINES);
}
function renderOcrCall(
    toolName: string,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    if (!context.isPartial) stopSpinnerTicker();
    // The title is a literal: the name formatter would render "Ocr Review".
    const title = toolName === "ocr_scan" ? "OCR Scan" : "OCR Review";
    let headerDetail = callScope(toolName, args);
    const effort = asString(args.effort);
    if (effort) headerDetail += ` · effort ${effort}`;
    if (headerDetail.length > 63) headerDetail = `${headerDetail.slice(0, 60)}…`;
    return renderBoxedToolCall(theme, title, callDetailLines(args, context.expanded, theme), {
        headerDetail,
        isError: context.isError,
        isPartial: context.isPartial,
        isPending: context.isPartial,
        running: context.executionStarted,
        resultSeen: isResultSeen(context.state),
    });
}
/** `details` arrives untyped through the renderer bridge, so every entry is narrowed before use. */
function readDetails(result: BoxedToolResult | undefined): OcrCardState | undefined {
    const details = result?.details;
    if (!details || typeof details !== "object") return undefined;
    const raw = details as Record<string, unknown>;
    const filesRaw = Array.isArray(raw.files) ? raw.files : undefined;
    const files = filesRaw
        ?.map((entry) => {
            if (!entry || typeof entry !== "object") return undefined;
            const record = entry as Record<string, unknown>;
            const path = asString(record.path);
            if (!path) return undefined;
            const row: OcrFileRow = { path };
            const comments = asNumber(record.comments);
            if (comments !== undefined) row.comments = comments;
            return row;
        })
        .filter((row): row is OcrFileRow => row !== undefined);
    // An empty file list carries no rows, so it counts as absent.
    const fileRows = files && files.length > 0 ? files : undefined;
    const actionsRaw = Array.isArray(raw.actions) ? raw.actions : [];
    const actions: OcrActionRow[] = [];
    for (const entry of actionsRaw) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const tool = asString(record.tool);
        if (!tool) continue;
        const action: OcrActionRow = { tool, ok: record.ok === true };
        const args = asString(record.args);
        if (args !== undefined) action.args = args;
        const ms = asNumber(record.ms);
        if (ms !== undefined) action.ms = ms;
        actions.push(action);
    }
    let stateResult: OcrResultState | undefined;
    const resultRaw = raw.result;
    if (resultRaw && typeof resultRaw === "object") {
        const record = resultRaw as Record<string, unknown>;
        const findings: OcrFindingRow[] = [];
        const commentsRaw = Array.isArray(record.findings) ? record.findings : [];
        for (const entry of commentsRaw) {
            if (!entry || typeof entry !== "object") continue;
            const finding = entry as Record<string, unknown>;
            const path = asString(finding.path);
            if (!path) continue;
            findings.push({
                path,
                start: asNumber(finding.start_line) ?? 0,
                end: asNumber(finding.end_line) ?? 0,
                severity: asString(finding.severity) ?? "",
                category: asString(finding.category) ?? "",
                content: asString(finding.content) ?? "",
                suggestion: asString(finding.suggestion_code),
            });
        }
        stateResult = {
            findings,
            filesReviewed: asNumber(record.filesReviewed) ?? 0,
            comments: asNumber(record.comments) ?? findings.length,
            totalTokens: asNumber(record.totalTokens) ?? 0,
            elapsed: asString(record.elapsed),
            model: asString(record.model),
        };
    }
    return {
        mode: asString(raw.mode) ?? "review",
        scope: asString(raw.scope),
        files: fileRows,
        actions,
        result: stateResult,
        error: asString(raw.error),
    };
}
function fileRowLines(
    files: OcrFileRow[],
    glyph: string,
    glyphRole: "warning" | "success" | "error",
    theme: BoxTheme,
    withCounts: boolean,
): string[] {
    return files.map((file) => {
        const count =
            withCounts && file.comments !== undefined
                ? theme.fg(
                      "dim",
                      `  ${file.comments} ${file.comments === 1 ? "comment" : "comments"}`,
                  )
                : "";
        return `${theme.fg(glyphRole, glyph)} ${file.path}${count}`;
    });
}
function applyBudget(lines: string[], expanded: boolean, theme: BoxTheme): string[] {
    const budget = expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_RUN_LINES;
    if (lines.length <= budget) return lines;
    const omitted = lines.length - budget;
    return [
        ...lines.slice(0, budget),
        theme.fg("muted", `… ${omitted} more lines omitted by render budget`),
    ];
}
function severityRole(severity: string): "error" | "warning" | "dim" {
    switch (severity.toLowerCase()) {
        case "high":
        case "critical":
        case "error":
            return "error";
        case "medium":
        case "moderate":
        case "warning":
            return "warning";
        default:
            return "dim";
    }
}
function findingBlockLines(
    finding: OcrFindingRow,
    showSuggestion: boolean,
    expanded: boolean,
    theme: BoxTheme,
): string[] {
    const role = severityRole(finding.severity);
    const location =
        finding.start > 0 ? `${finding.path}:${finding.start}-${finding.end}` : finding.path;
    const lines = [
        `${theme.fg(role, "●")} ${theme.fg(role, finding.severity.toUpperCase() || "?")}  ${theme.fg("accent", finding.category || "review")}  ${theme.fg("dim", location)}`,
    ];
    if (finding.content) {
        for (const line of finding.content.replace(/\r/g, "").split("\n")) {
            if (line.trim()) lines.push(`  ${line.trim()}`);
        }
    }
    // Only the first finding carries its suggestion inline; the rest stay compact.
    if (showSuggestion && finding.suggestion) {
        const { lines: suggestionLines, omitted } = selectRenderLines(
            finding.suggestion,
            expanded ? getToolsRenderConfig().maxExpandedLines : 10,
        );
        lines.push(theme.fg("muted", "┌ suggestion"));
        for (const line of suggestionLines) {
            lines.push(formatToolOutputLine(theme, `│ ${line}`));
        }
        if (omitted > 0) {
            lines.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
        }
        lines.push(theme.fg("muted", "└"));
    }
    return lines;
}
function summaryLine(result: OcrResultState, theme: BoxTheme): string {
    const files = `${result.filesReviewed} ${result.filesReviewed === 1 ? "file" : "files"} reviewed`;
    const comments = `${result.comments} ${result.comments === 1 ? "comment" : "comments"}`;
    return `${theme.fg("text", files)}${theme.fg("dim", " · ")}${theme.fg("text", comments)}`;
}
function settledFooterLines(
    state: OcrCardState,
    result: OcrResultState,
    theme: BoxTheme,
    context: BoxedToolContext,
): string[] {
    const elapsedMs = stateElapsedMs(context);
    const elapsed =
        result.elapsed ??
        (elapsedMs === undefined ? undefined : formatElapsedMetric(theme, elapsedMs));
    const total = Math.max(state.files?.length ?? 0, result.filesReviewed);
    const parts = [
        theme.fg("dim", elapsed ?? "--"),
        theme.fg("dim", `${result.filesReviewed}/${total} files`),
    ];
    if (result.totalTokens > 0) {
        parts.push(theme.fg("dim", `${formatCompactCount(result.totalTokens)} tok`));
    }
    if (result.model) parts.push(theme.fg("dim", result.model));
    return [parts.join(theme.fg("dim", " · "))];
}

function actionRowLines(actions: OcrActionRow[], expanded: boolean, theme: BoxTheme): string[] {
    const maxActions = expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_ACTIONS;
    const shown = actions.length > maxActions ? actions.slice(-maxActions) : actions;
    const omitted = actions.length - shown.length;
    const lines: string[] = [];
    if (omitted > 0) {
        lines.push(theme.fg("muted", `… ${omitted} earlier actions omitted by render budget`));
    }
    for (const action of shown) {
        const glyph = action.ok ? theme.fg("success", "✓") : theme.fg("warning", "▸");
        const args = action.args ? ` ${theme.fg("dim", oneLine(action.args, 80))}` : "";
        const ms =
            action.ms !== undefined
                ? `${theme.fg("dim", " · ")}${formatElapsedMetric(theme, action.ms)}`
                : "";
        lines.push(`${glyph} ${theme.fg("accent", action.tool)}${args}${ms}`);
    }
    return lines;
}

/** Placeholder shown before the first progress line reaches the card. */
function emptyPartialHint(state: OcrCardState): string {
    if (state.scope) return `Running ${state.mode} · ${state.scope} — preparing review…`;
    return `Running ${state.mode} — preparing review…`;
}

function renderPartial(
    state: OcrCardState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const body = (contentWidth: number): string[] => {
        void contentWidth;
        const lines: string[] = [];
        const files = state.files ?? [];
        const hasActions = state.actions.length > 0;

        if (state.error) {
            lines.push(theme.fg("error", state.error));
        } else if (hasActions) {
            lines.push(...actionRowLines(state.actions, options.expanded, theme));
        } else if (files.length === 0) {
            lines.push(theme.fg("dim", emptyPartialHint(state)));
        }

        if (!state.error && files.length > 0) {
            if (hasActions) lines.push("", theme.fg("dim", "Files"));
            lines.push(
                ...fileRowLines(files, SPINNER_FRAMES[spinnerFrameIndex], "warning", theme, false),
            );
        }
        return applyBudget(lines, options.expanded, theme);
    };
    startSpinnerTicker(context);
    const fileCount = state.files?.length ?? 0;
    const footer = `${formatBoxedRunningStatus(theme, stateElapsedMs(context))}${
        fileCount > 0 ? countMetric(theme, fileCount, "file") : ""
    }`;
    let dividerLabel = "Status";
    if (state.actions.length > 0) dividerLabel = "Actions";
    else if (fileCount > 0) dividerLabel = "Files";
    return renderBoxedToolResult(theme, body, {
        dividerLabel,
        footerLines: [footer],
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
function renderSettled(
    state: OcrCardState,
    result: OcrResultState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const maxFindings = options.expanded
        ? getToolsRenderConfig().maxExpandedLines
        : COLLAPSED_FINDINGS;
    const body = (): string[] => {
        const lines = [summaryLine(result, theme), ""];
        const shown = result.findings.slice(0, maxFindings);
        if (shown.length === 0) {
            lines.push(`${theme.fg("success", "✓")} ${theme.fg("dim", "no findings")}`);
        } else {
            for (const [index, finding] of shown.entries()) {
                if (index > 0) lines.push("");
                lines.push(...findingBlockLines(finding, index === 0, options.expanded, theme));
            }
            if (result.findings.length > shown.length) {
                lines.push(
                    theme.fg(
                        "muted",
                        `… ${result.findings.length - shown.length} more lines omitted by render budget`,
                    ),
                );
            }
        }
        if (state.files !== undefined && state.files.length > 0) {
            lines.push("", theme.fg("dim", "Files"));
            lines.push(...fileRowLines(state.files, "✓", "success", theme, true));
        }
        return applyBudget(lines, options.expanded, theme);
    };
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Findings",
        footerLines: settledFooterLines(state, result, theme, context),
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
function renderPreview(
    state: OcrCardState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const body = (): string[] => {
        const lines =
            state.files && state.files.length > 0
                ? fileRowLines(state.files, "✓", "success", theme, false)
                : [theme.fg("dim", "No output received yet")];
        return applyBudget(lines, options.expanded, theme);
    };
    const elapsedMs = stateElapsedMs(context);
    const footer = [
        `${elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs)}${theme.fg("dim", " · ")}${theme.fg("dim", `${state.files?.length ?? 0} files`)}`,
    ];
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Files",
        footerLines: footer,
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
function renderFailed(
    state: OcrCardState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
    fallbackError?: string,
): Component {
    const body = (): string[] => {
        const errorText = state.error || fallbackError || "Unknown error";
        const { lines: errorLines, omitted } = selectRenderLines(
            errorText,
            options.expanded ? getToolsRenderConfig().maxExpandedLines : 10,
        );
        const lines = errorLines.map((line) => formatToolOutputLine(theme, line, "error"));
        if (omitted > 0) {
            lines.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
        }
        if (state.files !== undefined && state.files.length > 0) {
            lines.push("", theme.fg("dim", "Files"));
            lines.push(...fileRowLines(state.files, "✗", "error", theme, true));
        }
        return applyBudget(lines, options.expanded, theme);
    };
    const elapsedMs = stateElapsedMs(context);
    const fileCount = state.files?.length ?? 0;
    const footer = [
        `${
            elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs)
        }${fileCount > 0 ? countMetric(theme, fileCount, "file") : ""}`,
    ];
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Error",
        footerLines: footer,
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
function renderOcrResult(
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
    // Terminal pass: the run is over, so the spinner must not outlive it.
    if (!options.isPartial) stopSpinnerTicker();
    const state = readDetails(result);
    const output = getTextOutput(result);
    if (!state) {
        // No structured payload: fall back to the plain output so the card never
        // renders empty.
        const text = output.trim() || "No output received yet";
        return renderBoxedToolResult(theme, (width) => new Text(text, 0, 0).render(width), {
            dividerLabel: "Output",
            isError: context.isError,
            isPartial: options.isPartial,
        });
    }
    if (options.isPartial && firstResultPass) return EMPTY_RESULT;
    if (options.isPartial) return renderPartial(state, options, theme, context);
    if (context.isError || state.error) {
        return renderFailed(state, options, theme, context, output.trim());
    }
    if (state.result) return renderSettled(state, state.result, options, theme, context);
    // Preview runs publish the seeded file list without a result payload.
    return renderPreview(state, options, theme, context);
}

// from: subagent-card.ts

/**
 * Boxed card for the `subagent` tool (fork addition — not vendored pi-style).
 *
 * The renderer patch replaces every tool's renderer, so subagents' own
 * `renderResult` never ran: a running subagent fell to the generic fallback,
 * which prints the call args (`Agent:/Title:/Task:`) plus the literal content
 * string `(running...)` and drops `details` entirely. This card keeps the
 * fork's box chrome and draws that payload instead — one row per agent, its
 * live tool rows while running, metrics once it settles, and the concatenated
 * output underneath.
 */
const SUBAGENT_TOOL_NAME = "subagent";
/** Call-card task preview before the expand hint, mirroring pi-style's 5-line cap. */
const COLLAPSED_TASK_LINES = 5;
/** Tool rows shown per agent while collapsed; expanding reveals the rest. */
const COLLAPSED_TOOL_ROWS = 6;
/** Result output lines shown while collapsed. */
const COLLAPSED_OUTPUT_LINES = 10;
/**
 * Collapsed line budget for the whole card. Deliberately not `previewLines`
 * (8): a multi-agent run needs its per-agent rows, the live tool rows and the
 * output, and the shared preview budget cut the payload off before the output
 * section could ever appear.
 */
const COLLAPSED_RUN_LINES = 24;
interface SubagentToolRow {
    tool?: unknown;
    args?: unknown;
    durationMs?: unknown;
    isError?: unknown;
}
interface SubagentProgress {
    status?: unknown;
    currentTool?: unknown;
    currentToolArgs?: unknown;
    recentTools?: SubagentToolRow[];
    toolCount?: unknown;
    tokens?: unknown;
    durationMs?: unknown;
    lastMessage?: unknown;
    error?: unknown;
}
interface SubagentRow {
    agent?: unknown;
    title?: unknown;
    task?: unknown;
    exitCode?: unknown;
    progress?: SubagentProgress;
}
interface SubagentDetails {
    results?: SubagentRow[];
    mode?: unknown;
    pane?: unknown;
    reused?: unknown;
}
/** True for the `subagent` tool this card owns. */
function isSubagentTool(toolName: unknown): toolName is string {
    return toolName === SUBAGENT_TOOL_NAME;
}
function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** `details` arrives untyped through the renderer bridge, so every entry is narrowed before use. */
function readSubagentRows(result: BoxedToolResult | undefined): SubagentRow[] | undefined {
    const details = result?.details;
    if (!details || typeof details !== "object") return undefined;
    const results = (details as SubagentDetails).results;
    if (!Array.isArray(results)) return undefined;
    // Rows are dereferenced throughout this card, so non-objects are dropped here.
    const rows = results.filter(
        (row): row is SubagentRow => typeof row === "object" && row !== null,
    );
    return rows.length > 0 ? rows : undefined;
}
/** Single-line preview: newlines collapsed, cut to `max` characters. */
function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
/** First `max` logical lines of a task, for the call card. */
function taskPreviewLines(task: string, max: number): string[] {
    return task
        .replace(/\r/g, "")
        .split("\n")
        .slice(0, max)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
/** One entry of the call card: a requested run. */
interface CallItem {
    agent: string;
    label?: string;
    task?: string;
}
function toRequest(raw: unknown): CallItem {
    const item = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
        agent: asString(item.agent) ?? "?",
        label: asString(item.title),
        task: asString(item.task),
    };
}
/** Flatten the call arguments into the runs being requested, plus a header summary. */
function readCall(args: Record<string, unknown>): { summary: string; items: CallItem[] } {
    return { summary: `single · ${asString(args.agent) ?? "?"}`, items: [toRequest(args)] };
}
/** Body lines for the call card: one block per requested agent/task. */
function requestDetailLines(items: CallItem[], expanded: boolean, theme: BoxTheme): string[] {
    const maxLines = expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_TASK_LINES;
    const lines: string[] = [];
    for (const item of items) {
        lines.push(
            `${theme.fg("accent", item.agent)}${item.label ? theme.fg("dim", ` · ${item.label}`) : ""}`,
        );
        for (const line of item.task ? taskPreviewLines(item.task, maxLines) : []) {
            lines.push(`${theme.fg("muted", "  ")}${theme.fg("dim", line)}`);
        }
    }
    return lines;
}
/**
 * Shared with the subagents widget (`subagents/src/render.ts`): only `running`
 * and `pending` come from the reported status, and a terminal row is judged by
 * its exit code, so both surfaces classify the same payload identically.
 */
function rowStatus(row: SubagentRow): "running" | "pending" | "completed" | "failed" {
    const status = asString(row.progress?.status) ?? "running";
    if (status === "running" || status === "pending") return status;
    return row.exitCode === 0 ? "completed" : "failed";
}
function rowGlyph(row: SubagentRow, theme: BoxTheme): string {
    switch (rowStatus(row)) {
        case "running":
            return theme.fg("warning", RUNNING_TITLE_GLYPH);
        case "pending":
            return theme.fg("dim", "○");
        case "completed":
            return theme.fg("success", "✓");
        default:
            return theme.fg("error", "✗");
    }
}
/** Compact tool count, tokens and elapsed for one agent row. */
function rowMetrics(row: SubagentRow, theme: BoxTheme): string {
    const parts: string[] = [];
    const tools = asNumber(row.progress?.toolCount);
    const tokens = asNumber(row.progress?.tokens);
    const durationMs = asNumber(row.progress?.durationMs);
    if (tools) parts.push(`${tools} tools`);
    if (tokens) parts.push(`${formatCompactCount(tokens)} tok`);
    if (durationMs) parts.push(formatElapsedMetric(theme, durationMs));
    return parts.join(theme.fg("dim", " · "));
}
function toolRowLines(row: SubagentRow, expanded: boolean, theme: BoxTheme): string[] {
    const recent = Array.isArray(row.progress?.recentTools) ? row.progress.recentTools : [];
    const current = asString(row.progress?.currentTool);
    const running = rowStatus(row) === "running";
    const limit = expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_TOOL_ROWS;
    const shown = running && current ? recent.slice(-(limit - 1)) : recent.slice(-limit);
    const hidden = recent.length - shown.length;
    const lines: string[] = [];
    if (hidden > 0) {
        lines.push(
            `${theme.fg("muted", "  ")}${theme.fg("dim", `… ${hidden} earlier tool calls`)}`,
        );
    }
    for (const entry of shown) {
        const name = asString(entry?.tool) ?? "?";
        const args = asString(entry?.args);
        const isError = Boolean(entry?.isError);
        const durMs = asNumber(entry?.durationMs);
        const durStr =
            durMs !== undefined ? theme.fg("dim", ` (${formatElapsedMetric(theme, durMs)})`) : "";
        const statusGlyph = isError ? theme.fg("error", "✗ ") : "";
        lines.push(
            `${theme.fg("muted", "  ")}${statusGlyph}${theme.fg("accent", name)}${args ? ` ${theme.fg("dim", oneLine(args, 80))}` : ""}${durStr}`,
        );
    }
    if (running && current) {
        const args = asString(row.progress?.currentToolArgs);
        lines.push(
            `${theme.fg("muted", "  ")}${theme.fg("warning", "▸ ")}${theme.fg("accent", current)}${args ? ` ${theme.fg("dim", oneLine(args, 80))}` : ""}`,
        );
    }
    return lines;
}
function agentBlockLines(row: SubagentRow, expanded: boolean, theme: BoxTheme): string[] {
    const agent = asString(row.agent) ?? "?";
    const label = asString(row.title) ?? asString(row.task);
    const head = `${rowGlyph(row, theme)} ${theme.fg("toolTitle", agent)}${label ? theme.fg("dim", ` · ${oneLine(label, 60)}`) : ""}`;
    const metrics = rowMetrics(row, theme);
    const lines = [metrics ? `${head} ${theme.fg("dim", "·")} ${metrics}` : head];
    lines.push(...toolRowLines(row, expanded, theme));
    const lastMessage = asString(row.progress?.lastMessage);
    if (lastMessage) {
        lines.push(`${theme.fg("muted", "  ")}${theme.fg("dim", oneLine(lastMessage, 120))}`);
    }
    const error = asString(row.progress?.error);
    if (error) {
        lines.push(`${theme.fg("muted", "  ")}${theme.fg("error", oneLine(error, 120))}`);
    }
    return lines;
}
function renderSubagentCall(
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    const { summary, items } = readCall(args);
    return renderBoxedToolCall(
        theme,
        formatToolName(SUBAGENT_TOOL_NAME),
        requestDetailLines(items, context.expanded, theme),
        {
            headerDetail: summary,
            isError: context.isError,
            isPartial: context.isPartial,
            isPending: context.isPartial,
            running: context.executionStarted,
            resultSeen: isResultSeen(context.state),
        },
    );
}
function footerLines(
    rows: SubagentRow[],
    isPartial: boolean,
    theme: BoxTheme,
    context: BoxedToolContext,
): string[] {
    if (isPartial) {
        return [formatBoxedRunningStatus(theme, stateElapsedMs(context))];
    }
    const elapsedMs = stateElapsedMs(context);
    const ok = rows.filter((row) => rowStatus(row) === "completed").length;
    const tokens = rows.reduce((sum, row) => sum + (asNumber(row.progress?.tokens) ?? 0), 0);
    const parts = [
        elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs),
        theme.fg("dim", `${ok}/${rows.length} agents`),
    ];
    if (tokens) parts.push(theme.fg("dim", `${formatCompactCount(tokens)} tok`));
    return [parts.join(theme.fg("dim", " · "))];
}
/** First-partial-pass result: the running call card stands alone. */
const EMPTY_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
function renderSubagentResult(
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
    const rows = readSubagentRows(result);
    const output = getTextOutput(result);
    if (!rows) {
        const details =
            result.details && typeof result.details === "object"
                ? (result.details as SubagentDetails)
                : undefined;
        if (details?.mode === "single") {
            const pane = asString(details.pane) ?? "single";
            const line = details.reused === true ? `${pane} · reused` : pane;
            return renderBoxedToolResult(theme, () => [theme.fg("dim", line)], {
                dividerLabel: "Run",
                isError: context.isError,
                isPartial: options.isPartial,
            });
        }
        // No structured payload: fall back to the plain output so the card never
        // renders empty.
        const text = output.trim() || "No output received yet";
        return renderBoxedToolResult(theme, (width) => new Text(text, 0, 0).render(width), {
            dividerLabel: "Output",
            isError: context.isError,
            isPartial: options.isPartial,
        });
    }
    if (options.isPartial && firstResultPass) return EMPTY_RESULT;
    const budget = options.expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_RUN_LINES;
    const hasOutput = output.trim().length > 0;
    const bodyLines = (contentWidth: number): string[] => {
        const lines: string[] = [];
        for (const [index, row] of rows.entries()) {
            if (index > 0) lines.push("");
            lines.push(...agentBlockLines(row, options.expanded, theme));
        }
        // Settled runs append the concatenated output underneath the rows.
        if (!options.isPartial && hasOutput) {
            lines.push("");
            lines.push(theme.fg("muted", "─".repeat(Math.max(8, contentWidth))));
            const maxOutput = options.expanded ? budget : COLLAPSED_OUTPUT_LINES;
            const { lines: outputLines, omitted } = selectRenderLines(output, maxOutput);
            for (const line of outputLines) {
                lines.push(
                    formatToolOutputLine(theme, line, context.isError ? "error" : "toolOutput"),
                );
            }
            if (omitted > 0 && !options.expanded) {
                lines.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
            }
        }
        if (lines.length > budget) {
            const omitted = lines.length - budget;
            return [
                ...lines.slice(0, budget),
                theme.fg("muted", `… ${omitted} more lines omitted by render budget`),
            ];
        }
        return lines;
    };
    return renderBoxedToolResult(theme, bodyLines, {
        dividerLabel: options.isPartial ? "Agents" : "Run",
        footerLines: footerLines(rows, options.isPartial, theme, context),
        showDivider: options.isPartial ? hasOutput : true,
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
