<p align="center">
  <img src="https://pi.dev/logo-auto.svg" width="120" alt="pi">
</p>

<h1 align="center">Pi Agent Setup</h1>

<p align="center">
  <a href="https://github.com/VanKurnia/pi-agent-setup"><img src="https://img.shields.io/github/stars/VanKurnia/pi-agent-setup?style=flat-square&logo=github" alt="Stars"></a>
  <a href="https://github.com/VanKurnia/pi-agent-setup/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-0.87.1-8A2BE2?style=flat-square" alt="pi"></a>
</p>

<p align="center">
  Minimal Opinionated <a href="https://pi.dev">Pi</a> Coding Agent Setup,
  Optimized for Work & Minimal Resource Usages
</p>

<p align="center">
  <a href="#why-this-setup">Why This Setup</a> •
  <a href="#quick-setup">Quick Setup</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#custom-models">Custom Models</a>
</p>

---

## Why This Setup

Three decisions shape this configuration.

### 1. A context window that survives long sessions

[`blackhole`](agent/extensions/blackhole/) — four `.ts` files — compacts context instead of
dropping it, by combining two mechanisms:

- **Observational Memory**, modelled on
  [Mastra's OM research](https://mastra.ai/research/observational-memory) — 84.23% on LongMemEval
  with `gpt-4o`, 94.87% with `gpt-5-mini`: a background **Observer** and **Reflector** turn raw
  history into a dense observation log that lives in the context window. Here the observer wakes at
  25k unobserved tokens, the reflector at 80k, and the observation pool stays bounded (40k render
  budget, trimmed toward 20k under pressure) so memory can never crowd out the session.

  <img src="https://mastra.ai/_next/image?url=%2Fimages%2Fresearch%2Fom-gpt4o-overall.jpeg&amp;w=1920&amp;q=75" alt="Mastra Observational Memory — LongMemEval results with gpt-4o" width="720">
- **VCC summaries** — the sectioned summary format from upstream `pi-vcc`, based on
  [VCC — View-oriented Conversation Compiler](https://arxiv.org/abs/2603.29678) (Stanford), which
  lowers agent traces into structured, role-annotated views instead of handing them to a reflector
  as plain text or JSON. One summary per compaction: memory first, then recent conversation,
  carried context, files touched, recent commits. It is always composed inside a fixed budget, with
  memory capped at a share so no single section starves the others.

<figure id="S3.T1" class="ltx_table">

<div class="ltx_flex_cell ltx_flex_size_1">
<p id="S3.T1.6" class="ltx_p ltx_figure_panel ltx_align_center">(b) Claude Code 2.1.81: claude-sonnet-4-6 (generator) + claude-sonnet-4-6 (reflector)</p></div><div class="ltx_flex_break"></div><div class="ltx_flex_cell ltx_flex_size_1">
<div id="S3.T1.7" class="ltx_inline-block ltx_figure_panel ltx_align_center ltx_transformed_outer" style="width:345.0pt;height:31.1pt;vertical-align:-14.3pt;"><span class="ltx_transformed_inner" style="transform:translate(-168.7pt,15.2pt) scale(0.505629514663051,0.505629514663051) ;">
<table id="S3.T1.7.1" class="ltx_tabular ltx_guessed_headers ltx_align_middle">
<tbody class="ltx_tbody">
<tr id="S3.T1.7.1.1" class="ltx_tr">
<th id="S3.T1.7.1.1.1" class="ltx_td ltx_th ltx_th_row ltx_border_tt"></th>
<th id="S3.T1.7.1.1.2" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_tt" colspan="4">TN task_goal</th>
<th id="S3.T1.7.1.1.3" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_tt" colspan="4">TN scenario_goal</th>
<th id="S3.T1.7.1.1.4" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_tt" colspan="4">TC task_goal</th>
<th id="S3.T1.7.1.1.5" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_tt" colspan="4">TC scenario_goal</th>
<th id="S3.T1.7.1.1.6" class="ltx_td ltx_th ltx_th_column ltx_border_tt"></th>
<th id="S3.T1.7.1.1.7" class="ltx_td ltx_th ltx_th_column ltx_border_tt"></th>
<td id="S3.T1.7.1.1.8" class="ltx_td ltx_border_tt"></td></tr>
<tr id="S3.T1.7.1.2" class="ltx_tr">
<th id="S3.T1.7.1.2.1" class="ltx_td ltx_align_left ltx_th ltx_th_column ltx_th_row">Method</th>
<th id="S3.T1.7.1.2.2" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">all</th>
<th id="S3.T1.7.1.2.3" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d1</th>
<th id="S3.T1.7.1.2.4" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d2</th>
<th id="S3.T1.7.1.2.5" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d3</th>
<th id="S3.T1.7.1.2.6" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">all</th>
<th id="S3.T1.7.1.2.7" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d1</th>
<th id="S3.T1.7.1.2.8" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d2</th>
<th id="S3.T1.7.1.2.9" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d3</th>
<th id="S3.T1.7.1.2.10" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">all</th>
<th id="S3.T1.7.1.2.11" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d1</th>
<th id="S3.T1.7.1.2.12" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d2</th>
<th id="S3.T1.7.1.2.13" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d3</th>
<th id="S3.T1.7.1.2.14" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">all</th>
<th id="S3.T1.7.1.2.15" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d1</th>
<th id="S3.T1.7.1.2.16" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d2</th>
<th id="S3.T1.7.1.2.17" class="ltx_td ltx_align_center ltx_th ltx_th_column ltx_border_t">d3</th>
<th id="S3.T1.7.1.2.18" class="ltx_td ltx_align_center ltx_th ltx_th_column">T tok</th>
<th id="S3.T1.7.1.2.19" class="ltx_td ltx_align_center ltx_th ltx_th_column">T/a</th>
<th id="S3.T1.7.1.2.20" class="ltx_td ltx_align_center ltx_th ltx_th_column">Mem</th></tr>
<tr id="S3.T1.7.1.3" class="ltx_tr">
<th id="S3.T1.7.1.3.1" class="ltx_td ltx_align_left ltx_th ltx_th_row ltx_border_t">Baseline</th>
<td id="S3.T1.7.1.3.2" class="ltx_td ltx_align_center ltx_border_t">73.2</td>
<td id="S3.T1.7.1.3.3" class="ltx_td ltx_align_center ltx_border_t">77.2</td>
<td id="S3.T1.7.1.3.4" class="ltx_td ltx_align_center ltx_border_t">58.3</td>
<td id="S3.T1.7.1.3.5" class="ltx_td ltx_align_center ltx_border_t">81.0</td>
<td id="S3.T1.7.1.3.6" class="ltx_td ltx_align_center ltx_border_t">67.9</td>
<td id="S3.T1.7.1.3.7" class="ltx_td ltx_align_center ltx_border_t">73.7</td>
<td id="S3.T1.7.1.3.8" class="ltx_td ltx_align_center ltx_border_t">50.0</td>
<td id="S3.T1.7.1.3.9" class="ltx_td ltx_align_center ltx_border_t">76.2</td>
<td id="S3.T1.7.1.3.10" class="ltx_td ltx_align_center ltx_border_t">61.4</td>
<td id="S3.T1.7.1.3.11" class="ltx_td ltx_align_center ltx_border_t">61.1</td>
<td id="S3.T1.7.1.3.12" class="ltx_td ltx_align_center ltx_border_t">59.3</td>
<td id="S3.T1.7.1.3.13" class="ltx_td ltx_align_center ltx_border_t">63.1</td>
<td id="S3.T1.7.1.3.14" class="ltx_td ltx_align_center ltx_border_t">50.4</td>
<td id="S3.T1.7.1.3.15" class="ltx_td ltx_align_center ltx_border_t">45.8</td>
<td id="S3.T1.7.1.3.16" class="ltx_td ltx_align_center ltx_border_t">50.0</td>
<td id="S3.T1.7.1.3.17" class="ltx_td ltx_align_center ltx_border_t">52.3</td>
<td id="S3.T1.7.1.3.18" class="ltx_td ltx_align_center ltx_border_t">—</td>
<td id="S3.T1.7.1.3.19" class="ltx_td ltx_align_center ltx_border_t">—</td>
<td id="S3.T1.7.1.3.20" class="ltx_td ltx_align_center ltx_border_t">—</td></tr>
<tr id="S3.T1.7.1.4" class="ltx_tr">
<th id="S3.T1.7.1.4.1" class="ltx_td ltx_align_left ltx_th ltx_th_row">JSON</th>
<td id="S3.T1.7.1.4.2" class="ltx_td ltx_align_center">90.5</td>
<td id="S3.T1.7.1.4.3" class="ltx_td ltx_align_center"><span id="S3.T1.7.1.4.3.1" class="ltx_text ltx_font_bold">98.2</span></td>
<td id="S3.T1.7.1.4.4" class="ltx_td ltx_align_center">91.7</td>
<td id="S3.T1.7.1.4.5" class="ltx_td ltx_align_center">82.5</td>
<td id="S3.T1.7.1.4.6" class="ltx_td ltx_align_center">82.1</td>
<td id="S3.T1.7.1.4.7" class="ltx_td ltx_align_center"><span id="S3.T1.7.1.4.7.1" class="ltx_text ltx_font_bold">94.7</span></td>
<td id="S3.T1.7.1.4.8" class="ltx_td ltx_align_center">81.2</td>
<td id="S3.T1.7.1.4.9" class="ltx_td ltx_align_center">71.4</td>
<td id="S3.T1.7.1.4.10" class="ltx_td ltx_align_center">71.0</td>
<td id="S3.T1.7.1.4.11" class="ltx_td ltx_align_center">86.1</td>
<td id="S3.T1.7.1.4.12" class="ltx_td ltx_align_center">66.7</td>
<td id="S3.T1.7.1.4.13" class="ltx_td ltx_align_center">68.7</td>
<td id="S3.T1.7.1.4.14" class="ltx_td ltx_align_center">60.4</td>
<td id="S3.T1.7.1.4.15" class="ltx_td ltx_align_center">75.0</td>
<td id="S3.T1.7.1.4.16" class="ltx_td ltx_align_center">54.0</td>
<td id="S3.T1.7.1.4.17" class="ltx_td ltx_align_center">60.0</td>
<td id="S3.T1.7.1.4.18" class="ltx_td ltx_align_center">20.5M</td>
<td id="S3.T1.7.1.4.19" class="ltx_td ltx_align_center">115K</td>
<td id="S3.T1.7.1.4.20" class="ltx_td ltx_align_center">23.4K</td></tr>
<tr id="S3.T1.7.1.5" class="ltx_tr">
<th id="S3.T1.7.1.5.1" class="ltx_td ltx_align_left ltx_th ltx_th_row ltx_border_bb">VCC</th>
<td id="S3.T1.7.1.5.2" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.2.1" class="ltx_text ltx_font_bold">92.9</span></td>
<td id="S3.T1.7.1.5.3" class="ltx_td ltx_align_center ltx_border_bb">96.5</td>
<td id="S3.T1.7.1.5.4" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.4.1" class="ltx_text ltx_font_bold">95.8</span></td>
<td id="S3.T1.7.1.5.5" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.5.1" class="ltx_text ltx_font_bold">87.3</span></td>
<td id="S3.T1.7.1.5.6" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.6.1" class="ltx_text ltx_font_bold">89.3</span></td>
<td id="S3.T1.7.1.5.7" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.7.1" class="ltx_text ltx_font_bold">94.7</span></td>
<td id="S3.T1.7.1.5.8" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.8.1" class="ltx_text ltx_font_bold">93.8</span></td>
<td id="S3.T1.7.1.5.9" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.9.1" class="ltx_text ltx_font_bold">81.0</span></td>
<td id="S3.T1.7.1.5.10" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.10.1" class="ltx_text ltx_font_bold">74.3</span></td>
<td id="S3.T1.7.1.5.11" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.11.1" class="ltx_text ltx_font_bold">88.9</span></td>
<td id="S3.T1.7.1.5.12" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.12.1" class="ltx_text ltx_font_bold">68.7</span></td>
<td id="S3.T1.7.1.5.13" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.13.1" class="ltx_text ltx_font_bold">73.3</span></td>
<td id="S3.T1.7.1.5.14" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.14.1" class="ltx_text ltx_font_bold">63.3</span></td>
<td id="S3.T1.7.1.5.15" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.15.1" class="ltx_text ltx_font_bold">79.2</span></td>
<td id="S3.T1.7.1.5.16" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.16.1" class="ltx_text ltx_font_bold">56.0</span></td>
<td id="S3.T1.7.1.5.17" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.17.1" class="ltx_text ltx_font_bold">63.1</span></td>
<td id="S3.T1.7.1.5.18" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.18.1" class="ltx_text ltx_font_bold">8.8M</span></td>
<td id="S3.T1.7.1.5.19" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.19.1" class="ltx_text ltx_font_bold">49K</span></td>
<td id="S3.T1.7.1.5.20" class="ltx_td ltx_align_center ltx_border_bb"><span id="S3.T1.7.1.5.20.1" class="ltx_text ltx_font_bold">15.5K</span></td></tr>
</tbody>
</table>
</span></div></div>
</figure>

The payoff: better, faster compaction that stays bounded as a session ages — and a `recall` tool
that searches the full transcript (message text and tool-call payloads) whenever the summary is not
enough. Memory moves forward; it does not evaporate.

### 2. Two subagents — minimal, foreground, context-aware

[`herdr-subagents`](agent/extensions/herdr-subagents/) registers exactly two agents:

- **`scout`** — read-only recon: codebase mapping, fact-checking, lightweight web research.
- **`worker`** — the main agent's working toolset, for actual changes.

Each agent runs as a separate pi-bolt process in its own herdr pane; only the final reply is returned, no polling for
results. Each is handed a **read-only VCC snapshot of the parent** at delegation time — files
touched, recent commits, live observations — and can drill into the parent's own history with
`recall source:'parent'` when that is not enough. Delegation without the usual context loss: the
context-isolated-thread design [AOrchestra](https://arxiv.org/abs/2602.03786) credits with
mitigating context rot.

<img src="https://arxiv.org/html/2602.03786v2/diff.png" alt="AOrchestra Figure 2: sub-agent-as-tools designs compared — context-isolated threads, static predefined roles, and on-demand specialization" width="720">

*Figure 2 of [AOrchestra](https://arxiv.org/abs/2602.03786) — context-isolated threads vs static predefined roles.*

Two measurements bound the claim: [MAST](https://arxiv.org/abs/2503.13657) measured **41%–86.7%**
failure rates across 7 state-of-the-art open-source multi-agent systems (1600+ annotated traces) —
the case for a small cast. AOrchestra reports **+16.28%** relative over its strongest baseline on
GAIA, SWE-Bench and Terminal-Bench with curated per-sub-agent context, but it spawns sub-agents
dynamically rather than fixing two, and neither paper measures this repository's `scout`/`worker`.

### 3. A workflow built on `improve`

The working loop follows [shadcn/improve](https://github.com/shadcn/improve) — audit with your
strongest model, write plans, execute with a cheaper one — wired into the tools that already exist
here: recon dispatches sequential `scout` calls, one at a time, plans land in `.plans/` (browsable through
`plan-artifact`), probes live in `.plans/probes/`, and execution is dispatched to `worker`
subagents. The plan is the handoff artifact: the planner/executor split
[Plan-and-Act](https://arxiv.org/abs/2503.09572) formalizes for long-horizon tasks.

<img src="https://arxiv.org/html/2503.09572v1/System_Diagram.png" alt="Plan-and-Act Figure 1: a Planner turns the user query into a structured multi-step plan, a separate Executor turns each step into environment actions, and observations trigger replanning" width="720">

*Figure 1 of [Plan-and-Act](https://arxiv.org/abs/2503.09572) — the Planner writes structured plans, a separate Executor implements them.*

Planner/executor separation is what carries long-horizon work
([Plan-and-Act](https://arxiv.org/abs/2503.09572): **57.58%** on WebArena-Lite, **81.36%** on
WebVoyager); the cost argument is separate ([FrugalGPT](https://arxiv.org/abs/2305.05176): GPT-4-level
results at up to **98%** lower cost). Neither measures this loop — Plan-and-Act trains both roles,
FrugalGPT routes queries rather than splitting them.

---

## Quick Setup

Clone this repo to `~/.pi` — pi reads everything from there.

> **Run these commands in Git Bash.** On Windows, `~` expands in bash but **not** in cmd or PowerShell. Alternatives: `%USERPROFILE%\.pi` (cmd) or `$HOME\.pi` (PowerShell).

### Fresh machine

```bash
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi
bash install.sh
```

Then run `/login` inside pi to set up your provider.

### Upgrading an existing setup

```bash
cd ~/.pi
bash install.sh
```

`install.sh` is idempotent: it fetches the latest version, stashes any local changes, and reinstalls dependencies while preserving your existing config files.

> **Note:** `install.sh` is the entry point for fresh machines; `/update-setup` (via `.script/update.sh`) is the updater for existing checkouts.

### Post-install

- **`/login`** — authenticate with your provider (API key or subscription)
- **Nerd Font** — required for icons in the TUI. Without one, you'll see garbled characters in menus and dialogs. [Download here](https://www.nerdfonts.com/font-downloads).

---

## Configuration

### Provider & Models

Set your default provider and model in `agent/settings.json`:

```json
{
    "defaultProvider": "opencode-go",
    "defaultModel": "muse-spark-1.3-contributor",
    "defaultThinkingLevel": "xhigh"
}
```

### Shell (Windows)

Pi auto-detects Git Bash. Only set a custom path for non-standard installations:

```json
{
    "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

### Subagent Models

Configure per-agent models via `/herdr-subagent:settings` inside pi. Settings are stored in `agent/subagents.json`:

```json
{
    "agentModels": {
        "scout": "opencode-go/mimo-v2.6-flash",
        "worker": "opencode-go/muse-spark-1.3-contributor"
    },
    "agentThinking": {
        "scout": "high",
        "worker": "xhigh"
    }
}
```

Per-agent models plus thinking levels, edited via `/herdr-subagent:settings` — settings are the single source of truth.

### Custom Models

Add local or custom API endpoints in `agent/models.json`:

```jsonc
{
    "providers": {
        "ollama": {
            "baseUrl": "http://localhost:11434/v1",
            "api": "openai-completions",
            "apiKey": "ollama",
            "models": [{ "id": "llama3.2" }, { "id": "deepseek-coder:6.7b" }],
        },
        "lm-studio": {
            "baseUrl": "http://localhost:1234/v1",
            "api": "openai-completions",
            "apiKey": "lm-studio",
            "models": [{ "id": "local-model" }],
        },
    },
}
```

See [pi.dev/docs/latest/models](https://pi.dev/docs/latest/models) for provider details.

## Acknowledgements

Inspired by [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).
