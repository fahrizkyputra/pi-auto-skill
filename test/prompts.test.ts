import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { authoringBrief, judgePrompt, loadReferenceSkill, parseVerdict } from "../src/prompts.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const DIGEST = {
	request: "deploy branch feat/x ke staging",
	steps: ["bash: git push origin feat/x", "bash: ssh staging 'cd /srv/app && git pull && docker compose up -d'"],
	changedFiles: ["deploy/staging.env"],
	finalAnswer: "Staging sudah jalan di feat/x.",
};
const EXISTING = [{ name: "deploy-production", description: "Deploy to production", path: "/r/.pi/skills/deploy-production/SKILL.md" }];

test("judge prompt carries the task, existing skills, and declined names", () => {
	const prompt = judgePrompt(DIGEST, EXISTING, ["old-idea"]);
	assert.match(prompt, /deploy branch feat\/x ke staging/);
	assert.match(prompt, /2\. bash: ssh staging/);
	assert.match(prompt, /- deploy\/staging\.env/);
	assert.match(prompt, /- deploy-production: Deploy to production/);
	assert.match(prompt, /declined them: old-idea/);
	assert.match(prompt, /ONE line of JSON/);
});

test("judge prompt clips long steps and caps their number", () => {
	const steps = Array.from({ length: 80 }, (_, index) => `bash: echo ${"x".repeat(400)} ${index}`);
	const prompt = judgePrompt({ ...DIGEST, steps }, [], []);
	assert.match(prompt, /… 20 more steps/);
	assert.ok(prompt.split("\n").every((line) => line.length < 1600));
});

test("parseVerdict accepts create, corrects create/update from the filesystem, and rejects bad names", () => {
	assert.deepEqual(parseVerdict('{"action":"create","name":"deploy-staging","reason":"berulang"}', EXISTING, []), {
		action: "create",
		name: "deploy-staging",
		reason: "berulang",
	});
	assert.equal(parseVerdict('Sure! {"action":"create","name":"deploy-production","reason":"x"}', EXISTING, []).action, "update");
	assert.equal(parseVerdict('{"action":"update","name":"brand-new","reason":"x"}', EXISTING, []).action, "create");
	assert.equal(parseVerdict('{"action":"create","name":"Deploy Staging"}', EXISTING, []).action, "skip");
	assert.equal(parseVerdict('{"action":"create","name":"old-idea"}', EXISTING, ["old-idea"]).action, "skip");
	assert.equal(parseVerdict('{"action":"skip","reason":"one-off"}', EXISTING, []).action, "skip");
	assert.equal(parseVerdict("not json at all", EXISTING, []).action, "skip");
	assert.equal(parseVerdict("{broken", EXISTING, []).action, "skip");
});

test("loadReferenceSkill reads writing-great-skills, or reports it missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-skill-ref-"));
	dirs.push(dir);
	assert.equal(loadReferenceSkill(dir), undefined);
	writeFileSync(join(dir, "SKILL.md"), "# writing-great-skills\nLeading words.");
	assert.equal(loadReferenceSkill(dir)?.glossaryPath, undefined);
	writeFileSync(join(dir, "GLOSSARY.md"), "glossary");
	const reference = loadReferenceSkill(dir);
	assert.match(reference?.skill ?? "", /Leading words/);
	assert.equal(reference?.glossaryPath, join(dir, "GLOSSARY.md"));
});

test("authoring brief embeds the reference, the rules, and the tool to call", () => {
	const brief = authoringBrief({
		verdict: { action: "create", name: "deploy-staging", reason: "dipakai tiap minggu" },
		reference: { skillPath: "/x/SKILL.md", skill: "REFERENCE-BODY", glossaryPath: "/x/GLOSSARY.md" },
		skillsDir: "/repo/.agents/skills",
	});
	assert.match(brief, /^\[auto-skill\] Write a new project skill "deploy-staging"/);
	assert.match(brief, /REFERENCE-BODY/);
	assert.match(brief, /\/x\/GLOSSARY\.md/);
	assert.match(brief, /Call the `propose_skill` tool with name="deploy-staging"/);
	assert.match(brief, /Do NOT write the file yourself/);
	assert.match(brief, /\/repo\/\.agents\/skills\/deploy-staging\/SKILL\.md/);
	assert.match(brief, /named inputs/);
});

test("an update brief includes the current version", () => {
	const brief = authoringBrief({
		verdict: { action: "update", name: "deploy-production", reason: "langkah baru" },
		reference: { skillPath: "/x/SKILL.md", skill: "REF" },
		skillsDir: "/repo/.pi/skills",
		existingContent: "OLD-SKILL-CONTENT",
	});
	assert.match(brief, /Update the project skill "deploy-production"/);
	assert.match(brief, /OLD-SKILL-CONTENT/);
});

void mkdirSync;

// ---- wrap-up: the recap the agent writes once the skill is saved --------------------------------

import { savedBlock, wrapUpMessage } from "../src/prompts.ts";

const WRAP = { action: "create" as const, name: "deploy-staging", path: "/r/.agents/skills/deploy-staging/SKILL.md", edited: false, digest: DIGEST };

test("wrap-up: the agent restates the task and leaves the skill notice to the extension", () => {
	const message = wrapUpMessage(WRAP);
	assert.match(message, /A short recap of the task/);
	assert.match(message, /Do not mention the skill or \/reload: the extension shows that itself/);
	assert.doesNotMatch(message, /Run \/reload to use it\./, "the notice is not asked from the agent twice");
	assert.match(message, /Done: what was completed/);
	assert.match(message, /Not done \/ needs you/);
	assert.match(message, /Next: the one concrete next step/);
	assert.match(message, /at most 8 lines/);
	assert.match(message, /in the language the user wrote in/);
	assert.match(message, /Do not describe the skill here/);
	assert.match(message, /Do not invent work that was not done/);
});

test("wrap-up: carries the facts kept from the task, not the skill brief", () => {
	const message = wrapUpMessage(WRAP);
	assert.match(message, /The user's request: deploy branch feat\/x ke staging/);
	assert.match(message, /Files changed: deploy\/staging\.env/);
	assert.match(message, /> Staging sudah jalan di feat\/x\./);
	assert.doesNotMatch(message, /REF|writing-great-skills reference/);
});

test("wrap-up: mentions the user's edits and clips long answers and file lists", () => {
	const message = wrapUpMessage({ ...WRAP, action: "update", edited: true, digest: { ...DIGEST, finalAnswer: "x".repeat(5000), changedFiles: Array.from({ length: 20 }, (_, i) => `f${i}.ts`) } });
	assert.match(message, /with the user's edits/);
	assert.ok(message.length < 3000, "a long final answer is clipped");
	assert.match(message, /f11\.ts, …/, "only the first 12 files are listed");
});

test("wrap-up: no final answer or files still gives a usable message", () => {
	const message = wrapUpMessage({ ...WRAP, digest: { request: "", steps: [], changedFiles: [], finalAnswer: "" } });
	assert.match(message, /\(not recorded\)/);
	assert.doesNotMatch(message, /Files changed|final answer then/);
});

test("the saved block is fixed text with the name, the path, and /reload", () => {
	assert.equal(
		savedBlock("create", "deploy-staging", "/r/.agents/skills/deploy-staging/SKILL.md"),
		'🧩 Skill "deploy-staging" created\n   /r/.agents/skills/deploy-staging/SKILL.md\n   Run /reload to use it.',
	);
	assert.match(savedBlock("update", "x", "/p"), /updated/);
});
