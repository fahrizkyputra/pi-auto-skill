import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoSkillController, type AutoSkillHost } from "../src/controller.ts";
import type { ProjectState } from "../src/project-state.ts";

const DIGEST = {
	request: "deploy feat/x ke staging",
	steps: ["bash: a", "bash: b", "bash: c", "bash: d", "bash: e"],
	changedFiles: [],
	finalAnswer: "done",
};
const VALID = (name: string) => `---\nname: ${name}\ndescription: Use when deploying.\n---\n\n1. Deploy.\n`;

interface Options {
	hasUI?: boolean;
	isSubagent?: boolean;
	state?: ProjectState;
	reply?: string;
	confirm?: boolean;
	edited?: string | undefined | ((text: string) => string | undefined);
	reference?: boolean;
	skills?: { name: string; description: string; path: string }[];
}

function harness(options: Options = {}) {
	let state: ProjectState = options.state ?? { enabled: true, declined: [] };
	const calls = { judge: 0, confirm: 0, edit: 0 };
	const briefs: string[] = [];
	const notices: string[] = [];
	const saved: { name: string; content: string }[] = [];
	const host: AutoSkillHost = {
		hasUI: options.hasUI ?? true,
		isSubagent: options.isSubagent ?? false,
		projectRoot: "/repo",
		skillsDir: "/repo/.agents/skills",
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		listSkills: () => options.skills ?? [],
		readSkill: () => "OLD",
		loadReference: () => (options.reference === false ? undefined : { skillPath: "/ref/SKILL.md", skill: "REF" }),
		judge: async () => {
			calls.judge++;
			return options.reply ?? '{"action":"create","name":"deploy-staging","reason":"berulang tiap rilis"}';
		},
		confirm: async () => {
			calls.confirm++;
			return options.confirm ?? true;
		},
		notify: (message) => notices.push(message),
		edit: async (_title, text) => {
			calls.edit++;
			const edited = options.edited;
			if (typeof edited === "function") return edited(text);
			return "edited" in options ? edited : text;
		},
		sendBrief: (text) => briefs.push(text),
		saveSkill: (name, content) => {
			saved.push({ name, content });
			return `/repo/.agents/skills/${name}/SKILL.md`;
		},
	};
	return { controller: new AutoSkillController(host), calls, briefs, notices, saved, state: () => state };
}

test("short chats are never judged", async () => {
	const { controller, calls } = harness();
	const outcome = await controller.onTaskFinished({ ...DIGEST, steps: ["bash: ls"] }, 1);
	assert.equal(outcome.kind, "skipped");
	assert.equal(calls.judge, 0);
});

test("a changed file meets the bar even with few tool calls", async () => {
	const { controller, calls } = harness();
	await controller.onTaskFinished({ ...DIGEST, changedFiles: ["a.ts"] }, 1);
	assert.equal(calls.judge, 1);
});

test("no UI, subagents, and disabled projects are skipped without a model call", async () => {
	for (const options of [{ hasUI: false }, { isSubagent: true }, { state: { enabled: false, declined: [] } }] as Options[]) {
		const { controller, calls } = harness(options);
		assert.equal((await controller.onTaskFinished(DIGEST, 9)).kind, "skipped");
		assert.equal(calls.judge, 0);
	}
});

test("a missing writing-great-skills stops before judging", async () => {
	const { controller, calls } = harness({ reference: false });
	assert.deepEqual(await controller.onTaskFinished(DIGEST, 9), { kind: "error", reason: "writing-great-skills not found" });
	assert.equal(calls.judge, 0);
});

test("judge says skip: no dialog", async () => {
	const { controller, calls } = harness({ reply: '{"action":"skip","reason":"one-off"}' });
	assert.equal((await controller.onTaskFinished(DIGEST, 9)).kind, "skipped");
	assert.equal(calls.confirm, 0);
});

test("declining records the name so it is never proposed again", async () => {
	const { controller, briefs, state } = harness({ confirm: false });
	assert.deepEqual(await controller.onTaskFinished(DIGEST, 9), { kind: "declined", name: "deploy-staging" });
	assert.deepEqual(state().declined, ["deploy-staging"]);
	assert.deepEqual(briefs, []);
});

