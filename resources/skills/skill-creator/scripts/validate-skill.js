#!/usr/bin/env node
/**
 * validate-skill.js — validate a pi skill folder.
 *
 * Mirrors the checks in @earendil-works/pi-coding-agent/dist/core/skills.js
 * (frontmatter format, name rules, description constraints) so you can catch
 * issues before reloading the skill loader.
 *
 * Usage:
 *   node validate-skill.js <path-to-skill-folder>
 *
 * Exit codes: 0 = valid, 1 = invalid.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

/** Minimal YAML frontmatter parser (key: value, one level, supports quoted values). */
function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    return { ok: false, error: 'No YAML frontmatter found (file must start with "---")' };
  }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { ok: false, error: 'Invalid frontmatter format (missing closing "---")' };
  }
  const fmText = m[1];
  const body = m[2] || '';
  const fm = {};
  for (const line of fmText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    fm[key] = val;
  }
  return { ok: true, frontmatter: fm, body };
}

function validateName(name) {
  const errors = [];
  if (typeof name !== 'string' || !name) {
    errors.push('name is missing or empty');
    return errors;
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} chars (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('name must be lowercase a-z, 0-9, hyphens only');
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens');
  }
  return errors;
}

function validateDescription(desc) {
  const errors = [];
  if (typeof desc !== 'string' || desc.trim() === '') {
    errors.push('description is required and must not be empty');
    return errors;
  }
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} chars (${desc.length})`);
  }
  if (/<|>/.test(desc)) {
    errors.push('description must not contain angle brackets (< or >)');
  }
  return errors;
}

function main() {
  const skillPath = process.argv[2];
  if (!skillPath) {
    console.error('Usage: node validate-skill.js <path-to-skill-folder>');
    process.exit(1);
  }
  const dir = path.resolve(skillPath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`✗ Skill directory not found: ${dir}`);
    process.exit(1);
  }

  const skillMdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    fail(`SKILL.md not found in ${dir}`);
    process.exit(1);
  }

  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const parsed = parseFrontmatter(content);
  if (!parsed.ok) {
    fail(parsed.error);
    process.exit(1);
  }
  const { frontmatter: fm, body } = parsed;

  // Required fields
  const nameErrors = validateName(fm.name);
  for (const e of nameErrors) fail(`name: ${e}`);
  if (!nameErrors.length) ok(`name "${fm.name}" is valid`);

  const descErrors = validateDescription(fm.description);
  for (const e of descErrors) fail(`description: ${e}`);
  if (!descErrors.length) ok('description is valid');

  // Unknown frontmatter keys (informational — pi ignores them, but warn to keep skills clean)
  const allowed = new Set(['name', 'description', 'disable-model-invocation']);
  const extras = Object.keys(fm).filter((k) => !allowed.has(k));
  if (extras.length) {
    console.warn(`⚠ frontmatter has extra keys (ignored by pi): ${extras.join(', ')}`);
  }

  // Body sanity
  if (!body.trim()) {
    fail('SKILL.md body is empty — skills need instructions');
  } else {
    const lineCount = body.split(/\r?\n/).length;
    if (lineCount > 500) {
      console.warn(`⚠ SKILL.md body is ${lineCount} lines (>500) — consider splitting into references/`);
    } else {
      ok(`body is ${lineCount} lines`);
    }
  }

  // Folder name should match skill name
  const folderName = path.basename(dir);
  if (fm.name && fm.name !== folderName) {
    console.warn(`⚠ folder name "${folderName}" != skill name "${fm.name}" (recommended to keep in sync)`);
  }

  // Stray .md in skill root would be picked up as separate skills by the loader
  // (only when the dir itself is treated as a skills root, but worth flagging)
  const strayMd = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'SKILL.md')
    .map((e) => e.name);
  if (strayMd.length) {
    console.warn(`⚠ .md files in skill root may be loaded as separate skills: ${strayMd.join(', ')} (move to references/)`);
  }

  if (process.exitCode) {
    console.error('\nValidation FAILED.');
    process.exit(1);
  } else {
    console.log('\nSkill is valid! ✓');
    process.exit(0);
  }
}

main();
