import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

const GOOD = `---
name: deploy-staging
description: Deploy the app to staging. Use when the user says deploy staging.
---

# Deploy staging

1. Run the deploy. Done when it prints ok.
`;

function scratch() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "auto-skill-jcode-")));
	const jcodeHome = join(home, ".jcode");
	const bin = join(home, ".local", "bin");
	const repo = join(home, "repo");
	const reference = join(home, ".agents", "skills", "writing-great-skills");
	for (const dir of [bin, jcodeHome, join(repo, ".git"), join(repo, ".agents", "skills"), reference]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(reference, "SKILL.md"), "---\nname: writing-great-skills\ndescription: ref\n---\nREFERENCE BODY\n");
	writeFileSync(join(reference, "GLOSSARY.md"), "terms\n");
	const env = {
		...process.env,
		HOME: home,
		JCODE_HOME: jcodeHome,
		PI_CODING_AGENT_DIR: join(home, "no-pi"),
		PATH: `${bin}:${process.env.PATH}`,
	};
	const run = (file: string, args: string[]) => spawnSync(file, args, { env, cwd: repo, encoding: "utf8" });
	return { home, jcodeHome, bin, repo, run };
}

test("install links /auto-skill; brief, check, save write a validated skill into the repo; uninstall cleans up", () => {
	const { jcodeHome, bin, repo, run } = scratch();
	const installed = run(process.execPath, [join(ROOT, "bin", "jcode.mjs"), "jcode", "install"]);
	assert.equal(installed.status, 0, installed.stderr);
	assert.match(installed.stdout, /writing-great-skills\/SKILL\.md/);
	assert.ok(lstatSync(join(jcodeHome, "skills", "auto-skill")).isSymbolicLink());
	const skill = readFileSync(join(jcodeHome, "skills", "auto-skill", "SKILL.md"), "utf8");
	assert.match(skill, /^---\nname: auto-skill\ndescription: "/);
	assert.match(skill, /jcode-auto-skill brief <name>/);

	const cli = join(bin, "jcode-auto-skill");
	const brief = run(cli, ["brief", "deploy-staging"]);
	assert.equal(brief.status, 0, brief.stderr);
	assert.match(brief.stdout, /REFERENCE BODY/);
	assert.doesNotMatch(brief.stdout, /propose_skill/);
	const draft = /Write the draft to (\S+\.md)/.exec(brief.stdout)?.[1] ?? "";
	assert.ok(draft.startsWith(join(jcodeHome, "auto-skill-drafts")), draft);
	assert.match(brief.stdout, new RegExp(`Saved to: ${join(repo, ".agents", "skills", "deploy-staging", "SKILL.md").replace(/[/.]/g, "\\$&")}`));

	assert.equal(run(cli, ["check", "deploy-staging"]).status, 1, "no draft yet");
	writeFileSync(draft, GOOD.replace("name: deploy-staging", "name: other"));
	const bad = run(cli, ["check", "deploy-staging"]);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /must equal "deploy-staging"/);
	assert.equal(run(cli, ["save", "deploy-staging"]).status, 1, "save refuses an invalid draft");
	assert.ok(!existsSync(join(repo, ".agents", "skills", "deploy-staging")));

	writeFileSync(draft, GOOD);
	assert.equal(run(cli, ["check", "deploy-staging"]).stdout.trim(), "ok");
	const saved = run(cli, ["save", "deploy-staging"]);
	assert.equal(saved.status, 0, saved.stderr);
	assert.equal(readFileSync(join(repo, ".agents", "skills", "deploy-staging", "SKILL.md"), "utf8"), GOOD);
	assert.ok(!existsSync(draft));

	// A second brief for the same name is an update and carries the current version.
	assert.match(run(cli, ["brief", "deploy-staging"]).stdout, /Current version of the skill[\s\S]*# Deploy staging/);

	assert.equal(run(cli, ["brief", "Bad Name"]).status, 1);

	assert.equal(run(cli, ["uninstall"]).status, 0);
	assert.ok(!existsSync(join(jcodeHome, "skills", "auto-skill")));
	assert.ok(!existsSync(cli));
	assert.ok(existsSync(join(repo, ".agents", "skills", "deploy-staging", "SKILL.md")), "saved project skills are kept");
});

test("install refuses to overwrite a foreign ~/.jcode/skills/auto-skill", () => {
	const { jcodeHome, run } = scratch();
	mkdirSync(join(jcodeHome, "skills", "auto-skill"), { recursive: true });
	const installed = run(process.execPath, [join(ROOT, "bin", "jcode.mjs"), "jcode", "install"]);
	assert.equal(installed.status, 0);
	assert.match(installed.stdout, /NOT linked/);
	assert.ok(!lstatSync(join(jcodeHome, "skills", "auto-skill")).isSymbolicLink());
});
