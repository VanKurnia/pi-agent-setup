import { statSync, existsSync, type BigIntStats } from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    SettingsManager,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
    componentColor,
    FOOTER_FORMAT_ALIASES,
    FOOTER_FORMAT_VARIABLES,
    renderCustomValue,
    AtomicTemplateValues,
    normalizeTemplateVariables,
    isHostTemplateVariable,
    liveMetadataColor,
    renderStyleForSource,
    type ModelLabelSource,
    type SeparatorStyle,
    type ZentuiConfig,
    type HostTemplateValues,
} from "./config.ts";
import {
    buildCacheReadLabel,
    buildCacheWriteLabel,
    buildContextLabel,
    buildCostLabel,
    buildTokenLabel,
    formatProviderLabel,
    getUsageTotals,
    emptyGitStatus,
    sanitizeEditorMetadataText,
    compiledFooterFormat,
    renderFormatSplit,
    renderFormatTokens,
    stripOrphanSeparators,
    compactChunkBudget,
    fullFooterFitsAligned,
    packCompactChunks,
    packCompactZones,
    reflowFullFooter,
    truncateFooterText,
    buildContextDisplayLabel,
    buildSessionDurationLabel,
    contextColorTier,
    formatCwdLabel,
    formatGitBranchText,
    formatGitCommitSegment,
    formatGitMetricsSegment,
    formatOsLabel,
    formatTimeLabel,
    formatUsernameHostLabel,
    resolveContextUsage,
    type UsageTotals,
    type GitStatusSummary,
    type GitReadResult,
    type CompiledCompactChunk,
    type CompactLayoutChunk,
    type ContextUsageSnapshot,
} from "./format.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

export type FooterTelemetry = {
    subscription?: boolean;
    autoCompaction?: boolean;
};

type SettingsManagerLike = {
    drainErrors?: () => unknown[];
    getCompactionEnabled?: () => unknown;
};

type SettingsManagerFactory = {
    create?: (
        cwd: string,
        agentDir?: string,
        options?: { projectTrusted?: boolean },
    ) => SettingsManagerLike;
};

export type TelemetryCapabilities = {
    settingsManager?: SettingsManagerFactory;
};

export type TelemetryDemand = {
    subscription: boolean;
    autoCompaction: boolean;
};

type SnapshotCapabilities = TelemetryCapabilities & {
    getAgentDir?: () => string;
    stat?: (path: string) => Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;
};

function resolveSubscription(ctx: ExtensionContext): boolean | undefined {
    const model = ctx.model;
    if (!model) return undefined;
    if (model.provider === "kimi-coding") return true;

    try {
        const registry = ctx.modelRegistry as {
            isUsingOAuth?: (candidate: typeof model) => unknown;
        };
        if (typeof registry?.isUsingOAuth !== "function") return undefined;
        const result = registry.isUsingOAuth(model);
        return typeof result === "boolean" ? result : undefined;
    } catch {
        return undefined;
    }
}

function resolveAutoCompaction(
    ctx: ExtensionContext,
    factory: SettingsManagerFactory | undefined,
): boolean | undefined {
    try {
        const isProjectTrusted = (
            ctx as ExtensionContext & {
                isProjectTrusted?: () => unknown;
            }
        ).isProjectTrusted;
        if (typeof factory?.create !== "function" || typeof isProjectTrusted !== "function") {
            return undefined;
        }
        const trusted = isProjectTrusted.call(ctx);
        if (typeof trusted !== "boolean") return undefined;
        return readAutoCompaction(factory.create(ctx.cwd, undefined, { projectTrusted: trusted }));
    } catch {
        return undefined;
    }
}

/** Resolve optional Pi telemetry without depending on private session or TUI fields. */
export function resolveFooterTelemetry(
    ctx: ExtensionContext,
    capabilities: TelemetryCapabilities = {},
): FooterTelemetry {
    const settingsManager = capabilities.settingsManager ?? SettingsManager;
    return {
        subscription: resolveSubscription(ctx),
        autoCompaction: resolveAutoCompaction(ctx, settingsManager),
    };
}

function readAutoCompaction(settings: SettingsManagerLike): boolean | undefined {
    if (
        typeof settings?.drainErrors !== "function" ||
        typeof settings.getCompactionEnabled !== "function"
    ) {
        return undefined;
    }
    if (settings.drainErrors().length > 0) return undefined;
    const enabled = settings.getCompactionEnabled();
    return typeof enabled === "boolean" ? enabled : undefined;
}

/** One owner-local settings snapshot; OAuth is deliberately never cached. */
export class FooterTelemetryController {
    private snapshot:
        | { key: string; session: ExtensionContext["sessionManager"]; enabled: boolean }
        | undefined;

    constructor(private readonly capabilities: SnapshotCapabilities = {}) {}

    reset(): void {
        this.snapshot = undefined;
    }

    refresh(ctx: ExtensionContext, demand: TelemetryDemand): FooterTelemetry {
        this.reset();
        return this.resolve(ctx, demand);
    }

    resolve(ctx: ExtensionContext, demand: TelemetryDemand): FooterTelemetry {
        if (!demand.autoCompaction) this.reset();
        return {
            subscription: demand.subscription ? resolveSubscription(ctx) : undefined,
            autoCompaction: demand.autoCompaction ? this.autoCompaction(ctx) : undefined,
        };
    }

    private fileSignature(path: string): string {
        try {
            const stat = this.capabilities.stat?.(path) ?? statSync(path, { bigint: true });
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT" || code === "ENOTDIR") return "missing";
            throw error;
        }
    }

    private autoCompaction(ctx: ExtensionContext): boolean | undefined {
        try {
            const factory = this.capabilities.settingsManager ?? SettingsManager;
            const trust = (ctx as ExtensionContext & { isProjectTrusted?: () => unknown })
                .isProjectTrusted;
            if (typeof factory.create !== "function" || typeof trust !== "function") {
                this.reset();
                return undefined;
            }
            const trusted = trust.call(ctx);
            if (typeof trusted !== "boolean") {
                this.reset();
                return undefined;
            }
            const cwd = resolve(ctx.cwd);
            const agentDir = resolve((this.capabilities.getAgentDir ?? getAgentDir)());
            // Metadata changes, not a TTL, invalidate ordinary edits and atomic replacements.
            // Never even stat project settings before trust has been established.
            const key = () =>
                JSON.stringify([
                    cwd,
                    agentDir,
                    trusted,
                    this.fileSignature(join(agentDir, "settings.json")),
                    trusted
                        ? this.fileSignature(join(cwd, CONFIG_DIR_NAME, "settings.json"))
                        : null,
                ]);
            const before = key();
            if (this.snapshot?.key === before && this.snapshot.session === ctx.sessionManager) {
                return this.snapshot.enabled;
            }
            this.reset();
            const enabled = readAutoCompaction(
                factory.create(cwd, agentDir, { projectTrusted: trusted }),
            );
            if (enabled !== undefined && key() === before) {
                this.snapshot = { key: before, session: ctx.sessionManager, enabled };
            }
            return enabled;
        } catch {
            // Do not retain a successful-looking key after a read, lock, or stat failure.
            this.reset();
            return undefined;
        }
    }
}
export class SessionLifecycle {
    private generation = 0;
    private active = false;
    private readonly timeouts = new Set<ReturnType<typeof setTimeout>>();

