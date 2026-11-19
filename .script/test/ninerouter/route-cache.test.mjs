// Test: ninerouter's route cache only ever serves routes discovered for the same
// router identity (baseUrl + apiKey).
// Run from repo root: node .script/test/ninerouter/route-cache.test.mjs
//
// Hermetic: globalThis.fetch is stubbed with a scripted queue, so no router is
// needed and no request leaves the process.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const { getRoutes, __resetRouteCacheForTests } = await importProd(
    jiti,
    "agent/extensions/ninerouter.js",
);
assert.equal(typeof getRoutes, "function", "getRoutes is not exported");
assert.equal(typeof __resetRouteCacheForTests, "function", "no test reset");

const configFor = (baseUrl, apiKey) => ({
    baseUrl,
    apiKey,
    webSearchRoute: undefined,
    webFetchRoute: undefined,
});

const A = configFor("http://router-a.test", "key-a");
const B = configFor("http://router-b.test", "key-b");
const ROUTES_A = [
    { id: "search-a", kind: "webSearch" },
    { id: "fetch-a", kind: "webFetch" },
];

/** A response `fetchJson` accepts: `ok`, `status` and a `text()` carrying JSON. */
const respond = (routes) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: routes }),
});

let queue = [];
let calls = 0;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
let warns = [];

globalThis.fetch = async () => {
    calls++;
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called with an empty queue");
    if (next instanceof Error) throw next;
    return next;
};

/** Each case starts from a cold cache and and a scripted queue. */
const script = (...steps) => {
    __resetRouteCacheForTests();
    queue = steps;
    calls = 0;
    warns = [];
};

console.warn = (...args) => warns.push(args.join(" "));

const ids = (routes) => routes.map((r) => r.id);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("a repeated call for the same router is served from the cache, not the network", async () => {
    script(respond(ROUTES_A));
    assert.deepEqual(ids(await getRoutes(A)), ["search-a", "fetch-a"]);
    assert.equal(calls, 1);

    // No second response is scripted: a network call here would throw.
    assert.deepEqual(ids(await getRoutes(A)), ["search-a", "fetch-a"]);
    assert.equal(calls, 1, "the cache hit must not re-discover");
});

test("an empty discovery for this router never falls back to the cache", async () => {
    script(respond(ROUTES_A));
    await getRoutes(A);
    // A warm cache outranks discovery, so the empty-discovery branch is only
    // reachable from a cold cache.
    script(respond([]));
    assert.deepEqual(await getRoutes(A), [], "an empty answer must stay empty");
});

test("router B's empty discovery does not serve router A's routes", async () => {
    script(respond(ROUTES_A), respond([]));
    assert.deepEqual(ids(await getRoutes(A)), ["search-a", "fetch-a"]);
    assert.deepEqual(await getRoutes(B), [], "router A's ids leaked into router B");
    assert.equal(calls, 2);
    assert.equal(warns.length, 0, "an empty answer is not a failure and must not warn");
});

test("a failed discovery for the same router cannot lose its cached routes", async () => {
    script(respond(ROUTES_A), new Error("ECONNREFUSED"));
    assert.deepEqual(ids(await getRoutes(A)), ["search-a", "fetch-a"]);
    // The warm-cache return precedes discovery, so the queued failure is never
    // consumed: a repeat call for the same router cannot reach the catch at all.
    assert.deepEqual(ids(await getRoutes(A)), ["search-a", "fetch-a"]);
    assert.equal(calls, 1, "a warm cache must bypass discovery entirely");
    assert.equal(warns.length, 0);
});

test("a failed discovery for another router yields nothing", async () => {
    script(respond(ROUTES_A), new Error("ECONNREFUSED"));
    await getRoutes(A);
    assert.deepEqual(await getRoutes(B), [], "router A's routes were served to router B");
    assert.equal(calls, 2);
    assert.ok(
        warns.some((line) => line.includes("no cached routes for this router.")),
        warns.join("\n"),
    );
});

try {
    await runCases(cases, "\nninerouter route cache");
} finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
}
