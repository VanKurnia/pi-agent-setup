import { describe, it, expect } from "vitest";
import { renderMarkdown, extractSections } from "./markdown.js";

describe("headings", () => {
  it("converts # to h1", () => {
    const result = renderMarkdown("# Title");
    expect(result).toContain("<h1>Title</h1>");
  });

  it("converts ## to h2", () => {
    const result = renderMarkdown("## Section");
    expect(result).toContain("<h2>Section</h2>");
  });

  it("converts ### to h3", () => {
    const result = renderMarkdown("### Subsection");
    expect(result).toContain("<h3>Subsection</h3>");
  });
});

describe("inline formatting", () => {
  it("renders **bold** as <strong>", () => {
    const result = renderMarkdown("This is **bold** text.");
    expect(result).toContain("<strong>bold</strong>");
  });

  it("renders `code` as <code>", () => {
    const result = renderMarkdown("This is `code` text.");
    expect(result).toContain("<code>code</code>");
  });

  it("renders bold and code in a paragraph", () => {
    const result = renderMarkdown("This is **bold** and `code`.");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<code>code</code>");
  });

  it("renders inline formatting inside headings", () => {
    const result = renderMarkdown("# **Bold** `code` heading");
    expect(result).toContain("<h1>");
    expect(result).toContain("<strong>Bold</strong>");
    expect(result).toContain("<code>code</code>");
    expect(result).toContain("heading");
    expect(result).toContain("</h1>");
  });
});

describe("code blocks", () => {
  it("renders code block with language badge", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const result = renderMarkdown(md);
    expect(result).toContain("typescript");
    expect(result).toContain('<code class="language-typescript">');
    expect(result).toContain("const x = 1;");
  });

  it("renders code block without language badge", () => {
    const md = "```\nplain code\n```";
    const result = renderMarkdown(md);
    expect(result).not.toContain("lang-badge");
    expect(result).toContain("plain code");
  });
});

describe("lists", () => {
  it("renders unordered list", () => {
    const md = "- item 1\n- item 2";
    const result = renderMarkdown(md);
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item 1</li>");
    expect(result).toContain("</ul>");
  });

  it("renders ordered list", () => {
    const md = "1. first\n2. second";
    const result = renderMarkdown(md);
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>first</li>");
    expect(result).toContain("</ol>");
  });
});

describe("paragraphs", () => {
  it("wraps text in <p> tags", () => {
    const result = renderMarkdown("Just a paragraph.");
    expect(result).toContain("<p>Just a paragraph.</p>");
  });

  it("separates paragraphs on blank lines", () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    const result = renderMarkdown(md);
    expect(result).toContain("<p>First paragraph.</p>");
    expect(result).toContain("<p>Second paragraph.</p>");
  });
});

describe("empty / edge cases", () => {
  it("returns empty string for empty input", () => {
    const result = renderMarkdown("");
    expect(result.trim()).toBe("");
  });

  it("handles only whitespace", () => {
    const result = renderMarkdown("   \n  \n");
    expect(result.trim()).toBe("");
  });
});

describe("extractSections", () => {
  it("extracts sections by heading", () => {
    const md = "# Intro\nHello\n\n## Step 1\nDo this\n\n## Step 2\nDo that\n";
    const sections = extractSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].title).toBe("Intro");
    expect(sections[0].level).toBe(1);
    expect(sections[1].title).toBe("Step 1");
    expect(sections[1].level).toBe(2);
    expect(sections[2].title).toBe("Step 2");
    expect(sections[2].level).toBe(2);
  });

  it("sets startLine and endLine correctly", () => {
    const md = "# A\n\n## B\n\ncontent";
    const sections = extractSections(md);
    expect(sections[0].startLine).toBe(0);
    // endLine is the line index of the next heading
    expect(sections[0].endLine).toBe(2);
  });

  it("returns empty array when there are no headings", () => {
    const sections = extractSections("just text\nno headings");
    expect(sections).toHaveLength(0);
  });
});

describe("blockquotes", () => {
  it("renders a simple blockquote", () => {
    const result = renderMarkdown("> A note");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("A note");
  });

  it("renders multi-line blockquote", () => {
    const result = renderMarkdown("> Line 1\n> Line 2");
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
  });
});

describe("horizontal rules", () => {
  it("renders --- as <hr>", () => {
    const result = renderMarkdown("---");
    expect(result).toContain("<hr>");
  });

  it("renders *** as <hr>", () => {
    const result = renderMarkdown("***");
    expect(result).toContain("<hr>");
  });
});

describe("tables", () => {
  it("renders a simple table", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = renderMarkdown(md);
    expect(result).toContain("<table>");
    expect(result).toContain("<th>A</th>");
    expect(result).toContain("<td>1</td>");
  });
});

describe("task lists", () => {
  it("renders unchecked task", () => {
    const result = renderMarkdown("- [ ] Todo");
    expect(result).toContain('type="checkbox"');
    expect(result).not.toContain('checked');
    expect(result).toContain("Todo");
  });

  it("renders checked task", () => {
    const result = renderMarkdown("- [x] Done");
    expect(result).toContain('checked');
    expect(result).toContain("Done");
  });
});

describe("edge cases", () => {
  it("handles ** without closing", () => {
    const result = renderMarkdown("**unclosed");
    expect(result).not.toContain("<strong>");
  });

  it("handles empty heading", () => {
    const result = renderMarkdown("# ");
    // marked.js emits an empty <h1></h1> for an empty heading
    expect(result).toContain("<h1></h1>");
  });

  it("handles very long lines without crashing", () => {
    const long = "a".repeat(10000);
    const result = renderMarkdown(long);
    expect(result).toContain("<p>");
  });
});
