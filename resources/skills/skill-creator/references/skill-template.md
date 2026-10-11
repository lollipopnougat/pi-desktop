---
name: {{SKILL_NAME}}
description: [TODO: What this skill does + when to use it. This is the ONLY trigger surface —
  the body loads only after the skill fires, so list every trigger scenario/phrase here.
  Example: "Rotate, merge, and split PDF files. Use when the user asks to manipulate PDF
  documents: rotating pages, merging multiple PDFs, splitting a PDF into parts, or extracting
  text. Triggers on 'rotate pdf', 'merge pdfs', 'split pdf'." ≤1024 chars, no < or >.]
---

# {{SKILL_TITLE}}

## Overview

[TODO: 1-2 sentences. What this skill enables. Imperative voice.]

## When to use

[TODO: Delete this section — "when to use" must live in the frontmatter `description`
above, because the body is only loaded AFTER the skill triggers. Keep this section only
if you need to disambiguate from nearby skills the model might confuse this with.]

## Workflow

[TODO: Core procedural steps. Choose a structure that fits:

**Workflow-Based** (sequential process): ## Step 1 -> ## Step 2 -> ...
**Task-Based** (tool collection): ## Quick start -> ## Task A -> ## Task B -> ...
**Reference/Guidelines** (standards): ## Guidelines -> ## Specs -> ## Usage
**Capabilities-Based** (integrated system): ## Core capabilities -> ### 1. ... -> ### 2. ...

Most skills mix patterns. Delete this guidance when done.]

## [TODO: first main section]

[TODO: content — code samples, decision trees, concrete examples. Point to bundled
resources with relative paths: "read `references/x.md` when …", "run `scripts/y.js` …".]

## Resources (optional — delete section if unused)

### scripts/
Executable code run without loading into context. Use for determinism or repeated logic.
Test every script by actually running it before committing.

### references/
Docs loaded on demand. Keeps SKILL.md lean. Link from here with "read `references/x.md`
when …". Keep one level deep.

### assets/
Files used in the output pi produces (templates, images, boilerplate). Not loaded into
context. Reference by relative path: `assets/template.docx`.