    start(): number {
        this.cancelTimeouts();
        this.generation += 1;
        this.active = true;
        return this.generation;
    }

    currentGeneration(): number {
        return this.generation;
    }

    isCurrent(generation = this.generation): boolean {
        return this.active && generation === this.generation;
    }

    defer(callback: () => void, delayMs = 0): () => void {
        if (!this.active) return () => {};
        const generation = this.generation;
        let canceled = false;
        const timeout = setTimeout(() => {
            this.timeouts.delete(timeout);
            if (!canceled && this.isCurrent(generation)) callback();
        }, delayMs);
        this.timeouts.add(timeout);
        return () => {
            if (canceled) return;
            canceled = true;
            clearTimeout(timeout);
            this.timeouts.delete(timeout);
        };
    }

    queueMicrotask(callback: () => void): () => void {
        let canceled = !this.active;
        const generation = this.generation;
        queueMicrotask(() => {
            if (!canceled && this.isCurrent(generation)) callback();
        });
        return () => {
            canceled = true;
        };
    }

    shutdown(): void {
        if (!this.active && this.timeouts.size === 0) return;
        this.active = false;
        this.generation += 1;
        this.cancelTimeouts();
    }

    private cancelTimeouts(): void {
        for (const timeout of this.timeouts) clearTimeout(timeout);
        this.timeouts.clear();
    }
}
export type StopProjectRefreshInterval = () => void;

export type ScheduleProjectRefreshOptions = {
    force?: boolean;
};

export type ProjectRefreshRun = {
    isCurrent: () => boolean;
};

export type ProjectRefreshScheduler<T> = {
    schedule: (target: T, options?: ScheduleProjectRefreshOptions) => void;
    invalidate: () => void;
    stop: () => void;
};

export const PROJECT_REFRESH_THROTTLE_MS = 5_000;

export function startProjectRefreshInterval(
    intervalMs: number,
    refresh: () => void,
): StopProjectRefreshInterval {
    if (intervalMs <= 0) return () => {};

    const timer = setInterval(refresh, intervalMs);
    timer.unref?.();

    return () => clearInterval(timer);
}

/** A refresh may return false when no visible snapshot changed; void/errors still notify. */
export function createProjectRefreshScheduler<T>(
    refresh: (target: T, run: ProjectRefreshRun) => Promise<void> | Promise<boolean>,
    afterRefresh: () => void,
    throttleMs = PROJECT_REFRESH_THROTTLE_MS,
): ProjectRefreshScheduler<T> {
    let refreshInFlight = false;
    let refreshPending = false;
    let pendingForce = false;
    let pendingTarget: T | undefined;
    let delayedRefresh: ReturnType<typeof setTimeout> | undefined;
    let lastRefreshStartedAt: number | undefined;
    let generation = 0;

    const clearDelayedRefresh = () => {
        if (!delayedRefresh) return;
        clearTimeout(delayedRefresh);
        delayedRefresh = undefined;
    };

    const runRefresh = (target: T, options: ScheduleProjectRefreshOptions = {}) => {
        clearDelayedRefresh();
        if (refreshInFlight) {
            refreshPending = true;
            pendingForce ||= options.force === true;
            pendingTarget = target;
            return;
        }

        const currentGeneration = generation;
        const run: ProjectRefreshRun = {
            isCurrent: () => currentGeneration === generation,
        };
        refreshInFlight = true;
        lastRefreshStartedAt = Date.now();
        let notify = true;
        void refresh(target, run)
            .then(
                (changed) => {
                    notify = changed !== false;
                },
                () => undefined,
            )
            .finally(() => {
                if (currentGeneration !== generation) return;
                refreshInFlight = false;
                if (notify) afterRefresh();
                if (refreshPending) {
                    refreshPending = false;
                    const nextForce = pendingForce;
                    pendingForce = false;
                    const nextTarget = pendingTarget ?? target;
                    pendingTarget = undefined;
                    schedule(nextTarget, { force: nextForce });
                }
            });
    };

    const schedule = (target: T, options: ScheduleProjectRefreshOptions = {}) => {
        if (options.force || throttleMs <= 0 || lastRefreshStartedAt === undefined) {
            runRefresh(target, options);
            return;
        }

        const delayMs = Math.max(0, throttleMs - (Date.now() - lastRefreshStartedAt));
        if (delayMs === 0) {
            runRefresh(target);
            return;
        }

        pendingTarget = target;
        if (delayedRefresh) return;
        delayedRefresh = setTimeout(() => {
            delayedRefresh = undefined;
            const nextTarget = pendingTarget ?? target;
            pendingTarget = undefined;
            runRefresh(nextTarget);
        }, delayMs);
        delayedRefresh.unref?.();
    };

    const invalidate = () => {
        generation += 1;
        clearDelayedRefresh();
        refreshInFlight = false;
        refreshPending = false;
        pendingForce = false;
        pendingTarget = undefined;
        lastRefreshStartedAt = undefined;
    };

    return {
        schedule,
        invalidate,
        stop: invalidate,
    };
}

export type RepositoryRootState = {
    /** The cwd whose repository lookup produced this state. */
    cwd: string;
    root?: string;
};

export type RepositoryRootRequest = {
    cwd: string;
    generation: number;
};

