import { Text } from "@earendil-works/pi-tui";

export function renderCall(label: string, pick: (args: Record<string, unknown>) => string | undefined = () => undefined) {
  return (args: Record<string, unknown>, theme: any) => {
    const suffix = pick(args);
    return new Text(`${theme.fg("toolTitle", theme.bold(`${label} `))}${suffix ? theme.fg("accent", suffix) : ""}`, 0, 0);
  };
}

export function renderResult(label: string) {
  return (result: { details?: Record<string, unknown> }, _options: unknown, theme: any) => {
    switch (label) {
      case "check_index_coverage": {
        const details = result.details ?? {};
        const cov = details.data as Record<string, unknown> | undefined;
        if (!cov) return new Text(theme.fg("muted", JSON.stringify(result, null, 2)), 0, 0);
        let out = "";
        if (Array.isArray(cov.paths) && cov.paths.length > 0) {
          out += "Paths checked:\n";
          for (const p of cov.paths as Array<{ path: string; status: string; freshness: string }>) {
            out += `• ${p.path} [${p.status} - ${p.freshness}]\n`;
          }
          out += "\n";
        }
        if (Array.isArray(cov.scopes) && cov.scopes.length > 0) {
          out += "Scopes checked:\n";
          for (const s of cov.scopes as Array<{ path: string; status: string; freshness: string }>) {
            out += `• ${s.path} [${s.status} - ${s.freshness}]\n`;
          }
        }
        if (!out && cov.error) out = `Error: ${String(cov.error)}`;
        return new Text(out.trim() ? theme.fg("toolTitle", out.trim()) : theme.fg("muted", JSON.stringify(result, null, 2)), 0, 0);
      }
      default: {
        const details = result.details ?? {};
        const args = details.args as Record<string, unknown> | undefined;
        const data = details.data as Record<string, unknown> | undefined;
        const bits: string[] = [theme.fg("success", `✓ ${label}`)];
        if (args?.project) bits.push(theme.fg("muted", `project=${String(args.project)}`));
        if (typeof data?.total === "number") bits.push(theme.fg("muted", `total=${data.total}`));
        if (typeof data?.has_more === "boolean" && data.has_more) bits.push(theme.fg("warning", "has_more"));
        if (details.fullOutputPath) bits.push(theme.fg("warning", `full=${String(details.fullOutputPath)}`));
        if (details.uncompactedOutputPath) bits.push(theme.fg("warning", `uncompacted=${String(details.uncompactedOutputPath)}`));
        return new Text(bits.join(" "), 0, 0);
      }
    }
  };
}