test("approving briefs the agent with the reference", async () => {
	const { controller, briefs } = harness();
	const outcome = await controller.onTaskFinished(DIGEST, 9);
	assert.deepEqual(outcome, { kind: "briefed", name: "deploy-staging", action: "create" });
	assert.match(briefs[0] ?? "", /^\[auto-skill\] Write a new project skill "deploy-staging"/);
	assert.match(briefs[0] ?? "", /REF/);
	assert.equal(controller.isWriting(), true);
});

test("a late judgement is dropped when the user typed meanwhile", async () => {
	const { controller, calls } = harness();
	const pending = controller.onTaskFinished(DIGEST, 9);
	controller.onUserPrompt();
	assert.deepEqual(await pending, { kind: "skipped", reason: "the user moved on" });
	assert.equal(calls.confirm, 0);
});

test("proposal: invalid drafts go back to the agent, valid ones open the editor and save", async () => {
	const { controller, saved, calls } = harness();
	await controller.onTaskFinished(DIGEST, 9);

	const wrongName = await controller.onProposal({ name: "other", content: VALID("other") });
	assert.equal(wrongName.ok, false);
	const invalid = await controller.onProposal({ name: "deploy-staging", content: "# no frontmatter" });
	assert.equal(invalid.ok, false);
	assert.match(invalid.message, /frontmatter/);
	assert.equal(calls.edit, 0, "invalid drafts never reach the user");

	const result = await controller.onProposal({ name: "deploy-staging", content: VALID("deploy-staging") });
	assert.equal(result.ok, true);
	assert.match(result.message, /Saved to \/repo\/\.agents\/skills\/deploy-staging\/SKILL\.md/);
	assert.deepEqual(saved.map((entry) => entry.name), ["deploy-staging"]);
	assert.equal(controller.isWriting(), false);
});

test("the user's edits are what gets saved", async () => {
	const { controller, saved } = harness({ edited: (text) => text.replace("1. Deploy.", "1. Deploy carefully.") });
	await controller.onTaskFinished(DIGEST, 9);
	const result = await controller.onProposal({ name: "deploy-staging", content: VALID("deploy-staging") });
	assert.match(saved[0]?.content ?? "", /Deploy carefully/);
	assert.match(result.message, /with the user's edits/);
});

test("cancelling the editor saves nothing", async () => {
	const { controller, saved } = harness({ edited: undefined });
	await controller.onTaskFinished(DIGEST, 9);
	const result = await controller.onProposal({ name: "deploy-staging", content: VALID("deploy-staging") });
	assert.deepEqual(saved, []);
	assert.match(result.message, /discarded/);
});

test("an edit that breaks the skill saves nothing", async () => {
	const { controller, saved, notices } = harness({ edited: "oops" });
	await controller.onTaskFinished(DIGEST, 9);
	await controller.onProposal({ name: "deploy-staging", content: VALID("deploy-staging") });
	assert.deepEqual(saved, []);
	assert.match(notices.at(-1) ?? "", /not a valid skill/);
});

test("propose_skill without a brief is refused", async () => {
	const { controller } = harness();
	const result = await controller.onProposal({ name: "x", content: VALID("x") });
	assert.equal(result.ok, false);
	assert.match(result.message, /No skill was requested/);
});

test("an existing skill is updated with its current content in the brief", async () => {
	const { controller, briefs } = harness({
		reply: '{"action":"create","name":"deploy-production","reason":"langkah baru"}',
		skills: [{ name: "deploy-production", description: "Deploy", path: "/repo/.pi/skills/deploy-production/SKILL.md" }],
	});
	const outcome = await controller.onTaskFinished(DIGEST, 9);
	assert.deepEqual(outcome, { kind: "briefed", name: "deploy-production", action: "update" });
	assert.match(briefs[0] ?? "", /Update the project skill "deploy-production"/);
	assert.match(briefs[0] ?? "", /OLD/);
});

test("forced runs ignore the bar, the off switch, and declined names", async () => {
	const { controller, calls } = harness({ state: { enabled: false, declined: ["deploy-staging"] } });
	const outcome = await controller.onTaskFinished({ ...DIGEST, steps: [] }, 0, { force: true });
	assert.equal(calls.judge, 1);
	assert.equal(outcome.kind, "briefed");
});

test("a writing run that ends without a proposal clears the pending skill", async () => {
	const { controller, notices } = harness();
	await controller.onTaskFinished(DIGEST, 9);
	controller.onWritingRunEnded();
	assert.equal(controller.isWriting(), false);
	assert.match(notices.at(-1) ?? "", /did not propose "deploy-staging"/);
});
