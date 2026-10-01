import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PackageManifest {
    name?: string;
    dependencies?: Record<string, string>;
    pi?: {
        extensions?: unknown;
    };
}

export async function readPackageManifest(
    packageRoot: string,
): Promise<PackageManifest | undefined> {
    const packageJsonPath = join(packageRoot, "package.json");

    try {
        const raw = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
        }
        return parsed as PackageManifest;
    } catch {
        return undefined;
    }
}
