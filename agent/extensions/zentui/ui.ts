import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
    UserMessageComponent,
    CustomEditor,
    type Theme,
    type ThemeColor,
    type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
    componentColor,
    EDITOR_BORDER_FALLBACK,
    renderEditorBorder,
    renderStyleForSourceOrFallback,
    EDITOR_ACCENT_FALLBACK,
    renderStyleForSourceOrFallbackStrict,
    editorShellColor,
    safeThemeFg,
    type ZentuiConfig,
    type EditorStyle,
    type HostTemplateValues,
} from "./config.ts";
import { stripAnsi } from "../shared/strip-ansi.ts";
import {
    truncateToWidth,
    visibleWidth,
    Markdown,
    wrapTextWithAnsi,
    CURSOR_MARKER,
    sliceByColumn,
    type EditorComponent,
    type MarkdownTheme,
    type AutocompleteProvider,
    type Component,
    type EditorTheme,
    type TUI,
} from "@earendil-works/pi-tui";
import {
    resolveUserMessageRailGlyph,
    renderEditorMetadataFormatSplit,
    sanitizeEditorMetadataText,
    collectFooterFormatReferences,
    parseFooterFormat,
    bashModeLabel,
    resolveEditorFrameRailGlyph,
    type EditorMetadataZones,
} from "./format.ts";

export const ZENTUI_PROTOTYPE_PATCH_REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");

type PrototypePatchAdapter =
    | "user-message-render"
    | "user-message-invalidate"
    | "selector-border-render";

type PrototypeMethod = (this: unknown, ...args: unknown[]) => unknown;

type PatchInvocation = {
    predecessor: PrototypeMethod;
    receiver: unknown;
    args: unknown[];
};

type PatchBehavior = (invocation: PatchInvocation) => unknown;

type Registration = {
    token: symbol;
    behavior?: PatchBehavior;
    onDisplaced?: () => void;
};

type PatchMethod = "render" | "invalidate" | "updateContent";

type PatchRecord = {
    method: PatchMethod;
    predecessor: PrototypeMethod;
    predecessorDescriptor?: PropertyDescriptor;
    wrapper: PrototypeMethod;
    registration?: Registration;
};

type PatchRegistry = Map<PrototypePatchAdapter, PatchRecord>;

type PatchTarget = Record<PropertyKey, unknown>;

function existingRegistry(target: PatchTarget): PatchRegistry | undefined {
    const existing = target[ZENTUI_PROTOTYPE_PATCH_REGISTRY];
    return existing instanceof Map ? (existing as PatchRegistry) : undefined;
}

function registryFor(target: PatchTarget): PatchRegistry {
    const existing = existingRegistry(target);
    if (existing) return existing;
    const registry: PatchRegistry = new Map();
    Object.defineProperty(target, ZENTUI_PROTOTYPE_PATCH_REGISTRY, {
        value: registry,
        configurable: true,
    });
    return registry;
}

function deactivateRecord(record: PatchRecord, displaced = false): void {
    if (!record.registration) return;
    const registration = record.registration;
    const onDisplaced = registration.onDisplaced;
    registration.behavior = undefined;
    registration.onDisplaced = undefined;
    record.registration = undefined;
    if (displaced) {
        try {
            onDisplaced?.();
        } catch {
            // Registration handoff must not prevent the newer owner from installing.
        }
    }
}

function restorePredecessor(target: PatchTarget, record: PatchRecord): void {
    if (target[record.method] !== record.wrapper) return;
    if (record.predecessorDescriptor) {
        Object.defineProperty(target, record.method, record.predecessorDescriptor);
    } else {
        delete target[record.method];
    }
}

function installWrapper(target: PatchTarget, record: PatchRecord): void {
    const descriptor = record.predecessorDescriptor;
    if (descriptor && "value" in descriptor) {
        Object.defineProperty(target, record.method, { ...descriptor, value: record.wrapper });
        return;
    }
    Object.defineProperty(target, record.method, {
        value: record.wrapper,
        writable: true,
        enumerable: descriptor?.enumerable ?? true,
        configurable: true,
    });
}

export type PrototypePatchRegistration = (() => void) & Readonly<{ token: symbol }>;

function createCleanup(
    target: PatchTarget,
    adapter: PrototypePatchAdapter,
    registry: PatchRegistry,
    record: PatchRecord,
    token: symbol,
): PrototypePatchRegistration {
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (record.registration?.token !== token) return;
        deactivateRecord(record);

        const current = registry.get(adapter);
        if (current !== record) return;
        restorePredecessor(target, record);
        registry.delete(adapter);
        if (registry.size === 0) delete target[ZENTUI_PROTOTYPE_PATCH_REGISTRY];
    };
    return Object.assign(cleanup, { token });
}

export function installPrototypePatch(
    targetValue: object,
    method: PatchMethod,
    adapter: PrototypePatchAdapter,
    behavior: PatchBehavior,
    onDisplaced?: () => void,
): PrototypePatchRegistration {
    const target = targetValue as PatchTarget;
    const registry = registryFor(target);
    let record = registry.get(adapter);

    if (!(record && record.method === method && target[method] === record.wrapper)) {
        const displacedRecord = record;
        const predecessorDescriptor = Object.getOwnPropertyDescriptor(target, method);
        const predecessor = target[method];
        if (typeof predecessor !== "function") {
            if (registry.size === 0) delete target[ZENTUI_PROTOTYPE_PATCH_REGISTRY];
            throw new TypeError(`Cannot patch ${method}: predecessor is not a function`);
        }
        const nextRecord: PatchRecord = {
            method,
            predecessor: predecessor as PrototypeMethod,
            predecessorDescriptor,
            wrapper: () => undefined,
        };
        const wrapper: PrototypeMethod = function zentuiPrototypeWrapper(
            this: unknown,
            ...args: unknown[]
        ): unknown {
            const activeBehavior = nextRecord.registration?.behavior;
            return activeBehavior
                ? activeBehavior({ predecessor: nextRecord.predecessor, receiver: this, args })
                : Reflect.apply(nextRecord.predecessor, this, args);
        };
        nextRecord.wrapper = wrapper;
        try {
            installWrapper(target, nextRecord);
        } catch (error) {
            if (registry.size === 0) delete target[ZENTUI_PROTOTYPE_PATCH_REGISTRY];
            throw error;
        }
        record = nextRecord;
        registry.set(adapter, record);
        if (displacedRecord && displacedRecord !== record) deactivateRecord(displacedRecord, true);
    }

    const previousRegistration = record.registration;
    const token = Symbol(adapter);
    record.registration = { token, behavior, onDisplaced };
    if (previousRegistration) {
        previousRegistration.behavior = undefined;
        try {
            previousRegistration.onDisplaced?.();
        } catch {
            // Registration handoff must not prevent the newer owner from installing.
        }
        previousRegistration.onDisplaced = undefined;
    }
    return createCleanup(target, adapter, registry, record, token);
}

export function isPrototypePatchCurrent(
    targetValue: object,
    method: PatchMethod,
    adapter: PrototypePatchAdapter,
    token?: symbol,
): boolean {
    const target = targetValue as PatchTarget;
    const record = existingRegistry(target)?.get(adapter);
    return Boolean(
        record &&
        record.method === method &&
        target[method] === record.wrapper &&
        (token === undefined || record.registration?.token === token),
    );
}

export function removePrototypePatch(
    targetValue: object,
    method: PatchMethod,
    adapter: PrototypePatchAdapter,
): void {
    const target = targetValue as PatchTarget;
    const registry = existingRegistry(target);
    const record = registry?.get(adapter);
    if (!registry || !record || record.method !== method) return;

    deactivateRecord(record);
    restorePredecessor(target, record);
    registry.delete(adapter);
    if (registry.size === 0) delete target[ZENTUI_PROTOTYPE_PATCH_REGISTRY];
}

type PatchableSelectorPrototype = {
    render: (width: number) => string[];
};

type Cleanup = () => void;

function selectorPrototypes(): PatchableSelectorPrototype[] {
    const exports = PiCodingAgent as unknown as Record<string, unknown>;
    return ["ModelSelectorComponent", "SettingsSelectorComponent"].flatMap((name) => {
        const value = exports[name] as { prototype?: PatchableSelectorPrototype } | undefined;
        return value?.prototype ? [value.prototype] : [];
    });
}

function isHorizontalBorderLine(line: string): boolean {
    return /^─+$/.test(stripAnsi(line));
}

function renderBorderLine(
    text: string,
    theme: Theme | undefined,
    config: ZentuiConfig | undefined,
): string {
    if (theme && config) {
        return renderStyleForSourceOrFallback(
            theme,
            config.components.selectorBorders.colorSource,
            componentColor(config, "selectorBorders", "border"),
            EDITOR_BORDER_FALLBACK,
            text,
        );
    }
    return renderEditorBorder(text);
}

export function patchSelectorBorderStyle(
    prototype: PatchableSelectorPrototype,
    getTheme?: () => Theme | undefined,
    getConfig?: () => ZentuiConfig,
): Cleanup {
    return installPrototypePatch(
        prototype,
        "render",
        "selector-border-render",
        ({ predecessor, receiver, args }) => {
            const lines = Reflect.apply(predecessor, receiver, args) as string[];
            const width = args[0];
            if (
                !Array.isArray(lines) ||
                !lines.every((line) => typeof line === "string") ||
                lines.length === 0 ||
                typeof width !== "number" ||
                width <= 0 ||
                getConfig?.().components.selectorBorders.enabled === false
            )
                return lines;
            const theme = getTheme?.();
            const config = getConfig?.();
            const paint = (text: string) => renderBorderLine(text, theme, config);
            return lines.map((line, index) => {
                if (index !== 0 && index !== lines.length - 1) return line;
                if (!isHorizontalBorderLine(line)) return line;
                return paint("─".repeat(Math.max(1, width)));
            });
        },
    );
}

export function removeSelectorBorderStyle(): void {
    for (const prototype of selectorPrototypes())
        removePrototypePatch(prototype, "render", "selector-border-render");
}

export function installSelectorBorderStyle(
    getTheme?: () => Theme | undefined,
    getConfig?: () => ZentuiConfig,
): Cleanup {
    const cleanups: Cleanup[] = [];
    try {
        for (const prototype of selectorPrototypes())
            cleanups.push(patchSelectorBorderStyle(prototype, getTheme, getConfig));
    } catch (error) {
        for (const cleanup of cleanups) cleanup();
        throw error;
    }
    return () => {
        for (const cleanup of cleanups) cleanup();
    };
}

export type CompletionRowsOptions = {
    lines: string[];
    width: number;
    theme: Theme;
    selectedPrefix: string;
    ownedBackground: boolean;
};

export type CompletionPaletteOptions = {
    lines: string[];
    width: number;
    theme: Theme;
    renderSeparator: (text: string) => string;
    ownedBackground: boolean;
};

