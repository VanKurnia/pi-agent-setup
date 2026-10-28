import type { ExtensionAPI, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    CombinedAutocompleteProvider,
    Editor,
    type AutocompleteProvider,
    type EditorTheme,
    Key,
    Text,
    type TUI,
    matchesKey,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskOption {
    label: string;
    value: string;
    description?: string;
}

interface OptionItem {
    kind: "option";
    /** 1-based position shown in the list and reported to the model. */
    index: number;
    label: string;
    value: string;
    description?: string;
}

type ChoiceItem = OptionItem | { kind: "other"; label: string };
type MultiChoiceItem = ChoiceItem | { kind: "submit" };

interface TextAnswer {
    type: "text";
    label: string;
    value: string;
}

interface OptionAnswer {
    type: "option";
    label: string;
    value: string;
    index: number;
}

interface OtherAnswer {
    type: "other";
    label: string;
    value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
    status: AskUserQuestionStatus;
    question: string;
    context?: string;
    mode: AskUserQuestionMode;
    answers: AskAnswer[];
    message?: string;
}

const OptionSchema = Type.Object({
    label: Type.String({
        description:
            'Display label for the option (max 50 chars — longer labels overflow in interactive UI). If you recommend an option, place it first and append "(Recommended)" to the label.',
    }),
    value: Type.Optional(
        Type.String({
            description:
                "Optional machine-readable value returned for the option. Defaults to the label.",
        }),
    ),
    description: Type.Optional(
        Type.String({ description: "Optional extra detail shown below the option." }),
    ),
});

const AskUserQuestionParams = Type.Object({
    question: Type.String({
        description: "The single question to ask the user. Ask exactly one question per tool call.",
    }),
    details: Type.Optional(
        Type.String({
            description: "Optional extra context or instructions shown under the question.",
        }),
    ),
    options: Type.Optional(
        Type.Array(OptionSchema, {
            description:
                "Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
        }),
    ),
    multiSelect: Type.Optional(
        Type.Boolean({
            description: "Set to true to allow multiple answers to be selected for a question.",
        }),
    ),
});

export function normalizeOptions(
    options: Array<{ label: string; value?: string; description?: string }> | undefined,
): AskOption[] {
    return (options || [])
        .map((option) => ({
            label: option.label.trim(),
            value: option.value?.trim() || option.label.trim(),
            description: option.description?.trim() || undefined,
        }))
        .filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
    return options.some((option) => option.label.toLowerCase() === "other")
        ? "Other (custom)"
        : "Other";
}

function createEditorTheme(theme: Theme): EditorTheme {
    return {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
        },
    };
}

function addWrappedWithPrefix(prefix: string, text: string, lines: string[], width: number): void {
    const prefixWidth = visibleWidth(prefix);
    if (prefixWidth >= width) {
        // Prefix alone fills the line — fall back: push prefix, then wrap text
        lines.push(prefix);
        for (const line of wrapTextWithAnsi(text, width)) {
            lines.push(line);
        }
        return;
    }
    const contentWidth = width - prefixWidth;
    const wrapped = wrapTextWithAnsi(text, contentWidth);
    const continuationPrefix = " ".repeat(prefixWidth);
    for (let i = 0; i < wrapped.length; i++) {
        lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
    }
}

export function formatAnswerForModel(answer: AskAnswer): string {
    switch (answer.type) {
        case "text":
            return answer.label;
        case "other":
            return `Other: ${answer.label}`;
        case "option":
            return `${answer.index}. ${answer.label}`;
    }
}

function answerSortRank(answer: AskAnswer): number {
    switch (answer.type) {
        case "option":
            return answer.index;
        case "other":
            return Number.MAX_SAFE_INTEGER - 1;
        case "text":
            return Number.MAX_SAFE_INTEGER;
    }
}

