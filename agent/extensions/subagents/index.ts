import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent from "./register.js";

export default function subagent(pi: ExtensionAPI) {
	registerSubagent(pi);
}