const SGR_SEQUENCE = /(?:\x1b\[|\u009b)([0-9:;]*)m/g;

function normalizeC1Csi(content: string): string {
    return content.replace(/\u009b([0-?]*[ -/]*[@-~])/g, "\x1b[$1");
}

function sgrBackgroundAction(parameters: string): "reset" | "set" | undefined {
    let action: "reset" | "set" | undefined;
    const values = (parameters || "0").split(";");
    for (let index = 0; index < values.length; index++) {
        const parameter = values[index] ?? "";
        const primary =
            parameter === "" ? 0 : Number.parseInt(parameter.split(":", 1)[0] ?? "", 10);
        if (primary === 38 || primary === 48 || primary === 58) {
            if (primary === 48) action = "set";
            if (!parameter.includes(":")) {
                const mode = Number.parseInt(values[index + 1] ?? "", 10);
                if (mode === 5) index += 2;
                else if (mode === 2) index += 4;
            }
            continue;
        }
        if (primary === 0 || primary === 49) action = "reset";
        else if ((primary >= 40 && primary <= 47) || (primary >= 100 && primary <= 107))
            action = "set";
    }
    return action;
}

function restoresOwnedBackground(sequence: string): boolean {
    const parameters = sequence.slice(sequence.startsWith("\u009b") ? 1 : 2, -1);
    return sgrBackgroundAction(parameters) === "reset";
}

function truncateTerminalLine(content: string, width: number): string {
    const safeWidth = Math.max(0, width);
    const normalized = normalizeC1Csi(content);
    return visibleWidth(normalized) <= safeWidth
        ? content
        : truncateToWidth(normalized, safeWidth, "");
}

export function fillTerminalLine(content: string, width: number): string {
    const truncated = truncateTerminalLine(content, width);
    const renderedWidth = visibleWidth(normalizeC1Csi(truncated));
    return `${truncated}${" ".repeat(Math.max(0, width - renderedWidth))}`;
}

export function applyOwnedSurfaceBackground(theme: Theme, text: string): string {
    try {
        const background = theme.getBgAnsi("userMessageBg");
        const restored = text.replace(SGR_SEQUENCE, (sequence) =>
            restoresOwnedBackground(sequence) ? `${sequence}${background}` : sequence,
        );
        return `${background}${restored}\x1b[49m`;
    } catch {
        try {
            let cursor = 0;
            let rendered = "";
            for (const match of text.matchAll(SGR_SEQUENCE)) {
                if (!restoresOwnedBackground(match[0])) continue;
                const before = text.slice(cursor, match.index);
                if (before) rendered += theme.bg("userMessageBg", before);
                rendered += match[0];
                cursor = (match.index ?? 0) + match[0].length;
            }
            const trailing = text.slice(cursor);
            if (trailing) rendered += theme.bg("userMessageBg", trailing);
            return rendered || theme.bg("userMessageBg", text);
        } catch {
            return text;
        }
    }
}

export function replaceNativeSelectedPrefix(line: string, replacement: string): string {
    const selectedPrefix = /^((?:(?:\x1b\[|\u009b)[0-9:;]*m)*)→ /;
    const match = line.match(selectedPrefix);
    if (!match) return line;
    return `${replacement}${match[1]}${line.slice(match[0].length)}`;
}

export function isNativeCompletionCountRow(line: string): boolean {
    const withoutSgr = line.replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*m/g, "");
    return /^\s*\(\d+\/\d+\)\s*$/.test(withoutSgr);
}

export function omitTrailingNativeCompletionCountRow(lines: string[]): string[] {
    return lines.length > 0 && isNativeCompletionCountRow(lines.at(-1) ?? "")
        ? lines.slice(0, -1)
        : lines;
}

export function renderCompletionRows({
    lines,
    width,
    theme,
    selectedPrefix,
    ownedBackground,
}: CompletionRowsOptions): string[] {
    return lines.map((line) => {
        const content = fillTerminalLine(replaceNativeSelectedPrefix(line, selectedPrefix), width);
        const surfaced = ownedBackground ? applyOwnedSurfaceBackground(theme, content) : content;
        return truncateTerminalLine(surfaced, width);
    });
}

function helpLabel(width: number): string {
    const labels = [
        " ↑↓ Navigate   Enter Use   Esc Close",
        " ↑↓ Nav   Enter Use   Esc",
        " ↑↓   Enter   Esc",
    ];
    return labels.find((label) => visibleWidth(label) <= width) ?? labels.at(-1) ?? "";
}

/** Full-width, provenance-preserving completion shell for Opencode editor styles. */
export function renderCompletionPalette({
    lines,
    width,
    theme,
    renderSeparator,
    ownedBackground,
}: CompletionPaletteOptions): string[] {
    const resultLines = omitTrailingNativeCompletionCountRow(lines);
    if (resultLines.length === 0) return [];
    const safeWidth = Math.max(0, width);
    const rows = renderCompletionRows({
        lines: resultLines,
        width: safeWidth,
        theme,
        selectedPrefix: "  ",
        ownedBackground,
    });
    const separator = renderSeparator("─".repeat(safeWidth));
    if (safeWidth < 3) return [...rows, truncateToWidth(separator, safeWidth, "")];
    const helpText = fillTerminalLine(helpLabel(safeWidth), safeWidth);
    const help = ownedBackground ? applyOwnedSurfaceBackground(theme, helpText) : helpText;
    return [
        ...rows,
        truncateToWidth(separator, safeWidth, ""),
        truncateToWidth(help, safeWidth, ""),
    ];
}

export type EditorMouseEvent = Parameters<NonNullable<EditorComponent["handleMouse"]>>[0];

export type EditorMouseResult = {
    handled?: boolean;
    capture?: boolean;
    focus?: boolean;
    render?: boolean;
};

export type EditorMouseHandler = (event: EditorMouseEvent) => EditorMouseResult | undefined;

type Cell = { x: number; y: number };

export type EditorMouseLayout = { body: Cell[]; completion: Cell[] };

type RowTranslation = { x: number; y: number };

const layouts = new WeakMap<string[], EditorMouseLayout>();

const translations = new WeakMap<string[], Map<number, RowTranslation>>();

/** Record only rows actually emitted, never infer positions from terminal text. */
export function rememberEditorMouseLayout(
    lines: string[],
    baseLines: string[],
    bodyCount: number,
    completionCount: number,
    layout: EditorMouseLayout,
): void {
    const base = layouts.get(baseLines) ?? {
        body: Array.from({ length: bodyCount }, (_, index) => ({ x: 0, y: index + 1 })),
        completion: Array.from({ length: completionCount }, (_, index) => ({
            x: 0,
            y: bodyCount + 2 + index,
        })),
    };
    const rows = new Map<number, RowTranslation>();
    for (const section of ["body", "completion"] as const) {
        layout[section].forEach((cell, index) => {
            const source = base[section][index];
            if (source) rows.set(cell.y, { x: source.x - cell.x, y: source.y - cell.y });
        });
    }
    layouts.set(lines, layout);
    translations.set(lines, rows);
}

export function editorMouseCells(count: number, x: number, y: number): Cell[] {
    return Array.from({ length: count }, (_, index) => ({ x, y: y + index }));
}

export class EditorMouseForwarder {
    private width?: number;
    private height?: number;
    private rows?: Map<number, RowTranslation>;
    private pendingBounds?: { width: number; height: number };
    private captured?: RowTranslation;

    baseRendered(width: number, lines: string[]): string[] {
        this.pendingBounds = { width, height: lines.length };
        return lines;
    }

    rendered(lines: string[]): string[] {
        this.width = this.pendingBounds?.width;
        this.height = this.pendingBounds?.height;
        this.rows = translations.get(lines);
        return lines;
    }

    forward(
        receiver: object,
        handler: EditorMouseHandler,
        event: EditorMouseEvent,
    ): EditorMouseResult | undefined {
        const row = this.rows ? (this.rows.get(event.y) ?? this.captured) : undefined;
        if (this.rows && !row) return undefined;
        const translated =
            this.width === undefined
                ? event
                : {
                      ...event,
                      x: event.x + (row?.x ?? 0),
                      y: event.y + (row?.y ?? 0),
                      width: this.width,
                      height: this.height ?? event.height,
                  };
        const result = handler.call(receiver, translated);
        if (result?.capture) this.captured = row ?? { x: 0, y: 0 };
        if (event.type === "release") this.captured = undefined;
        return result;
    }
}
export type EditorComponentFactory = (...args: never[]) => unknown;

export type EditorTransferUi<Factory = EditorComponentFactory> = {
    getEditorText?: () => unknown;
    setEditorText?: (text: string) => void;
    setEditorComponent?: (factory: Factory | undefined) => void;
    getEditorComponent?: () => Factory | undefined;
};

export type EditorTransferFailureReason =
    | "unsupported-transfer-api"
    | "editor-factory-snapshot-failed"
    | "editor-text-snapshot-failed"
    | "editor-text-preparation-failed"
    | "editor-replacement-failed-with-rollback"
    | "editor-replacement-rollback-failed";

export type EditorTransferResult =
    | { ok: true }
    | { ok: false; reason: EditorTransferFailureReason };

/**
 * Pi custom UI saves raw editor text and restores it with setText(), which clears
 * collapsed paste storage. Expand nonempty drafts before that snapshot is taken.
 * Hosts without public text APIs retain their existing custom-UI behavior.
 */
export function prepareEditorTextForCustomUi(
    ui: Pick<EditorTransferUi, "getEditorText" | "setEditorText">,
): void {
    if (typeof ui.getEditorText !== "function" || typeof ui.setEditorText !== "function") return;
    const text = ui.getEditorText();
    if (typeof text !== "string") throw new Error("expanded editor text could not be read safely");
    if (text) ui.setEditorText(text);
}

/**
 * Prepare the active editor's public expanded text before Pi replaces its factory.
 * This intentionally transfers prompt contents only; editor-private state is never inspected.
 */
export function replaceEditorComponentWithExpandedText<Factory>(
    ui: EditorTransferUi<Factory>,
    factory: Factory | undefined,
): EditorTransferResult {
    if (
        typeof ui.getEditorText !== "function" ||
        typeof ui.setEditorText !== "function" ||
        typeof ui.setEditorComponent !== "function" ||
        typeof ui.getEditorComponent !== "function"
    ) {
        return { ok: false, reason: "unsupported-transfer-api" };
    }

    let previousFactory: Factory | undefined;
    try {
        previousFactory = ui.getEditorComponent();
    } catch {
        return { ok: false, reason: "editor-factory-snapshot-failed" };
    }

    let expandedText: unknown;
    try {
        expandedText = ui.getEditorText();
    } catch {
        return { ok: false, reason: "editor-text-snapshot-failed" };
    }
    if (typeof expandedText !== "string") {
        return { ok: false, reason: "editor-text-snapshot-failed" };
    }

    try {
        ui.setEditorText(expandedText);
    } catch {
        return { ok: false, reason: "editor-text-preparation-failed" };
    }

    try {
        ui.setEditorComponent(factory);
    } catch {
        try {
            ui.setEditorComponent(previousFactory);
            return { ok: false, reason: "editor-replacement-failed-with-rollback" };
        } catch {
            return { ok: false, reason: "editor-replacement-rollback-failed" };
        }
    }
    return { ok: true };
}
/**
 * Records that a Zentui editor instance is still visible beneath a foreign predecessor-preserving
 * wrapper (`setEditorComponent((tui, theme, kb) => predecessor(tui, theme, kb))`).
 *
 * This is deliberately NOT installation ownership: Zentui does not own the outer factory, must not
 * replace or restore it, and keeps this record across ownership clearing. It only answers
 * "may a surface Zentui rendered still be on screen?" for read-only consumers such as usage demand
 * and redraw requests. The record is valid only while the outer factory observed at construction is
 * still the current editor factory, so any replacement of the chain invalidates it.
 *
 * Construction alone cannot authorize hiding the Working row: its controller additionally requires
 * a focused editor that has rendered safe border geometry. A wrapper that renders then discards those
 * rows remains undetectable; supporting such wrappers requires an explicit host visibility contract.
 */
export class LayeredEditorConsumer<Factory, Editor = unknown> {
    private record?: {
        outerFactory: Factory;
        generation: number;
        editor: Editor;
        requestRender: () => void;
    };

    constructor(private readonly isCurrentGeneration: (generation: number) => boolean) {}

    attach(
        outerFactory: Factory,
        generation: number,
        editor: Editor,
        requestRender: () => void,
    ): void {
        this.record = { outerFactory, generation, editor, requestRender };
    }

    detach(): void {
        this.record = undefined;
    }

    editorVisibleThrough(currentFactory: Factory | undefined): Editor | undefined {
        const record = this.record;
        if (!record) return undefined;
        if (
            !this.isCurrentGeneration(record.generation) ||
            record.outerFactory !== currentFactory
        ) {
            this.record = undefined;
            return undefined;
        }
        return record.editor;
    }

    isVisibleThrough(currentFactory: Factory | undefined): boolean {
        return this.editorVisibleThrough(currentFactory) !== undefined;
    }

    requestRender(currentFactory: Factory | undefined): void {
        if (this.isVisibleThrough(currentFactory)) this.record?.requestRender();
    }
}
const ESC = "\x1b";

const BEL = "\x07";

const C1_DCS = "\x90";

const C1_SOS = "\x98";

const C1_CSI = "\x9b";

const C1_ST = "\x9c";

const C1_OSC = "\x9d";

const C1_PM = "\x9e";

const C1_APC = "\x9f";

const CAN = 0x18;

const SUB = 0x1a;

type ControlBoundary =
    | { kind: "terminator"; index: number; length: number; safeOsc8Terminator: boolean }
    | { kind: "start"; index: number };

type FilterOptions = {
    preserveValidOsc8: boolean;
    preserveSourceWhitespace: boolean;
    preserveSgr: boolean;
};

type FilterResult = {
    text: string;
    balancedOsc8: boolean;
};

function anyOscStartLength(text: string, index: number): number {
    if (text[index] === C1_OSC) return 1;
    return text[index] === ESC && text[index + 1] === "]" ? 2 : 0;
}

function findOscBoundary(text: string, payloadStart: number): ControlBoundary | undefined {
    for (let index = payloadStart; index < text.length; index += 1) {
        if (anyOscStartLength(text, index) > 0) return { kind: "start", index };
        if (text[index] === BEL) {
            return { kind: "terminator", index, length: 1, safeOsc8Terminator: true };
        }
        if (text[index] === C1_ST) {
            return { kind: "terminator", index, length: 1, safeOsc8Terminator: false };
        }
        if (text[index] === ESC && text[index + 1] === "\\") {
            return { kind: "terminator", index, length: 2, safeOsc8Terminator: true };
        }
    }
    return undefined;
}

const terminalControlPattern = /[\u0000-\u001f\u007f-\u009f]/;

const safeParameterKeyPattern = /^[A-Za-z0-9_.-]+$/;

export function isValidUserMessageOsc8Payload(payload: string): boolean {
    if (!payload.startsWith("8;")) return false;
    const uriSeparator = payload.indexOf(";", 2);
    if (uriSeparator < 0) return false;

    const params = payload.slice(2, uriSeparator);
    const uri = payload.slice(uriSeparator + 1);
    if (params === "" && uri === "") return true;
    if (uri === "" || /\s/.test(uri) || terminalControlPattern.test(uri)) return false;
    if (params === "") return true;

    return params.split(":").every((entry) => {
        const equals = entry.indexOf("=");
        if (equals <= 0) return false;
        const key = entry.slice(0, equals);
        const value = entry.slice(equals + 1);
        return (
            safeParameterKeyPattern.test(key) &&
            !terminalControlPattern.test(key) &&
            !terminalControlPattern.test(value)
        );
    });
}

function incompleteOsc133PrefixLength(payload: string): number {
    if (payload.length > 0 && "133".startsWith(payload)) return payload.length;
    if (!payload.startsWith("133;")) return 0;

    let length = 4;
    if (/^[A-D]$/.test(payload[length] ?? "")) length += 1;
    if (payload[length] === ";") length += 1;
    return length;
}

function consumeCsi(value: string, start: number): number {
    for (let index = start; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === CAN || code === SUB) return index + 1;
        if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return value.length;
}

function consumeControlString(value: string, start: number, allowBel: boolean): number {
    for (let index = start; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === CAN || code === SUB) return index + 1;
        if (allowBel && code === BEL.charCodeAt(0)) return index + 1;
        if (code === C1_ST.charCodeAt(0)) return index + 1;
        if (code === ESC.charCodeAt(0) && value[index + 1] === "\\") return index + 2;
    }
    return value.length;
}

