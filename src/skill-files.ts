/**
 * Project skill files: where they live, what already exists, and what a valid
 * SKILL.md looks like (Agent Skills frontmatter as Pi loads it).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const SKILL_DIR_CANDIDATES = [".agents/skills", ".pi/skills"] as const;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** Git root of `cwd`, or `cwd` itself outside a repository. */
export function projectRoot(cwd: string): string {
	let current = cwd;
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return cwd;
		current = parent;
	}
}

/** The repo's existing skills folder, `.agents/skills` first; `.agents/skills` when none exists yet. */
export function skillsDir(root: string): string {
	for (const candidate of SKILL_DIR_CANDIDATES) {
		const path = join(root, candidate);
		if (existsSync(path) && statSync(path).isDirectory()) return path;
	}
	return join(root, SKILL_DIR_CANDIDATES[0]);
}

export interface ExistingSkill {
	name: string;
	description: string;
	path: string;
}

/** Skills already in the project, from every supported folder. */
export function listProjectSkills(root: string): ExistingSkill[] {
	const skills: ExistingSkill[] = [];
	for (const candidate of SKILL_DIR_CANDIDATES) {
		const dir = join(root, candidate);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir)) {
			const file = join(dir, entry, "SKILL.md");
			if (!existsSync(file)) continue;
			const parsed = parseFrontmatter(readFileSync(file, "utf8"));
			skills.push({ name: parsed.fields.name ?? entry, description: parsed.fields.description ?? "", path: file });
		}
	}
	return skills;
}

export interface Frontmatter {
	fields: Record<string, string>;
	body: string;
	hasFrontmatter: boolean;
}

/** Minimal YAML frontmatter reader: `key: value` lines, quoted or plain. */
export function parseFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) return { fields: {}, body: text, hasFrontmatter: false };
	const fields: Record<string, string> = {};
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (!field) continue;
		let value = (field[2] ?? "").trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[field[1] ?? ""] = value;
	}
	return { fields, body: match[2] ?? "", hasFrontmatter: true };
}

export interface ValidationResult {
	ok: boolean;
	problems: string[];
}

export function validateSkill(name: string, content: string): ValidationResult {
	const problems: string[] = [];
	if (!NAME_PATTERN.test(name)) problems.push(`name "${name}" must be lowercase letters, numbers, and single hyphens`);
	if (name.length > MAX_NAME) problems.push(`name is ${name.length} characters (max ${MAX_NAME})`);

	const parsed = parseFrontmatter(content);
	if (!parsed.hasFrontmatter) {
		problems.push("SKILL.md must start with a --- frontmatter block");
		return { ok: false, problems };
	}
	if (parsed.fields.name !== name) problems.push(`frontmatter name "${parsed.fields.name ?? ""}" must equal "${name}"`);
	const description = parsed.fields.description ?? "";
	if (description.trim().length === 0) problems.push("frontmatter needs a description (Pi does not load skills without one)");
	if (description.length > MAX_DESCRIPTION) problems.push(`description is ${description.length} characters (max ${MAX_DESCRIPTION})`);
	if (parsed.body.trim().length === 0) problems.push("the skill body is empty");
	return { ok: problems.length === 0, problems };
}

/** Write `<dir>/<name>/SKILL.md`; an existing version goes to the trash first. */
export function saveSkill(dir: string, name: string, content: string): string {
	const folder = join(dir, name);
	const file = join(folder, "SKILL.md");
	if (existsSync(file)) {
		const trashed = spawnSync("trash", [file], { encoding: "utf8" });
		if (trashed.status !== 0 && existsSync(file)) {
			renameSync(file, `${file}.${Date.now()}.bak`);
		}
	}
	mkdirSync(folder, { recursive: true });
	writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`);
	return file;
}
