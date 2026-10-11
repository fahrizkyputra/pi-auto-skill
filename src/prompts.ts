/**
 * Prompts: the judge that decides whether a finished task is worth a skill,
 * and the authoring brief the session's agent follows to write it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExistingSkill } from "./skill-files.ts";

export const PROPOSE_TOOL = "propose_skill";

export interface TaskDigest {
	/** The user's request that started the run. */
	request: string;
	/** Tool calls in order, compact: `bash: npm run deploy:staging`. */
	steps: string[];
	/** Files written or edited. */
	changedFiles: string[];
	/** The agent's final answer, trimmed. */
	finalAnswer: string;
}

export interface Verdict {
	action: "create" | "update" | "skip";
	name?: string;
	reason?: string;
}

const MAX_STEP_CHARS = 200;
const MAX_STEPS = 60;

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function judgePrompt(digest: TaskDigest, existing: readonly ExistingSkill[], declined: readonly string[]): string {
	const steps = digest.steps.slice(0, MAX_STEPS).map((step, index) => `${index + 1}. ${clip(step, MAX_STEP_CHARS)}`);
	if (digest.steps.length > MAX_STEPS) steps.push(`… ${digest.steps.length - MAX_STEPS} more steps`);
	const skills = existing.length > 0 ? existing.map((skill) => `- ${skill.name}: ${clip(skill.description, 220)}`) : ["- (none)"];

	return [
		"You decide whether a task an AI coding agent just finished should become a reusable skill for THIS project.",
		"",
		"A skill is worth it only for a procedure that will plausibly be repeated in this project with different inputs:",
		"deploying, releasing, migrating, setting up a recurring kind of feature, running a multi-step maintenance routine,",
		"debugging a recurring class of failure. Answer skip for one-off fixes, explanations, exploration, questions,",
		"generic programming knowledge, or anything a competent agent does correctly without guidance.",
		"",
		"If an existing project skill already covers the procedure and the task revealed new or corrected steps, answer",
		"update with that skill's exact name. If an existing skill already covers it fully, answer skip.",
		`Never propose these names; the user declined them: ${declined.length > 0 ? declined.join(", ") : "(none)"}.`,
		"",
		"## User request",
		clip(digest.request, 1500),
		"",
		"## Steps the agent took",
		...steps,
		"",
		"## Files changed",
		...(digest.changedFiles.length > 0 ? digest.changedFiles.slice(0, 40).map((file) => `- ${file}`) : ["- (none)"]),
		"",
		"## Agent's final answer",
		clip(digest.finalAnswer, 1500),
		"",
		"## Existing project skills",
		...skills,
		"",
		"Reply with ONE line of JSON and nothing else:",
		'{"action":"create"|"update"|"skip","name":"kebab-case-name","reason":"one sentence in the user\'s language"}',
		"`name` is required for create and update: lowercase letters, numbers, single hyphens, at most 64 characters,",
		"named after the procedure (deploy-staging, add-api-endpoint), not after this one instance.",
	].join("\n");
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Tolerant: takes the first JSON object in the reply; anything malformed is a skip. */
export function parseVerdict(reply: string, existing: readonly ExistingSkill[], declined: readonly string[]): Verdict {
	const match = /\{[\s\S]*?\}/.exec(reply);
	if (!match) return { action: "skip", reason: "no JSON in the judge reply" };
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(match[0]) as Record<string, unknown>;
	} catch {
		return { action: "skip", reason: "malformed JSON in the judge reply" };
	}
	const action = raw.action;
	if (action !== "create" && action !== "update") return { action: "skip", reason: typeof raw.reason === "string" ? raw.reason : undefined };
	const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
	if (!NAME_PATTERN.test(name) || name.length > 64) return { action: "skip", reason: `invalid skill name "${name}"` };
	if (declined.includes(name)) return { action: "skip", reason: `"${name}" was declined before` };
	const exists = existing.some((skill) => skill.name === name);
	const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
	// The judge may confuse the two; the filesystem decides.
	return { action: exists ? "update" : "create", name, reason };
}

export interface ReferenceSkill {
	skillPath: string;
	skill: string;
	glossaryPath?: string;
}

export function referenceSkillDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "skills", "writing-great-skills");
}

/** writing-great-skills from this machine; undefined when it is not installed. */
export function loadReferenceSkill(dir: string = referenceSkillDir()): ReferenceSkill | undefined {
	const skillPath = join(dir, "SKILL.md");
	if (!existsSync(skillPath)) return undefined;
	const glossaryPath = join(dir, "GLOSSARY.md");
	return {
		skillPath,
		skill: readFileSync(skillPath, "utf8"),
		...(existsSync(glossaryPath) ? { glossaryPath } : {}),
	};
}

export interface AuthoringInput {
	verdict: Required<Pick<Verdict, "name">> & Verdict;
	reference: ReferenceSkill;
	skillsDir: string;
	existingContent?: string;
}

export function authoringBrief(input: AuthoringInput): string {
	const { verdict, reference, skillsDir, existingContent } = input;
	const updating = verdict.action === "update";
	return [
		`[auto-skill] ${updating ? `Update the project skill "${verdict.name}"` : `Write a new project skill "${verdict.name}"`} from the task you just finished.`,
		...(verdict.reason ? [`Why: ${verdict.reason}`] : []),
		"",
		"Follow the writing-great-skills reference below exactly. It defines how this skill must be shaped:",
		"invocation (model-invoked here), the description's triggers, steps with checkable completion criteria,",
		"leading words, and pruning no-ops and duplication.",
		...(reference.glossaryPath ? [`Bold terms are defined in ${reference.glossaryPath}; read it when a term matters.`] : []),
		"",
		"Rules for this skill:",
		"- Write a reusable procedure for this project, not a log of what happened: turn values that will differ next",
		"  time (branch names, IDs, versions, hosts that vary) into named inputs; keep project facts that are stable",
		"  (real paths, scripts, commands, hosts) exactly as they are.",
		"- Base it only on the task you just finished in this session.",
		"- One SKILL.md, in English. The description may include trigger phrases in the language the user speaks.",
		`- Frontmatter: name: ${verdict.name}, and a description of at most 1024 characters.`,
		`- Do NOT write the file yourself. Call the \`${PROPOSE_TOOL}\` tool with name="${verdict.name}" and the full`,
		"  SKILL.md content. The user reviews and edits it before anything is saved.",
		`- The skill will live in ${skillsDir}/${verdict.name}/SKILL.md.`,
		...(updating && existingContent
			? ["", "Current version of the skill (keep what is still right, fix what the task proved wrong, add what is missing):", "````markdown", existingContent, "````"]
			: []),
		"",
		"## writing-great-skills reference",
		"````markdown",
		reference.skill,
		"````",
	].join("\n");
}