function consumeEscape(value: string, start: number): number {
    if (start + 1 >= value.length) return value.length;
    const next = value[start + 1];
    if (next === "[") return consumeCsi(value, start + 2);
    if (next === "P" || next === "X" || next === "^" || next === "_") {
        return consumeControlString(value, start + 2, false);
    }

    let index = start + 1;
    while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x20 && code <= 0x2f) {
            index += 1;
            continue;
        }
        return code >= 0x30 && code <= 0x7e ? index + 1 : index;
    }
    return value.length;
}

function isSafeSgr(sequence: string): boolean {
    return /^\x1b\[[0-9:;]*m$/.test(sequence);
}

function isOsc8Close(payload: string): boolean {
    return payload === "8;;";
}

function updateOsc8Balance(payload: string, state: { open: boolean; invalid: boolean }): void {
    if (isOsc8Close(payload)) {
        if (!state.open) state.invalid = true;
        state.open = false;
        return;
    }
    if (state.open) state.invalid = true;
    state.open = true;
}

function filterUserMessageTerminalText(text: string, options: FilterOptions): FilterResult {
    let output = "";
    let index = 0;
    const osc8 = { open: false, invalid: false };
    while (index < text.length) {
        const oscStartLength = anyOscStartLength(text, index);
        if (oscStartLength > 0) {
            const payloadStart = index + oscStartLength;
            const boundary = findOscBoundary(text, payloadStart);
            if (boundary?.kind === "terminator") {
                const end = boundary.index + boundary.length;
                const payload = text.slice(payloadStart, boundary.index);
                if (
                    options.preserveValidOsc8 &&
                    oscStartLength === 2 &&
                    boundary.safeOsc8Terminator &&
                    isValidUserMessageOsc8Payload(payload)
                ) {
                    updateOsc8Balance(payload, osc8);
                    output += text.slice(index, end);
                }
                index = end;
                continue;
            }

            // Removing an unterminated introducer prevents it from consuming
            // Zentui's prompt markers. Preserve visible trailing payload, except
            // for a recognized partial OSC 133 command prefix.
            const payloadEnd = boundary?.index ?? text.length;
            const payload = text.slice(payloadStart, payloadEnd);
            index = payloadStart + incompleteOsc133PrefixLength(payload);
            continue;
        }

        const code = text.charCodeAt(index);
        if (code === ESC.charCodeAt(0)) {
            if (text[index + 1] === "[") {
                const end = consumeCsi(text, index + 2);
                const sequence = text.slice(index, end);
                if (options.preserveSgr && isSafeSgr(sequence)) output += sequence;
                index = end;
                continue;
            }
            index = consumeEscape(text, index);
            continue;
        }
        if (text[index] === C1_CSI) {
            index = consumeCsi(text, index + 1);
            continue;
        }
        if (
            text[index] === C1_DCS ||
            text[index] === C1_SOS ||
            text[index] === C1_PM ||
            text[index] === C1_APC
        ) {
            index = consumeControlString(text, index + 1, false);
            continue;
        }
        if (code === 0x09 || code === 0x0a) {
            if (options.preserveSourceWhitespace) output += text[index];
            index += 1;
            continue;
        }
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
            index += 1;
            continue;
        }
        output += text[index];
        index += 1;
    }
    return { text: output, balancedOsc8: !osc8.open && !osc8.invalid };
}

function filterBalancedUserMessageTerminalText(text: string, options: FilterOptions): string {
    const filtered = filterUserMessageTerminalText(text, options);
    if (!options.preserveValidOsc8 || filtered.balancedOsc8) return filtered.text;
    return filterUserMessageTerminalText(text, { ...options, preserveValidOsc8: false }).text;
}

const sourceFilterOptions = {
    preserveValidOsc8: false,
    preserveSourceWhitespace: true,
} as const;

/** Strip every terminal control from untrusted source text before Markdown rendering. */
export function sanitizeUserMessageSourceText(text: string): string {
    return filterBalancedUserMessageTerminalText(text, {
        ...sourceFilterOptions,
        preserveSgr: false,
    });
}

/** Strip strict 7-bit CSI SGR, rejecting source that contains any other terminal control. */
export function sanitizeSgrOnlySourceText(text: string): string | undefined {
    const sgrPreserved = filterBalancedUserMessageTerminalText(text, {
        ...sourceFilterOptions,
        preserveSgr: true,
    });
    if (sgrPreserved !== text) return undefined;
    return sanitizeUserMessageSourceText(text);
}

/**
 * Sanitize a predecessor-rendered row. Pi formatting needs only SGR and
 * structurally valid 7-bit OSC 8; every other terminal control is removed.
 */
export function sanitizeRenderedUserMessageText(text: string): string {
    return filterBalancedUserMessageTerminalText(text, {
        preserveValidOsc8: true,
        preserveSourceWhitespace: true,
        preserveSgr: true,
    });
}

/** Sanitize one predecessor output stream while retaining its row boundaries. */
export function sanitizeRenderedUserMessageLines(lines: string[]): string[] {
    return sanitizeRenderedUserMessageText(lines.join("\n")).split("\n");
}

export type UserMessageStyleRenderInput = {
    text: string;
    width: number;
    theme?: Theme;
    config: ZentuiConfig;
    markdown?: {
        theme: MarkdownTheme;
        defaultTextStyle: ConstructorParameters<typeof Markdown>[4];
        options: ConstructorParameters<typeof Markdown>[5];
    };
};

function themeFg(theme: Theme | undefined, color: ThemeColor, text: string): string {
    return theme ? theme.fg(color, text) : text;
}

export function makeMarkdownTheme(theme: Theme | undefined): MarkdownTheme {
    return {
        // OMP Markdown also requires its host symbol palette and additional native hooks.
        ...("describe" in Markdown.prototype ? PiCodingAgent.getMarkdownTheme() : {}),
        heading: (text) => themeFg(theme, "mdHeading", text),
        link: (text) => themeFg(theme, "mdLink", text),
        linkUrl: (text) => themeFg(theme, "mdLinkUrl", text),
        code: (text) => themeFg(theme, "mdCode", text),
        codeBlock: (text) => themeFg(theme, "mdCodeBlock", text),
        codeBlockBorder: (text) => themeFg(theme, "mdCodeBlockBorder", text),
        quote: (text) => themeFg(theme, "mdQuote", text),
        quoteBorder: (text) => themeFg(theme, "mdQuoteBorder", text),
        hr: (text) => themeFg(theme, "mdHr", text),
        listBullet: (text) => themeFg(theme, "mdListBullet", text),
        bold: (text) => (theme ? theme.bold(text) : text),
        italic: (text) => (theme ? theme.italic(text) : text),
        underline: (text) => (theme ? theme.underline(text) : text),
        strikethrough: (text) => (theme ? theme.strikethrough(text) : text),
    };
}

function renderMarkdown(input: UserMessageStyleRenderInput, width: number): string[] {
    const { text, theme, markdown } = input;
    const transform = markdown?.options?.transform;
    const renderer = new Markdown(
        text,
        0,
        0,
        markdown?.theme ?? makeMarkdownTheme(theme),
        markdown?.defaultTextStyle ?? {
            color: (content) => themeFg(theme, "userMessageText", content),
        },
        // OMP's native Markdown uses the sixth argument for numeric code-block
        // indentation, not Pi's parser options. Leave its supported default intact.
        "describe" in Markdown.prototype
            ? undefined
            : {
                  ...markdown?.options,
                  preserveOrderedListMarkers: true,
                  preserveBackslashEscapes: true,
                  ...(transform
                      ? {
                            transform: (source: string, availableWidth: number) =>
                                sanitizeUserMessageSourceText(transform(source, availableWidth)),
                        }
                      : {}),
              },
    );
    const lines = renderer.render(Math.max(1, width));
    return lines.length > 0 ? lines : [""];
}

