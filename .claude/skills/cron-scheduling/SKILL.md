---
name: cron-scheduling
description: "Prevents cron expression errors by providing a helper that computes expressions from time deltas. MUST be used before any CronCreate call. Triggers: 'schedule', 'cron', 'check in N minutes', 'remind me', 'set a timer', CronCreate."
---

# Cron Scheduling -- Safe Cron Expression Generation

## The Problem

Agents frequently get cron expressions wrong when scheduling one-shot checks (e.g., "check in 30 minutes"). Manually reading `date` output and computing minute/hour/day/month leads to:
- Wrong day-of-month (off-by-one on midnight rollover)
- UTC vs local time confusion
- Month boundary errors

## The Rule

**NEVER manually compute cron expressions.** Always use the `cronafter` helper.

## Usage

The `cronafter` script lives in this skill's directory. Run it with a time delta:

```bash
# Find the script path (it's in the same directory as this SKILL.md)
SKILL_DIR="$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"

# Or just use the known path:
cronafter_path="$HOME/.claude/skills/cron-scheduling/cronafter"

# Generate a cron expression for "30 minutes from now"
CRON=$($cronafter_path 30m)
# Output: 48 23 26 3 *

# Then use it with CronCreate:
# CronCreate(cron: "$CRON", recurring: false, prompt: "Check deploy status")
```

### Supported deltas

| Delta | Meaning |
|-------|---------|
| `30m` | 30 minutes from now |
| `2h` | 2 hours from now |
| `1d` | 1 day from now |
| `1h30m` | 1 hour and 30 minutes from now |
| `2d12h` | 2 days and 12 hours from now |

The script handles midnight rollover, month boundaries, and always uses the system's local timezone.

## Workflow

When you need to schedule something for a future time:

1. Determine the delta (e.g., "check in 30 minutes" = `30m`)
2. Run: `$HOME/.claude/skills/cron-scheduling/cronafter 30m`
3. Capture the output (e.g., `48 23 26 3 *`)
4. Pass that expression to `CronCreate` with `recurring: false`

```
# Example: "check the deploy in 30 minutes"
CRON=$($HOME/.claude/skills/cron-scheduling/cronafter 30m)
CronCreate(cron: "$CRON", recurring: false, prompt: "Check deploy status and report")
```

## When This Applies

- Any use of `CronCreate` with a one-shot schedule
- Any request like "check in X minutes/hours"
- Any request like "remind me in X"
- Any time you need to convert a relative time to a cron expression

## When This Does NOT Apply

- Recurring schedules with simple patterns (e.g., "every 5 minutes" = `*/5 * * * *`)
- Schedules already given as absolute cron expressions by the user
