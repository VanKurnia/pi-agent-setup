import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	defaultConfig,
	ensureConfigExists,
	FOOTER_FORMAT_ALIASES,
	loadConfig,
	type PolishedTuiConfig,
} from "./config.ts";
import {
	type EditorTransferFailureReason,
	replaceEditorComponentWithExpandedText,
} from "./editor-transfer.ts";
import { installFooter } from "./footer.ts";
import { compiledFooterFormat } from "./footer-format.ts";
import {
	buildSessionDurationLabel,
	EventUsageTotalsController,
	resolveContextUsage,
} from "./format.ts";
import { emptyGitStatus, readGitStatus } from "./git.ts";
import { LayeredEditorConsumer } from "./layered-editor.ts";
import { LiveContextController } from "./live-context.ts";
import { readPackageVersionResult } from "./package-version.ts";
import {
	createProjectRefreshScheduler,
	type ProjectRefreshRun,
	type ScheduleProjectRefreshOptions,
	type StopProjectRefreshInterval,
	startProjectRefreshInterval,
} from "./project-refresh.ts";
import { applyProjectRefreshToState, projectStateSnapshot } from "./project-state.ts";
import { ProjectDiscovery } from "./project-discovery.ts";
import { RepositoryRootController, type RepositoryRootRequest } from "./repository-root.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { installSelectorBorderStyle, removeSelectorBorderStyle } from "./selector-border.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import {
	createInitialState,
	type FooterState,
	modelLabelFor,
	syncModelState,
	syncState,
	syncUsageState,
} from "./state.ts";
import { FooterTelemetryController } from "./telemetry.ts";
import { editorWantsContext, PolishedEditor, WrappedPolishedEditor } from "./ui.ts";
import { installUserMessageStyle, removeUserMessageStyle } from "./user-message.ts";

const ZENTUI_EDITOR_FACTORY = Symbol.for("pi-zentui.editor-factory");
const ZENTUI_EDITOR_BASE_FACTORY = Symbol.for("pi-zentui.editor-base-factory");
const ZENTUI_EDITOR_OWNER = Symbol.for("pi-zentui.editor-owner");
const ZENTUI_FOOTER_OWNER = Symbol.for("pi-zentui.footer-owner");

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type ZentuiEditorFactory = EditorFactory & {
	[ZENTUI_EDITOR_FACTORY]?: true;
	[ZENTUI_EDITOR_BASE_FACTORY]?: EditorFactory;
	[ZENTUI_EDITOR_OWNER]?: symbol;
};

type EditorChangeResult = { ok: true } | { ok: false; reason: string };
type EditorInstallMode = "none" | "standalone" | "wrapper";

type ZentuiHost = {
	wrapEditor?: boolean;
	skinOnly?: boolean;
	liveModel?: boolean;
	getFastMode?: (ctx: ExtensionContext) => string | undefined;
};

function editorTransferFailureMessage(reason: EditorTransferFailureReason): string {
	switch (reason) {
		case "unsupported-transfer-api":
			return "this Pi version cannot safely transfer expanded editor text; reload Pi to apply this change";
		case "editor-factory-snapshot-failed":
			return "the current editor factory could not be read safely; reload Pi to apply this change";
		case "editor-text-snapshot-failed":
			return "expanded editor text could not be read safely; reload Pi to apply this change";
		case "editor-text-preparation-failed":
			return "expanded editor text could not be prepared safely; reload Pi to apply this change";
		case "editor-replacement-failed-with-rollback":
			return "the editor replacement failed; the previous factory was reapplied, but editor instance identity is not guaranteed";
		case "editor-replacement-rollback-failed":
			return "the editor replacement and previous-factory rollback both failed; reload Pi before editing";
	}
}

function isZentuiEditorFactory(factory: EditorFactory | undefined): boolean {
	return Boolean((factory as ZentuiEditorFactory | undefined)?.[ZENTUI_EDITOR_FACTORY]);
}

function getZentuiEditorBaseFactory(factory: EditorFactory | undefined): EditorFactory | undefined {
	return (factory as ZentuiEditorFactory | undefined)?.[ZENTUI_EDITOR_BASE_FACTORY];
}

