---
name: skill-creator
description: Guide for creating and updating pi skills (SKILL.md + bundled resources). Use when the user wants to create a new skill, update an existing skill, or asks how to author/structure a skill. Triggers on phrases like "create a skill", "make a skill", "new skill", "update skill", "skill 模板", "创建技能", "新建技能", "写一个 skill".
---

# Skill Creator

Guide for creating effective pi skills. A skill is a folder with a `SKILL.md` that gives pi
specialized procedural knowledge for a domain or task — an "onboarding guide" that turns a
general-purpose agent into a specialized one.

## pi Skill Format

Every skill is a folder containing a required `SKILL.md`:

```
skill-name/
├── SKILL.md            (required) frontmatter + markdown instructions
├── scripts/            (optional) executable code (node/bash/python)
├── references/         (optional) docs loaded into context on demand
└── assets/             (optional) files used in output (templates, images)
```

### SKILL.md (required)

```markdown
---
name: skill-name
description: What the skill does AND when to use it. This is the ONLY trigger surface —
  the body is loaded only after the skill fires, so put all "when to use" info here.
---

# Skill Title

Instructions for using the skill. Imperative voice. Concise.
```

Frontmatter rules (enforced by the pi loader):

- `name` (required): lowercase `a-z0-9-` only, no leading/trailing/double hyphen, ≤64 chars.
  Defaults to the parent directory name if omitted — keep them in sync.
- `description` (required): ≤1024 chars, no angle brackets `<` `>`. This is the **only** text
  the model sees before deciding to load the skill, so be comprehensive about triggers.
- `disable-model-invocation` (optional, default false): when `true`, the skill is hidden from
  the system prompt and can only be invoked explicitly via `/skill:name`. Use for skills that
  should be opt-in only.

No other frontmatter fields are used by pi. Do **not** create codex-style `agents/openai.yaml`.

### Skill Locations (pi-desktop)

| Scope      | Path                              | When to use                                   |
|------------|-----------------------------------|-----------------------------------------------|
| User       | `~/.pi-desktop/skills/<name>/`    | Default — pi-desktop only                     |
| Shared     | `~/.agents/skills/<name>/`        | Shared across pi CLI and other tools          |
| Project    | `<cwd>/.pi-desktop/skills/<name>/`| Skill specific to current pi-desktop project  |

Both `~/.pi-desktop/skills/` and `~/.agents/skills/` are auto-loaded by the SDK as user-level
skills. When creating a skill, **ask the user** which scope they want (default: User). Only use
Project scope if the skill should travel with a specific repo. The pi-desktop settings page
manages user/shared skills (edit/toggle/delete); project skills are edited via the file panel.

## Core Principles

### Concise is Key

The context window is shared with system prompt, history, other skills, and the user request.
**Default assumption: pi is already very smart.** Only add what pi doesn't already know.
Challenge each paragraph: "Does this justify its token cost?" Prefer concrete examples over
verbose explanation.

### Match Freedom to Fragility

- **High freedom** (prose instructions): multiple valid approaches, context-dependent. Use for
  most knowledge/workflow skills.
- **Medium freedom** (pseudocode / parameterized scripts): a preferred pattern exists, some
  variation acceptable.
- **Low freedom** (specific scripts, few params): operation is fragile/error-prone, consistency
  is critical, an exact sequence must be followed.

A narrow bridge over cliffs needs guardrails (low freedom); an open field allows many routes
(high freedom).

### Progressive Disclosure

Skills load in three tiers — design for this:

1. **Metadata** (name + description) — always in context (~100 words). Put all trigger info here.
2. **SKILL.md body** — loaded only when the skill fires. Keep under ~500 lines.
3. **Bundled resources** — loaded on demand by pi (unlimited; scripts can run without reading).

When SKILL.md approaches ~500 lines, split detail into `references/*.md` and link to it from
the body with a clear "read this when…" pointer. Keep references one level deep (linked
directly from SKILL.md, not nested).