function trimMarkdownPadding(line: string): string {
    return line.replace(/ +((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/, "$1");
}

function fillLine(content: string, width: number): string {
    const truncated = truncateToWidth(content, Math.max(0, width), "");
    return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function accent(theme: Theme | undefined, config: ZentuiConfig, text: string): string {
    return theme
        ? renderStyleForSourceOrFallbackStrict(
              theme,
              config.components.userMessages.colorSource,
              componentColor(config, "userMessages", "accent"),
              EDITOR_ACCENT_FALLBACK,
              text,
          )
        : text;
}

function border(theme: Theme | undefined, config: ZentuiConfig, text: string): string {
    return theme
        ? renderStyleForSourceOrFallbackStrict(
              theme,
              config.components.userMessages.colorSource,
              componentColor(config, "userMessages", "border"),
              EDITOR_BORDER_FALLBACK,
              text,
          )
        : text;
}

function renderRail(theme: Theme | undefined, config: ZentuiConfig): string {
    return `${accent(theme, config, resolveUserMessageRailGlyph(config))} `;
}

function renderFramed(input: UserMessageStyleRenderInput): string[] {
    const { width, theme, config } = input;
    if (width <= 0) return [""];
    const rail = renderRail(theme, config);
    const contentWidth = Math.max(1, width - visibleWidth(rail));
    const body = renderMarkdown(input, contentWidth);
    const row = (line: string) => {
        const available = Math.max(0, width - visibleWidth(rail));
        return truncateToWidth(`${rail}${fillLine(line, available)}`, width, "");
    };
    const rule = truncateToWidth(border(theme, config, "─".repeat(width)), width, "");
    return [rule, row(""), ...body.map(row), row(""), rule];
}

function renderFramedCopyFriendly(input: UserMessageStyleRenderInput): string[] {
    const { width, theme, config } = input;
    if (width <= 0) return [""];
    const prefix = width > 1 ? " " : "";
    const body = renderMarkdown(input, width - prefix.length).map((line) =>
        fillLine(`${prefix}${line}`, width),
    );
    const rule = truncateToWidth(border(theme, config, "─".repeat(width)), width, "");
    return [rule, "", ...body, "", rule];
}

function renderCompact(input: UserMessageStyleRenderInput): string[] {
    const { width, theme, config } = input;
    if (width <= 0) return [""];
    const rail = renderRail(theme, config);
    const railWidth = visibleWidth(rail);
    if (width <= railWidth) {
        return renderMarkdown(input, width).map((line) =>
            truncateToWidth(trimMarkdownPadding(line), width, ""),
        );
    }
    const contentWidth = width - railWidth;
    return renderMarkdown(input, contentWidth).map((line) =>
        truncateToWidth(`${rail}${trimMarkdownPadding(line)}`, width, ""),
    );
}

function renderLabeled(input: UserMessageStyleRenderInput): string[] {
    const { width, theme, config } = input;
    if (width <= 0) return [""];
    if (width <= 2) {
        return renderMarkdown(input, width).map((line) => truncateToWidth(line, width, ""));
    }

    const horizontalPadding = width >= 5 ? 1 : 0;
    const contentWidth = Math.max(1, width - 2 - horizontalPadding * 2);
    const body = renderMarkdown(input, contentWidth);
    const top =
        width >= 9
            ? `${border(theme, config, "╭─")}${accent(theme, config, " User ")}${border(
                  theme,
                  config,
                  `${"─".repeat(Math.max(0, width - 9))}╮`,
              )}`
            : border(theme, config, `╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const padding = " ".repeat(horizontalPadding);
    const side = (line: string) =>
        `${border(theme, config, "│")}${padding}${fillLine(line, contentWidth)}${padding}${border(
            theme,
            config,
            "│",
        )}`;
    const bottom = border(theme, config, `╰${"─".repeat(Math.max(0, width - 2))}╯`);
    return [top, ...body.map(side), bottom];
}

export function userMessageStyleCacheKey(config: ZentuiConfig): string {
    const messages = config.components.userMessages;
    switch (messages.style) {
        case "framed":
            return [
                "framed",
                messages.colorSource,
                componentColor(config, "userMessages", "accent") ?? "<inherit>",
                componentColor(config, "userMessages", "border") ?? "<inherit>",
                resolveUserMessageRailGlyph(config),
            ].join("\0");
        case "framed-copy-friendly":
            return [
                "framed-copy-friendly",
                messages.colorSource,
                componentColor(config, "userMessages", "border") ?? "<inherit>",
            ].join("\0");
        case "compact":
            return [
                "compact",
                messages.colorSource,
                componentColor(config, "userMessages", "accent") ?? "<inherit>",
                resolveUserMessageRailGlyph(config),
            ].join("\0");
        case "labeled":
            return [
                "labeled",
                messages.colorSource,
                componentColor(config, "userMessages", "accent") ?? "<inherit>",
                componentColor(config, "userMessages", "border") ?? "<inherit>",
                "User:v1",
            ].join("\0");
    }
}

function renderSelectedUserMessageStyle(input: UserMessageStyleRenderInput): string[] {
    switch (input.config.components.userMessages.style) {
        case "framed":
            return renderFramed(input);
        case "framed-copy-friendly":
            return renderFramedCopyFriendly(input);
        case "compact":
            return renderCompact(input);
        case "labeled":
            return renderLabeled(input);
    }
}

export function renderUserMessageStyle(input: UserMessageStyleRenderInput): string[] {
    // Raw user input is a terminal trust boundary. Strip every source control,
    // including OSC 8; Markdown may add its own validated links afterward.
    return sanitizeRenderedUserMessageLines(
        renderSelectedUserMessageStyle({
            ...input,
            text: sanitizeUserMessageSourceText(input.text),
        }),
    );
}

const OSC133_ZONE_START = "\x1b]133;A\x07";

const OSC133_ZONE_END = "\x1b]133;B\x07";

const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type PatchableUserMessagePrototype = {
    children?: unknown[];
    describe?: () => unknown;
};

type Cleanup$usermessage = () => void;

type UserMessageRenderCache = {
    markdown: object;
    text: string;
    width: number;
    theme?: Theme;
    configKey: string;
    renderedLines: string[];
};

const userMessageRenderCache = new WeakMap<object, UserMessageRenderCache>();

function isObject(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeMarkdown(renderer: unknown): boolean {
    return (
        isRecord(renderer) &&
        renderer.constructor?.name === "Markdown" &&
        typeof renderer.text === "string" &&
        ["render", "setText", "invalidate"].every((key) => typeof renderer[key] === "function")
    );
}

const sanitizedMarkdownCache = new WeakMap<
    object,
    { lines: unknown; sourceText: string; text: string; options: unknown }
>();

// Framing eligibility is deliberately narrower than the source trust boundary.
// Unknown renderers still fail open: rendered controls alone cannot distinguish
// raw input from renderer-generated hyperlinks or theme styles.
function withSanitizedMarkdownSources<T>(instance: unknown, render: (adapted: boolean) => T): T {
    const restore: Array<() => void> = [];
    const visited = new Set<object>();
    const visit = (value: unknown) => {
        if (!isRecord(value) || visited.has(value)) return;
        visited.add(value);
        if (isNativeMarkdown(value)) {
            const text = Object.getOwnPropertyDescriptor(value, "text");
            const options = Object.getOwnPropertyDescriptor(value, "options");
            const cachedText = Object.getOwnPropertyDescriptor(value, "cachedText");
            if (!text?.writable || !options?.writable || !cachedText?.writable) return;
            if (!isRecord(options.value)) return;
            const transform = options.value.transform;
            if (transform !== undefined && typeof transform !== "function") return;
            const cached = sanitizedMarkdownCache.get(value);
            // Source sanitization depends only on the immutable raw string, not on
            // width, theme, options or native output invalidation. Reuse just that
            // result; the guarded native render and its cache checks still run.
            const source =
                cached && cached.sourceText === text.value
                    ? cached.text
                    : sanitizeUserMessageSourceText(text.value);
            const safeOptions = {
                ...options.value,
                ...(transform
                    ? {
                          transform: (input: string, width: number) =>
                              sanitizeUserMessageSourceText(
                                  Reflect.apply(transform, options.value, [input, width]),
                              ),
                      }
                    : {}),
            };
            restore.push(() => {
                Object.defineProperty(value, "text", text);
                Object.defineProperty(value, "options", options);
                // Never let a native/unpatched render reuse a source-sanitized cache.
                // Keep the lines only for the next guarded render; invalidate() clears
                // them normally, and cleanup needs no retained component references.
                sanitizedMarkdownCache.set(value, {
                    lines: value.cachedText === source ? value.cachedLines : undefined,
                    sourceText: text.value,
                    text: source,
                    options: options.value,
                });
                Object.defineProperty(value, "cachedText", { ...cachedText, value: undefined });
            });
            value.text = source;
            value.options = safeOptions;
            value.cachedText =
                cached?.lines &&
                cached.lines === value.cachedLines &&
                cached.text === source &&
                cached.options === options.value
                    ? source
                    : undefined;
            return;
        }
        if (Array.isArray(value.children)) for (const child of value.children) visit(child);
    };
    try {
        try {
            visit(instance);
        } catch {
            // Uninspectable predecessor state remains outside the native adapter.
        }
        return render(restore.length > 0);
    } finally {
        for (const undo of restore.reverse()) undo();
    }
}

// Normal user messages have no public framing renderer. Only adapt the native
// zero-padding Markdown child; unfamiliar component trees delegate unchanged.
// Shape checks also support separate same-version Pi TUI package instances.
function nativeMarkdown(instance: PatchableUserMessagePrototype):
    | {
          renderer: Markdown;
          text: string;
          input: UserMessageStyleRenderInput["markdown"];
      }
    | undefined {
    // OMP keeps Markdown state in ECMAScript private fields. Its public native
    // description exposes the complete source without truncated debug previews.
    const direct = instance.children;
    if (
        Array.isArray(direct) &&
        direct.length === 1 &&
        isRecord(direct[0]) &&
        typeof direct[0].describe === "function" &&
        isRecord(instance) &&
        typeof instance.describe === "function"
    ) {
        const bubble = Reflect.apply(instance.describe, instance, []);
        const source = Reflect.apply(direct[0].describe, direct[0], []);
        if (
            !isRecord(bubble) ||
            !isRecord(bubble.p) ||
            bubble.p.role !== "omp.user" ||
            !Array.isArray(bubble.c) ||
            !bubble.c.every(
                (child) =>
                    isRecord(child) &&
                    (child.k === "md" || (isRecord(child.p) && child.p.role === "omp.user.tools")),
            ) ||
            !isRecord(source) ||
            source.k !== "md" ||
            !isRecord(source.p) ||
            typeof source.p.text !== "string"
        )
            return undefined;
        return {
            renderer: direct[0] as unknown as Markdown,
            text: source.p.text,
            input: undefined,
        };
    }
    const children = direct;
    if (!Array.isArray(children) || children.length !== 1) return undefined;
    // Pi >=1.0 holds the Markdown directly (it pads/colors itself); older Pi
    // wrapped it in a Box. Accept both shapes.
    let renderer = children[0];
    const direct1 = isNativeMarkdown(renderer);
    if (isRecord(renderer) && !direct1) {
        const box = renderer;
        if (!Array.isArray(box.children) || box.children.length !== 1) return undefined;
        renderer = box.children[0];
    }
    if (!isNativeMarkdown(renderer)) return undefined;
    const child = renderer as unknown as Record<string, unknown>;
    if (typeof child.text !== "string" || !isRecord(child.theme)) return undefined;
    // Box-wrapped (older Pi) Markdown must be unpadded; Pi >=1.0 pads it itself.
    if (!direct1 && (child.paddingX !== 0 || child.paddingY !== 0)) return undefined;
    for (const key of [
        "heading",
        "link",
        "linkUrl",
        "code",
        "codeBlock",
        "codeBlockBorder",
        "quote",
        "quoteBorder",
        "hr",
        "listBullet",
        "bold",
        "italic",
        "underline",
        "strikethrough",
    ]) {
        if (typeof child.theme[key] !== "function") return undefined;
    }
    if (child.options !== undefined && !isRecord(child.options)) return undefined;
    if (
        isRecord(child.options) &&
        child.options.transform !== undefined &&
        typeof child.options.transform !== "function"
    )
        return undefined;
    if (child.defaultTextStyle !== undefined && !isRecord(child.defaultTextStyle)) return undefined;
    // Pi >=1.0 puts the message background in defaultTextStyle; Zentui frames draw their own.
    const { bgColor: _bg, ...textStyle } = (child.defaultTextStyle ?? {}) as Record<
        string,
        unknown
    >;
    return {
        renderer: renderer as unknown as Markdown,
        text: child.text,
        input: {
            theme: child.theme as unknown as NonNullable<
                UserMessageStyleRenderInput["markdown"]
            >["theme"],
            defaultTextStyle: (child.defaultTextStyle === undefined
                ? undefined
                : textStyle) as NonNullable<
                UserMessageStyleRenderInput["markdown"]
            >["defaultTextStyle"],
            options: child.options as NonNullable<
                UserMessageStyleRenderInput["markdown"]
            >["options"],
        },
    };
}

function renderZentuiUserMessage(
    instance: PatchableUserMessagePrototype,
    width: number,
    theme: Theme | undefined,
    config: ZentuiConfig,
): string[] | undefined {
    if (!isRecord(instance)) return undefined;

    const native = nativeMarkdown(instance);
    if (!native) return undefined;
    const text = native.text;
    const configKey = userMessageStyleCacheKey(config);
    const cached = userMessageRenderCache.get(instance);
    if (
        cached?.markdown === native.renderer &&
        cached.text === text &&
        cached.width === width &&
        cached.theme === theme &&
        cached.configKey === configKey &&
        cached.renderedLines
    ) {
        return cached.renderedLines;
    }

    const lines = renderUserMessageStyle({
        markdown: native.input,
        text,
        width,
        theme,
        config,
    });
    userMessageRenderCache.set(instance, {
        markdown: native.renderer,
        text,
        width,
        theme,
        configKey,
        renderedLines: lines,
    });
    return lines;
}

function withPromptZoneMarkers(lines: string[]): string[] {
    if (lines.length === 1) {
        // Pi's fullscreen renderer strips only a leading run of zone markers per row,
        // so a single row keeps all three at its start, as Pi's native message does.
        return [`${OSC133_ZONE_START}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${lines[0]}`];
    }
    const markedLines = [...lines];
    markedLines[0] = OSC133_ZONE_START + markedLines[0];
    markedLines[markedLines.length - 1] =
        OSC133_ZONE_END + OSC133_ZONE_FINAL + markedLines[markedLines.length - 1];
    return markedLines;
}

function sanitizePredecessorRender(result: unknown): unknown {
    if (typeof result === "string") return sanitizeRenderedUserMessageText(result);
    if (!Array.isArray(result)) return result;
    const stringRows = result.every((line): line is string => typeof line === "string");
    if (stringRows) return sanitizeRenderedUserMessageLines(result);
    return result.map((line) =>
        typeof line === "string" ? sanitizeRenderedUserMessageText(line) : line,
    );
}

function renderSafeSourceFallback(
    instance: PatchableUserMessagePrototype,
    width: number,
): string[] | undefined {
    let text: string | undefined;
    try {
        // A plain fallback is only for an eligible frame that failed to render.
        // Never replace an unfamiliar predecessor tree (and its siblings) with it.
        text = isRecord(instance) ? nativeMarkdown(instance)?.text : undefined;
    } catch {
        return undefined;
    }
    if (text === undefined) return undefined;
    const stripped = sanitizeUserMessageSourceText(text);
    if (stripped === text) return undefined;
    const lines = (width > 0 ? wrapTextWithAnsi(stripped, width) : [""]).map(
        sanitizeRenderedUserMessageText,
    );
    return withPromptZoneMarkers(lines.length > 0 ? lines : [""]);
}

export function removeUserMessageStyle(): void {
    const prototype = UserMessageComponent.prototype;
    removePrototypePatch(prototype, "render", "user-message-render");
    removePrototypePatch(prototype, "invalidate", "user-message-invalidate");
}

export function installUserMessageStyle(
    getTheme: () => Theme | undefined,
    getConfig: () => ZentuiConfig,
): Cleanup$usermessage {
    const prototype = UserMessageComponent.prototype;
    const cleanupInvalidate = installPrototypePatch(
        prototype,
        "invalidate",
        "user-message-invalidate",
        ({ predecessor, receiver, args }) => {
            if (isObject(receiver)) userMessageRenderCache.delete(receiver);
            return Reflect.apply(predecessor, receiver, args);
        },
    );
    let cleanupRender: Cleanup$usermessage;
    try {
        cleanupRender = installPrototypePatch(
            prototype,
            "render",
            "user-message-render",
            ({ predecessor, receiver, args }) => {
                const renderPredecessor = () =>
                    withSanitizedMarkdownSources(receiver, (adapted) => {
                        const result = sanitizePredecessorRender(
                            Reflect.apply(predecessor, receiver, args),
                        );
                        return adapted &&
                            Array.isArray(result) &&
                            result.length > 0 &&
                            result.every((row) => typeof row === "string")
                            ? withPromptZoneMarkers(result)
                            : result;
                    });
                const width = args[0];
                if (typeof width !== "number") return renderPredecessor();
                try {
                    const lines = renderZentuiUserMessage(
                        receiver as PatchableUserMessagePrototype,
                        width,
                        getTheme(),
                        getConfig(),
                    );
                    if (lines) return lines.length ? withPromptZoneMarkers(lines) : lines;
                } catch {
                    const safeFallback = renderSafeSourceFallback(
                        receiver as PatchableUserMessagePrototype,
                        width,
                    );
                    if (safeFallback) return safeFallback;
                }
                return renderPredecessor();
            },
        );
    } catch (error) {
        cleanupInvalidate();
        throw error;
    }
    let cleaned = false;
    return () => {
        if (cleaned) return;
        cleaned = true;
        cleanupRender();
        cleanupInvalidate();
    };
}

const LEGACY_SPLIT_POLISHED_FRAME = Symbol.for("pi-zentui.polished-frame");

export type ViewportCounts = {
    above?: string;
    below?: string;
};

type PolishedFrameSplit = {
    editorLines: string[];
    /** Logical, unframed autocomplete payload rows owned by this module. */
    trailingLines: string[];
    viewport: ViewportCounts;
    nativeStatusLine?: string;
};

type PolishedFrameProvenance = {
    rows: readonly string[];
    split: PolishedFrameSplit;
};

const POLISHED_FRAME_SPLITS = new WeakMap<string[], PolishedFrameProvenance>();

type AutocompleteListInternals = Pick<Component, "render">;

type AutocompleteEditorInternals = {
    autocompleteList?: AutocompleteListInternals;
    debugChildren?: readonly AutocompleteListInternals[];
    isShowingAutocomplete?: () => boolean;
    getPaddingX?: () => number;
    getBorderStyle?: () => unknown;
};

type AutocompleteCapture = {
    compatible: boolean;
    called: number;
    rows: string[];
};

type WrappedEditor = EditorComponent &
    AutocompleteEditorInternals & {
        handleMouse?: EditorMouseHandler;
        focused?: boolean;
        onEscape?: () => void;
        onCtrlD?: () => void;
        onPasteImage?: () => void;
        onExtensionShortcut?: (data: string) => boolean;
        actionHandlers?: Map<unknown, () => void>;
        wantsKeyRelease?: boolean;
        disableSubmit?: boolean;
        getLines?: () => string[];
        getCursor?: () => unknown;
        getMode?: () => unknown;
        getPaddingX?: () => number;
        getAutocompleteMaxVisible?: () => number;
        addToHistory?: (text: string) => void;
        getExpandedText?: () => string;
        insertTextAtCursor?: (text: string) => void;
        setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
        setPaddingX?: (padding: number) => void;
        setAutocompleteMaxVisible?: (maxVisible: number) => void;
    };

export type EditorMeta = {
    modelLabel: string;
    modelId?: string;
    modelName?: string;
    fastMode?: string;
    providerLabel: string;
    sessionName?: string;
    contextPercent?: number;
    contextWindow?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheHitRate?: number;
    customVariables?: ReadonlyMap<string, string>;
    hostTemplateValues?: HostTemplateValues;
};

export type PolishedEditorFrameOptions = {
    width: number;
    editorLines: string[];
    autocompleteLines?: string[];
    viewport?: ViewportCounts;
    uiTheme: Theme;
    config: ZentuiConfig;
    modelMeta: EditorMeta;
    thinkingLevel?: string;
    rightStatus?: string;
    shellMode?: boolean;
    borderColor?: (text: string) => string;
};

type PolishedFrameOptions = {
    width: number;
    baseWidth: number;
    baseRendered: string[];
    autocompleteSource: AutocompleteEditorInternals;
    autocompleteCapture?: AutocompleteCapture;
    uiTheme: Theme;
    config: ZentuiConfig;
    modelMeta: EditorMeta;
    thinkingLevel: string | undefined;
    rightStatus?: string;
    shellMode?: boolean;
    ownedFrame?: PolishedFrameSplit;
    trustedBaseFrame?: boolean;
    borderColor?: (text: string) => string;
};

type PolishedFrameResult = {
    lines: string[];
    decorated: boolean;
};

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function isViewportCounts(value: unknown): value is ViewportCounts {
    if (!value || typeof value !== "object") return false;
    const counts = value as Record<string, unknown>;
    return [counts.above, counts.below].every(
        (count) => count === undefined || (typeof count === "string" && /^[1-9]\d*$/.test(count)),
    );
}

function isPolishedFrameSplit(value: unknown, baseLineCount: number): value is PolishedFrameSplit {
    if (!value || typeof value !== "object") return false;
    const split = value as Record<string, unknown>;
    return (
        isStringArray(split.editorLines) &&
        isStringArray(split.trailingLines) &&
        split.trailingLines.length <= baseLineCount &&
        isViewportCounts(split.viewport)
    );
}

function stripNativeRightPadding(value: string): string {
    return value.replace(/ +$/, "");
}

// Mirrors the native editor's per-render padding clamp: effective horizontal
// padding never exceeds half of the rendered width.
function nativeHorizontalPadding(source: AutocompleteEditorInternals, baseWidth: number): number {
    try {
        if (typeof source.getPaddingX !== "function") return 0;
        const padding = source.getPaddingX.call(source);
        if (!Number.isFinite(padding)) return 0;
        const maxPadding = Math.max(0, Math.floor((baseWidth - 1) / 2));
        return Math.min(Math.max(0, Math.floor(padding)), maxPadding);
    } catch {
        return 0;
    }
}

type AutocompleteCount = { known: true; count: number } | { known: false };

function autocompleteCount(
    source: AutocompleteEditorInternals,
    capture: AutocompleteCapture | undefined,
    baseRendered: string[],
    baseWidth: number,
): AutocompleteCount {
    try {
        const showing = source.isShowingAutocomplete;
        if (typeof showing !== "function" || !showing.call(source))
            return { known: true, count: 0 };
        if (
            !capture?.compatible ||
            capture.called !== 1 ||
            capture.rows.length <= 0 ||
            capture.rows.length >= baseRendered.length
        )
            return { known: false };
        const paddingX = nativeHorizontalPadding(source, baseWidth);
        const leftPadding = " ".repeat(paddingX);
        const suffix = baseRendered.slice(-capture.rows.length);
        if (
            !suffix.every((line, index) => {
                const captured = capture.rows[index];
                const unpadded =
                    paddingX > 0 && line.startsWith(leftPadding)
                        ? line.slice(leftPadding.length)
                        : line;
                return (
                    captured !== undefined &&
                    (line === captured ||
                        stripNativeRightPadding(unpadded) === stripNativeRightPadding(captured))
                );
            })
        )
            return { known: false };
        return { known: true, count: capture.rows.length };
    } catch {
        return { known: false };
    }
}

// The native editor renders autocomplete rows wrapped in its horizontal
// padding; prefer the raw captured rows so decoration starts at column zero.
function capturedAutocompleteLines(
    capture: AutocompleteCapture | undefined,
    baseRendered: string[],
    count: number,
): string[] {
    if (count <= 0) return [];
    return capture && capture.rows.length === count ? capture.rows : baseRendered.slice(-count);
}

/** @internal Exported only for descriptor-safety regression tests. */
export function renderWithAutocompleteCapture<T>(
    source: AutocompleteEditorInternals,
    render: () => T,
): { value: T; capture?: AutocompleteCapture } {
    let showing = false;
    try {
        showing =
            typeof source.isShowingAutocomplete === "function" &&
            source.isShowingAutocomplete.call(source);
    } catch {
        return { value: render() };
    }
    if (!showing) return { value: render(), capture: { compatible: true, called: 0, rows: [] } };

    let list: AutocompleteListInternals;
    let own: PropertyDescriptor | undefined;
    let predecessor: (...args: unknown[]) => unknown;
    try {
        const candidate = source.autocompleteList ?? source.debugChildren?.[0];
        if (!candidate) return { value: render() };
        own = Object.getOwnPropertyDescriptor(candidate, "render");
        const current = Reflect.get(candidate, "render");
        if (typeof current !== "function") return { value: render() };
        if (own && (!("value" in own) || own.writable !== true)) return { value: render() };
        if (!own && !Object.isExtensible(candidate)) return { value: render() };
        list = candidate;
        predecessor = current as (...args: unknown[]) => unknown;
    } catch {
        return { value: render() };
    }

    const capture: AutocompleteCapture = { compatible: true, called: 0, rows: [] };
    const wrapper = function (this: AutocompleteListInternals, ...args: unknown[]) {
        const result = Reflect.apply(predecessor, this, args);
        capture.called++;
        if (!isStringArray(result)) {
            capture.compatible = false;
            return result;
        }
        capture.rows = [...result];
        return result;
    };
    const installedDescriptor: PropertyDescriptor = {
        ...(own ?? { configurable: true, enumerable: false, writable: true }),
        value: wrapper,
    };
    try {
        Object.defineProperty(list, "render", installedDescriptor);
    } catch {
        return { value: render() };
    }

    try {
        return { value: render(), capture };
    } finally {
        let current: PropertyDescriptor | undefined;
        let currentValue: unknown;
        let descriptorKnown = true;
        try {
            current = Object.getOwnPropertyDescriptor(list, "render");
            currentValue =
                current && "value" in current ? current.value : Reflect.get(list, "render");
        } catch {
            descriptorKnown = false;
            try {
                currentValue = Reflect.get(list, "render");
            } catch {
                currentValue = undefined;
            }
        }
        if (currentValue === wrapper) {
            if (
                !descriptorKnown ||
                !current ||
                current.configurable !== installedDescriptor.configurable ||
                current.enumerable !== installedDescriptor.enumerable ||
                current.writable !== installedDescriptor.writable
            )
                capture.compatible = false;
            try {
                if (own) Object.defineProperty(list, "render", own);
                else if (!Reflect.deleteProperty(list, "render")) capture.compatible = false;
            } catch {
                capture.compatible = false;
            }
        } else {
            // A synchronous third-party replacement wins; captured semantics are no longer trustworthy.
            capture.compatible = false;
        }
    }
}

function clampRenderedLines(lines: string[], width: number): string[] {
    const maxWidth = Math.max(0, width);
    return lines.map((line) => truncateToWidth(line, maxWidth, ""));
}

function fillLine$ui(content: string, width: number): string {
    const truncated = truncateToWidth(content, Math.max(0, width), "");
    const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
    return `${truncated}${pad}`;
}

function isLowRailPolishedStyle(style: EditorStyle): boolean {
    return style === "opencode-copy-friendly";
}

function isShellModeInput(text: string): boolean {
    return bashModeLabel(text) !== "";
}

export function editorWantsContext(config: ZentuiConfig): boolean {
    const editor = config.components.editor;
    if (!editor.enabled) return false;
    return collectFooterFormatReferences(
        parseFooterFormat(sanitizeEditorMetadataText(editor.styles[editor.style].metadataFormat)),
    ).has("context");
}

function selectedPolishedConfig(config: ZentuiConfig) {
    switch (config.components.editor.style) {
        case "opencode":
            return config.components.editor.styles.opencode;
        case "opencode-copy-friendly":
            return config.components.editor.styles["opencode-copy-friendly"];
    }
}

function lowRailPrompt(config: ZentuiConfig, uiTheme: Theme, reset: string): string {
    const promptIcon = config.icons.editorPrompt;
    return promptIcon
        ? `${renderStyleForSourceOrFallback(
              uiTheme,
              config.components.editor.colorSource,
              componentColor(config, "editor", "prompt") ??
                  componentColor(config, "editor", "accent"),
              EDITOR_ACCENT_FALLBACK,
              promptIcon,
          )}${reset} `
        : "";
}

function getEditorChromeWidths(
    config: ZentuiConfig,
    uiTheme: Theme,
    reset: string,
    shellMode = false,
) {
    const lowRail = isLowRailPolishedStyle(config.components.editor.style);
    const prompt = lowRailPrompt(config, uiTheme, reset);
    const chromeColor = shellMode
        ? editorShellColor(config)
        : { color: componentColor(config, "editor", "accent"), fallback: EDITOR_ACCENT_FALLBACK };
    const rail = lowRail
        ? ""
        : `${renderStyleForSourceOrFallback(
              uiTheme,
              config.components.editor.colorSource,
              chromeColor.color,
              chromeColor.fallback,
              resolveEditorFrameRailGlyph(config),
          )}${reset} `;
    return {
        prompt,
        promptWidth: visibleWidth(prompt),
        rail,
        railWidth: lowRail ? visibleWidth(prompt) : visibleWidth(rail),
    };
}

export function composeEditorMetadataLine(
    { left, middle, right }: EditorMetadataZones,
    rightStatus: string | undefined,
    width: number,
): string {
    const maxWidth = Math.max(0, width);

    // Preserve the legacy no-fill path exactly, including deferring left-only
    // truncation to the style-specific frame clamp below.
    if (!middle && !right) {
        if (!rightStatus) return left;
        const rightStatusWidth = visibleWidth(rightStatus);
        if (rightStatusWidth >= maxWidth) return truncateToWidth(rightStatus, maxWidth, "");

        const leftBudget = Math.max(0, maxWidth - rightStatusWidth - 1);
        const leftText = truncateToWidth(left, leftBudget, "");
        const gap = " ".repeat(Math.max(1, maxWidth - visibleWidth(leftText) - rightStatusWidth));
        return `${leftText}${gap}${rightStatus}`;
    }

    const statusText = rightStatus ? truncateToWidth(rightStatus, maxWidth, "") : "";
    const statusWidth = visibleWidth(statusText);
    const leftBudget = Math.max(0, maxWidth - statusWidth - (statusText && left ? 1 : 0));
    const leftText = truncateToWidth(left, leftBudget, "");
    const leftWidth = visibleWidth(leftText);

    const rightBudget = Math.max(
        0,
        maxWidth - leftWidth - statusWidth - (leftText ? 1 : 0) - (statusText ? 1 : 0),
    );
    const configuredRight = truncateToWidth(right, rightBudget, "");
    const rightText =
        configuredRight && statusText
            ? `${configuredRight} ${statusText}`
            : configuredRight || statusText;
    const rightWidth = visibleWidth(rightText);
    const gapWidth = Math.max(0, maxWidth - leftWidth - rightWidth);
    const middleWidth = visibleWidth(middle);
    const minimumMiddleGap = (leftText ? 1 : 0) + (rightText ? 1 : 0);

    if (!middle || middleWidth + minimumMiddleGap > gapWidth) {
        return `${leftText}${" ".repeat(gapWidth)}${rightText}`;
    }

    const availablePadding = gapWidth - middleWidth;
    const minimumLeftPadding = leftText ? 1 : 0;
    const maximumLeftPadding = availablePadding - (rightText ? 1 : 0);
    const leftPadding = Math.min(
        maximumLeftPadding,
        Math.max(minimumLeftPadding, Math.floor(availablePadding / 2)),
    );
    return `${leftText}${" ".repeat(leftPadding)}${middle}${" ".repeat(
        availablePadding - leftPadding,
    )}${rightText}`;
}

function ansiStrippedText(line: string): string {
    return stripAnsi(line);
}

function plainRenderedText(line: string): string {
    return ansiStrippedText(line).replace(/\[\/?[^\]]+\]/g, "");
}

function parseEditorBorder(
    line: string,
    direction: keyof ViewportCounts,
): { count?: string } | undefined {
    const plain = ansiStrippedText(line);
    if (/^─+$/.test(plain)) return {};

    const arrow = direction === "above" ? "↑" : "↓";
    const match = new RegExp(`^─{3,} ${arrow} ([1-9]\\d*) more ─*$`).exec(plain);
    return match?.[1] ? { count: match[1] } : undefined;
}

function renderEditorBorder$ui(
    width: number,
    direction: keyof ViewportCounts,
    count: string | undefined,
): string {
    if (!count) return "─".repeat(width);
    const arrow = direction === "above" ? "↑" : "↓";
    const indicator = `─── ${arrow} ${count} more `;
    return `${indicator}${"─".repeat(Math.max(0, width - visibleWidth(indicator)))}`;
}

/** Slice native chrome in terminal cells without dropping the zero-width caret. */
function sliceEditorColumns(line: string, start: number, length: number): string | undefined {
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex < 0) return sliceByColumn(line, start, length, true);
    if (line.indexOf(CURSOR_MARKER, markerIndex + CURSOR_MARKER.length) >= 0) return undefined;
    const before = line.slice(0, markerIndex);
    const after = line.slice(markerIndex + CURSOR_MARKER.length);
    const markerColumn = visibleWidth(before);
    if (markerColumn < start || markerColumn > start + length) return undefined;
    const beforeLength = markerColumn - start;
    return (
        sliceByColumn(before, start, beforeLength, true) +
        CURSOR_MARKER +
        sliceByColumn(after, 0, length - beforeLength, true)
    );
}

type NormalizedBaseFrame = PolishedFrameSplit & { nativeFrame: boolean };

/** Both hosts feed the same unframed payload into the existing style renderers. */
function normalizeBaseFrame(
    baseRendered: string[],
    baseWidth: number,
    source: AutocompleteEditorInternals,
    capture: AutocompleteCapture | undefined,
    ownedFrame: PolishedFrameSplit | undefined,
    trustedBaseFrame: boolean,
): NormalizedBaseFrame | undefined {
    if (ownedFrame) return { ...ownedFrame, nativeFrame: false };
    if (source.getBorderStyle?.() === "band") {
        if (!trustedBaseFrame && source.getPaddingX?.() !== 0) return undefined;
        const autocomplete = autocompleteCount(source, capture, baseRendered, baseWidth);
        if (!autocomplete.known) return undefined;
        const end = baseRendered.length - autocomplete.count;
        if (end < 2) return undefined;
        const editorLines: string[] = [];
        for (let index = 1; index < end; index++) {
            const row = baseRendered[index];
            const plain = ansiStrippedText(row.replaceAll(CURSOR_MARKER, ""));
            if (!plain.startsWith(index === 1 ? "╰─ " : "   ")) return undefined;
            const rowWidth = visibleWidth(row.replaceAll(CURSOR_MARKER, ""));
            if (rowWidth < 3 || rowWidth > baseWidth) return undefined;
            const content = sliceEditorColumns(row, 3, rowWidth - 3);
            if (content === undefined) return undefined;
            editorLines.push(content);
        }
        return {
            editorLines,
            trailingLines: capturedAutocompleteLines(capture, baseRendered, autocomplete.count),
            viewport: {},
            nativeFrame: true,
            nativeStatusLine: baseRendered[0],
        };
    }
    const top = ansiStrippedText(baseRendered[0] ?? "");
    if (top.startsWith("╭")) {
        // The native subclass explicitly selects zero padding. A predecessor with
        // unknown padding is not safe to unwrap: leading spaces may be prompt text.
        if (
            !/^╭.*╮$/.test(top) ||
            visibleWidth(top) !== baseWidth ||
            top.includes(CURSOR_MARKER) ||
            (typeof source.getBorderStyle === "function" && source.getBorderStyle() !== "box") ||
            baseWidth < 4 ||
            (!trustedBaseFrame &&
                (typeof source.getPaddingX !== "function" || source.getPaddingX() !== 0))
        )
            return undefined;
        const editorLines: string[] = [];
        for (let index = 1; index < baseRendered.length; index++) {
            const row = baseRendered[index] ?? "";
            const plain = ansiStrippedText(row.replaceAll(CURSOR_MARKER, ""));
            const rowWidth = visibleWidth(row.replaceAll(CURSOR_MARKER, ""));
            const last = plain.startsWith("╰─") && plain.endsWith("╯");
            if (
                rowWidth < 3 ||
                rowWidth > baseWidth + 1 ||
                (!last && !(plain.startsWith("│") && /[│█]$/.test(plain)))
            )
                return undefined;
            const leftWidth = last ? 2 : 1;
            const content = sliceEditorColumns(row, leftWidth, rowWidth - leftWidth - 1);
            if (content === undefined) return undefined;
            editorLines.push(content);
            if (last) {
                return {
                    editorLines,
                    trailingLines: baseRendered.slice(index + 1),
                    viewport: {},
                    nativeFrame: true,
                    nativeStatusLine: /[^╭╮─\s]/u.test(top) ? baseRendered[0] : undefined,
                };
            }
        }
        return undefined;
    }
    // Other OMP composer shapes are not Pi frames, even when the source is native.
    if (typeof source.getBorderStyle === "function") return undefined;
    const autocomplete = autocompleteCount(source, capture, baseRendered, baseWidth);
    if (!autocomplete.known) return undefined;
    const frame =
        autocomplete.count > 0 ? baseRendered.slice(0, -autocomplete.count) : baseRendered;
    if (frame.length < 2) return undefined;
    const parsedTop = parseEditorBorder(frame[0] ?? "", "above");
    const parsedBottom = parseEditorBorder(frame.at(-1) ?? "", "below");
    if (!trustedBaseFrame && (!parsedTop || !parsedBottom)) return undefined;
    return {
        editorLines: frame.slice(1, -1),
        trailingLines: capturedAutocompleteLines(capture, baseRendered, autocomplete.count),
        viewport: { above: parsedTop?.count, below: parsedBottom?.count },
        nativeFrame: false,
    };
}

function rememberNormalizedMouseLayout(
    lines: string[],
    baseRendered: string[],
    frame: NormalizedBaseFrame,
    layout: Parameters<typeof rememberEditorMouseLayout>[4],
): void {
    // OMP's merged bottom has different per-row offsets and completion origins.
    // Until its geometry is exposed, consume decorated clicks rather than send
    // Pi coordinates to a predecessor's native input handler.
    rememberEditorMouseLayout(
        lines,
        baseRendered,
        frame.editorLines.length,
        frame.trailingLines.length,
        frame.nativeFrame ? { body: [], completion: [] } : layout,
    );
}

function unwrapPolishedFrameOnly(
    lines: string[],
    config: ZentuiConfig,
    uiTheme: Theme,
    shellMode = false,
): { editorLines: string[]; viewport: ViewportCounts } | undefined {
    if (lines.length < 5) return undefined;
    const top = parseEditorBorder(lines[0] ?? "", "above");
    const bottom = parseEditorBorder(lines.at(-1) ?? "", "below");
    if (!top || !bottom) return undefined;

    const viewport = { above: top.count, below: bottom.count };
    const interior = lines.slice(1, -1);
    if (interior.length < 3) return undefined;

    if (isLowRailPolishedStyle(config.components.editor.style)) {
        if (
            plainRenderedText(interior[0] ?? "").trim() !== "" ||
            plainRenderedText(interior.at(-2) ?? "").trim() !== "" ||
            !(interior.at(-1) ?? "").startsWith(" ")
        )
            return undefined;

        const { prompt, promptWidth } = getEditorChromeWidths(config, uiTheme, "\x1b[0m");
        const continuation = " ".repeat(promptWidth);
        const content = interior.slice(1, -2);
        const unwrapped: string[] = [];
        for (let index = 0; index < content.length; index++) {
            const prefix = index === 0 ? prompt : continuation;
            const line = content[index] ?? "";
            if (prefix && !line.startsWith(prefix)) return undefined;
            unwrapped.push(prefix ? line.slice(prefix.length) : line);
        }
        return { editorLines: unwrapped, viewport };
    }

    const { rail } = getEditorChromeWidths(config, uiTheme, "\x1b[0m", shellMode);
    if (!rail || interior.some((line) => !line.startsWith(rail))) return undefined;
    const unrailed = interior.map((line) => line.slice(rail.length));
    if (
        plainRenderedText(unrailed[0] ?? "").trim() !== "" ||
        plainRenderedText(unrailed.at(-2) ?? "").trim() !== ""
    )
        return undefined;
    return { editorLines: unrailed.slice(1, -2), viewport };
}

function splitPolishedFrame(
    lines: string[],
    config: ZentuiConfig,
    uiTheme: Theme,
    shellMode = false,
): PolishedFrameSplit | undefined {
    if (!parseEditorBorder(lines[0] ?? "", "above")) return undefined;

    for (let bottomIndex = lines.length - 1; bottomIndex >= 4; bottomIndex--) {
        if (!parseEditorBorder(lines[bottomIndex] ?? "", "below")) continue;
        const frame = unwrapPolishedFrameOnly(
            lines.slice(0, bottomIndex + 1),
            config,
            uiTheme,
            shellMode,
        );
        if (frame) return { ...frame, trailingLines: lines.slice(bottomIndex + 1) };
    }
    return undefined;
}

function inspectPolishedFrameProvenance(
    base: WrappedEditor,
    rendered: string[],
    config: ZentuiConfig,
    uiTheme: Theme,
): { safe: boolean; ownedFrame?: PolishedFrameSplit } {
    const provenance = POLISHED_FRAME_SPLITS.get(rendered);
    const provenanceMatches = Boolean(
        provenance &&
        provenance.rows.length === rendered.length &&
        provenance.rows.every((line, index) => line === rendered[index]),
    );
    const ownedFrame = provenanceMatches ? provenance?.split : undefined;
    const unsafe =
        Boolean(provenance && !provenanceMatches) ||
        LEGACY_SPLIT_POLISHED_FRAME in base ||
        // A predecessor may return cached rows from either input mode.
        (!ownedFrame &&
            Boolean(
                splitPolishedFrame(rendered, config, uiTheme) ||
                splitPolishedFrame(rendered, config, uiTheme, true),
            ));
    return { safe: !unsafe, ownedFrame };
}

function vimModeColor(mode: string): string {
    switch (mode.toLowerCase()) {
        case "insert":
            return "success";
        case "normal":
            return "accent";
        case "ex":
            return "warning";
        case "replace":
            return "error";
        case "visual":
            return "syntaxKeyword";
        default:
            return "muted";
    }
}

function readVimStatus(editor: WrappedEditor, uiTheme: Theme): string | undefined {
    const mode = editor.getMode?.();
    if (typeof mode !== "string") return undefined;
    const normalized = mode.trim();
    if (!normalized) return undefined;
    const label = `${normalized.toUpperCase()} `;
    return safeThemeFg(uiTheme, vimModeColor(normalized), label);
}

function renderPolishedFrame({
    width,
    baseWidth,
    baseRendered,
    autocompleteSource,
    autocompleteCapture,
    uiTheme,
    config,
    modelMeta,
    thinkingLevel,
    rightStatus,
    shellMode = false,
    ownedFrame,
    trustedBaseFrame = false,
    borderColor,
}: PolishedFrameOptions): PolishedFrameResult {
    if (width <= 2) return { lines: clampRenderedLines(baseRendered, width), decorated: false };

    if (ownedFrame && !isPolishedFrameSplit(ownedFrame, baseRendered.length)) {
        return { lines: clampRenderedLines(baseRendered, width), decorated: false };
    }

    const frame = normalizeBaseFrame(
        baseRendered,
        baseWidth,
        autocompleteSource,
        autocompleteCapture,
        ownedFrame,
        trustedBaseFrame,
    );
    if (!frame) return { lines: clampRenderedLines(baseRendered, width), decorated: false };
    const { editorLines, trailingLines: autocompleteLines, viewport } = frame;
    const lines = renderPolishedEditorFrame({
        width,
        editorLines,
        autocompleteLines,
        viewport,
        uiTheme,
        config,
        modelMeta,
        thinkingLevel,
        rightStatus,
        shellMode,
        borderColor,
    });
    if (frame.nativeStatusLine !== undefined) lines.unshift(frame.nativeStatusLine);
    const { railWidth } = getEditorChromeWidths(config, uiTheme, "\x1b[0m", shellMode);
    const completionCount =
        selectedPolishedConfig(config)?.completionMenu === "palette"
            ? omitTrailingNativeCompletionCountRow(autocompleteLines).length
            : autocompleteLines.length;
    rememberNormalizedMouseLayout(lines, baseRendered, frame, {
        body: editorMouseCells(editorLines.length, railWidth, 2),
        completion: editorMouseCells(completionCount, 0, editorLines.length + 5),
    });
    POLISHED_FRAME_SPLITS.set(lines, {
        rows: Object.freeze([...lines]),
        split: {
            editorLines,
            trailingLines: autocompleteLines,
            viewport,
            nativeStatusLine: frame.nativeStatusLine,
        },
    });
    return { lines, decorated: true };
}

/** Pure Opencode frame composition shared by the live editor and settings preview. */
export function renderPolishedEditorFrame({
    width,
    editorLines,
    autocompleteLines = [],
    viewport = {},
    uiTheme,
    config,
    modelMeta,
    thinkingLevel,
    rightStatus,
    shellMode = false,
    borderColor,
}: PolishedEditorFrameOptions): string[] {
    if (width <= 2) return clampRenderedLines(editorLines, width);
    const reset = "\x1b[0m";
    const colorSource = config.components.editor.colorSource;
    const { prompt, promptWidth, rail, railWidth } = getEditorChromeWidths(
        config,
        uiTheme,
        reset,
        shellMode,
    );
    const innerWidth = Math.max(0, width - railWidth);
    const lowRailContinuation = " ".repeat(promptWidth);
    const renderMetadata = (includeCustom = true) =>
        renderEditorMetadataFormatSplit(
            selectedPolishedConfig(config)?.metadataFormat ??
                config.components.editor.styles.opencode.metadataFormat,
            {
                model: modelMeta.modelLabel,
                modelId: modelMeta.modelId ?? "",
                modelName: modelMeta.modelName ?? "",
                provider: modelMeta.providerLabel,
                thinking: thinkingLevel ?? "",
                fastMode: modelMeta.fastMode,
                sessionName: modelMeta.sessionName ?? "",
                contextPercent: modelMeta.contextPercent,
                contextWindow: modelMeta.contextWindow,
                inputTokens: modelMeta.inputTokens,
                outputTokens: modelMeta.outputTokens,
                cacheHitRate: modelMeta.cacheHitRate,
                customVariables: includeCustom ? modelMeta.customVariables : undefined,
                hostTemplateValues: modelMeta.hostTemplateValues,
            },
            uiTheme,
            config,
            shellMode,
        );
    let metadataZones = renderMetadata();
    // Extension values are never clipped away.
    const metadataBudget = isLowRailPolishedStyle(config.components.editor.style)
        ? width - 1
        : innerWidth;
    const naturalWidth = () =>
        Object.values(metadataZones).reduce((sum, zone) => sum + visibleWidth(zone), 0) +
        Object.values(metadataZones).filter(Boolean).length -
        1 +
        (rightStatus ? visibleWidth(rightStatus) + 1 : 0);
    // Configured extension values yield whole before any built-in metadata is cropped.
    const includeCustom = naturalWidth() <= metadataBudget;
    if (!includeCustom) metadataZones = renderMetadata(false);
    const lowRailMeta = composeEditorMetadataLine(
        metadataZones,
        rightStatus,
        Math.max(0, width - 1),
    );
    const railedMeta = composeEditorMetadataLine(metadataZones, rightStatus, innerWidth);

    const renderStaticBorder = (text: string) =>
        renderStyleForSourceOrFallback(
            uiTheme,
            colorSource,
            componentColor(config, "editor", "border"),
            EDITOR_BORDER_FALLBACK,
            text,
        );
    const renderBorder = (text: string) => {
        if (
            config.components.editor.borderColorMode !== "adaptive" ||
            typeof borderColor !== "function"
        ) {
            return renderStaticBorder(text);
        }
        try {
            const rendered = borderColor(text);
            return typeof rendered === "string" ? rendered : renderStaticBorder(text);
        } catch {
            return renderStaticBorder(text);
        }
    };
    const top = renderBorder(
        renderEditorBorder$ui(
            width,
            "above",
            config.components.editor.viewportIndicators ? viewport.above : undefined,
        ),
    );
    const bottom = renderBorder(
        renderEditorBorder$ui(
            width,
            "below",
            config.components.editor.viewportIndicators ? viewport.below : undefined,
        ),
    );
    const completionLines =
        selectedPolishedConfig(config)?.completionMenu === "palette"
            ? renderCompletionPalette({
                  lines: autocompleteLines,
                  width,
                  theme: uiTheme,
                  renderSeparator: renderBorder,
                  ownedBackground: false,
              })
            : autocompleteLines;
    const lines = ["", ...editorLines, "", railedMeta];
    const renderedLines = isLowRailPolishedStyle(config.components.editor.style)
        ? [
              top,
              "",
              ...editorLines.map(
                  (line, index) =>
                      `${index === 0 ? prompt : lowRailContinuation}${fillLine$ui(line, innerWidth)}`,
              ),
              "",
              ` ${truncateToWidth(lowRailMeta, Math.max(0, width - 1), "")}`,
              bottom,
              ...completionLines,
          ]
        : [
              top,
              ...lines.map((line) => `${rail}${fillLine$ui(line, innerWidth)}`),
              bottom,
              ...completionLines,
          ];

    return clampRenderedLines(renderedLines, width);
}

export class PolishedEditor extends CustomEditor {
    private readonly getModelMeta: () => EditorMeta;
    private readonly getThinkingLevel: () => string | undefined;
    private readonly getConfig: () => ZentuiConfig;
    private readonly uiTheme: Theme;

    private readonly mouse = new EditorMouseForwarder();
    private metadataDecorated = false;
    private metadataDecoratedStyle?: EditorStyle;

    constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
        uiTheme: Theme,
        getConfig: () => ZentuiConfig,
        getModelMeta: () => EditorMeta,
        getThinkingLevel: () => string | undefined,
        private readonly onMetadataDecorationChange: () => void = () => {},
    ) {
        super(tui, theme, keybindings, { paddingX: 0 });
        // OMP accepts the legacy constructor but ignores its options argument.
        this.setPaddingX(0);
        this.borderColor = (text: string) => safeThemeFg(uiTheme, "border", text);
        this.uiTheme = uiTheme;
        this.getConfig = getConfig;
        this.getModelMeta = getModelMeta;
        this.getThinkingLevel = getThinkingLevel;
        // Pi defines focused as an instance field; observe its public focus lifecycle
        // without shadowing the native cursor's value with a prototype accessor.
        let focused = this.focused;
        Object.defineProperty(this, "focused", {
            configurable: true,
            enumerable: true,
            get: () => focused,
            set: (value: boolean) => {
                focused = value;
            },
        });
        // Resolve subclass prototype overrides before installing the instance adapter.
        // Their super call reaches the native prototype directly, so translate once.
        const handleMouse = (this as unknown as { handleMouse?: EditorMouseHandler }).handleMouse;
        if (typeof handleMouse === "function") {
            Object.defineProperty(this, "handleMouse", {
                value: (event: Parameters<EditorMouseHandler>[0]) =>
                    this.mouse.forward(this, handleMouse, event),
                writable: true,
                configurable: true,
            });
        }
    }

    /** OMP's native tree adapter falls back to render() for a null description. */
    describe(): null {
        return null;
    }

    isMetadataDecorated(): boolean {
        return (
            this.metadataDecorated &&
            this.metadataDecoratedStyle === this.getConfig().components.editor.style
        );
    }
    private reportMetadataDecoration(active: boolean): void {
        const style = active ? this.getConfig().components.editor.style : undefined;
        if (this.metadataDecorated === active && this.metadataDecoratedStyle === style) return;
        this.metadataDecorated = active;
        this.metadataDecoratedStyle = style;
        this.onMetadataDecorationChange();
    }

    private renderBase(width: number): string[] {
        return this.mouse.baseRendered(width, super.render(width));
    }

    private renderFallback(lines: string[], width: number): string[] {
        this.reportMetadataDecoration(false);
        return clampRenderedLines(lines, width);
    }

    render(width: number): string[] {
        try {
            return this.mouse.rendered(this.renderDecorated(width));
        } catch (error) {
            this.reportMetadataDecoration(false);
            throw error;
        }
    }

    private renderDecorated(width: number): string[] {
        const config = this.getConfig();
        if (!config.components.editor.enabled) {
            return this.renderFallback(this.renderBase(width), width);
        }
        if (width <= 2) {
            return this.renderFallback(this.renderBase(width), width);
        }

        const shellMode = isShellModeInput(this.getText());
        const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m", shellMode);
        const innerWidth = Math.max(0, width - railWidth);
        let captured: { value: string[]; capture?: AutocompleteCapture };
        try {
            captured = renderWithAutocompleteCapture(
                this as unknown as AutocompleteEditorInternals,
                () => this.renderBase(innerWidth),
            );
        } catch {
            return this.renderFallback(this.renderBase(width), width);
        }
        try {
            const result = renderPolishedFrame({
                width,
                baseWidth: innerWidth,
                baseRendered: captured.value,
                autocompleteSource: this as unknown as AutocompleteEditorInternals,
                autocompleteCapture: captured.capture,
                uiTheme: this.uiTheme,
                config,
                modelMeta: this.getModelMeta(),
                thinkingLevel: this.getThinkingLevel(),
                shellMode,
                trustedBaseFrame: true,
                borderColor: this.borderColor,
            });
            if (result.decorated) {
                this.reportMetadataDecoration(true);
                return result.lines;
            }
        } catch {
            // Decoration is optional; preserve the completed same-render rows below.
        }
        return this.renderFallback(captured.value, width);
    }
}

export class WrappedPolishedEditor implements EditorComponent {
    declare readonly handleMouse?: EditorMouseHandler;
    declare readonly addToHistory?: (text: string) => void;
    declare readonly insertTextAtCursor?: (text: string) => void;
    declare readonly setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
    declare readonly setPaddingX?: (padding: number) => void;
    declare readonly setAutocompleteMaxVisible?: (maxVisible: number) => void;

    private readonly mouse = new EditorMouseForwarder();
    private metadataDecorated = false;
    private metadataDecoratedStyle?: EditorStyle;

    constructor(
        private readonly base: WrappedEditor,
        private readonly uiTheme: Theme,
        private readonly getConfig: () => ZentuiConfig,
        private readonly getModelMeta: () => EditorMeta,
        private readonly getThinkingLevel: () => string | undefined,
        private readonly onMetadataDecorationChange: () => void = () => {},
    ) {
        if (typeof base.handleMouse === "function") {
            this.handleMouse = (event) => {
                const handler = base.handleMouse;
                return typeof handler === "function"
                    ? this.mouse.forward(base, handler, event)
                    : undefined;
            };
        }
        if (typeof base.addToHistory === "function") {
            this.addToHistory = (text) => base.addToHistory?.(text);
        }
        if (typeof base.insertTextAtCursor === "function") {
            this.insertTextAtCursor = (text) => base.insertTextAtCursor?.(text);
        }
        if (typeof base.setAutocompleteProvider === "function") {
            this.setAutocompleteProvider = (provider) => base.setAutocompleteProvider?.(provider);
        }
        if (typeof base.setPaddingX === "function") {
            this.setPaddingX = (padding) => base.setPaddingX?.(padding);
        }
        if (typeof base.setAutocompleteMaxVisible === "function") {
            this.setAutocompleteMaxVisible = (maxVisible) =>
                base.setAutocompleteMaxVisible?.(maxVisible);
        }
    }

    get focused(): boolean {
        return Boolean(this.base.focused);
    }
    set focused(value: boolean) {
        this.base.focused = value;
    }

    get borderColor(): ((str: string) => string) | undefined {
        return this.base.borderColor;
    }
    set borderColor(value: ((str: string) => string) | undefined) {
        this.base.borderColor = value;
    }

    get onSubmit(): ((text: string) => void) | undefined {
        return this.base.onSubmit;
    }
    set onSubmit(value: ((text: string) => void) | undefined) {
        this.base.onSubmit = value;
    }

    get onChange(): ((text: string) => void) | undefined {
        return this.base.onChange;
    }
    set onChange(value: ((text: string) => void) | undefined) {
        this.base.onChange = value;
    }

    get onEscape(): (() => void) | undefined {
        return this.base.onEscape;
    }
    set onEscape(value: (() => void) | undefined) {
        this.base.onEscape = value;
    }

    get onCtrlD(): (() => void) | undefined {
        return this.base.onCtrlD;
    }
    set onCtrlD(value: (() => void) | undefined) {
        this.base.onCtrlD = value;
    }

    get onPasteImage(): (() => void) | undefined {
        return this.base.onPasteImage;
    }
    set onPasteImage(value: (() => void) | undefined) {
        this.base.onPasteImage = value;
    }

    get onExtensionShortcut(): ((data: string) => boolean) | undefined {
        return this.base.onExtensionShortcut;
    }
    set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
        this.base.onExtensionShortcut = value;
    }

    get actionHandlers(): Map<unknown, () => void> | undefined {
        return this.base.actionHandlers;
    }
    set actionHandlers(value: Map<unknown, () => void> | undefined) {
        this.base.actionHandlers = value;
    }

    get wantsKeyRelease(): boolean | undefined {
        return this.base.wantsKeyRelease;
    }
    set wantsKeyRelease(value: boolean | undefined) {
        this.base.wantsKeyRelease = value;
    }

    get disableSubmit(): boolean | undefined {
        return this.base.disableSubmit;
    }
    set disableSubmit(value: boolean | undefined) {
        this.base.disableSubmit = value;
    }

    isMetadataDecorated(): boolean {
        return (
            this.metadataDecorated &&
            this.metadataDecoratedStyle === this.getConfig().components.editor.style
        );
    }
    private reportMetadataDecoration(active: boolean): void {
        const style = active ? this.getConfig().components.editor.style : undefined;
        if (this.metadataDecorated === active && this.metadataDecoratedStyle === style) return;
        this.metadataDecorated = active;
        this.metadataDecoratedStyle = style;
        this.onMetadataDecorationChange();
    }

    private renderBase(width: number): string[] {
        return this.mouse.baseRendered(width, this.base.render(width));
    }

    private renderFallback(lines: string[], width: number): string[] {
        this.reportMetadataDecoration(false);
        return clampRenderedLines(lines, width);
    }

    render(width: number): string[] {
        try {
            return this.mouse.rendered(this.renderDecorated(width));
        } catch (error) {
            this.reportMetadataDecoration(false);
            throw error;
        }
    }

    private renderDecorated(width: number): string[] {
        const config = this.getConfig();
        if (!config.components.editor.enabled) {
            return this.renderFallback(this.renderBase(width), width);
        }
        if (width <= 2) return this.renderFallback(this.renderBase(width), width);

        const shellMode = isShellModeInput(this.base.getText());
        const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m", shellMode);
        const innerWidth = Math.max(0, width - railWidth);
        let captured: { value: string[]; capture?: AutocompleteCapture };
        try {
            captured = renderWithAutocompleteCapture(this.base, () => this.renderBase(innerWidth));
        } catch {
            return this.renderFallback(this.renderBase(width), width);
        }
        let result: PolishedFrameResult | undefined;
        try {
            const provenance = inspectPolishedFrameProvenance(
                this.base,
                captured.value,
                config,
                this.uiTheme,
            );
            if (provenance.safe) {
                result = renderPolishedFrame({
                    width,
                    baseWidth: innerWidth,
                    baseRendered: captured.value,
                    autocompleteSource: this.base,
                    autocompleteCapture: captured.capture,
                    uiTheme: this.uiTheme,
                    config,
                    modelMeta: this.getModelMeta(),
                    thinkingLevel: this.getThinkingLevel(),
                    rightStatus: readVimStatus(this.base, this.uiTheme),
                    shellMode,
                    ownedFrame: provenance.ownedFrame,
                    borderColor: this.borderColor,
                });
            }
        } catch {
            // Decoration is optional; preserve the completed same-render rows below.
        }
        if (result?.decorated) {
            this.reportMetadataDecoration(true);
            return result.lines;
        }
        return this.renderFallback(captured.value, width);
    }

    invalidate(): void {
        this.base.invalidate?.();
    }

    handleInput(data: string): void {
        this.base.handleInput(data);
    }

    getText(): string {
        return this.base.getText();
    }

    setText(text: string): void {
        this.base.setText(text);
    }

    getExpandedText(): string {
        return this.base.getExpandedText?.() ?? this.base.getText();
    }

    getLines(): string[] {
        return this.base.getLines?.() ?? this.base.getText().split("\n");
    }

    getCursor(): unknown {
        return this.base.getCursor?.();
    }

    getMode(): unknown {
        return this.base.getMode?.();
    }

    getPaddingX(): number | undefined {
        return this.base.getPaddingX?.();
    }

    getAutocompleteMaxVisible(): number | undefined {
        return this.base.getAutocompleteMaxVisible?.();
    }
}
