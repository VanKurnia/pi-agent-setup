import * as fs from "node:fs";

/**
 * Relay a user question from a headless subagent to the user
 * via the main session's UI context, and write the answer back.
 */
async function relayQuestion(ctx: any, evt: any): Promise<void> {
  const { question, context, mode, options, answerFile } = evt;

  let answers: any[];

  try {
    if (mode === "text") {
      const answer = await ctx.ui.editor(context
        ? `${question}\n\n${context}`
        : question);
      if (answer === undefined) {
        answers = [];
      } else {
        answers = [{ type: "text", label: answer.trim(), value: answer.trim() }];
      }
    } else if (mode === "multi-select") {
      // ctx.ui.select expects an array of label strings, not objects
      const labels = (options || []).map((o: any) => o.label);
      const selected = await ctx.ui.select(question, labels, {
        multiSelect: true,
        message: context,
      });
      if (!selected || selected.length === 0) {
        answers = [];
      } else {
        answers = selected.map((s: string) => {
          const opt = (options || []).find((o: any) => o.label === s);
          const idx = (options || []).findIndex((o: any) => o.label === s);
          return {
            type: "option" as const,
            label: s,
            value: opt?.value || s,
            index: idx + 1,
          };
        });
      }
    } else {
      // single-select — ctx.ui.select expects label strings, returns the chosen string
      const labels = (options || []).map((o: any) => o.label);
      const selected = await ctx.ui.select(question, labels, {
        message: context,
      });
      if (!selected) {
        answers = [];
      } else {
        const opt = (options || []).find((o: any) => o.label === selected);
        const idx = (options || []).findIndex((o: any) => o.label === selected);
        answers = [{
          type: "option" as const,
          label: selected,
          value: opt?.value || selected,
          index: idx + 1,
        }];
      }
    }
  } catch (err) {
    // If UI interaction fails, write empty answer
    answers = [];
  }

  // Write answer to the shared answer file
  try {
    await fs.promises.writeFile(answerFile, JSON.stringify({ answers }), "utf-8");
  } catch (err) {
    console.error("[subagents] failed to write answer file:", answerFile, err);
  }
}

/** Shared relay handler with error logging — used from stdout, stderr, and close handlers. */
export function relayOrLog(ctx: any, evt: any): void {
  relayQuestion(ctx, evt).catch((err) => {
    console.error("[subagents] relayQuestion failed:", err);
  });
}