- **scripts/**: code that would otherwise be rewritten every time, or needs deterministic
  reliability. Run without loading into context.
- **references/**: docs pi should consult while working (schemas, API refs, policies). Keeps
  SKILL.md lean.
- **assets/**: files used in the *output* pi produces (templates, logos, boilerplate). Not
  loaded into context.

Avoid duplicating info between SKILL.md and references — pick one home for each fact.

### Do Not Include

No `README.md`, `CHANGELOG.md`, `INSTALLATION.md`, or other auxiliary docs. A skill contains
only what an agent needs to do the job — nothing about the process of creating it.

## Creation Process

Follow in order, skipping a step only when it clearly doesn't apply.

### Step 1 — Understand with concrete examples

Clarify what the skill should support. Ask (at most a couple per message):

- "What should this skill do? Can you give 2-3 example requests that should trigger it?"
- "Any workflows that are fragile and need exact steps, vs. open-ended?"
- "User scope (~/.pi-desktop/skills, pi-desktop only), Shared scope (~/.agents/skills, cross-tool),
  or Project scope (<cwd>/.pi/skills, this repo)? Default: User scope."

Conclude when the functionality and trigger phrases are clear.

### Step 2 — Plan reusable contents

For each example, ask: what gets rewritten every time? What does pi re-discover each time?

- Repeated code → `scripts/`
- Re-discovered schemas/docs → `references/`
- Boilerplate/templates reused in output → `assets/`

Only create directories you'll actually fill. Empty `scripts/` dirs are clutter.

### Step 3 — Initialize the skill

Create the folder and a starter `SKILL.md`. Use the template at
[references/skill-template.md](references/skill-template.md) — copy it, then fill in the TODOs.

Ask the user which scope (default User):

```bash
# User scope (pi-desktop only, default)
mkdir -p ~/.pi-desktop/skills/<skill-name>
# Shared scope (cross-tool: pi CLI + pi-desktop)
mkdir -p ~/.agents/skills/<skill-name>
# Project scope (this repo, pi-desktop)
mkdir -p <cwd>/.pi-desktop/skills/<skill-name>
# then write SKILL.md via the write tool, using the template
```

Name rules: lowercase, hyphen-case, verb-led when possible (`rotate-pdf`, `address-comments`),
namespaced by tool when it aids clarity (`gh-address-comments`). Folder name = skill name.

### Step 4 — Implement resources and write SKILL.md

Build `scripts/`, `references/`, `assets/` first (may need user input — e.g. brand assets,
API docs). **Test every script by actually running it** before committing.

Then write SKILL.md:

- **Frontmatter `description`**: state what the skill does AND every trigger scenario/phrase.
  This is the only trigger surface — "When to Use" sections in the body are useless for
  triggering because the body loads *after* the trigger fires.
- **Body**: imperative voice. Include only non-obvious procedural knowledge, decision trees,
  and pointers to bundled resources ("read `references/x.md` when …").

Write for *another instance of pi* that doesn't have your current context.

### Step 5 — Validate

Run the validator (Node, no dependencies):

```bash
node ~/.pi-desktop/skills/skill-creator/scripts/validate-skill.js <path-to-skill-folder>
```

It checks frontmatter format, name rules, description constraints, and required fields. Fix
everything it reports. See [references/pi-skill-format.md](references/pi-skill-format.md) for
the full spec when a validation error is unclear.

### Step 6 — Iterate and forward-test

After using the skill on real tasks, notice struggles and tighten SKILL.md or resources.

For complex/fragile skills, **forward-test**: launch a fresh subagent with a realistic user
request and the skill path, and see if it succeeds *without* your conclusions leaked into its
context. Prompt the subagent like a real user ("Use the skill at /path to do X"), not like a
reviewer ("Test this skill; pretend a user asks…"). If success depends on leaked context,
tighten the skill before trusting it.

## Quick Reference

- Locations: `~/.pi-desktop/skills/` (User), `~/.agents/skills/` (Shared), `<cwd>/.pi/skills/` (Project)
- Frontmatter: `name` + `description` only (+ optional `disable-model-invocation`)
- Validate: `node scripts/validate-skill.js <skill-folder>`
- Template: `references/skill-template.md`
- Spec detail: `references/pi-skill-format.md`
