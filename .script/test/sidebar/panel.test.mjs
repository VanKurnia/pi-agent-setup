// Test: sidebar workspace panel chrome — frame, rows, width invariant, theme duality.
// Run from repo root: node .script/test/sidebar/panel.test.mjs
//
// Guards the atelier-chrome contract: every emitted line fits 39 visible
// columns, the frame opens/closes correctly, empty values render the
// placeholder, and the no-theme path emits identical layout with zero
// escape bytes.
import assert from "node:assert/strict";
import { createTestJiti, importProd } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const { buildWorkspaceLines } = await importProd(jiti, "agent/extensions/sidebar.js");

const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, "");
const visibleLen = (s) => [...stripAnsi(s)].length;

// Minimal stand-in for the host Theme: only fg/bold, which is all the panel uses.
const theme = {
    fg: (_token, text) => `[36m${text}[0m`,
    bold: (text) => `[1m${text}[22m`,
};

const snap = {
    project: "my-proj",
    location: "~/code/my-proj",
    history: "12 entries",
    storage: "Saved",
};

let n = 0;

// 1. Top frame line: jewel, title, closing corner.
{
    const lines = buildWorkspaceLines(snap, theme);
    const first = stripAnsi(lines[0]);
    assert.ok(first.startsWith("╭─ ✦"), "top starts with jewel frame");
    assert.ok(first.includes("Workspace"), "top contains title");
    assert.ok(first.endsWith("╮"), "top ends with corner");
    console.log(`ok ${++n} - top frame line`);
}

// 2. Bottom frame line: rule corners only.
{
    const lines = buildWorkspaceLines(snap, theme);
    const nonEmpty = lines.filter((l) => stripAnsi(l).length > 0);
    assert.match(stripAnsi(nonEmpty[nonEmpty.length - 1]), /^╰─+╯$/, "bottom frame shape");
    console.log(`ok ${++n} - bottom frame line`);
}

// 3. Body rows: borders + all four labels and values.
{
    const lines = buildWorkspaceLines(snap, theme).map(stripAnsi);
    const body = lines.filter((l) => l.startsWith("│"));
    assert.equal(body.length, 4, "four body rows");
    for (const l of body) assert.ok(l.endsWith("│"), "row ends with border");
    const joined = body.join("\n");
    for (const [label, value] of [
        ["Project", "my-proj"],
        ["Location", "~/code/my-proj"],
        ["History", "12 entries"],
        ["Storage", "Saved"],
    ]) {
        assert.ok(joined.includes(label), `label ${label} present`);
        assert.ok(joined.includes(value), `value ${value} present`);
    }
    console.log(`ok ${++n} - body rows with labels and values`);
}

// 4. Empty values render the placeholder, never a bare label.
{
    const lines = buildWorkspaceLines(
        { project: "", location: "", history: "0 entries", storage: "" },
        theme,
    ).map(stripAnsi);
    const body = lines.filter((l) => l.startsWith("│"));
    const proj = body.find((l) => l.includes("Project"));
    assert.ok(proj.includes("—"), "empty project renders placeholder");
    assert.ok(!/Project\s*│/.test(proj), "no empty gap after label");
    console.log(`ok ${++n} - placeholder for empty values`);
}

// 5. Width invariant: every line fits 39 visible columns.
{
    for (const useTheme of [undefined, theme]) {
        const lines = buildWorkspaceLines(
            {
                project: "a".repeat(60),
                location: "/very/long/" + "p".repeat(60),
                history: "999 entries",
                storage: "Temporary",
            },
            useTheme,
        );
        for (const l of lines) {
            assert.ok(visibleLen(l) <= 39, `line fits 39 cols: ${stripAnsi(l).slice(0, 45)}`);
        }
    }
    console.log(`ok ${++n} - width invariant`);
}

// 6. No-theme path: zero escape bytes, identical row count.
{
    const themed = buildWorkspaceLines(snap, theme);
    const plain = buildWorkspaceLines(snap);
    assert.equal(plain.length, themed.length, "same row count");
    assert.ok(!plain.join("\n").includes(""), "no escape bytes without theme");
    assert.deepEqual(plain.map(stripAnsi), themed.map(stripAnsi), "identical layout");
    console.log(`ok ${++n} - no-theme duality`);
}

// 7. Long project name truncates with an ellipsis within width.
{
    const lines = buildWorkspaceLines({ ...snap, project: "b".repeat(50) }, theme).map(stripAnsi);
    const proj = lines.find((l) => l.includes("Project"));
    assert.ok(proj.includes("…"), "ellipsis present");
    assert.ok(visibleLen(proj) <= 39, "truncated row fits");
    console.log(`ok ${++n} - long value truncation`);
}

console.log("panel: all ok");
