import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, Key, Markdown, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerExtensionApi } from "../shared/cross-extension-api.js";
import { createPlanServer } from "./server.ts";
import { extractSections } from "./markdown.ts";
import type { PlanProposal } from "./types.ts";
import * as crypto from "node:crypto";

export default function (pi: ExtensionAPI) {
  const server = createPlanServer(pi);
  registerExtensionApi("plan-artifact", {
    isRunning: () => server.isRunning(),
    getUrl: () => server.getUrl(),
    getSummary: () => server.getProposal()?.summary ?? null,
  });
  let latestCtx: any = null;

  server.onStop(() => { if (latestCtx) updateUi(latestCtx); });

  function updateUi(ctx: any): void {
    if (!ctx?.hasUI) return;
    if (!server.isRunning()) {
      ctx.ui.setWidget("plan-artifact", undefined);
      return;
    }
    ctx.ui.setWidget("plan-artifact", (_tui: any, theme: any) => ({
      render: (_width: number) => {
        const url = server.getUrl();
        const icon = "\u25CF";
        if (!url) return [theme.fg("accent", `${icon} Plan-Artifact`)];
        const linkStart = `\x1b]8;;${url}\x07`;
        const linkEnd = `\x1b]8;;\x07`;
        const text = `${linkStart}${icon} Plan-Artifact${linkEnd}`;
        return [theme.fg("accent", text)];
      },
    }));
  }

  async function openReviewOverlay(ctx: any): Promise<void> {
    while (true) {
      const proposal = server.getProposal();
      if (!proposal) {
        ctx.ui.notify("No plan to review.", "warning");
        return;
      }

      const theme = ctx.ui.theme;
      const sectionItems: SelectItem[] = proposal.sections.map((s, i) => ({
        value: `section:${i}`,
        label: s.title.slice(0, 50),
        description: `Section ${i + 1}`,
      }));

      const actionItems: SelectItem[] = [
        { value: "__url__", label: "Show URL", description: "Browser review link" },
      ];
      if (proposal.status === "pending") {
        actionItems.push({ value: "__accept__", label: "Accept plan", description: "Mark as accepted and proceed" });
        actionItems.push({ value: "__reject__", label: "Request changes", description: "Request revisions with feedback" });
      }
      actionItems.push({ value: "__close__", label: "Close", description: "Exit review" });

      const allItems = [
        ...sectionItems,
        { value: "__sep__", label: "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500", description: "" },
        ...actionItems,
      ];

      const picked = await ctx.ui.custom((tui: any, tuiTheme: any, _kb: any, done: any) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => tuiTheme.fg("accent", s)));

        const statusText = proposal.status === "accepted" ? "\u2713 Accepted" :
                           proposal.status === "revising" ? "! Needs Revision" : "\u25CF Pending";
        container.addChild(new Text(tuiTheme.fg("accent", tuiTheme.bold("Plan Review")), 1, 0));
        container.addChild(new Text(tuiTheme.fg("text", proposal.summary), 1, 0));
        container.addChild(new Text(tuiTheme.fg("muted", statusText), 1, 0));
        container.addChild(new Text("", 0, 0));

        const list = new SelectList(allItems, Math.min(14, allItems.length), {
          selectedPrefix: (t: string) => tuiTheme.fg("accent", t),
          selectedText: (t: string) => tuiTheme.fg("accent", t),
          description: (t: string) => tuiTheme.fg("muted", t),
          scrollInfo: (t: string) => tuiTheme.fg("dim", t),
          noMatch: (t: string) => tuiTheme.fg("warning", t),
        });

        list.onSelect = (item) => {
          if (item.value === "__sep__") return;
          done(item.value);
        };
        list.onCancel = () => done(null);
        container.addChild(list);

        container.addChild(new Text(tuiTheme.fg("dim", "\u2191\u2193 navigate \u00B7 enter select \u00B7 esc close"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => tuiTheme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      }, { overlay: true });

      if (!picked || picked === "__close__") return;

      if (picked === "__accept__") {
        const ok = await ctx.ui.confirm("Accept plan?", "Mark as accepted and proceed with implementation?");
        if (!ok) continue;
        proposal.status = "accepted";
        pi.sendUserMessage(`**Plan accepted**: "${proposal.summary}". Proceed with implementation.`, { deliverAs: "followUp" });
        server.stop();
        ctx.ui.notify("Plan accepted.", "success");
        updateUi(ctx);
        return;
      }

      if (picked === "__reject__") {
        const feedback = await ctx.ui.input("Request changes", "Describe what needs revision...");
        if (!feedback || !feedback.trim()) continue;
        proposal.status = "revising";
        pi.sendUserMessage(`**Plan needs revision**: "${proposal.summary}"\n\n**Feedback:**\n${feedback}`, { deliverAs: "followUp" });
        server.stop();
        ctx.ui.notify("Changes requested.", "info");
        updateUi(ctx);
        return;
      }

      if (picked === "__url__") {
        const url = server.getUrl();
        ctx.ui.notify(url ? `Review: ${url}` : "No server running.", "info");
        continue;
      }

      if (picked.startsWith("section:")) {
        const idx = parseInt(picked.split(":")[1], 10);
        const section = proposal.sections[idx];
        if (!section) continue;
        const sectionComments = proposal.comments.filter(c => c.sectionIndex === idx);
        const planLines = proposal.plan.split("\n");
        const sectionMd = planLines.slice(section.startLine + 1, section.endLine).join("\n");

        await ctx.ui.custom((tui: any, tuiTheme: any, _kb: any, done: any) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => tuiTheme.fg("accent", s)));
          container.addChild(new Text(tuiTheme.fg("accent", tuiTheme.bold(section.title)), 1, 0));

          if (sectionMd.trim()) {
            container.addChild(new Markdown(sectionMd, 1, 0, getMarkdownTheme()));
          } else {
            container.addChild(new Text(tuiTheme.fg("muted", "(no content)"), 1, 0));
          }

          if (sectionComments.length > 0) {
            container.addChild(new Text(tuiTheme.fg("muted", "Comments:"), 1, 0));
            for (const c of sectionComments) {
              container.addChild(new Text(tuiTheme.fg("text", c.text), 1, 1));
            }
          }

          container.addChild(new Text(tuiTheme.fg("dim", "esc to go back"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => tuiTheme.fg("accent", s)));

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done();
              else tui.requestRender();
            },
          };
        }, { overlay: true });
        continue;
      }
    }
  }

  pi.registerTool({
    name: "plan_artifact",
    label: "Propose Plan",
    description: "Propose a markdown plan for user review. Starts a local web UI showing the rendered plan with inline commenting.",
    promptSnippet: "Propose a plan for browser-based review",
    promptGuidelines: [
      "Use plan_artifact when you have a concrete plan ready for user review, not during exploration.",
      "Write the plan in markdown with clear ## sections for each step.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Short summary of the plan" }),
      plan: Type.String({ description: "Full plan in markdown format. Use ## headings for major sections, ### for subsections." }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (server.getProposal()?.status === "pending") {
        return { content: [{ type: "text", text: `A plan is already pending at ${server.getUrl()}. Accept or reject it first.` }], details: {} };
      }

      const sections = extractSections(params.plan);
      const proposal: PlanProposal = {
        id: crypto.randomUUID(),
        summary: params.summary,
        plan: params.plan,
        sections,
        comments: [],
        status: "pending",
      };

      const url = await server.start(proposal);
      latestCtx = ctx;
      updateUi(ctx);
      return {
        content: [{ type: "text", text: `Plan created \u2014 ${sections.length} section(s).\nPreview \u0026 review: ${url}\nRun /plan-artifact to open TUI review.` }],
        details: { proposalId: proposal.id, url, sections: sections.length },
      };
    },
  });

  pi.registerCommand("plan-artifact", {
    description: "Open plan review overlay to inspect sections and accept/request changes",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (!ctx.hasUI) {
        const url = server.getUrl();
        const prop = server.getProposal();
        if (url && prop) {
          console.log(`Plan: "${prop.summary}" (${prop.status})\nReview: ${url}`);
        } else {
          console.log("No plan to review.");
        }
        return;
      }
      updateUi(ctx);
      await openReviewOverlay(ctx);
    },
  });

  pi.on("session_shutdown", () => { server.stop(); });
}
