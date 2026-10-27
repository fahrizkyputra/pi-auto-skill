/**
 * `jcode-auto-skill <install|uninstall|status|brief|check|save>`
 *
 * jcode has no hook that can start a new turn after a task, so the skill is
 * drafted on request: `/auto-skill [name]` in jcode loads a skill that runs
 * `brief`, drafts the SKILL.md in a scratch file, shows it, and only after
 * the user says yes runs `save`, which validates and writes it to the repo.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authoringBrief, loadReferenceSkill, type ReferenceSkill } from "../src/prompts.ts";
import { listProjectSkills, projectRoot, saveSkill, skillsDir, validateSkill } from "../src/skill-files.ts";
import { installShim, jcodeHome, linkSkill, removeShim, shimCommand, unlinkSkill } from "./kit.ts";

export const PACKAGE = "pi-auto-skill";
export const SHIM = "jcode-auto-skill";
export const SKILL_NAME = "auto-skill";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** writing-great-skills: the jcode copy first, then Pi's, then the shared ~/.agents one. */
export function findReference(): ReferenceSkill | undefined {
	const home = dirname(jcodeHome());
	for (const dir of [join(jcodeHome(), "skills", "writing-great-skills"), undefined, join(home, ".agents", "skills", "writing-great-skills")]) {
		const found = dir === undefined ? loadReferenceSkill() : loadReferenceSkill(dir);
		if (found) return found;
	}
	return undefined;
}

export function draftPath(cwd: string, name: string): string {
	return join(jcodeHome(), "auto-skill-drafts", projectRoot(cwd).replace(/[^A-Za-z0-9]+/g, "_").slice(-80), `${name}.md`);
}

export function skillText(shim: string): string {
	const description =
		'Turn the task just finished in this jcode session into a reusable project skill: draft it with writing-great-skills, show it, and save it to the repo only after the user approves. Use when the user types /auto-skill, or says "jadikan skill", "buat skill dari task ini", "save this as a skill".';
	return [
		"---",
		`name: ${SKILL_NAME}`,
		`description: ${JSON.stringify(description)}`,
		"---",
		"",
		"# auto-skill",
		"",
		"Turn the task you just finished in this session into a project skill. The user reviews the draft before anything is saved.",
		"",
		"1. **Pick the name.** Use the name typed after `/auto-skill` if there is one. Otherwise choose a kebab-case name for the",
		"   *procedure* (deploy-staging, add-api-endpoint), not for this one instance. If the task was a one-off (an explanation,",
		"   a single fix, exploration), say so in one line and stop: it is not worth a skill.",
		`   Done when you have a name matching \`^[a-z0-9]+(-[a-z0-9]+)*$\`, at most 64 characters.`,
		"",
		`2. **Read the brief.** Run \`${shim} brief <name>\` with bash. It prints the authoring rules, the writing-great-skills`,
		"   reference, the skills folder of this repo, the existing skill when the name is taken (then you are updating it),",
		"   and the scratch path for the draft. Done when you have read the whole output.",
		"",
		"3. **Draft.** Write the complete SKILL.md to the scratch path the brief gave, following the brief exactly.",
		`   Run \`${shim} check <name>\`. Done when it prints \`ok\`; fix and re-run until it does.`,
		"",
		"4. **Show it and ask.** Show the user the full draft in a markdown code block and ask whether to save it,",
		"   change something, or drop it. Wait for the answer. Apply requested changes to the scratch file and run `check` again.",
		"",
		`5. **Save only on a yes.** Run \`${shim} save <name>\`. It prints the saved path. If the user declines, stop.`,
		"",
		"6. **Recap the original task** in at most 8 lines, in the user's language: Done, Not done / needs the user, Next.",
		"   Leave the skill out of the recap.",
		"",
	].join("\n");
}

function install(): string[] {
	const shim = installShim(SHIM, join(here, "cli.ts"));
	const dir = join(pluginRoot, "skills", SKILL_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), skillText(shim));
	const linked = linkSkill(dir, SKILL_NAME);
	const reference = findReference();
	return [
		`${PACKAGE} installed for jcode`,
		linked === "linked"
			? `- skill: /${SKILL_NAME} [name]`
			: `- skill: /${SKILL_NAME} NOT linked: ~/.jcode/skills/${SKILL_NAME} already exists (remove it and run install again)`,
		`- command: ${shim} status | brief | check | save | uninstall`,
		reference ? `- reference: ${reference.skillPath}` : "- reference: writing-great-skills NOT found (install it in ~/.agents/skills or ~/.jcode/skills)",
		"Reload skills in jcode (skill_manage reload_all) or start a new session.",
	];
}

