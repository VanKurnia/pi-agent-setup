// Test: sidebar dock controller — thresholds, widths, layout split, render wrap.
// Run from repo root: node .script/test/sidebar/dock.test.mjs
//
// Covers the atelier port mechanics with plain-object fake TUIs: no host
// needed, no timers, no real terminal.
import assert from "node:assert/strict";
import { HStack } from "@earendil-works/pi-tui";
import { createTestJiti, importProd } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const { createDockController, dockVisible, dockWidths } = await importProd(
    jiti,
    "agent/extensions/sidebar.js",
);

const VIEWPORT = Symbol.for("@earendil-works/pi-tui/viewport");
const theme = { fg: (_t, x) => x, bold: (x) => x };
const snap = () => ({ project: "p", location: "l", history: "1 entries", storage: "Saved" });

function fullscreenStub(columns) {
    const calls = [];
    const original = { render: () => ["orig"], invalidate() {} };
    const tui = {
        mode: "fullscreen",
        terminal: { columns },
        layoutRoot: original,
        setLayoutRoot(c) {
            calls.push(c);
            this.layoutRoot = c;
        },
        requestRender() {},
        [VIEWPORT]: true,
    };
    return { tui, calls, original };
}

function regularStub(columns) {
    const seen = [];
    const original = (w) => {
        seen.push(w);
        return [`w${w}`];
    };
    const tui = { mode: "regular", terminal: { columns }, render: original, requestRender() {} };
    return { tui, seen, original };
}

let n = 0;

// 1. Visibility threshold: 64 main + 28 sidebar.
{
    assert.equal(dockVisible(91), false);
    assert.equal(dockVisible(92), true);
    assert.equal(dockVisible(200), true);
    console.log(`ok ${++n} - dockVisible threshold`);
}

// 2. Width split: sidebar clamped to [28, 72].
{
    assert.deepEqual(dockWidths(200), { sidebar: 44, main: 156 });
    assert.deepEqual(dockWidths(92), { sidebar: 28, main: 64 });
    console.log(`ok ${++n} - dockWidths split`);
}

// 3. Fullscreen show installs one HStack; second show is a no-op.
{
    const { tui, calls } = fullscreenStub(200);
    const c = createDockController();
    assert.equal(c.show(tui, theme, { width: 44, snapshot: snap }), true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof HStack);
    assert.equal(c.show(tui, theme, { width: 44, snapshot: snap }), false);
    assert.equal(calls.length, 1);
    assert.equal(c.isShown(), true);
    console.log(`ok ${++n} - fullscreen show installs HStack once`);
}

// 4. Hide restores the original root; double-hide is safe.
{
    const { tui, calls, original } = fullscreenStub(200);
    const c = createDockController();
    c.show(tui, theme, { width: 44, snapshot: snap });
    c.hide();
    assert.equal(calls.length, 2);
    assert.ok(calls[1] === original);
    assert.equal(tui.layoutRoot, original);
    assert.equal(c.isShown(), false);
    c.hide();
    assert.equal(calls.length, 2);
    console.log(`ok ${++n} - hide restores original root`);
}

// 5. Regular stub: render wraps narrowed, unwraps on hide.
{
    const { tui, seen, original } = regularStub(100);
    const c = createDockController();
    assert.equal(c.show(tui, theme, { width: 44, snapshot: snap }), true);
    assert.notEqual(tui.render, original);
    tui.render(100);
    assert.deepEqual(seen, [56]);
    tui.render(80);
    assert.deepEqual(seen, [56, 80]);
    c.hide();
    assert.equal(tui.render, original);
    assert.equal(c.isShown(), false);
    console.log(`ok ${++n} - regular render wrap and restore`);
}

// 6. Narrow terminal: show refuses, zero layout calls.
{
    const { tui, calls } = fullscreenStub(80);
    const c = createDockController();
    assert.equal(c.show(tui, theme, { width: 44, snapshot: snap }), false);
    assert.equal(calls.length, 0);
    assert.equal(c.isShown(), false);
    console.log(`ok ${++n} - narrow show refuses`);
}

// 7. Fullscreen without the viewport brand: show refuses.
{
    const tui = { mode: "fullscreen", terminal: { columns: 200 }, requestRender() {} };
    const c = createDockController();
    assert.equal(c.show(tui, theme, { width: 44, snapshot: snap }), false);
    assert.equal(c.isShown(), false);
    console.log(`ok ${++n} - non-viewport show refuses`);
}

console.log("dock: all ok");