export function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
    return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
    status: AskUserQuestionStatus,
    question: string,
    mode: AskUserQuestionMode,
    answers: AskAnswer[],
    context?: string,
    message?: string,
) {
    return {
        status,
        question,
        context,
        mode,
        answers,
        message,
    } as AskUserQuestionResultDetails;
}

export function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
    const message = "User cancelled the question";
    return {
        content: [{ type: "text" as const, text: message }],
        details: buildStructuredResult("cancelled", question, mode, [], context, message),
    };
}

export function unavailableResult(
    question: string,
    mode: AskUserQuestionMode,
    message: string,
    context?: string,
) {
    return {
        content: [{ type: "text" as const, text: message }],
        details: buildStructuredResult("unavailable", question, mode, [], context, message),
    };
}

export function buildResult(
    question: string,
    context: string | undefined,
    mode: AskUserQuestionMode,
    answers: AskAnswer[],
) {
    let text: string;
    if (mode === "text") {
        const answer = answers[0];
        text =
            answer.label.trim().length > 0
                ? `User answered: ${answer.label}`
                : "User submitted an empty response";
    } else if (mode === "single-select") {
        text = `User selected: ${formatAnswerForModel(answers[0])}`;
    } else {
        text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
    }

    return {
        content: [{ type: "text" as const, text }],
        details: buildStructuredResult("answered", question, mode, answers, context),
    };
}

function createAnswerEditor(tui: TUI, theme: Theme, autocomplete: AutocompleteProvider): Editor {
    const editor = new Editor(tui, createEditorTheme(theme));
    editor.setAutocompleteProvider(autocomplete);
    return editor;
}

function optionItems(options: AskOption[]): OptionItem[] {
    return options.map((option, index) => ({ ...option, kind: "option", index: index + 1 }));
}

function dialogHeader(
    theme: Theme,
    question: string,
    context: string | undefined,
    width: number,
): string[] {
    const lines = [theme.fg("accent", "─".repeat(width))];
    addWrappedWithPrefix(" ", theme.fg("text", question), lines, width);
    if (context) {
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("muted", context), lines, width);
    }
    lines.push("");
    return lines;
}

function dialogFooter(
    lines: string[],
    theme: Theme,
    width: number,
    hint: string,
    warning?: string,
): void {
    lines.push("");
    if (warning) lines.push(theme.fg("warning", ` ${warning}`));
    lines.push(theme.fg("dim", ` ${hint}`), theme.fg("accent", "─".repeat(width)));
}

function editorLines(editor: Editor, width: number): string[] {
    return editor.render(Math.max(1, width - 2)).map((line) => ` ${line}`);
}

// Esc closes an open suggestion list before the screen acts on it, and Enter applies the
// highlighted suggestion instead of submitting, which a `/` completion would otherwise do.
function handleAnswerEditorInput(editor: Editor, data: string, tui: TUI): boolean {
    if (!editor.isShowingAutocomplete()) return false;
    if (matchesKey(data, Key.escape)) {
        editor.handleInput(data);
    } else if (matchesKey(data, Key.enter)) {
        editor.handleInput("\t");
    } else {
        return false;
    }
    tui.requestRender();
    return true;
}

function handleEditModeInput(editor: Editor, data: string, tui: TUI, onCancel: () => void): void {
    if (handleAnswerEditorInput(editor, data, tui)) return;
    if (matchesKey(data, Key.escape)) {
        onCancel();
        tui.requestRender();
        return;
    }
    editor.handleInput(data);
    tui.requestRender();
}

