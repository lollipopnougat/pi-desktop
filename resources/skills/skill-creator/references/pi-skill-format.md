# pi Skill Format (full spec)

Source of truth: `node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js`.
Read this when a validation error is unclear or you need loader behavior details.

## Frontmatter

```yaml
---
name: my-skill
description: One to a few sentences. What + when. No angle brackets.
disable-model-invocation: false
---
```

| Field                     | Required | Constraints                                                  |
|---------------------------|----------|--------------------------------------------------------------|
| `name`                    | yes*     | `^[a-z0-9-]+$`, no leading/trailing/double `-`, ≤64 chars. Defaults to parent dir name if omitted. |
| `description`             | yes      | non-empty, ≤1024 chars, no `<` or `>`.                       |
| `disable-model-invocation`| no       | `true`/`false` (default `false`).                            |

*`name` is technically optional (falls back to directory name) but always set it explicitly
to stay in sync with the folder name.

No other fields are read by the pi loader. Any extra frontmatter keys are ignored (not
rejected), but don't rely on them.

## Discovery rules

The loader scans a skills directory as follows:

1. If a directory contains `SKILL.md`, treat it as a skill root — **do not recurse further**
   into it. The skill's `baseDir` is that directory.
2. Otherwise, load direct `.md` children of the directory root (each is a standalone skill,
   `baseDir` = the root dir).
3. Recurse into subdirectories to find `SKILL.md` or more `.md` skills.

Practical implication: a skill with bundled `scripts/`/`references/`/`assets/` **must** live
in its own subdirectory (rule 1), so the loader treats the folder as one skill and doesn't
try to load `references/foo.md` as a separate skill.

## Ignore rules

The loader honors `.gitignore` / `.ignore` / `.fdignore` files found while scanning. Dotfiles
and `node_modules/` are skipped.

## Source / scope (how a skill was loaded)

Each skill carries a `sourceInfo` describing origin:

- `source: "local"`, `scope: "user"` — from `~/.pi-desktop/skills/` (agentDir)
- `source: "local"`, `scope: "project"` — from `<cwd>/.pi/skills/`
- `source: "local"` (no scope) — from an explicit `additionalSkillPaths` entry
- `source: "package"` / `origin: "package"` — bundled inside an npm package

pi-desktop's settings page shows user/project/package skills and allows edit/toggle/delete on
user & project skills. `disable-model-invocation` is toggled by rewriting the frontmatter.

## System prompt injection

Visible skills (where `disable-model-invocation` is false) are injected into the system prompt
in XML form:

```xml
<available_skills>
  <skill>
    <name>skill-name</name>
    <description>…</description>
    <location>/abs/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

The model is instructed: "Use the read tool to load a skill's file when the task matches its
description. When a skill file references a relative path, resolve it against the skill
directory (parent of SKILL.md) and use that absolute path in tool commands."

So: **relative paths inside SKILL.md resolve against the skill's own directory** — use
`references/foo.md`, `scripts/bar.js`, etc. and they will resolve correctly.

## Name collision handling

If two skills share the same `name`, the loader emits a `collision` diagnostic and keeps the
first one loaded. Later skills with the same name are dropped. Give skills unique names.

## Validation checklist (mirrors `validate-skill.js`)

- [ ] `SKILL.md` exists and starts with `---`
- [ ] Frontmatter is valid YAML with a `name` and `description`
- [ ] `name` matches `^[a-z0-9-]+$`, no leading/trailing/double hyphen, ≤64 chars
- [ ] `description` non-empty, ≤1024 chars, no `<` or `>`
- [ ] Folder name matches `name` (recommended)
- [ ] No stray `.md` files in the skill root that the loader might pick up as separate skills
      (put docs in `references/`)
