/**
 * Open Code Review — Pi native tools wrapping the `ocr` CLI
 *
 * Registers:
 *   ocr_review   — Review workspace changes, a single commit, or a ref range (foreground only)
 *   ocr_scan     — Full-file scan (no diff needed, foreground only)
 *   ocr_health   — Check OCR installation and LLM connectivity
 *
 * Follows the official Open Code Review agent integration guidelines:
 *   https://github.com/alibaba/open-code-review/tree/main/skills
 *
 * Key behaviors:
 *   - Runs with the human audience flag and streams progress on stderr;
 *     stdout stays a single JSON document
 *   - Uses `--format json` for machine-readable output
 *   - Reports a setup message when the `ocr` CLI is missing (manual install required)
 *   - Reports findings by priority (High/Medium)
 *   - Only applies fixes when the user explicitly requests it
 *   - Never invents or hardcodes API keys
 *
 * Inspired by the community pi-open-code-review package (mshen6666).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOcrTools } from "./tools.js";
import { resetOcrWidgetState } from "./widget.js";

export default function (pi: ExtensionAPI) {
    registerOcrTools(pi);
    pi.on("session_start", (_event, ctx) => {
        resetOcrWidgetState(ctx);
    });
}
