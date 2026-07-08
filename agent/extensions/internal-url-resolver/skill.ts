import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_DIR, formatError, PiUrlResult } from "./types.js";

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

export function resolveSkillUrl(path: string, url: string): PiUrlResult {
    if (!path) {
        return { content: "", mime: "text/markdown", protocol: "skill", path };
    }

    const parts = path.split("/");
    const name = parts[0];

    if (parts.length >= 3 && parts[1] === "reference") {
        const refPath = parts.slice(2).join("/");
        const base = join(SKILLS_DIR, name, "reference");
        const file = join(base, refPath);
        if (!file.startsWith(base) || !existsSync(file)) {
            return {
                content: formatError(`Skill reference not found: ${name} → ${refPath}`, url),
                mime: "text/markdown",
                protocol: "skill",
                path,
            };
        }
        const content = safeRead(file);
        return content !== null
            ? { content, mime: "text/markdown", protocol: "skill", path }
            : {
                  content: formatError(`Cannot read: ${file}`, url),
                  mime: "text/markdown",
                  protocol: "skill",
                  path,
              };
    }

    const dir = join(SKILLS_DIR, name);
    const candidates = [join(dir, "SKILL.md"), join(dir, `${name}.md`), join(dir, "README.md")];
    const file = candidates.find((c) => existsSync(c));
    if (!file)
        return {
            content: formatError(`Skill not found: ${name}`, url),
            mime: "text/markdown",
            protocol: "skill",
            path,
        };

    const content = safeRead(file);
    return content !== null
        ? { content, mime: "text/markdown", protocol: "skill", path }
        : {
              content: formatError(`Cannot read: ${file}`, url),
              mime: "text/markdown",
              protocol: "skill",
              path,
          };
}
