import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionApi } from "../shared/cross-extension-api.ts";
import { registerMemoryWrite } from "./memory_write.ts";
import { registerMemoryRecall } from "./memory_recall.ts";

export default function (pi: ExtensionAPI) {
    registerMemoryWrite(pi);
    registerMemoryRecall(pi);
    registerExtensionApi("obsidian-memory", {});
}
