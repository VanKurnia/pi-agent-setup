import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionApi } from "../shared/cross-extension-api.js";
import { registerOperations } from "./operations.js";
import { runGit } from "./helpers.js";

export default function (pi: ExtensionAPI) {
    registerOperations(pi);
    registerExtensionApi("git-toolkit", { runGit });
}
