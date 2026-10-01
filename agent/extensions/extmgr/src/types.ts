/**
 * Core types for the toggle-only extension manager.
 */

export type Scope = "global" | "project";
export type State = "enabled" | "disabled";

export interface ExtensionEntry {
    id: string;
    scope: Scope;
    state: State;
    activePath: string;
    disabledPath: string;
    displayName: string;
    summary: string;
}