/** Names the configured footer can actually render, wide and responsive formats included. */
function activeFooterReferences(config: PolishedTuiConfig): Set<string> {
	const starship = config.components.footer.styles.starship;
	const references = starship.format
		? new Set(compiledFooterFormat(starship.format, FOOTER_FORMAT_ALIASES).references)
		: new Set<string>([
				...(starship.segments.cwd ? ["cwd"] : []),
				...(starship.segments.gitBranch ? ["git_branch"] : []),
				...(starship.segments.gitStatus ? ["git_status"] : []),
				...(starship.segments.sessionName ? ["session_name"] : []),
				...(starship.segments.runtime ? ["runtime"] : []),
				...(starship.segments.sessionDuration ? ["session_duration"] : []),
				...(starship.segments.time ? ["time"] : []),
				...(starship.segments.cost ? ["cost"] : []),
				...(starship.segments.tokens ? ["tokens"] : []),
				...(starship.segments.context ? ["auto_compaction"] : []),
			]);
	if (starship.responsive) {
		for (const name of compiledFooterFormat(starship.compactFormat, FOOTER_FORMAT_ALIASES)
			.references) {
			references.add(name);
		}
	}
	return references;
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI, host: ZentuiHost = {}) {
	const state: FooterState = createInitialState(emptyGitStatus());
	const sessionLifecycle = new SessionLifecycle();
	const editorOwnerToken = Symbol("zentui-editor-owner");

	const scopeConfig = (config: PolishedTuiConfig): PolishedTuiConfig =>
		host.skinOnly
			? {
					...config,
					components: {
						...config.components,
						selectorBorders: { ...config.components.selectorBorders, enabled: false },
					},
				}
			: config;
	let currentConfig: PolishedTuiConfig = scopeConfig(structuredClone(defaultConfig));

	let activeTheme: Theme | undefined;
	let requestFooterRender: (() => void) | undefined;
	let requestEditorRender: (() => void) | undefined;
	let stopRefreshInterval: StopProjectRefreshInterval = () => {};
	let cleanupUserMessageStyle: () => void = () => {};
	let userMessageStyleInstalled = false;
	let cleanupSelectorBorderStyle: () => void = () => {};
	let selectorBorderStyleInstalled = false;
	let installedFooterToken: symbol | undefined;
	let editorInstalled = false;
	let editorInstallMode: EditorInstallMode = "none";
	let installedEditorFactory: EditorFactory | undefined;
	let activeEditor:
		| {
				editor: PolishedEditor | WrappedPolishedEditor;
				factory: EditorFactory;
				generation: number;
		  }
		| undefined;
	let wrappedEditorFactory: EditorFactory | undefined;
	let stopSessionTimer: () => void = () => {};
	let sessionTimerRequirements = "";
	let lastDurationLabel = "";
	let lastProjectCwd: string | undefined;
	const repositoryRoots = new RepositoryRootController();
	let projectRefreshActive = false;
	let activeTuiContext: ExtensionContext | undefined;

	const isOwnedEditorFactory = (factory: EditorFactory | undefined) =>
		(factory as ZentuiEditorFactory | undefined)?.[ZENTUI_EDITOR_OWNER] === editorOwnerToken;
	const effectiveEditorEnabled = () => currentConfig.components.editor.enabled;
	const effectiveUserMessagesEnabled = () => currentConfig.components.userMessages.enabled;
	const effectiveSelectorBordersEnabled = () =>
		currentConfig.components.selectorBorders.enabled;
	const effectiveFooterStyle = () => currentConfig.components.footer.style;

	const ownsInstalledEditorFactory = () => {
		if (
			!sessionLifecycle.isCurrent() ||
			!editorInstalled ||
			!installedEditorFactory ||
			!activeTuiContext
		) {
			return false;
		}
		try {
			return (
				isOwnedEditorFactory(installedEditorFactory) &&
				activeTuiContext.ui.getEditorComponent() === installedEditorFactory
			);
		} catch {
			return false;
		}
	};

	const layeredEditor = new LayeredEditorConsumer<
		EditorFactory,
		PolishedEditor | WrappedPolishedEditor
	>((generation) => sessionLifecycle.isCurrent(generation));
	const currentEditorFactory = (): EditorFactory | undefined => {
		try {
			return activeTuiContext?.ui.getEditorComponent();
		} catch {
			return undefined;
		}
	};
	const requestEditorRepaint = () => {
		requestEditorRender?.();
		if (effectiveEditorEnabled()) layeredEditor.requestRender(currentEditorFactory());
	};

	const getActiveTheme = () => activeTheme;
	const liveContext = new LiveContextController(sessionLifecycle, () => {
		requestEditorRepaint();
		requestFooterRender?.();
	});
	const getCurrentConfig = () => currentConfig;
	const getEditorContextMetadata = (ctx: ExtensionContext) => {
		const context = editorWantsContext(currentConfig)
			? resolveContextUsage(ctx, liveContext.get())
			: undefined;
		return { contextPercent: context?.percent, contextWindow: context?.contextWindow };
	};
	const getEditorMeta = (ctx: ExtensionContext) => {
		if (host.liveModel) syncModelState(state, ctx.model);
		return {
			modelLabel: modelLabelFor(state, currentConfig.components.editor.modelLabel),
			modelId: state.modelId,
			modelName: state.modelName,
			providerLabel: state.providerLabel,
			fastMode: host.getFastMode?.(ctx),
			sessionName: ctx.sessionManager.getSessionName() ?? "",
			...getEditorContextMetadata(ctx),
			inputTokens: state.usageTotals.input,
			outputTokens: state.usageTotals.output,
			cacheHitRate: state.usageTotals.latestCacheHitRate,
		};
	};
	const getThinkingLevel = () =>
		sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : ("off" as const);

	const footerTelemetry = new FooterTelemetryController();
	const footerReferences = () => activeFooterReferences(currentConfig);
	const getFooterTelemetry = (ctx: ExtensionContext) =>
		footerTelemetry.resolve(ctx, {
			subscription: footerReferences().has("subscription"),
			autoCompaction: footerReferences().has("auto_compaction"),
		});
	const syncFooterTelemetry = (ctx: ExtensionContext) => {
		const telemetry = getFooterTelemetry(ctx);
		state.subscription = telemetry.subscription === true;
		state.autoCompaction = telemetry.autoCompaction === true;
	};
	const usageTotals = new EventUsageTotalsController();
	const getFooterUsage = (ctx: ExtensionContext) =>
		usageTotals.resolve(
			ctx,
			["tokens", "cache_read", "cache_write", "cost"].some((name) =>
				footerReferences().has(name),
			),
		);
	const syncFooterUsage = (ctx: ExtensionContext) =>
		syncUsageState(state, getFooterUsage(ctx), currentConfig.icons.cacheHit);
	const syncFooterState = (ctx: ExtensionContext) =>
		syncState(state, ctx, currentConfig.icons.cacheHit, getFooterTelemetry(ctx), {
			includeContextLabel: false,
			usageTotals: getFooterUsage(ctx),
		});

	const ownsInstalledFooter = () =>
		Boolean(
			activeTuiContext &&
				installedFooterToken &&
				ctxFooterOwner(activeTuiContext) === installedFooterToken,
		);
	const installedFooterReferences = () =>
		installedFooterToken && ownsInstalledFooter() ? footerReferences() : new Set<string>();

	type ProjectRefreshTarget = {
		repository: RepositoryRootRequest;
		sessionGeneration: number;
	};
	const refreshProjectState = async (
		{ repository, sessionGeneration }: ProjectRefreshTarget,
		run: ProjectRefreshRun,
	) => {
		const { cwd } = repository;
		if (
			!run.isCurrent() ||
			!sessionLifecycle.isCurrent(sessionGeneration) ||
			!repositoryRoots.isCurrent(repository)
		) {
			return false;
		}
		const discovery = new ProjectDiscovery(cwd);
		const [git, runtime, packageVersion] = await Promise.all([
			readGitStatus(cwd, { readStash: false, readOperationState: true }),
			readRuntimeInfo(cwd, discovery),
			readPackageVersionResult(cwd, discovery),
		]);
		const previous = projectStateSnapshot(state, lastProjectCwd, undefined);
		lastProjectCwd = applyProjectRefreshToState(state, {
			cwd,
			previousCwd: lastProjectCwd,
			git,
			runtime,
			packageVersion,
		});
		return previous !== projectStateSnapshot(state, lastProjectCwd, undefined);
	};

	const projectRefreshScheduler = createProjectRefreshScheduler(refreshProjectState, () => {
		if (sessionLifecycle.isCurrent()) {
			requestEditorRepaint();
			requestFooterRender?.();
		}
	});
	const scheduleProjectRefresh = (
		ctx: ExtensionContext,
		options?: ScheduleProjectRefreshOptions,
	) => {
		const sessionGeneration = sessionLifecycle.currentGeneration();
		if (!sessionLifecycle.isCurrent(sessionGeneration)) return;
		projectRefreshScheduler.schedule(
			{ repository: repositoryRoots.request(ctx.cwd), sessionGeneration },
			options,
		);
	};
	const stopProjectRefresh = () => {
		stopRefreshInterval();
		stopRefreshInterval = () => {};
		projectRefreshScheduler.stop();
		projectRefreshActive = false;
		Object.assign(state, emptyGitStatus());
		state.runtime = undefined;
		state.packageVersion = undefined;
		lastProjectCwd = undefined;
		repositoryRoots.reset();
	};
	const reconcileProjectRefresh = (ctx: ExtensionContext, force = false) => {
		if (!sessionLifecycle.isCurrent()) {
			stopProjectRefresh();
			return;
		}
		const activated = !projectRefreshActive;
		if (activated) {
			stopRefreshInterval = startProjectRefreshInterval(currentConfig.projectRefreshIntervalMs, () =>
				scheduleProjectRefresh(ctx),
			);
			projectRefreshActive = true;
		}
		if (force && !activated) projectRefreshScheduler.invalidate();
		if (force || activated) scheduleProjectRefresh(ctx, { force: true });
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (activeTuiContext?.ui === ctx.ui) activeTuiContext = ctx;
		if (editorInstalled && !ownsInstalledEditorFactory()) reconcileObservedEditorOwnership(ctx);
		syncFooterState(ctx);
		if (project) scheduleProjectRefresh(ctx);
		requestEditorRepaint();
		requestFooterRender?.();
	};

	const reconcileSessionTimer = () => {
		const references = installedFooterReferences();
		const needsTime = references.has("time");
		const needsDuration = references.has("session_duration");
		const nextRequirements = needsTime || needsDuration ? `${needsTime}:${needsDuration}` : "";
		if (
			!sessionLifecycle.isCurrent() ||
			!ownsInstalledFooter() ||
			!nextRequirements
		) {
			stopSessionTimer();
			sessionTimerRequirements = "";
			lastDurationLabel = "";
			return;
		}
		if (sessionTimerRequirements === nextRequirements) return;
		stopSessionTimer();
		sessionTimerRequirements = nextRequirements;
		lastDurationLabel = "";
		const timer = setInterval(() => {
			if (!sessionLifecycle.isCurrent()) return;
			if (needsTime) {
				requestFooterRender?.();
				return;
			}
			const label = state.sessionStartEpoch
				? buildSessionDurationLabel(state.sessionStartEpoch)
				: "";
			if (label === lastDurationLabel) return;
			lastDurationLabel = label;
			requestFooterRender?.();
		}, 1000);
		stopSessionTimer = () => {
			clearInterval(timer);
			sessionTimerRequirements = "";
			stopSessionTimer = () => {};
		};
	};

	const installUserMessages = () => {
		if (userMessageStyleInstalled) return;
		let cleanup: (() => void) | undefined;
		try {
			cleanup = installUserMessageStyle(getActiveTheme, getCurrentConfig);
			cleanupUserMessageStyle = cleanup;
			userMessageStyleInstalled = true;
		} catch {
			try {
				cleanup?.();
			} catch {
				// Best effort: the installer is locally transactional.
			}
			cleanupUserMessageStyle = () => {};
			userMessageStyleInstalled = false;
		}
	};

	const uninstallUserMessages = () => {
		try {
			cleanupUserMessageStyle();
		} catch {
			// Best effort cleanup.
		} finally {
			cleanupUserMessageStyle = () => {};
			userMessageStyleInstalled = false;
		}
	};

	const reconcileUserMessages = () => {
		if (effectiveUserMessagesEnabled()) installUserMessages();
		else uninstallUserMessages();
	};

	const installSelectorBorders = () => {
		if (selectorBorderStyleInstalled) return;
		let cleanup: (() => void) | undefined;
		try {
			cleanup = installSelectorBorderStyle(getActiveTheme, getCurrentConfig);
			cleanupSelectorBorderStyle = cleanup;
			selectorBorderStyleInstalled = true;
		} catch {
			try {
				cleanup?.();
			} catch {
				// Best effort: the installer is locally transactional.
			}
			cleanupSelectorBorderStyle = () => {};
			selectorBorderStyleInstalled = false;
		}
	};

	const uninstallSelectorBorders = () => {
		try {
			cleanupSelectorBorderStyle();
		} catch {
			// Best effort cleanup.
		} finally {
			cleanupSelectorBorderStyle = () => {};
			selectorBorderStyleInstalled = false;
		}
	};

	const reconcileSelectorBorders = () => {
		if (effectiveSelectorBordersEnabled()) installSelectorBorders();
		else uninstallSelectorBorders();
	};

	const clearEditorOwnership = () => {
		activeEditor = undefined;
		requestEditorRender = undefined;
		wrappedEditorFactory = undefined;
		installedEditorFactory = undefined;
		editorInstallMode = "none";
		editorInstalled = false;
	};

	const trackZentuiEditorFactory = (factory: EditorFactory): boolean => {
		if (!isOwnedEditorFactory(factory)) return false;
		if (activeEditor?.factory !== factory) activeEditor = undefined;
		const baseFactory = getZentuiEditorBaseFactory(factory);
		wrappedEditorFactory = baseFactory;
		installedEditorFactory = factory;
		editorInstallMode = baseFactory && host.wrapEditor !== false ? "wrapper" : "standalone";
		editorInstalled = true;
		return true;
	};

	const observeEditorFactory = (
		ctx: ExtensionContext,
	): { known: true; factory: EditorFactory | undefined } | { known: false } => {
		try {
			return { known: true, factory: ctx.ui.getEditorComponent() };
		} catch {
			return { known: false };
		}
	};

	const reconcileObservedEditorOwnership = (ctx: ExtensionContext) => {
		const observed = observeEditorFactory(ctx);
		if (!observed.known) {
			activeEditor = undefined;
			return observed;
		}
		if (observed.factory && isOwnedEditorFactory(observed.factory)) {
			trackZentuiEditorFactory(observed.factory);
		} else {
			clearEditorOwnership();
			reconcileProjectRefresh(ctx);
		}
		return observed;
	};

	const registerConstructedEditor = (
		ctx: ExtensionContext,
		factory: ZentuiEditorFactory,
		generation: number,
		editor: PolishedEditor | WrappedPolishedEditor,
		tui: TUI,
	) => {
		const observed = observeEditorFactory(ctx);
		if (
			!sessionLifecycle.isCurrent(generation) ||
			activeTuiContext?.ui !== ctx.ui ||
			!observed.known
		) {
			return;
		}
		if (observed.factory === factory) {
			activeEditor = { editor, factory, generation };
			requestEditorRender = () => tui.requestRender();
		} else if (observed.factory && !isZentuiEditorFactory(observed.factory)) {
			layeredEditor.attach(observed.factory, generation, editor, () => tui.requestRender());
		}
	};

	const makeEditorFactory = (
		ctx: ExtensionContext,
		baseFactory: EditorFactory | undefined,
	): ZentuiEditorFactory => {
		const sessionTheme = ctx.ui.theme;
		const generation = sessionLifecycle.currentGeneration();
		const factory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const editor: PolishedEditor = new PolishedEditor(
				tui,
				theme,
				keybindings,
				sessionTheme,
				getCurrentConfig,
				() => getEditorMeta(activeTuiContext ?? ctx),
				getThinkingLevel,
			);
			registerConstructedEditor(ctx, factory, generation, editor, tui);
			return editor;
		}) as ZentuiEditorFactory;
		factory[ZENTUI_EDITOR_FACTORY] = true;
		factory[ZENTUI_EDITOR_OWNER] = editorOwnerToken;
		factory[ZENTUI_EDITOR_BASE_FACTORY] = baseFactory;
		return factory;
	};

	const makeWrappedEditorFactory = (
		ctx: ExtensionContext,
		baseFactory: EditorFactory,
	): ZentuiEditorFactory => {
		const sessionTheme = ctx.ui.theme;
		const generation = sessionLifecycle.currentGeneration();
		const factory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const editor: WrappedPolishedEditor = new WrappedPolishedEditor(
				baseFactory(tui, theme, keybindings),
				sessionTheme,
				getCurrentConfig,
				() => getEditorMeta(activeTuiContext ?? ctx),
				getThinkingLevel,
			);
			registerConstructedEditor(ctx, factory, generation, editor, tui);
			return editor;
		}) as ZentuiEditorFactory;
		factory[ZENTUI_EDITOR_FACTORY] = true;
		factory[ZENTUI_EDITOR_OWNER] = editorOwnerToken;
		factory[ZENTUI_EDITOR_BASE_FACTORY] = baseFactory;
		return factory;
	};

	const replaceEditor = (
		ctx: ExtensionContext,
		factory: EditorFactory | undefined,
	): EditorChangeResult => {
		const result = replaceEditorComponentWithExpandedText(ctx.ui, factory);
		return result.ok ? result : { ok: false, reason: editorTransferFailureMessage(result.reason) };
	};

	const installEditor = (ctx: ExtensionContext): EditorChangeResult => {
		const currentFactory = ctx.ui.getEditorComponent();
		if (currentFactory && currentFactory === installedEditorFactory) {
			editorInstalled = true;
			return { ok: true };
		}

		const currentZentuiBaseFactory = getZentuiEditorBaseFactory(currentFactory);
		const baseFactory =
			currentZentuiBaseFactory ??
			(currentFactory && !isZentuiEditorFactory(currentFactory) ? currentFactory : undefined);
		const nextFactory =
			baseFactory && host.wrapEditor !== false
				? makeWrappedEditorFactory(ctx, baseFactory)
				: makeEditorFactory(ctx, baseFactory);
		const replacement = replaceEditor(ctx, nextFactory);
		if (!replacement.ok) return replacement;

		trackZentuiEditorFactory(nextFactory);
		return { ok: true };
	};

	const uninstallEditor = (
		ctx: ExtensionContext,
		options: { allowStaleZentui?: boolean } = {},
	): EditorChangeResult => {
		const observed = observeEditorFactory(ctx);
		if (!observed.known) {
			return {
				ok: false,
				reason:
					"the current editor factory could not be observed safely; reload Pi to apply this change",
			};
		}
		const currentFactory = observed.factory;
		if (!currentFactory || !isZentuiEditorFactory(currentFactory)) {
			clearEditorOwnership();
			return { ok: true };
		}
		if (!isOwnedEditorFactory(currentFactory) && !options.allowStaleZentui) {
			clearEditorOwnership();
			return { ok: true };
		}

		const replacement = replaceEditor(
			ctx,
			getZentuiEditorBaseFactory(currentFactory) ??
				(editorInstallMode === "wrapper" && wrappedEditorFactory
					? wrappedEditorFactory
					: undefined),
		);
		if (!replacement.ok) return replacement;

		clearEditorOwnership();
		return { ok: true };
	};

	const ctxFooterOwner = (ctx: ExtensionContext): unknown =>
		(ctx.ui as unknown as Record<PropertyKey, unknown>)[ZENTUI_FOOTER_OWNER];

	const setStatusLineOwnership = (ctx: ExtensionContext, token: symbol | undefined) => {
		const ui = ctx.ui as unknown as Record<PropertyKey, unknown>;
		try {
			if (token) ui[ZENTUI_FOOTER_OWNER] = token;
			else delete ui[ZENTUI_FOOTER_OWNER];
		} catch {
			// Failure to mark ownership intentionally prevents Native from restoring it.
		}
	};

	const ownsStatusLine = (ctx: ExtensionContext) =>
		installedFooterToken !== undefined && ctxFooterOwner(ctx) === installedFooterToken;

	const clearFooterOwnership = (ctx: ExtensionContext, token: symbol) => {
		if (installedFooterToken !== token) return;
		installedFooterToken = undefined;
		if (ctxFooterOwner(ctx) === token) setStatusLineOwnership(ctx, undefined);
		requestFooterRender = undefined;
		stopSessionTimer();
		if (sessionLifecycle.isCurrent()) reconcileProjectRefresh(ctx, true);
	};

	const installStatusLine = (ctx: ExtensionContext) => {
		if (installedFooterToken && ownsStatusLine(ctx)) return;
		const token = Symbol("zentui-starship-footer");
		const generation = sessionLifecycle.currentGeneration();
		installFooter(ctx, state, getCurrentConfig, {
			setRequestRender: (fn) => {
				requestFooterRender = fn;
			},
			scheduleProjectRefresh,
			onProjectChanged: () => {
				if (sessionLifecycle.isCurrent(generation) && ownsStatusLine(ctx))
					reconcileProjectRefresh(ctx, true);
			},
			getThinkingLevel,
			beforeRender: host.liveModel ? () => syncModelState(state, ctx.model) : undefined,
			getFastMode: () => host.getFastMode?.(ctx),
			getLiveContext: () => liveContext.get(),
			getRepositoryRoot: (cwd) => repositoryRoots.cachedRootForCwd(cwd),
			onDispose: () => clearFooterOwnership(ctx, token),
		});
		installedFooterToken = token;
		setStatusLineOwnership(ctx, token);
		syncFooterUsage(ctx);
		reconcileSessionTimer();
	};

	const uninstallStatusLine = (
		ctx: ExtensionContext,
		options: { forceLocalCleanup?: boolean } = {},
	) => {
		const ownedToken = ownsStatusLine(ctx) ? installedFooterToken : undefined;
		if (!ownedToken) return;
		try {
			ctx.ui.setFooter(undefined);
		} catch {
			// A live transition must preserve an owned Footer that Pi retained.
			if (!options.forceLocalCleanup) return;
		}
		clearFooterOwnership(ctx, ownedToken);
	};

	const reconcileFooter = (ctx: ExtensionContext) => {
		if (effectiveFooterStyle() === "starship") installStatusLine(ctx);
		else uninstallStatusLine(ctx);
		syncFooterTelemetry(ctx);
	};

	const reconcileEditor = (
		ctx: ExtensionContext,
		options: { allowStaleZentui?: boolean } = {},
	): EditorChangeResult | undefined => {
		try {
			if (effectiveEditorEnabled()) {
				const currentFactory = ctx.ui.getEditorComponent();
				if (
					isZentuiEditorFactory(currentFactory) &&
					!isOwnedEditorFactory(currentFactory) &&
					!options.allowStaleZentui
				) {
					clearEditorOwnership();
					return {
						ok: false,
						reason:
							"another Zentui instance is currently managing the editor; reload Pi to apply this change",
					};
				}
				const editorMissingOrReplaced = !editorInstalled || !isOwnedEditorFactory(currentFactory);
				if (editorMissingOrReplaced) return installEditor(ctx);
			} else {
				const currentFactory = ctx.ui.getEditorComponent();
				if (editorInstalled || isOwnedEditorFactory(currentFactory)) return uninstallEditor(ctx);
			}
		} catch {
			return {
				ok: false,
				reason: "the editor could not be reconciled safely; reload Pi to apply this change",
			};
		}
		return undefined;
	};

	const applyConfiguredUi = (ctx: ExtensionContext, options: { allowStaleZentui?: boolean } = {}) => {
		if (!isTuiContext(ctx)) return;
		activeTheme = ctx.ui.theme;
		reconcileEditor(ctx, options);
		reconcileUserMessages();
		reconcileSelectorBorders();
		reconcileFooter(ctx);
		reconcileProjectRefresh(ctx);
		reconcileSessionTimer();
		syncFooterUsage(ctx);
	};

	const installUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		activeTuiContext = ctx;
		activeTheme = ctx.ui.theme;
		const staleFooterOwner = ctxFooterOwner(ctx);
		if (typeof staleFooterOwner === "symbol") installedFooterToken = staleFooterOwner;
		ensureConfigExists();
		syncFooterState(ctx);
		stopProjectRefresh();

		uninstallUserMessages();
		uninstallSelectorBorders();
		try {
			removeUserMessageStyle();
		} catch {
			// Startup alone may supersede a stale registration from an earlier reload.
		}
		if (!host.skinOnly) {
			try {
				removeSelectorBorderStyle();
			} catch {
				// Startup alone may supersede a stale registration from an earlier reload.
			}
		}
		uninstallStatusLine(ctx);
		if (effectiveEditorEnabled()) clearEditorOwnership();
		else {
			try {
				uninstallEditor(ctx, { allowStaleZentui: true });
			} catch {
				// Reconciliation below retries observable stale ownership.
			}
		}

		applyConfiguredUi(ctx, { allowStaleZentui: true });
	};

	const scheduleEditorReconciliation = (ctx: ExtensionContext) => {
		sessionLifecycle.defer(() => {
			if (!isTuiContext(ctx) || !effectiveEditorEnabled()) return;
			const observed = observeEditorFactory(ctx);
			if (!observed.known) return;
			if (observed.factory !== installedEditorFactory && !isOwnedEditorFactory(observed.factory)) {
				clearEditorOwnership();
			} else if (observed.factory) trackZentuiEditorFactory(observed.factory);
			reconcileProjectRefresh(ctx);
			syncFooterUsage(ctx);
			requestEditorRepaint();
			requestFooterRender?.();
		});
	};

	const cleanupUi = (ctx?: ExtensionContext) => {
		if (!ctx || !sessionLifecycle.isCurrent()) return;
		sessionLifecycle.shutdown();
		activeEditor = undefined;
		layeredEditor.detach();
		stopSessionTimer();
		stopProjectRefresh();

		let retainedEditorOwnership = false;
		if (isTuiContext(ctx)) {
			uninstallStatusLine(ctx, { forceLocalCleanup: true });
			try {
				const before = observeEditorFactory(ctx);
				if (before.known) {
					const currentFactory = before.factory;
					if (currentFactory && isOwnedEditorFactory(currentFactory)) {
						replaceEditor(
							ctx,
							getZentuiEditorBaseFactory(currentFactory) ??
								(editorInstallMode === "wrapper" && wrappedEditorFactory
									? wrappedEditorFactory
									: undefined),
						);
					}
				}
				const after = observeEditorFactory(ctx);
				if (after.known && after.factory && isOwnedEditorFactory(after.factory)) {
					trackZentuiEditorFactory(after.factory);
					retainedEditorOwnership = true;
				}
			} catch {
				// Continue cleaning independent surfaces.
			}
		}
		if (!retainedEditorOwnership) clearEditorOwnership();
		uninstallUserMessages();
		uninstallSelectorBorders();
		installedFooterToken = undefined;
		requestFooterRender = undefined;
		requestEditorRender = undefined;
		activeTheme = undefined;
		activeTuiContext = undefined;
	};

	const syncInteractiveState = (_event: unknown, ctx: ExtensionContext) => {
		refreshInteractiveState(ctx);
	};
	const syncInteractiveAndProjectState = (_event: unknown, ctx: ExtensionContext) => {
		refreshInteractiveState(ctx, true);
	};
	const syncInteractiveAndProjectStateWithUsage = (_event: unknown, ctx: ExtensionContext) => {
		usageTotals.invalidate();
		refreshInteractiveState(ctx, true);
	};

	pi.on("session_start", async (_event, ctx) => {
		liveContext.clear();
		usageTotals.invalidate();
		footerTelemetry.reset();
		const lifecycleGeneration = sessionLifecycle.start();
		activeEditor = undefined;
		// Reload synchronously so the static config snapshot is used before any await.
		currentConfig = scopeConfig(loadConfig());
		if (!sessionLifecycle.isCurrent(lifecycleGeneration)) return;
		state.sessionStartEpoch = Date.now();
		lastProjectCwd = undefined;
		repositoryRoots.reset();
		installUi(ctx);
		scheduleEditorReconciliation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		usageTotals.invalidate();
		footerTelemetry.reset();
		liveContext.clear();
		cleanupUi(ctx);
	});

	pi.on("agent_start", (event, ctx) => {
		liveContext.clear();
		syncInteractiveState(event, ctx);
	});
	pi.on("turn_start", () => {
		liveContext.clear();
	});
	pi.on("agent_end", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	pi.on("model_select", (event, ctx) => {
		liveContext.clear();
		syncInteractiveState(event, ctx);
	});
	pi.on("thinking_level_select", syncInteractiveState);
	pi.on("session_info_changed", syncInteractiveState);
	pi.on("message_update", (event) => {
		liveContext.update(event.message);
	});
	pi.on("message_end", (event, ctx) => {
		// Pi notifies extensions before persisting a successful message, so retain its live
		// context until agent_end; failed finals clear immediately instead of showing stale usage.
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		) {
			liveContext.clear();
		}
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		liveContext.clear();
		syncInteractiveState(event, ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		syncInteractiveAndProjectState(event, ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	pi.on("session_tree", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
}
