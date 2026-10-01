import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { renderPistyleToolCall, renderPistyleToolResult } from "./pistyle-bridge.js";
import type { ToolDisplayConfig } from "./types.js";

/**
 * Pi resolves a tool block's renderers through ToolExecutionComponent, so the
 * boxed presentation is installed at that resolution point - the same layer
 * pi-style patches. It reaches tools this extension cannot register for: tools
 * owned by other extensions and tools with no renderer at all. The patch is
 * additive and restored on dispose; if Pi's internals move, install() reports
 * false and the extension falls back to its registered renderers.
 */
type ConfigGetter = () => ToolDisplayConfig;
type RendererLike = (...args: unknown[]) => unknown;
type RendererSelector = (this: object) => RendererLike | undefined;
type PatchablePrototype = Record<string, unknown> & {
    getCallRenderer?: RendererSelector;
    getResultRenderer?: RendererSelector;
};

let restorePatch: (() => void) | undefined;

function neutralizeToolContainer(instance: object): void {
    const host = instance as {
        getRenderShell?(): string;
        selfRenderContainer?: {
            setBgFn?(fn: (text: string) => string): void;
            paddingX?: number;
            paddingY?: number;
        };
        contentBox?: {
            setBgFn?(fn: (text: string) => string): void;
            paddingX?: number;
            paddingY?: number;
        };
        contentText?: { setCustomBgFn?(fn: (text: string) => string): void };
    };
    const container =
        typeof host.getRenderShell === "function" && host.getRenderShell() === "self"
            ? host.selfRenderContainer
            : host.contentBox;
    if (container) {
        container.paddingX = 0;
        container.paddingY = 0;
        container.setBgFn?.((text) => text);
    }
    // The generic fallback shell (tools with no definition) tints contentText instead.
    host.contentText?.setCustomBgFn?.((text) => text);
}

function patchedSelector(
    method: "getCallRenderer" | "getResultRenderer",
    original: RendererSelector,
    getConfig: ConfigGetter,
): RendererSelector {
    return function patchedRendererSelection(this: object): RendererLike | undefined {
        const originalRenderer = Reflect.apply(original, this, []) as RendererLike | undefined;
        const rawName = (this as { toolName?: unknown }).toolName;
        const toolName = typeof rawName === "string" && rawName ? rawName : undefined;

        return (...rendererArgs: unknown[]) => {
            const config = getConfig();
            if (!config.boxedToolCalls) {
                return typeof originalRenderer === "function"
                    ? Reflect.apply(originalRenderer, this, rendererArgs)
                    : undefined;
            }
            neutralizeToolContainer(this);
            const [first, second, third, fourth] = rendererArgs;
            if (method === "getCallRenderer") {
                return renderPistyleToolCall(
                    toolName,
                    first as Record<string, unknown>,
                    second,
                    third,
                    config,
                );
            }
            return renderPistyleToolResult(toolName, first, second, third, fourth, config);
        };
    };
}

/** Returns true when the renderer-resolution patch is active. */
export function installPistyleToolRendererPatch(getConfig: ConfigGetter): boolean {
    restorePatch?.();

    const prototype = ToolExecutionComponent.prototype as unknown as PatchablePrototype;
    const originalCall = prototype.getCallRenderer;
    const originalResult = prototype.getResultRenderer;
    if (typeof originalCall !== "function" || typeof originalResult !== "function") {
        return false;
    }

    prototype.getCallRenderer = patchedSelector("getCallRenderer", originalCall, getConfig);
    prototype.getResultRenderer = patchedSelector("getResultRenderer", originalResult, getConfig);

    restorePatch = () => {
        prototype.getCallRenderer = originalCall;
        prototype.getResultRenderer = originalResult;
        restorePatch = undefined;
    };
    return true;
}

export function removePistyleToolRendererPatch(): void {
    restorePatch?.();
}
