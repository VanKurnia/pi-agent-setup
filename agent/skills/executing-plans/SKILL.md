---
name: executing-plans
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
---

# Executing Plans

## Pi-Specific Tool Mapping

| Generic action | Pi tool |
|---|---|
| "Read the plan file" | `read <path>` |
| "Create todos" | Track in plan file with `edit` or write a `.superpowers/tasks.md` via `write` |
| "Run test/verify command" | `bash <command>` |
| "Commit changes" | `git_add` + `git_commit`, or `bash` with `git commit` |
| "Check git status" | `git_status` |
| "Switch branches" | `git_checkout` |
| "Create a branch" | `git_create_branch` |
| "Use subagent-driven-development" | `read` the skill's SKILL.md and follow it |
| "Use finishing-a-development-branch" | `read` the skill's SKILL.md and follow it |

**Subagent note:** If subagents are available in pi (via the `subagent` tool), use `subagent-driven-development` instead of this skill for parallel session execution. This skill is for sequential execution when subagents aren't available or when tasks are tightly coupled.

See [pi-tools.md](../using-superpowers/references/pi-tools.md) for the complete reference.

---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Note:** On platforms with subagent support, use superpowers:subagent-driven-development instead of this skill. On Pi, you have the `subagent` tool available.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create todos for the plan items and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

### Step 3: Complete Development

After all tasks complete and verified:
- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch
- Follow that skill to verify tests, present options, execute choice

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent

## Integration

**Required workflow skills:**
- **superpowers:using-git-worktrees** - Ensures isolated workspace (creates one or verifies existing)
- **superpowers:writing-plans** - Creates the plan this skill executes
- **superpowers:finishing-a-development-branch** - Complete development after all tasks