/** Find the nearest ancestor containing either a .git directory or worktree .git file. */
export function findRepositoryRoot(cwd: string): string | undefined {
    let current = resolve(cwd);
    while (true) {
        if (existsSync(join(current, ".git"))) return current;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export function updateRepositoryRootState(
    cwd: string,
    isRepository: boolean,
    findRoot: (cwd: string) => string | undefined = findRepositoryRoot,
): RepositoryRootState {
    if (!isRepository) return { cwd };
    try {
        return { cwd, root: findRoot(cwd) };
    } catch {
        return { cwd };
    }
}

/** Return only a current, still-present root produced for this exact cwd. */
export function repositoryRootForCwd(
    state: RepositoryRootState | undefined,
    cwd: string,
    markerExists: (path: string) => boolean = existsSync,
): string | undefined {
    if (!state?.root || state.cwd !== cwd) return undefined;
    try {
        return markerExists(join(state.root, ".git")) ? state.root : undefined;
    } catch {
        return undefined;
    }
}

/** Own repository-root request generations so returning to an older cwd cannot revive old state. */
export class RepositoryRootController {
    private generation = 0;
    private requestedCwd: string | undefined;
    private state: RepositoryRootState | undefined;

    request(cwd: string): RepositoryRootRequest {
        if (cwd !== this.requestedCwd) {
            this.generation += 1;
            this.requestedCwd = cwd;
            this.state = undefined;
        }
        return { cwd, generation: this.generation };
    }

    isCurrent(request: RepositoryRootRequest): boolean {
        return request.cwd === this.requestedCwd && request.generation === this.generation;
    }

    update(
        request: RepositoryRootRequest,
        isRepository: boolean,
        findRoot: (cwd: string) => string | undefined = findRepositoryRoot,
    ): string | undefined {
        if (!this.isCurrent(request)) return undefined;
        this.state = updateRepositoryRootState(request.cwd, isRepository, findRoot);
        return this.state.root;
    }

    /** Render-only snapshot; marker creation/removal is validated by controlled project refresh. */
    cachedRootForCwd(cwd: string): string | undefined {
        return this.state?.cwd === cwd ? this.state.root : undefined;
    }

    rootForCwd(
        cwd: string,
        markerExists: (path: string) => boolean = existsSync,
    ): string | undefined {
        return repositoryRootForCwd(this.state, cwd, markerExists);
    }

    reset(): void {
        this.generation += 1;
        this.requestedCwd = undefined;
        this.state = undefined;
    }
}

export type LiveContextOverride = {
    tokens: number;
};

function usageComponent(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function calculateLiveContextTokens(usage: Usage | undefined): number | undefined {
    if (!usage) return undefined;
    const totalTokens = usageComponent(usage.totalTokens);
    if (totalTokens > 0) return totalTokens;
    const calculated =
        usageComponent(usage.input) +
        usageComponent(usage.output) +
        usageComponent(usage.cacheRead) +
        usageComponent(usage.cacheWrite);
    return calculated > 0 ? calculated : undefined;
}

export function liveContextFromMessage(message: unknown): LiveContextOverride | undefined {
    if (!message || typeof message !== "object") return undefined;
    const assistant = message as Partial<AssistantMessage>;
    if (assistant.role !== "assistant") return undefined;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return undefined;
    const tokens = calculateLiveContextTokens(assistant.usage);
    return tokens === undefined ? undefined : { tokens };
}

export class LiveContextController {
    private readonly lifecycle: SessionLifecycle;
    private readonly requestRender: () => void;
    private override: LiveContextOverride | undefined;
    private overrideGeneration: number | undefined;
    private cancelScheduledRender: (() => void) | undefined;
    private scheduledGeneration: number | undefined;

    constructor(lifecycle: SessionLifecycle, requestRender: () => void) {
        this.lifecycle = lifecycle;
        this.requestRender = requestRender;
    }

    get(): LiveContextOverride | undefined {
        return this.override;
    }

    update(message: unknown): boolean {
        const next = liveContextFromMessage(message);
        if (!next || !this.lifecycle.isCurrent()) return false;
        const generation = this.lifecycle.currentGeneration();
        if (this.overrideGeneration === generation && this.override?.tokens === next.tokens)
            return false;
        this.override = next;
        this.overrideGeneration = generation;
        if (this.cancelScheduledRender && this.scheduledGeneration !== generation) {
            this.cancelScheduledRender = undefined;
            this.scheduledGeneration = undefined;
        }
        if (!this.cancelScheduledRender) {
            this.scheduledGeneration = generation;
            this.cancelScheduledRender = this.lifecycle.defer(() => {
                this.cancelScheduledRender = undefined;
                this.scheduledGeneration = undefined;
                if (this.override) this.requestRender();
            }, 250);
        }
        return true;
    }

    clear(): void {
        this.override = undefined;
        this.overrideGeneration = undefined;
        this.cancelScheduledRender?.();
        this.cancelScheduledRender = undefined;
        this.scheduledGeneration = undefined;
    }
}

export type FooterState = GitStatusSummary & {
    modelLabel: string;
    modelId: string;
    modelName: string;
    providerLabel: string;
    contextLabel: string;
    tokenLabel: string;
    cacheReadLabel: string;
    cacheWriteLabel: string;
    costLabel: string;
    usageTotals: UsageTotals;
    subscription: boolean;
    autoCompaction: boolean;
    sessionStartEpoch?: number;
};

export function createInitialState(gitDefaults: GitStatusSummary): FooterState {
    return {
        modelLabel: "no-model",
        modelId: "",
        modelName: "",
        providerLabel: "Unknown",
        contextLabel: "--",
        tokenLabel: "↑0 ↓0",
        cacheReadLabel: "",
        cacheWriteLabel: "",
        costLabel: "$0.000",
        usageTotals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            latestCacheHitRate: undefined,
            cost: 0,
        },
        subscription: false,
        autoCompaction: false,
        sessionStartEpoch: Date.now(),
        ...gitDefaults,
    };
}

export function modelLabelFor(
    state: Pick<FooterState, "modelId" | "modelName">,
    source: ModelLabelSource,
): string {
    return source === "name"
        ? state.modelName || state.modelId || "no-model"
        : state.modelId || "no-model";
}

export function syncUsageState(
    state: FooterState,
    totals: UsageTotals,
    cacheHitIcon: string,
): void {
    state.tokenLabel = buildTokenLabel(totals, cacheHitIcon);
    state.cacheReadLabel = buildCacheReadLabel(totals.cacheRead);
    state.cacheWriteLabel = buildCacheWriteLabel(totals.cacheWrite);
    state.costLabel = buildCostLabel(totals);
    state.usageTotals = totals;
}

/** Refresh model identity without rescanning usage or project state. */
export function syncModelState(state: FooterState, model: ExtensionContext["model"]): void {
    state.modelId = model?.id ?? "";
    state.modelName = model?.name ?? "";
    state.modelLabel = modelLabelFor(state, "id");
    state.providerLabel = formatProviderLabel(model?.provider);
}

export function syncState(
    state: FooterState,
    ctx: ExtensionContext,
    cacheHitIcon: string,
    telemetry: FooterTelemetry = {},
    options: { includeContextLabel?: boolean; usageTotals?: UsageTotals } = {},
): void {
    const totals = options.usageTotals ?? getUsageTotals(ctx);
    syncModelState(state, ctx.model);
    // Production surfaces resolve fresh context on demand, not from this compatibility label.
    state.contextLabel = options.includeContextLabel === false ? "--" : buildContextLabel(ctx);
    syncUsageState(state, totals, cacheHitIcon);
    state.subscription = telemetry.subscription === true;
    state.autoCompaction = telemetry.autoCompaction === true;
}

/** Value snapshot of project fields, excluding unrelated session/telemetry state. */
export function projectStateSnapshot(
    state: FooterState,
    cwd: string | undefined,
    root: string | undefined,
): string {
    return JSON.stringify([
        cwd,
        root,
        state.branch,
        state.dirty,
        state.ahead,
        state.behind,
        state.conflicted,
        state.untracked,
        state.stashed,
        state.modified,
        state.staged,
        state.renamed,
        state.deleted,
        state.typechanged,
        state.gitState,
        state.gitStateLabel,
        state.commit?.oid,
        state.commit?.detached,
        state.commit?.tag,
        state.metrics?.added,
        state.metrics?.deleted,
    ]);
}

/**
 * Apply a project refresh (git) onto footer state, preserving
 * last-good values on transient errors and clearing on cwd change / not-a-repo.
 *
 * Returns the cwd to store as `previousCwd` for the next refresh.
 */
export function applyProjectRefreshToState(
    state: FooterState,
    args: {
        cwd: string;
        previousCwd: string | undefined;
        git: GitReadResult;
    },
): string {
    const cwdChanged = args.previousCwd !== undefined && args.previousCwd !== args.cwd;

    if (cwdChanged) {
        Object.assign(state, emptyGitStatus());
    }

    if (args.git.kind === "ok") {
        Object.assign(state, args.git.status);
    } else if (args.git.kind === "not_a_repo") {
        Object.assign(state, emptyGitStatus());
    }
    // kind === "error": keep previous git fields (unless cwdChanged already cleared)

    return args.cwd;
}

const separatorText: Record<SeparatorStyle, string> = {
    pipe: " | ",
    dot: " · ",
    chevron: " › ",
    none: " ",
};

function joinStatusTexts(statusTexts: string[], separator: string): string {
    return statusTexts.filter(Boolean).join(separator);
}

function normalizeModelInfoPart(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function composeModelInfoLabel(model: string, provider: string): string {
    const normalizedModel = normalizeModelInfoPart(model);
    const normalizedProvider = normalizeModelInfoPart(provider);
    const providerIsDuplicated =
        normalizedProvider.length > 0 && normalizedModel.includes(normalizedProvider);
    return [model, providerIsDuplicated ? "" : provider].filter(Boolean).join(" ");
}

function fitStatusTexts(statusTexts: string[], maxWidth: number, separator: string): string {
    if (maxWidth <= 0) return "";

    const fitted: string[] = [];
    for (const text of statusTexts) {
        const candidate = joinStatusTexts([...fitted, text], separator);
        if (visibleWidth(candidate) <= maxWidth) {
            fitted.push(text);
            continue;
        }

        if (fitted.length === 0) {
            return maxWidth > 1 ? truncateFooterText(text, maxWidth, "…") : "";
        }
        break;
    }

    return joinStatusTexts(fitted, separator);
}

function appendStatusArea(base: string, statusText: string, separator: string): string {
    if (!base) return statusText;
    if (!statusText) return base;
    return `${base}${separator}${statusText}`;
}

function prependStatusArea(base: string, statusText: string, separator: string): string {
    if (!base) return statusText;
    if (!statusText) return base;
    return `${statusText}${separator}${base}`;
}

function composeBuiltInFooterContent(left: string, right: string, innerWidth: number): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    return leftWidth >= innerWidth
        ? truncateFooterText(left, innerWidth, "")
        : leftWidth + 1 + rightWidth <= innerWidth
          ? `${left}${" ".repeat(innerWidth - leftWidth - rightWidth)}${right}`
          : truncateFooterText(left, innerWidth, "");
}

function composeFooterContent(
    builtInLeft: string,
    builtInRight: string,
    extensionLeft: string[],
    extensionMiddle: string[],
    extensionRight: string[],
    separator: string,
    innerWidth: number,
): string {
    const builtInLeftWidth = visibleWidth(builtInLeft);
    const builtInRightWidth = visibleWidth(builtInRight);
    const minimumGap = builtInLeft && builtInRight ? 1 : 0;

    if (builtInLeftWidth + minimumGap + builtInRightWidth > innerWidth) {
        return composeBuiltInFooterContent(builtInLeft, builtInRight, innerWidth);
    }

    const available = Math.max(0, innerWidth - builtInLeftWidth - builtInRightWidth - minimumGap);
    let remaining = available;
    const leftConnectorWidth =
        builtInLeft && extensionLeft.length > 0 ? visibleWidth(separator) : 0;
    const rightConnectorWidth =
        builtInRight && extensionRight.length > 0 ? visibleWidth(separator) : 0;
    let leftStatus = "";
    let rightStatus = "";

    if (extensionLeft.length > 0 && extensionRight.length > 0) {
        const leftBudget = Math.max(0, Math.floor(available / 2) - leftConnectorWidth);
        leftStatus = fitStatusTexts(extensionLeft, leftBudget, separator);
        remaining -= leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;

        const rightBudget = Math.max(0, remaining - rightConnectorWidth);
        rightStatus = fitStatusTexts(extensionRight, rightBudget, separator);
        remaining -= rightStatus ? rightConnectorWidth + visibleWidth(rightStatus) : 0;

        const expandedLeftBudget = Math.max(0, remaining + visibleWidth(leftStatus));
        const expandedLeftStatus = fitStatusTexts(extensionLeft, expandedLeftBudget, separator);
        if (visibleWidth(expandedLeftStatus) > visibleWidth(leftStatus)) {
            remaining += leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;
            leftStatus = expandedLeftStatus;
            remaining -= leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;
        }
    } else if (extensionLeft.length > 0) {
        leftStatus = fitStatusTexts(
            extensionLeft,
            Math.max(0, available - leftConnectorWidth),
            separator,
        );
        remaining -= leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;
    } else if (extensionRight.length > 0) {
        rightStatus = fitStatusTexts(
            extensionRight,
            Math.max(0, available - rightConnectorWidth),
            separator,
        );
        remaining -= rightStatus ? rightConnectorWidth + visibleWidth(rightStatus) : 0;
    }

    const left = appendStatusArea(builtInLeft, leftStatus, separator);
    const right = prependStatusArea(builtInRight, rightStatus, separator);
    const gapWidth = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(right));
    const middle = fitStatusTexts(extensionMiddle, gapWidth, separator);
    const middleWidth = visibleWidth(middle);

    if (!middle || middleWidth <= 0) {
        return `${left}${" ".repeat(gapWidth)}${right}`;
    }

    const leftPadding = Math.floor((gapWidth - middleWidth) / 2);
    const rightPadding = gapWidth - middleWidth - leftPadding;
    return `${left}${" ".repeat(leftPadding)}${middle}${" ".repeat(rightPadding)}${right}`;
}

export function installFooter(
    ctx: ExtensionContext,
    state: FooterState,
    getConfig: () => ZentuiConfig,
    hooks: {
        setRequestRender: (fn: (() => void) | undefined) => void;
        scheduleProjectRefresh: (ctx: ExtensionContext) => void;
        getThinkingLevel?: () => string | undefined;
        getFastMode?: () => string | undefined;
        getLiveContext?: () => LiveContextOverride | undefined;
        getCustomVariables?: () => ReadonlyMap<string, string>;
        getHostTemplateValues?: (names: ReadonlySet<string>) => HostTemplateValues | undefined;
        getRepositoryRoot?: (cwd: string) => string | undefined;
        onDispose?: () => void;
        onProjectChanged?: () => void;
        beforeRender?: () => void;
    },
): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
        hooks.setRequestRender(() => tui.requestRender());
        const unsubscribeBranch = footerData.onBranchChange(() => {
            hooks.onProjectChanged?.();
            hooks.scheduleProjectRefresh(ctx);
            tui.requestRender();
        });

        return {
            dispose: () => {
                unsubscribeBranch();
                hooks.setRequestRender(undefined);
                hooks.onDispose?.();
            },
            invalidate() {},
            render: function renderFooter(
                width: number,
                contextSnapshot?: ContextUsageSnapshot,
                excludedCustom: ReadonlySet<string> = new Set(),
                builtinSnapshots = new Map<string, string>(),
            ): string[] {
                if (width <= 0) return [""];
                hooks.beforeRender?.();
                const config = getConfig();
                const footer = config.components.footer;
                const aliases = normalizeTemplateVariables(footer.styles.starship.variables, [
                    ...FOOTER_FORMAT_VARIABLES,
                    ...Object.keys(FOOTER_FORMAT_ALIASES),
                ]);
                const published = hooks.getCustomVariables?.() ?? new Map<string, string>();
                const customTexts = new Map<string, string>();
                for (const key of Object.values(aliases)) {
                    if (excludedCustom.has(key)) continue;
                    const raw = published.get(key);
                    if (!raw) continue;
                    const text = renderCustomValue({
                        key,
                        raw,
                        colors: footer.customValueColors,
                        mode: footer.styles.starship.extensionColorMode ?? "original",
                        theme,
                        source: footer.colorSource,
                        fallbackStyle: componentColor(config, "footer", "extensionStatus"),
                    });
                    if (visibleWidth(text)) customTexts.set(key, text);
                }
                const footerModelLabel = modelLabelFor(state, footer.modelLabel);
                const wideFormat = compiledFooterFormat(
                    footer.styles.starship.format,
                    FOOTER_FORMAT_ALIASES,
                );
                const compactFormat = compiledFooterFormat(
                    footer.styles.starship.responsive ? footer.styles.starship.compactFormat : "",
                    FOOTER_FORMAT_ALIASES,
                );
                const wideFormatTokens = wideFormat.tokens;
                const wideReferences = wideFormat.references;
                const compactReferences = compactFormat.references;
                const colorSource = config.components.footer.colorSource;
                const requestedHostNames = new Set(
                    [...wideReferences, ...compactReferences].filter(
                        (name) =>
                            isHostTemplateVariable(name) &&
                            !Object.hasOwn(aliases, name) &&
                            !builtinSnapshots.has(name),
                    ),
                );
                if (requestedHostNames.size) {
                    const hostValues = hooks.getHostTemplateValues?.(requestedHostNames);
                    for (const name of requestedHostNames) {
                        if (!isHostTemplateVariable(name)) continue;
                        const text = sanitizeEditorMetadataText(hostValues?.[name] ?? "");
                        builtinSnapshots.set(
                            name,
                            text
                                ? renderStyleForSource(
                                      theme,
                                      colorSource,
                                      liveMetadataColor(config, "footer", name) ??
                                          componentColor(config, "footer", "extensionStatus"),
                                      text,
                                  )
                                : "",
                        );
                    }
                }
                const iconMode = config.icons.effectiveMode;
                const pathDisplay = config.components.footer.styles.starship.pathDisplay;
                const formattedCwd = sanitizeEditorMetadataText(
                    formatCwdLabel(ctx.cwd, config.icons.cwd, {
                        mode: pathDisplay.mode,
                        depth: pathDisplay.depth,
                        repositoryRoot:
                            pathDisplay.mode === "repository"
                                ? hooks.getRepositoryRoot?.(ctx.cwd)
                                : undefined,
                    }),
                );
                const branch = sanitizeEditorMetadataText(state.branch ?? "") || undefined;
                const gitStateLabel = sanitizeEditorMetadataText(state.gitStateLabel ?? "");
                const commit = state.commit
                    ? {
                          ...state.commit,
                          oid: state.commit.oid
                              ? sanitizeEditorMetadataText(state.commit.oid) || null
                              : null,
                          tag: state.commit.tag
                              ? sanitizeEditorMetadataText(state.commit.tag) || null
                              : null,
                      }
                    : undefined;
                const separator = renderStyleForSource(
                    theme,
                    colorSource,
                    componentColor(config, "footer", "separator"),
                    separatorText[config.components.footer.styles.starship.separator],
                );
                const innerWidth = Math.max(1, width - 2);
                const cwdLabel = renderStyleForSource(
                    theme,
                    colorSource,
                    componentColor(config, "footer", "cwd"),
                    formattedCwd,
                );
                const needsSessionName =
                    (config.components.footer.styles.starship.format
                        ? wideReferences.includes("session_name")
                        : config.components.footer.styles.starship.segments.sessionName) ||
                    compactReferences.includes("session_name");
                const sessionName =
                    needsSessionName && !builtinSnapshots.has("session_name")
                        ? sanitizeEditorMetadataText(ctx.sessionManager.getSessionName() ?? "")
                        : "";
                const sessionNameLabel =
                    builtinSnapshots.get("session_name") ??
                    (sessionName
                        ? renderStyleForSource(
                              theme,
                              colorSource,
                              componentColor(config, "footer", "sessionName"),
                              sessionName,
                          )
                        : "");
                if (needsSessionName) builtinSnapshots.set("session_name", sessionNameLabel);
                const builtInSessionNameLabel = sessionNameLabel ? `in ${sessionNameLabel}` : "";
                const branchText = branch
                    ? formatGitBranchText(
                          branch,
                          config.components.footer.styles.starship.gitBranch.maxLength,
                      )
                    : undefined;
                const needsContext =
                    (config.components.footer.styles.starship.format
                        ? wideReferences.includes("context")
                        : config.components.footer.styles.starship.segments.context) ||
                    compactReferences.includes("context") ||
                    (state.autoCompaction &&
                        (wideReferences.includes("auto_compaction") ||
                            compactReferences.includes("auto_compaction")));
                // Reuse only within this render, including resolved unknown usage.
                const context =
                    contextSnapshot ??
                    (needsContext
                        ? resolveContextUsage(ctx, hooks.getLiveContext?.())
                        : { percent: undefined, contextWindow: undefined });
                const { percent: contextPercent, contextWindow } = context;
                const contextLabel = buildContextDisplayLabel({
                    percent: contextPercent,
                    contextWindow,
                    style: config.components.footer.styles.starship.contextStyle,
                    asciiGauge: iconMode === "ascii",
                });
                const tier = contextColorTier(
                    contextPercent,
                    config.components.footer.styles.starship.contextThresholds,
                );
                const contextColor =
                    tier === "error"
                        ? componentColor(config, "footer", "contextError")
                        : tier === "warning"
                          ? componentColor(config, "footer", "contextWarning")
                          : componentColor(config, "footer", "contextNormal");
                const cacheReadLabel = state.cacheReadLabel
                    ? renderStyleForSource(
                          theme,
                          colorSource,
                          componentColor(config, "footer", "tokens"),
                          state.cacheReadLabel,
                      )
                    : "";
                const cacheWriteLabel = state.cacheWriteLabel
                    ? renderStyleForSource(
                          theme,
                          colorSource,
                          componentColor(config, "footer", "tokens"),
                          state.cacheWriteLabel,
                      )
                    : "";
                const subscriptionLabel = state.subscription
                    ? renderStyleForSource(
                          theme,
                          colorSource,
                          componentColor(config, "footer", "cost"),
                          "(sub)",
                      )
                    : "";
                const autoCompactionLabel = state.autoCompaction
                    ? renderStyleForSource(theme, colorSource, contextColor, "(auto)")
                    : "";
                const gitColor = (text: string) =>
                    renderStyleForSource(
                        theme,
                        colorSource,
                        componentColor(config, "footer", "gitBranch"),
                        text,
                    );
                const gitStatusColor = (text: string) =>
                    renderStyleForSource(
                        theme,
                        colorSource,
                        componentColor(config, "footer", "gitStatus"),
                        text,
                    );
                const gitIcon = config.icons.git ? gitColor(config.icons.git) : "";
                const gitCounts = config.components.footer.styles.starship.segments.gitCounts;
                const stashLabel =
                    state.stashed > 0
                        ? gitCounts
                            ? `${config.icons.stashed}${state.stashed}`
                            : config.icons.stashed
                        : "";
                const allStatus = [
                    state.conflicted > 0 ? config.icons.conflicted : "",
                    stashLabel,
                    state.deleted > 0 ? config.icons.deleted : "",
                    state.renamed > 0 ? config.icons.renamed : "",
                    state.modified > 0 ? config.icons.modified : "",
                    state.typechanged > 0 ? config.icons.typechanged : "",
                    state.staged > 0 ? config.icons.staged : "",
                    state.untracked > 0 ? config.icons.untracked : "",
                ].join("");
                const aheadBehind = (() => {
                    if (state.ahead > 0 && state.behind > 0) {
                        return gitCounts
                            ? `${config.icons.ahead}${state.ahead}${config.icons.behind}${state.behind}`
                            : config.icons.diverged;
                    }
                    if (state.ahead > 0)
                        return gitCounts
                            ? `${config.icons.ahead}${state.ahead}`
                            : config.icons.ahead;
                    if (state.behind > 0)
                        return gitCounts
                            ? `${config.icons.behind}${state.behind}`
                            : config.icons.behind;
                    return "";
                })();
                const statusBlock =
                    allStatus || aheadBehind ? gitStatusColor(`[${allStatus}${aheadBehind}]`) : "";
                const gitStateBlock = gitStateLabel ? gitStatusColor(gitStateLabel) : "";
                const renderBuiltInVariable = (name: string): string => {
                    const canonical = FOOTER_FORMAT_ALIASES[name] ?? name;
                    if (isHostTemplateVariable(canonical))
                        return builtinSnapshots.get(canonical) ?? "";
                    switch (canonical) {
                        case "cwd":
                            return cwdLabel;
                        case "session_name":
                            return sessionNameLabel;
                        case "git_branch":
                            return branchText
                                ? gitIcon
                                    ? `${gitIcon} ${gitColor(branchText)}`
                                    : gitColor(branchText)
                                : "";
                        case "git_status":
                            return statusBlock;
                        case "git_state":
                            return gitStateBlock;
                        case "model":
                            return sanitizeEditorMetadataText(footerModelLabel);
                        case "provider":
                            return sanitizeEditorMetadataText(state.providerLabel);
                        case "thinkingLevel": {
                            const level = sanitizeEditorMetadataText(
                                hooks.getThinkingLevel?.() ?? "",
                            );
                            return level.toLowerCase() === "off" ? "" : level;
                        }
                        case "fast_mode":
                            return sanitizeEditorMetadataText(hooks.getFastMode?.() ?? "");
                        case "session_duration":
                            return state.sessionStartEpoch
                                ? renderStyleForSource(
                                      theme,
                                      colorSource,
                                      componentColor(config, "footer", "sessionDuration"),
                                      buildSessionDurationLabel(state.sessionStartEpoch),
                                  )
                                : "";
                        case "username":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                componentColor(config, "footer", "username"),
                                formatUsernameHostLabel(config.icons.username),
                            );
                        case "os":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                componentColor(config, "footer", "os"),
                                formatOsLabel(
                                    config.icons.os,
                                    iconMode,
                                    process.platform,
                                    config.icons.osOverridden,
                                ),
                            );
                        case "time":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                componentColor(config, "footer", "time"),
                                formatTimeLabel(config.icons.time),
                            );
                        case "context":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                contextColor,
                                contextLabel,
                            );
                        case "tokens":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                componentColor(config, "footer", "tokens"),
                                state.tokenLabel,
                            );
                        case "cache_read":
                            return cacheReadLabel;
                        case "cache_write":
                            return cacheWriteLabel;
                        case "cost":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                componentColor(config, "footer", "cost"),
                                state.costLabel,
                            );
                        case "subscription":
                            return subscriptionLabel;
                        case "auto_compaction":
                            return autoCompactionLabel;
                        case "sep":
                            return renderStyleForSource(
                                theme,
                                colorSource,
                                componentColor(config, "footer", "separator"),
                                " | ",
                            );
                        case "git_commit":
                            return formatGitCommitSegment(
                                theme,
                                commit,
                                config.components.footer.styles.starship.gitCommit,
                                colorSource,
                                componentColor(config, "footer", "gitCommit"),
                            );
                        case "git_tag":
                            return config.components.footer.styles.starship.gitCommit.showTag &&
                                commit?.tag
                                ? renderStyleForSource(
                                      theme,
                                      colorSource,
                                      componentColor(config, "footer", "gitCommit"),
                                      commit.tag,
                                  )
                                : "";
                        case "git_metrics":
                            return formatGitMetricsSegment(
                                theme,
                                state.metrics,
                                config.components.footer.styles.starship.gitMetrics,
                                colorSource,
                                componentColor(config, "footer", "gitMetricsAdded"),
                                componentColor(config, "footer", "gitMetricsDeleted"),
                            );
                        case "git_added":
                            return state.metrics
                                ? renderStyleForSource(
                                      theme,
                                      colorSource,
                                      componentColor(config, "footer", "gitMetricsAdded"),
                                      `+${state.metrics.added}`,
                                  )
                                : "";
                        case "git_deleted":
                            return state.metrics
                                ? renderStyleForSource(
                                      theme,
                                      colorSource,
                                      componentColor(config, "footer", "gitMetricsDeleted"),
                                      `−${state.metrics.deleted}`,
                                  )
                                : "";
                        default:
                            return "";
                    }
                };
                // Reserve actual referenced builtin output, not just static state. Reuse the
                // same values during scans, packing and fallback so callbacks cannot collide later.
                const builtinNames = new Set<string>(FOOTER_FORMAT_VARIABLES);
                for (const name of new Set([...wideReferences, ...compactReferences])) {
                    if (builtinNames.has(name) && !builtinSnapshots.has(name))
                        builtinSnapshots.set(name, renderBuiltInVariable(name));
                }
                const renderVariable = (name: string): string => {
                    const canonical = FOOTER_FORMAT_ALIASES[name] ?? name;
                    if (Object.hasOwn(aliases, name)) return atomicCustom.resolve(aliases[name]);
                    if (builtinSnapshots.has(canonical))
                        return builtinSnapshots.get(canonical) ?? "";
                    return renderBuiltInVariable(name);
                };
                const branchParts: string[] = [];
                if (config.components.footer.styles.starship.segments.gitBranch) {
                    if (branchText) {
                        branchParts.push("on", gitIcon, gitColor(branchText));
                    } else if (commit?.detached) {
                        // `HEAD` uses git-branch style; `(hash)` uses git-commit style
                        // (bold green) per Starship `git_commit` format.
                        branchParts.push("on", gitIcon, gitColor("HEAD"));
                        if (
                            config.components.footer.styles.starship.segments.gitCommit &&
                            commit.oid
                        ) {
                            const shortHash = commit.oid.slice(
                                0,
                                config.components.footer.styles.starship.gitCommit.hashLength,
                            );
                            const tag =
                                config.components.footer.styles.starship.gitCommit.showTag &&
                                commit.tag
                                    ? commit.tag
                                    : "";
                            const inner = [shortHash, tag].filter(Boolean).join(" ");
                            branchParts.push(
                                renderStyleForSource(
                                    theme,
                                    colorSource,
                                    componentColor(config, "footer", "gitCommit"),
                                    `(${inner})`,
                                ),
                            );
                        }
                    }
                }
                const gitStatusParts =
                    config.components.footer.styles.starship.segments.gitStatus && statusBlock
                        ? [statusBlock]
                        : [];
                const showGitState =
                    config.components.footer.styles.starship.segments.gitBranch ||
                    config.components.footer.styles.starship.segments.gitStatus;
                const gitStateParts = showGitState && gitStateBlock ? [gitStateBlock] : [];
                const branchLabel = [...branchParts, ...gitStatusParts, ...gitStateParts]
                    .filter(Boolean)
                    .join(" ");
                // Skip standalone gitCommit when hash is already folded into the
                // branch display on detached HEAD.
                const hashFoldedIntoBranch =
                    commit?.detached && config.components.footer.styles.starship.segments.gitBranch;
                const gitCommitLabel =
                    config.components.footer.styles.starship.segments.gitCommit &&
                    !hashFoldedIntoBranch
                        ? formatGitCommitSegment(
                              theme,
                              commit,
                              config.components.footer.styles.starship.gitCommit,
                              colorSource,
                              componentColor(config, "footer", "gitCommit"),
                          )
                        : "";
                const gitMetricsLabel = config.components.footer.styles.starship.segments.gitMetrics
                    ? formatGitMetricsSegment(
                          theme,
                          state.metrics,
                          config.components.footer.styles.starship.gitMetrics,
                          colorSource,
                          componentColor(config, "footer", "gitMetricsAdded"),
                          componentColor(config, "footer", "gitMetricsDeleted"),
                      )
                    : "";

                const sessionDurationSegment = (() => {
                    if (
                        !config.components.footer.styles.starship.segments.sessionDuration ||
                        !state.sessionStartEpoch
                    )
                        return "";
                    const timeLabel = buildSessionDurationLabel(state.sessionStartEpoch);
                    const prefix = renderStyleForSource(theme, colorSource, "", "up for");
                    const time = renderStyleForSource(
                        theme,
                        colorSource,
                        componentColor(config, "footer", "sessionDuration"),
                        timeLabel,
                    );
                    return `${prefix} ${time}`;
                })();
                const usernameSegment = config.components.footer.styles.starship.segments.username
                    ? renderStyleForSource(
                          theme,
                          colorSource,
                          componentColor(config, "footer", "username"),
                          formatUsernameHostLabel(config.icons.username),
                      )
                    : "";
                const osSegment = config.components.footer.styles.starship.segments.os
                    ? renderStyleForSource(
                          theme,
                          colorSource,
                          componentColor(config, "footer", "os"),
                          formatOsLabel(
                              config.icons.os,
                              iconMode,
                              process.platform,
                              config.icons.osOverridden,
                          ),
                      )
                    : "";
                const left = [
                    osSegment,
                    usernameSegment,
                    config.components.footer.styles.starship.segments.cwd ? cwdLabel : "",
                    config.components.footer.styles.starship.segments.sessionName
                        ? builtInSessionNameLabel
                        : "",
                    branchLabel,
                    gitCommitLabel,
                    gitMetricsLabel,
                    sessionDurationSegment,
                ]
                    .filter(Boolean)
                    .join(" ");

                const modelInfoSegment = config.components.footer.styles.starship.segments.modelInfo
                    ? composeModelInfoLabel(
                          sanitizeEditorMetadataText(footerModelLabel),
                          sanitizeEditorMetadataText(state.providerLabel),
                      )
                    : "";
                const timeSegment = config.components.footer.styles.starship.segments.time
                    ? renderStyleForSource(
                          theme,
                          colorSource,
                          componentColor(config, "footer", "time"),
                          formatTimeLabel(config.icons.time),
                      )
                    : "";
                const builtInContextLabel = [
                    renderStyleForSource(theme, colorSource, contextColor, contextLabel),
                    autoCompactionLabel,
                ]
                    .filter(Boolean)
                    .join(" ");
                const builtInTokenLabel = [
                    renderStyleForSource(
                        theme,
                        colorSource,
                        componentColor(config, "footer", "tokens"),
                        state.tokenLabel,
                    ),
                    cacheReadLabel,
                    cacheWriteLabel,
                ]
                    .filter(Boolean)
                    .join(" ");
                const builtInCostLabel = [
                    renderStyleForSource(
                        theme,
                        colorSource,
                        componentColor(config, "footer", "cost"),
                        state.costLabel,
                    ),
                    subscriptionLabel,
                ]
                    .filter(Boolean)
                    .join(" ");
                const extensionLeftSegments: string[] = [];
                const extensionMiddleSegments: string[] = [];
                const extensionRightSegments: string[] = [];
                const rightParts = [
                    modelInfoSegment,
                    config.components.footer.styles.starship.segments.context
                        ? builtInContextLabel
                        : "",
                    config.components.footer.styles.starship.segments.tokens
                        ? builtInTokenLabel
                        : "",
                    config.components.footer.styles.starship.segments.cost ? builtInCostLabel : "",
                    timeSegment,
                ];
                const atomicCustom = new AtomicTemplateValues(
                    customTexts,
                    customTexts.size
                        ? [
                              JSON.stringify(state),
                              ctx.cwd,
                              JSON.stringify(config.icons),
                              footer.styles.starship.format,
                              footer.styles.starship.compactFormat,
                              ...builtinSnapshots.values(),
                              left,
                              separator,
                              ...rightParts,
                              ...extensionLeftSegments,
                              ...extensionMiddleSegments,
                              ...extensionRightSegments,
                          ]
                        : [],
                );
                const right = rightParts.filter(Boolean).join(separator);

                let contentLeft = left;
                let contentMiddle = "";
                let contentRight = right;
                if (config.components.footer.styles.starship.format) {
                    const {
                        left: fmtLeft,
                        middle: fmtMiddle,
                        right: fmtRight,
                    } = renderFormatSplit(wideFormatTokens, renderVariable);
                    contentLeft = stripOrphanSeparators(fmtLeft);
                    contentMiddle = stripOrphanSeparators(fmtMiddle);
                    contentRight = stripOrphanSeparators(fmtRight);
                }

                const middleSegments = contentMiddle
                    ? [contentMiddle, ...extensionMiddleSegments]
                    : extensionMiddleSegments;
                const renderLegacyContent = () =>
                    composeFooterContent(
                        contentLeft,
                        contentRight,
                        extensionLeftSegments,
                        middleSegments,
                        extensionRightSegments,
                        separator,
                        innerWidth,
                    );
                const frameRows = (
                    rows: string[],
                    source = [contentLeft, contentMiddle, contentRight],
                ) => {
                    const framedRows = rows.map((row) => {
                        const framed =
                            width > 2 ? ` ${truncateFooterText(row, width - 2, "")} ` : row;
                        return truncateFooterText(framed, width, "");
                    });

                    const omitted = atomicCustom.omitted(source, framedRows);
                    if (omitted.length)
                        return renderFooter(
                            width,
                            context,
                            new Set([...excludedCustom, ...omitted]),
                            builtinSnapshots,
                        );
                    return atomicCustom.restore(framedRows);
                };

                if (!config.components.footer.styles.starship.responsive)
                    return frameRows([renderLegacyContent()]);

                const fullZones = {
                    left: appendStatusArea(
                        contentLeft,
                        joinStatusTexts(extensionLeftSegments, separator),
                        separator,
                    ),
                    middle: appendStatusArea(
                        contentMiddle,
                        joinStatusTexts(extensionMiddleSegments, separator),
                        separator,
                    ),
                    right: prependStatusArea(
                        contentRight,
                        joinStatusTexts(extensionRightSegments, separator),
                        separator,
                    ),
                };
                if (fullFooterFitsAligned(fullZones, innerWidth)) {
                    return frameRows([renderLegacyContent()]);
                }

                const reflowed = reflowFullFooter(
                    fullZones,
                    innerWidth,
                    wideFormatTokens.some((token) => token.kind === "fill"),
                );
                if (reflowed) return frameRows(reflowed);

                const chunkBudget = compactChunkBudget(innerWidth);
                const compactCwdLabel = truncateFooterText(cwdLabel, chunkBudget, "…");
                const compactSessionNameLabel = truncateFooterText(
                    sessionNameLabel,
                    Math.max(1, chunkBudget - visibleWidth("in ")),
                    "…",
                );
                const compactBranchBudget = Math.max(
                    1,
                    chunkBudget -
                        visibleWidth("on ") -
                        (statusBlock ? visibleWidth(statusBlock) + 1 : 0),
                );
                const compactBranchLabel = truncateFooterText(
                    renderVariable("git_branch"),
                    compactBranchBudget,
                    "…",
                );
                const renderCompactVariable = (name: string): string => {
                    const canonical = FOOTER_FORMAT_ALIASES[name] ?? name;
                    switch (canonical) {
                        case "cwd":
                            return compactCwdLabel;
                        case "session_name":
                            return compactSessionNameLabel;
                        case "git_branch":
                            return compactBranchLabel;
                        default:
                            return renderVariable(name);
                    }
                };
                const renderCompactChunks = (
                    chunks: readonly CompiledCompactChunk[],
                ): CompactLayoutChunk[] => {
                    const compactChunks: CompactLayoutChunk[] = [];
                    for (const chunk of chunks) {
                        if (chunk.kind === "extensions") {
                            const statuses = [
                                ...extensionLeftSegments,
                                ...extensionMiddleSegments,
                                ...extensionRightSegments,
                            ];
                            for (const [index, text] of statuses.entries()) {
                                compactChunks.push({
                                    text,
                                    boundary: index === 0 ? chunk.boundary : "space",
                                });
                            }
                            continue;
                        }
                        let rendered = stripOrphanSeparators(
                            renderFormatTokens(chunk.tokens, renderCompactVariable),
                        );
                        const references = chunk.references;
                        if (
                            ["cwd", "session_name", "git_branch"].some((name) =>
                                references.includes(name),
                            )
                        ) {
                            rendered = truncateFooterText(rendered, chunkBudget, "…");
                        }
                        if (rendered)
                            compactChunks.push({ text: rendered, boundary: chunk.boundary });
                    }
                    return compactChunks;
                };
                const compact = compactFormat.compact;
                const compactLeft = renderCompactChunks(compact.left);
                const compactRight = renderCompactChunks(compact.right);
                return frameRows(
                    compact.alignRight
                        ? packCompactZones(
                              compactLeft,
                              compactRight,
                              innerWidth,
                              config.components.footer.styles.starship.compactMaxLines,
                              renderVariable("sep"),
                          )
                        : packCompactChunks(
                              compactLeft,
                              innerWidth,
                              config.components.footer.styles.starship.compactMaxLines,
                              renderVariable("sep"),
                          ),
                    [...compactLeft, ...compactRight].map((chunk) => chunk.text),
                );
            },
        };
    });
}
