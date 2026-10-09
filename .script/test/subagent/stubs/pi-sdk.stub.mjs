// SDK stub for dispatcher tests: re-exports the real pi SDK except
// createAgentSession, which returns an in-memory fake (no models, no files).
// Loaded via jiti `alias` so agent/extensions/subagents/src/run.ts picks it
// up instead of the real package. Keep the default module cache ON so the
// stub shares cross-extension module instances with the test.
export * from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";

import { getParentLinkGlobal } from "../../../../agent/extensions/shared/cross-extension-api.js";

export const stubbedSessions = [];
export const stubStats = { createCalls: 0 };

/** Fault injection: failCreate makes createAgentSession throw;
    failPrompt makes prompt() throw. Both reset by __resetStubbedSessions. */
export const stubFlags = { failPrompt: null, failCreate: null };

export function __resetStubbedSessions() {
    stubbedSessions.length = 0;
    stubStats.createCalls = 0;
    stubFlags.failPrompt = null;
    stubFlags.failCreate = null;
}

export async function createAgentSession(opts) {
    stubStats.createCalls++;
    if (stubFlags.failCreate) throw new Error(stubFlags.failCreate);
    const id = `stub-child-${stubbedSessions.length}`;
    const rec = { id, opts, prompts: [], disposed: false, linkSeen: [] };
    stubbedSessions.push(rec);
    return {
        session: {
            sessionManager: { getSessionId: () => id },
            subscribe: () => () => {},
            prompt: async (task) => {
                rec.prompts.push(task);
                // Golden capture: is the parent link resolvable DURING the run?
                rec.linkSeen.push(getParentLinkGlobal(id));
                if (stubFlags.failPrompt) throw new Error(stubFlags.failPrompt);
            },
            abort: async () => {},
            dispose: () => {
                rec.disposed = true;
            },
        },
    };
}
