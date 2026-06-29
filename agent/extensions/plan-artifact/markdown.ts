import { marked } from "marked";
import type { PlanSection } from "./types.ts";

const COPY_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const renderer = {
    code({ text, lang }: { text: string; lang?: string; escaped?: boolean }) {
        if (lang === "mermaid") {
            return `<pre class="mermaid">${text}</pre>\n`;
        }
        const badge = lang ? `<span class="lang-badge">${escapeHtml(lang)}</span>` : "";
        const lines = escapeHtml(text)
            .split("\n")
            .map((l) => `<span class="line">${l || " "}</span>`)
            .join("\n");
        return `<div class="code-block"><div class="code-header">${badge}<button class="copy-btn" onclick="copyCode(this)" title="Copy code">${COPY_ICON}</button></div><pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${lines}</code></pre></div>\n`;
    },
};

marked.use({ renderer });

export function renderMarkdown(md: string): string {
    return marked.parse(md, { gfm: true, breaks: false, async: false }) as string;
}

function isHeading(line: string): [number, string] | null {
    const m = line.match(/^(#{1,3})\s+(.+)/);
    return m ? [m[1].length, m[2].trim()] : null;
}

export function extractSections(md: string): PlanSection[] {
    const lines = md.split("\n");
    const sections: PlanSection[] = [];
    let currentTitle = "";
    let currentLevel = 0;
    let currentContentLines: string[] = [];
    let sectionStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const hd = isHeading(lines[i]);
        if (hd) {
            if (currentLevel > 0) {
                sections.push({
                    title: currentTitle,
                    level: currentLevel,
                    content: renderMarkdown(currentContentLines.join("\n")),
                    startLine: sectionStart,
                    endLine: i,
                });
            }
            currentTitle = hd[1];
            currentLevel = hd[0];
            currentContentLines = [];
            sectionStart = i;
        } else {
            currentContentLines.push(lines[i]);
        }
    }

    if (currentLevel > 0) {
        sections.push({
            title: currentTitle,
            level: currentLevel,
            content: renderMarkdown(currentContentLines.join("\n")),
            startLine: sectionStart,
            endLine: lines.length,
        });
    }

    return sections;
}