async function askFreeText(
    ctx: ExtensionToolContext,
    question: string,
    context: string | undefined,
    autocomplete: AutocompleteProvider,
): Promise<string | null> {
    return ctx.ui.custom((tui, theme, _keybindings, done: (result: string | null) => void) => {
        const editor = createAnswerEditor(tui, theme, autocomplete);

        editor.onSubmit = (value) => done(value);

        function handleInput(data: string) {
            if (handleAnswerEditorInput(editor, data, tui)) return;
            if (matchesKey(data, Key.escape)) {
                done(null);
                return;
            }
            editor.handleInput(data);
            tui.requestRender();
        }

        function render(width: number): string[] {
            const lines = dialogHeader(theme, question, context, width);
            lines.push(...editorLines(editor, width));
            dialogFooter(lines, theme, width, "Enter to submit • Tab insert • Esc cancel");
            return lines;
        }

        return { render, invalidate: () => {}, handleInput };
    });
}

async function askSingleChoice(
    ctx: ExtensionToolContext,
    question: string,
    context: string | undefined,
    options: AskOption[],
    autocomplete: AutocompleteProvider,
): Promise<AskAnswer | null> {
    const items: ChoiceItem[] = [
        ...optionItems(options),
        { kind: "other", label: getOtherLabel(options) },
    ];

    return ctx.ui.custom((tui, theme, _keybindings, done: (result: AskAnswer | null) => void) => {
        let cursor = 0;
        let editMode = false;
        const editor = createAnswerEditor(tui, theme, autocomplete);

        editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            done({ type: "other", label: trimmed, value: trimmed });
        };

        function handleInput(data: string) {
            if (editMode) {
                handleEditModeInput(editor, data, tui, () => {
                    editMode = false;
                    editor.setText("");
                });
                return;
            }
            if (matchesKey(data, Key.up)) {
                cursor = Math.max(0, cursor - 1);
                tui.requestRender();
                return;
            }
            if (matchesKey(data, Key.down)) {
                cursor = Math.min(items.length - 1, cursor + 1);
                tui.requestRender();
                return;
            }
            if (matchesKey(data, Key.escape)) {
                done(null);
                return;
            }
            if (!matchesKey(data, Key.enter)) return;

            const item = items[cursor];
            if (item.kind === "other") {
                editMode = true;
                editor.setText("");
                tui.requestRender();
                return;
            }
            done({ type: "option", label: item.label, value: item.value, index: item.index });
        }

        function render(width: number): string[] {
            const lines = dialogHeader(theme, question, context, width);
            const add = (...rows: string[]) => lines.push(...rows);

            for (const [index, item] of items.entries()) {
                const focused = index === cursor;
                const label = item.kind === "option" ? `${item.index}. ${item.label}` : item.label;
                const color = focused ? "accent" : "text";
                add(`${focused ? theme.fg("accent", "> ") : "  "}${theme.fg(color, label)}`);
                if (item.kind === "option" && item.description) {
                    addWrappedWithPrefix(
                        "     ",
                        theme.fg("muted", item.description),
                        lines,
                        width,
                    );
                }
            }

            if (editMode) {
                add(
                    "",
                    theme.fg("muted", " Write your custom answer:"),
                    ...editorLines(editor, width),
                );
                dialogFooter(lines, theme, width, "Enter to submit • Tab insert • Esc to go back");
            } else {
                dialogFooter(lines, theme, width, "↑↓ navigate • Enter select • Esc cancel");
            }
            return lines;
        }

        return { render, invalidate: () => {}, handleInput };
    });
}

