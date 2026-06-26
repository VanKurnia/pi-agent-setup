import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execSync } from "node:child_process";

// ── Global type augmentation for injected browser script ────
declare global {
	interface Window {
		/** Whether the element picker is already injected */
		__browser_pick_defined?: boolean;
		/** Picker function injected into the page by browser_pick tool */
		__browser_pick?: (message: string) => Promise<any>;
	}
}

// ── Chrome binary detection (Windows-first) ────────────────

function findChromePath(): string | null {
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || "";
    candidates.push(
      path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    // Linux
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fallback: try `which` / `where`
  try {
    const cmd = process.platform === "win32" ? "where chrome" : "which google-chrome chromium chromium-browser";
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const first = out.split("\n")[0]?.trim();
    if (first) return first;
  } catch {}

  return null;
}

// ── Lazy cached wrapper ─────────────────────────────────────

let cachedChromePath: string | null | undefined = undefined;

function getChromePath(): string | null {
  if (cachedChromePath === undefined) {
    cachedChromePath = findChromePath();
  }
  return cachedChromePath;
}

// ── Chrome profile dir ──────────────────────────────────────

function chromeProfileDir(): string {
  const base = process.env["XDG_CACHE_HOME"]
    || (process.platform === "win32"
      ? path.join(process.env["LOCALAPPDATA"] || os.homedir(), "browser-tools")
      : path.join(os.homedir(), ".cache", "browser-tools"));
  return base;
}

// ── Persistent browser connection ─────────────────────────
let cachedBrowser: any = null;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

async function getBrowser(): Promise<any> {
  const puppeteer = await import("puppeteer-core");
  const now = Date.now();

  // If we have a cached connection and it's recently been healthy, reuse it
  if (cachedBrowser && now - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
    return cachedBrowser;
  }

  // Health check: try the existing connection first
  if (cachedBrowser) {
    try {
      const pages = await cachedBrowser.pages();
      lastHealthCheck = now;
      return cachedBrowser;
    } catch {
      // Connection lost — clear and reconnect
      cachedBrowser = null;
    }
  }

  // Connect fresh
  cachedBrowser = await puppeteer.connect({
    browserURL: "http://localhost:9222",
    defaultViewport: null,
  });
  lastHealthCheck = now;
  return cachedBrowser;
}

// ── Format helpers ──────────────────────────────────────────

function formatEvalResult(result: unknown): string {
  if (Array.isArray(result)) {
    return result
      .map((item, i) => {
        if (typeof item === "object" && item !== null) {
          return Object.entries(item)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n");
        }
        return String(item);
      })
      .join("\n---\n");
  }
  if (typeof result === "object" && result !== null) {
    return Object.entries(result)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }
  return String(result);
}

// ── Page content extraction (Readability → Turndown) ───────

async function extractPageContent(url: string): Promise<{
  title: string;
  finalUrl: string;
  markdown: string;
}> {
  const readabilityMod = await import("@mozilla/readability");
  const { Readability } = readabilityMod;

  const jsdomMod = await import("jsdom");
  const { JSDOM } = jsdomMod;

  const turndownMod = await import("turndown");
  const TurndownService = turndownMod.default ?? turndownMod;

  const gfmMod = await import("turndown-plugin-gfm");
  const gfm = gfmMod.gfm ?? gfmMod.default?.gfm ?? gfmMod;

  const b = await getBrowser();

  const pages = await b.pages();
  const p = pages[pages.length - 1];
  if (!p) throw new Error("No active tab found");

  await Promise.race([
    p.goto(url, { waitUntil: "networkidle2" }),
    new Promise((r) => setTimeout(r, 10000)),
  ]).catch(() => {});

  // Get full HTML via CDP (bypasses TrustedScriptURL restrictions)
  const client = await p.createCDPSession();
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const { outerHTML } = await client.send("DOM.getOuterHTML", { nodeId: root.nodeId });
  await client.detach();

  const finalUrl = p.url();
  const doc = new JSDOM(outerHTML, { url: finalUrl });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();

  function htmlToMarkdown(html: string): string {
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    turndown.use(gfm);
    turndown.addRule("removeEmptyLinks", {
      filter: (node: any) => node.nodeName === "A" && !node.textContent?.trim(),
      replacement: () => "",
    });
    return turndown
      .turndown(html)
      .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
      .replace(/ +/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/\s+\./g, ".")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  let content: string;
  if (article?.content) {
    content = htmlToMarkdown(article.content);
  } else {
    // Fallback
    const fallbackDoc = new JSDOM(outerHTML, { url: finalUrl });
    const fallbackBody = fallbackDoc.window.document;
    fallbackBody
      .querySelectorAll("script, style, noscript, nav, header, footer, aside")
      .forEach((el: any) => el.remove());
    const main =
      fallbackBody.querySelector("main, article, [role='main'], .content, #content") || fallbackBody.body;
    const fallbackHtml = main?.innerHTML || "";
    if (fallbackHtml.trim().length > 100) {
      content = htmlToMarkdown(fallbackHtml);
    } else {
      content = "(Could not extract content)";
    }
  }

  return { title: article?.title || "", finalUrl, markdown: content };
}

// ── Chrome start ────────────────────────────────────────────

async function ensureChromeRunning(): Promise<boolean> {
  const puppeteer = await import("puppeteer-core");

  // Check if already running
  try {
    const b = await puppeteer.connect({
      browserURL: "http://localhost:9222",
      defaultViewport: null,
    });
    await b.disconnect();
    return true; // already running
  } catch {}

  // Need to start Chrome
  const chromePath = getChromePath();
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Install Google Chrome or set your Chrome binary path."
    );
  }

  const profileDir = chromeProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });

  // Remove lock files to allow new instance
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.unlinkSync(path.join(profileDir, lock)); } catch {}
  }

  const args = [
    "--remote-debugging-port=9222",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // On Windows, use spaced startup
  if (process.platform === "win32") {
    spawn(`"${chromePath}"`, args, {
      shell: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn(chromePath, args, { detached: true, stdio: "ignore" }).unref();
  }

  // Wait for Chrome to be ready (up to 15s)
  for (let i = 0; i < 30; i++) {
    try {
      const b = await puppeteer.connect({
        browserURL: "http://localhost:9222",
        defaultViewport: null,
      });
      await b.disconnect();
      return false; // just started
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error("Timed out waiting for Chrome to start on :9222");
}

// ── Extension definition ────────────────────────────────────

export default function browserToolsExtension(pi: ExtensionAPI) {

  // Tool 1: Start Chrome
  pi.registerTool({
    name: "browser_start",
    label: "Start Browser",
    description: "Start or connect to Chrome with remote debugging on port 9222. Must be running before using other browser tools.",
    promptSnippet: "Start Chrome browser for automation",
    promptGuidelines: [
      "Use browser_start before any other browser tool if Chrome isn't already running.",
      "If Chrome is already running on :9222, this will detect it and do nothing.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const alreadyRunning = await ensureChromeRunning();
        return {
          content: [{
            type: "text",
            text: alreadyRunning
              ? "✓ Chrome already running on :9222"
              : "✓ Chrome started on :9222",
          }],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Tool 2: Navigate
  pi.registerTool({
    name: "browser_nav",
    label: "Navigate Browser",
    description: "Navigate Chrome to a URL in the current tab (or open a new tab). Chrome must be running on :9222.",
    promptSnippet: "Navigate browser to URL",
    promptGuidelines: [
      "Use browser_nav to navigate the browser to a specific URL.",
      "Use --new flag to open in a new tab instead of reusing the current one.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of current tab" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const b = await getBrowser();
        if (params.newTab) {
          const p = await b.newPage();
          await p.goto(params.url, { waitUntil: "domcontentloaded" });
        } else {
          const pages = await b.pages();
          const p = pages[pages.length - 1];
          if (!p) throw new Error("No active tab found");
          await p.goto(params.url, { waitUntil: "domcontentloaded" });
        }
        return { content: [{ type: "text", text: `✓ Navigated to: ${params.url}` }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ ${e.message}\n  Run browser_start first.` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Tool 3: Evaluate JavaScript
  pi.registerTool({
    name: "browser_eval",
    label: "Evaluate JavaScript",
    description: "Execute JavaScript in the active Chrome tab and return the result.",
    promptSnippet: "Run JavaScript in browser page",
    promptGuidelines: [
      "Use browser_eval to inspect page state, extract data, or test UI interactions.",
      "Wrap multi-statement code in an IIFE or async function.",
      "Prefer DOM inspection over screenshots for checking page state.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript code to execute in the page context" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const b = await getBrowser();
        const pages = await b.pages();
        const p = pages[pages.length - 1];
        if (!p) throw new Error("No active tab found");

        const result = await p.evaluate((c: string) => {
          const AsyncFunction = (async () => {}).constructor as any;
          return new AsyncFunction(`return (${c})`)();
        }, params.code);

        return {
          content: [{ type: "text", text: formatEvalResult(result) }],
          details: { result },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ JavaScript eval failed: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Tool 4: Screenshot
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Capture a screenshot of the current Chrome tab. Saves to a temp file and returns the path.",
    promptSnippet: "Take browser screenshot",
    promptGuidelines: [
      "Use browser_screenshot sparingly — prefer browser_eval for DOM inspection.",
      "Screenshots are useful for visual verification of UI state.",
    ],
    parameters: Type.Object({
      description: Type.Optional(Type.String({ description: "Optional description of what to capture" })),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const b = await getBrowser();
        const pages = await b.pages();
        const p = pages[pages.length - 1];
        if (!p) throw new Error("No active tab found");

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `screenshot-${timestamp}.png`;
        const filepath = path.join(os.tmpdir(), filename);

        await p.screenshot({ path: filepath });

        return {
          content: [{ type: "text", text: `✓ Screenshot saved to: ${filepath}` }],
          details: { filepath },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ Screenshot failed: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Tool 5: Extract page content
  pi.registerTool({
    name: "browser_content",
    label: "Extract Page Content",
    description: "Navigate to a URL and extract readable content as markdown using Mozilla Readability.",
    promptSnippet: "Extract readable content from URL",
    promptGuidelines: [
      "Use browser_content when you need to extract article or main content from a web page as clean markdown.",
      "Works on pages with JavaScript (waits for network idle).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to extract content from" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const extracted = await extractPageContent(params.url);
        let text = `URL: ${extracted.finalUrl}\n`;
        if (extracted.title) text += `Title: ${extracted.title}\n\n`;
        text += extracted.markdown;
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ Content extraction failed: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Tool 6: Cookies
  pi.registerTool({
    name: "browser_cookies",
    label: "Get Browser Cookies",
    description: "List all cookies for the current Chrome tab.",
    promptSnippet: "Get browser cookies",
    promptGuidelines: [
      "Use browser_cookies to debug authentication issues or inspect session state.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const b = await getBrowser();
        const pages = await b.pages();
        const p = pages[pages.length - 1];
        if (!p) throw new Error("No active tab found");

        const cookies = await p.cookies();

        if (cookies.length === 0) {
          return { content: [{ type: "text", text: "No cookies for this page." }], details: {} };
        }

        const lines = cookies.map((c: any) =>
          `${c.name}: ${c.value}\n  domain: ${c.domain}\n  path: ${c.path}\n  httpOnly: ${c.httpOnly}\n  secure: ${c.secure}`
        );
        return { content: [{ type: "text", text: lines.join("\n\n") }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Tool 7: Interactive element picker
  pi.registerTool({
    name: "browser_pick",
    label: "Pick Elements",
    description: "Injects an interactive element picker into the current page. The user clicks elements (Cmd+Click for multi-select, Enter to finish, ESC to cancel). Returns CSS selector info for selected elements.",
    promptSnippet: "Pick elements from browser page",
    promptGuidelines: [
      "Use browser_pick when you need the user to identify specific elements on a page.",
      "Provide a clear message describing what the user should click.",
      "After elements are selected, use the returned info to construct CSS selectors.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "Instruction to display to the user (e.g. 'Click the submit button')" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const b = await getBrowser();
        const pages = await b.pages();
        const p = pages[pages.length - 1];
        if (!p) throw new Error("No active tab found");

        // Inject picker helper
        await p.evaluate(() => {
          if (window.__browser_pick_defined) return;
          window.__browser_pick_defined = true;

          window.__browser_pick = async (message: string) => {
            return new Promise((resolve) => {
              const selections: any[] = [];
              const selectedElements = new Set<Element>();

              const overlay = document.createElement("div");
              overlay.style.cssText =
                "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";

              const highlight = document.createElement("div");
              highlight.style.cssText =
                "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s";
              overlay.appendChild(highlight);

              const banner = document.createElement("div");
              banner.style.cssText =
                "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647";

              const updateBanner = () => {
                banner.textContent = `${message} (${selections.length} selected, Ctrl/Cmd+click to add, Enter to finish, ESC to cancel)`;
              };
              updateBanner();
              document.body.append(banner, overlay);

              const cleanup = () => {
                document.removeEventListener("mousemove", onMove, true);
                document.removeEventListener("click", onClick, true);
                document.removeEventListener("keydown", onKey, true);
                overlay.remove();
                banner.remove();
                selectedElements.forEach((el) => { (el as HTMLElement).style.outline = ""; });
              };

              const buildElementInfo = (el: Element) => {
                const parents: string[] = [];
                let current = el.parentElement;
                while (current && current !== document.body) {
                  const pTag = current.tagName.toLowerCase();
                  const pId = current.id ? `#${current.id}` : "";
                  const pCls = current.className
                    ? `.${current.className.trim().split(/\s+/).join(".")}`
                    : "";
                  parents.push(pTag + pId + pCls);
                  current = current.parentElement;
                }
                return {
                  tag: el.tagName.toLowerCase(),
                  id: (el as HTMLElement).id || null,
                  class: (el as HTMLElement).className || null,
                  text: el.textContent?.trim().slice(0, 200) || null,
                  html: el.outerHTML.slice(0, 500),
                  parents: parents.join(" > "),
                };
              };

              const onMove = (e: MouseEvent) => {
                const el = document.elementFromPoint(e.clientX, e.clientY);
                if (!el || overlay.contains(el) || banner.contains(el)) return;
                const r = el.getBoundingClientRect();
                highlight.style.cssText =
                  `position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
              };

              const onClick = (e: MouseEvent) => {
                if (banner.contains(e.target as Node)) return;
                e.preventDefault();
                e.stopPropagation();
                const el = document.elementFromPoint(e.clientX, e.clientY);
                if (!el || overlay.contains(el) || banner.contains(el)) return;
                if (e.metaKey || e.ctrlKey) {
                  if (!selectedElements.has(el)) {
                    selectedElements.add(el);
                    (el as HTMLElement).style.outline = "3px solid #10b981";
                    selections.push(buildElementInfo(el));
                    updateBanner();
                  }
                } else {
                  cleanup();
                  const info = buildElementInfo(el);
                  resolve(selections.length > 0 ? selections : info);
                }
              };

              const onKey = (e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cleanup();
                  resolve(null);
                } else if (e.key === "Enter" && selections.length > 0) {
                  e.preventDefault();
                  cleanup();
                  resolve(selections);
                }
              };

              document.addEventListener("mousemove", onMove, true);
              document.addEventListener("click", onClick, true);
              document.addEventListener("keydown", onKey, true);
            });
          };
        });

        // Call the picker and wait for user interaction
        const result = await p.evaluate(
          (msg: string) => window.__browser_pick!(msg),
          params.message
        );

        return {
          content: [{ type: "text", text: formatEvalResult(result) }],
          details: { selections: result },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ Element picker failed: ${e.message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Command: Quick Chrome start
  pi.registerCommand("browser", {
    description: "Start Chrome with remote debugging on :9222",
    handler: async (_args, ctx) => {
      try {
        const alreadyRunning = await ensureChromeRunning();
        ctx.ui.notify(
          alreadyRunning ? "Chrome already running on :9222" : "Chrome started on :9222",
          "info"
        );
      } catch (e: any) {
        ctx.ui.notify(`Failed: ${e.message}`, "error");
      }
    },
  });

  // ── Graceful shutdown ──────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (cachedBrowser) {
      try { await cachedBrowser.disconnect(); } catch { /* ignore */ }
      cachedBrowser = null;
    }
  });
}