function uninstall(): string[] {
	unlinkSkill(join(pluginRoot, "skills", SKILL_NAME), SKILL_NAME);
	removeShim(SHIM);
	rmSync(join(jcodeHome(), "auto-skill-drafts"), { recursive: true, force: true });
	rmSync(pluginRoot, { recursive: true, force: true });
	return [`${PACKAGE} removed from jcode (/${SKILL_NAME}, command, drafts). Saved project skills are kept.`];
}

function requireName(value: string | undefined): string {
	const name = (value ?? "").trim().toLowerCase();
	if (!NAME_PATTERN.test(name) || name.length > 64) throw new Error(`invalid skill name "${value ?? ""}": lowercase letters, numbers, single hyphens, max 64`);
	return name;
}

function brief(name: string, cwd: string): string[] {
	const reference = findReference();
	if (!reference) throw new Error("writing-great-skills not found in ~/.jcode/skills, ~/.pi/agent/skills, or ~/.agents/skills");
	const root = projectRoot(cwd);
	const dir = skillsDir(root);
	const existing = listProjectSkills(root).find((skill) => skill.name === name);
	const draft = draftPath(cwd, name);
	mkdirSync(dirname(draft), { recursive: true });
	const text = authoringBrief({
		verdict: { action: existing ? "update" : "create", name },
		reference,
		skillsDir: dir,
		...(existing ? { existingContent: readFileSync(existing.path, "utf8") } : {}),
	});
	// The Pi brief ends the draft in a tool call; in jcode it goes to a scratch file instead.
	const jcodeText = text
		.replace(/- Do NOT write the file yourself\. Call the `propose_skill` tool[\s\S]*?before anything is saved\.\n/, `- Write the draft to ${draft}, not to the skills folder. The user reviews it before \`save\` copies it there.\n`)
		.replace("(model-invoked here)", "(model-invoked)");
	return [jcodeText, "", `Draft file: ${draft}`, `Saved to: ${join(dir, name, "SKILL.md")}${existing ? " (replaces the current version; it goes to the trash)" : ""}`];
}

function check(name: string, cwd: string): { code: number; lines: string[] } {
	const draft = draftPath(cwd, name);
	if (!existsSync(draft)) return { code: 1, lines: [`no draft at ${draft}; write it first`] };
	const result = validateSkill(name, readFileSync(draft, "utf8"));
	return result.ok ? { code: 0, lines: ["ok"] } : { code: 1, lines: result.problems.map((problem) => `- ${problem}`) };
}

function save(name: string, cwd: string): { code: number; lines: string[] } {
	const checked = check(name, cwd);
	if (checked.code !== 0) return checked;
	const draft = draftPath(cwd, name);
	const path = saveSkill(skillsDir(projectRoot(cwd)), name, readFileSync(draft, "utf8"));
	rmSync(draft, { force: true });
	return { code: 0, lines: [`saved ${path}`, "jcode loads it after skill_manage reload_all or in a new session."] };
}

function status(cwd: string): string[] {
	const root = projectRoot(cwd);
	const reference = findReference();
	return [
		PACKAGE,
		`project: ${root}`,
		`skills folder: ${skillsDir(root)} (${listProjectSkills(root).length} skills)`,
		`reference: ${reference ? reference.skillPath : "writing-great-skills NOT found"}`,
		`command: ${shimCommand(SHIM)}`,
	];
}

export async function run(args: readonly string[], cwd: string = process.cwd()): Promise<{ code: number; lines: string[] }> {
	const command = (args[0] ?? "status").toLowerCase();
	const dir = resolve(cwd);
	switch (command) {
		case "install":
			return { code: 0, lines: install() };
		case "uninstall":
			return { code: 0, lines: uninstall() };
		case "status":
			return { code: 0, lines: status(dir) };
		case "brief":
			return { code: 0, lines: brief(requireName(args[1]), dir) };
		case "check":
			return check(requireName(args[1]), dir);
		case "save":
			return save(requireName(args[1]), dir);
		default:
			return { code: 2, lines: [`unknown command "${command}". Use install, uninstall, status, brief|check|save <name>.`] };
	}
}

if (import.meta.main) {
	try {
		const { code, lines } = await run(process.argv.slice(2));
		(code === 0 ? console.log : console.error)(lines.join("\n"));
		process.exitCode = code;
	} catch (error) {
		console.error(`${PACKAGE}: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