async function askMultiChoice(
    ctx: ExtensionToolContext,
    question: string,
    context: string | undefined,
    options: AskOption[],
    autocomplete: AutocompleteProvider,
): Promise<AskAnswer[] | null> {
    const items: MultiChoiceItem[] = [
        ...optionItems(options),
        { kind: "other", label: getOtherLabel(options) },
        { kind: "submit" },
    ];

    return ctx.ui.custom((tui, theme, _keybindings, done: (result: AskAnswer[] | null) => void) => {
        let cursor = 0;
        let editMode = false;
        let otherAnswer: string | undefined;
        const checked = new Set<number>();
        const editor = createAnswerEditor(tui, theme, autocomplete);

        function selectedCount(): number {
            return checked.size + (otherAnswer === undefined ? 0 : 1);
        }

        function answers(): AskAnswer[] {
            const picked: AskAnswer[] = [];
            for (const item of items) {
                if (item.kind !== "option" || !checked.has(item.index)) continue;
                picked.push({
                    type: "option",
                    label: item.label,
                    value: item.value,
                    index: item.index,
                });
            }
            if (otherAnswer !== undefined) {
                picked.push({ type: "other", label: otherAnswer, value: otherAnswer });
            }
            return sortAnswers(picked);
        }

        function toggle(index: number) {
            if (checked.has(index)) checked.delete(index);
            else checked.add(index);
            tui.requestRender();
        }

        function openOtherEditor() {
            editMode = true;
            editor.setText(otherAnswer ?? "");
            tui.requestRender();
        }

        editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            otherAnswer = trimmed;
            editMode = false;
            tui.requestRender();
        };

        function handleInput(data: string) {
            if (editMode) {
                handleEditModeInput(editor, data, tui, () => {
                    editMode = false;
                    editor.setText(otherAnswer ?? "");
                });
                return;
            }
            if (matchesKey(data, Key.up)) {
                cursor = Math.max(0, cursor - 1);
                tui.requestRender();
                return;
            }
            if (matchesKey(data, Key.down)) {
                cursor = Math.min(items.length - 1, cursor + 1);
                tui.requestRender();
                return;
            }
            if (matchesKey(data, Key.escape)) {
                done(null);
                return;
            }

            const item = items[cursor];
            if (item.kind === "submit") {
                if (matchesKey(data, Key.enter) && selectedCount() > 0) done(answers());
                return;
            }
            if (item.kind === "other") {
                const isSpace = matchesKey(data, Key.space);
                if (!isSpace && !matchesKey(data, Key.enter)) return;
                if (isSpace && otherAnswer !== undefined) {
                    otherAnswer = undefined;
                    tui.requestRender();
                    return;
                }
                openOtherEditor();
                return;
            }
            if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) toggle(item.index);
        }

        function render(width: number): string[] {
            const lines = dialogHeader(theme, question, context, width);
            const add = (...rows: string[]) => lines.push(...rows);
            const count = selectedCount();

            for (const [index, item] of items.entries()) {
                const focused = index === cursor;
                const prefix = focused ? theme.fg("accent", "> ") : "  ";

                if (item.kind === "submit") {
                    const label = count > 0 ? `✓ Submit (${count} selected)` : "○ Submit";
                    const color = focused ? "accent" : count > 0 ? "success" : "dim";
                    add(`${prefix}${theme.fg(color, label)}`);
                    continue;
                }
                if (item.kind === "other") {
                    const picked = otherAnswer !== undefined;
                    const suffix = picked ? ` — ${otherAnswer}` : "";
                    const label = `${picked ? "[x]" : "[ ]"} ${item.label}${suffix}`;
                    const color = focused ? "accent" : picked ? "success" : "text";
                    add(`${prefix}${theme.fg(color, label)}`);
                    continue;
                }
                const isChecked = checked.has(item.index);
                const label = `${isChecked ? "[x]" : "[ ]"} ${item.index}. ${item.label}`;
                const color = focused ? "accent" : isChecked ? "success" : "text";
                add(`${prefix}${theme.fg(color, label)}`);
                if (item.description) {
                    addWrappedWithPrefix(
                        "     ",
                        theme.fg("muted", item.description),
                        lines,
                        width,
                    );
                }
            }

            if (editMode) {
                add(
                    "",
                    theme.fg("muted", " Write your custom answer:"),
                    ...editorLines(editor, width),
                );
                dialogFooter(lines, theme, width, "Enter to save • Tab insert • Esc to go back");
            } else {
                dialogFooter(
                    lines,
                    theme,
                    width,
                    "↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel",
                    count === 0 ? "Select at least one answer before submitting." : undefined,
                );
            }
            return lines;
        }

        return { render, invalidate: () => {}, handleInput };
    });
}

