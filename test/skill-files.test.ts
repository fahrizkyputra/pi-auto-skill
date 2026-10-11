import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isDeclined, readState, statePath, writeState } from "../src/project-state.ts";
import { listProjectSkills, parseFrontmatter, projectRoot, saveSkill, skillsDir, validateSkill } from "../src/skill-files.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-skill-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const VALID = "---\nname: deploy-staging\ndescription: Use when deploying to staging.\n---\n\n# Deploy\n\n1. Run it.\n";

test("projectRoot walks up to the git root", () => {
	const root = tempDir();
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "packages", "web"), { recursive: true });
	assert.equal(projectRoot(join(root, "packages", "web")), root);
	const loose = tempDir();
	assert.equal(projectRoot(loose), loose, "outside a repo the cwd is the root");
});

test("skillsDir follows the repo: .agents/skills first, then .pi/skills, else .agents/skills", () => {
	const fresh = tempDir();
	assert.equal(skillsDir(fresh), join(fresh, ".agents/skills"));
	const piOnly = tempDir();
	mkdirSync(join(piOnly, ".pi/skills"), { recursive: true });
	assert.equal(skillsDir(piOnly), join(piOnly, ".pi/skills"));
	const both = tempDir();
	mkdirSync(join(both, ".pi/skills"), { recursive: true });
	mkdirSync(join(both, ".agents/skills"), { recursive: true });
	assert.equal(skillsDir(both), join(both, ".agents/skills"));
});

test("listProjectSkills reads names and descriptions from both folders", () => {
	const root = tempDir();
	mkdirSync(join(root, ".pi/skills/deploy-production"), { recursive: true });
	writeFileSync(join(root, ".pi/skills/deploy-production/SKILL.md"), "---\nname: deploy-production\ndescription: \"Deploy to prod\"\n---\nbody\n");
	mkdirSync(join(root, ".agents/skills/to-prd"), { recursive: true });
	writeFileSync(join(root, ".agents/skills/to-prd/SKILL.md"), "---\nname: to-prd\ndescription: Turn notes into a PRD\n---\nbody\n");
	mkdirSync(join(root, ".agents/skills/empty-folder"), { recursive: true });
	const skills = listProjectSkills(root).map((skill) => `${skill.name}=${skill.description}`).sort();
	assert.deepEqual(skills, ["deploy-production=Deploy to prod", "to-prd=Turn notes into a PRD"]);
});

test("parseFrontmatter reads quoted and plain values", () => {
	const parsed = parseFrontmatter("---\nname: a-b\ndescription: 'quoted text'\ndisable-model-invocation: true\n---\nbody here");
	assert.equal(parsed.fields.name, "a-b");
	assert.equal(parsed.fields.description, "quoted text");
	assert.equal(parsed.fields["disable-model-invocation"], "true");
	assert.equal(parsed.body, "body here");
	assert.equal(parseFrontmatter("no frontmatter").hasFrontmatter, false);
});

test("validateSkill enforces Pi's loading rules", () => {
	assert.deepEqual(validateSkill("deploy-staging", VALID), { ok: true, problems: [] });
	assert.match(validateSkill("Deploy_Staging", VALID).problems.join(), /lowercase/);
	assert.match(validateSkill("deploy-staging", "# no frontmatter").problems.join(), /frontmatter/);
	assert.match(validateSkill("other-name", VALID).problems.join(), /must equal "other-name"/);
	assert.match(validateSkill("deploy-staging", "---\nname: deploy-staging\n---\nbody").problems.join(), /needs a description/);
	assert.match(
		validateSkill("deploy-staging", `---\nname: deploy-staging\ndescription: ${"x".repeat(1025)}\n---\nbody`).problems.join(),
		/max 1024/,
	);
	assert.match(validateSkill("deploy-staging", "---\nname: deploy-staging\ndescription: d\n---\n   \n").problems.join(), /body is empty/);
});

test("saveSkill writes SKILL.md and keeps the previous version recoverable", () => {
	const dir = join(tempDir(), ".agents/skills");
	const first = saveSkill(dir, "deploy-staging", VALID);
	assert.equal(first, join(dir, "deploy-staging", "SKILL.md"));
	assert.equal(readFileSync(first, "utf8"), VALID);
	const updated = VALID.replace("Run it.", "Run it twice.");
	saveSkill(dir, "deploy-staging", updated);
	assert.equal(readFileSync(first, "utf8"), updated);
});

test("project state: defaults on, declined names persist", () => {
	const root = tempDir();
	assert.deepEqual(readState(root), { enabled: true, declined: [] });
	writeState(root, { enabled: false, declined: ["b", "a", "a"] });
	assert.equal(existsSync(statePath(root)), true);
	const state = readState(root);
	assert.deepEqual(state, { enabled: false, declined: ["a", "b"] });
	assert.equal(isDeclined(state, "a"), true);
	writeFileSync(statePath(root), "not json");
	assert.deepEqual(readState(root), { enabled: true, declined: [] }, "garbage falls back to defaults");
});