// Mutex to serialize concurrent UI interactions.
// showExtensionCustom/editor can only handle one active call at a time.
let uiLock: Promise<void> = Promise.resolve();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = uiLock;
    let release: () => void;
    uiLock = new Promise<void>((r) => {
        release = r;
    });
    return prev.then(fn).finally(() => release!());
}

export default function askUserQuestion(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user_question",
        label: "ask_user_question",
        exposure: "model-only",
        annotations: { readOnlyHint: true, idempotentHint: false },
        description:
            "Ask the user a single question and pause execution until they answer. One question per call — for several questions, make several separate calls.",
        promptSnippet:
            "Ask one clarifying question when the requirement, preference, or path is unclear",
        promptGuidelines: [
            'Users will always be able to select "Other" to provide custom text input when options are provided.',
            "Use multiSelect: true only when you need multiple answers to the same question.",
            'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
            "Keep options[].label under 50 characters — long labels overflow because they don't wrap in the interactive UI.",
        ],
        parameters: AskUserQuestionParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const options = normalizeOptions(params.options);
            const context = params.details?.trim() || undefined;
            const mode: AskUserQuestionMode =
                options.length === 0
                    ? "text"
                    : params.multiSelect
                      ? "multi-select"
                      : "single-select";

            if (signal?.aborted) {
                return cancelledResult(params.question, mode, context);
            }

            if (!ctx.hasUI) {
                return unavailableResult(
                    params.question,
                    mode,
                    "ask_user_question is not supported in non-interactive or subagent sessions. Provide all instructions and parameters upfront.",
                    context,
                );
            }

            return withUILock(async () => {
                const autocomplete = new CombinedAutocompleteProvider(
                    pi.getCommands(),
                    ctx.cwd,
                    "fd",
                );

                if (mode === "text") {
                    const answer = await askFreeText(ctx, params.question, context, autocomplete);
                    if (answer === null) {
                        return cancelledResult(params.question, mode, context);
                    }
                    return buildResult(params.question, context, mode, [
                        { type: "text", label: answer.trim(), value: answer.trim() },
                    ]);
                }

                if (mode === "single-select") {
                    const answer = await askSingleChoice(
                        ctx,
                        params.question,
                        context,
                        options,
                        autocomplete,
                    );
                    if (!answer) {
                        return cancelledResult(params.question, mode, context);
                    }
                    return buildResult(params.question, context, mode, [answer]);
                }

                const answers = await askMultiChoice(
                    ctx,
                    params.question,
                    context,
                    options,
                    autocomplete,
                );
                if (!answers) {
                    return cancelledResult(params.question, mode, context);
                }
                return buildResult(params.question, context, mode, answers);
            });
        },

        renderCall(args, theme) {
            const options = normalizeOptions(
                args.options as
                    | Array<{ label: string; value?: string; description?: string }>
                    | undefined,
            );
            let text =
                theme.fg("toolTitle", theme.bold("ask_user_question ")) +
                theme.fg("muted", args.question);
            if (args.multiSelect) {
                text += theme.fg("dim", " [multi-select]");
            }
            if (options.length > 0) {
                const labels = [
                    ...options.map((option) => option.label),
                    getOtherLabel(options),
                ].join(", ");
                text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details as AskUserQuestionResultDetails | undefined;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }

            if (details.status === "cancelled") {
                return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
            }

            if (details.status === "unavailable") {
                return new Text(
                    theme.fg("warning", details.message || "ask_user_question unavailable"),
                    0,
                    0,
                );
            }

            const lines = details.answers.map((answer) => {
                switch (answer.type) {
                    case "text":
                        return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
                    case "other":
                        return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
                    case "option":
                        return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
                }
            });
            return new Text(lines.join("\n"), 0, 0);
        },
    });
}
