import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoSkillExtension from "../extensions/auto-skill.ts";

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const hooks: Record<string, Handler[]> = {};
	const tools: string[] = [];
	const commands: string[] = [];
	const toolDefs: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
	const sent: { message: any }[] = [];
	const briefs: string[] = [];
	const pi = {
		on: (name: string, handler: Handler) => {
			hooks[name] = [...(hooks[name] ?? []), handler];
		},
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
			tools.push(tool.name);
			toolDefs[tool.name] = tool;
		},
		registerCommand: (name: string) => commands.push(name),
		registerMessageRenderer: () => {},
		sendUserMessage: (text: string) => {
			briefs.push(text);
		},
		sendMessage: (message: unknown) => sent.push({ message }),
	} as unknown as ExtensionAPI;
	return { pi, hooks, tools, commands, toolDefs, sent, briefs };
}

const ORIGINAL = process.env.PI_AUTO_SKILL_PARENT;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.PI_AUTO_SKILL_PARENT;
	else process.env.PI_AUTO_SKILL_PARENT = ORIGINAL;
});

test("registers the hooks, propose_skill, and /auto-skill", () => {
	const { pi, hooks, tools, commands } = fakePi();
	autoSkillExtension(pi);
	for (const name of ["session_start", "before_agent_start", "tool_call", "tool_result", "message_end", "agent_settled"]) {
		assert.ok(hooks[name]?.length, `missing ${name}`);
	}
	assert.deepEqual(tools, ["propose_skill"]);
	assert.deepEqual(commands, ["auto-skill"]);
});

test("an empty parent flag is not mistaken for a subagent (regression)", async () => {
	process.env.PI_AUTO_SKILL_PARENT = "";
	const { pi, hooks } = fakePi();
	autoSkillExtension(pi);
	const notices: string[] = [];
	const ctx = { cwd: process.cwd(), hasUI: true, ui: { notify: (m: string) => notices.push(m) } };
	for (const handler of hooks.session_start ?? []) await handler({ reason: "startup" }, ctx);
	assert.equal(process.env.PI_AUTO_SKILL_PARENT, String(process.pid), "the main process marks itself as the parent");
});

test("a process started under another pid's flag treats itself as a subagent", async () => {
	process.env.PI_AUTO_SKILL_PARENT = "999999";
	const { pi, hooks } = fakePi();
	autoSkillExtension(pi);
	const ctx = { cwd: process.cwd(), hasUI: true, ui: { notify: () => {} } };
	for (const handler of hooks.session_start ?? []) await handler({ reason: "startup" }, ctx);
	assert.equal(process.env.PI_AUTO_SKILL_PARENT, "999999", "a subagent leaves the parent's flag alone");
});

// ---- the end of the flow: recap first, "saved" block after it --------------------------------

function projectWithReference() {
	// An earlier test may have left another pid's flag behind, which would make this process a "subagent".
	delete process.env.PI_AUTO_SKILL_PARENT;
	const root = mkdtempSync(join(tmpdir(), "auto-skill-wiring-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "skills", "writing-great-skills"), { recursive: true });
	writeFileSync(join(agentDir, "skills", "writing-great-skills", "SKILL.md"), "---\nname: writing-great-skills\ndescription: x\n---\nREF\n");
	return { root, agentDir };
}

const DRAFT = "---\nname: deploy-staging\ndescription: Use when deploying a branch to staging.\n---\n\n1. Push the branch.\n";

test("after the skill is saved: the recap request goes to the agent, and the saved block comes only after its recap", async () => {
	const { root, agentDir } = projectWithReference();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { pi, hooks, toolDefs, sent, briefs } = fakePi();
		autoSkillExtension(pi);
		const notices: string[] = [];
		const ctx: any = {
			cwd: root,
			hasUI: true,
			model: { provider: "p", id: "m" },
			modelRegistry: {
				complete: async () => ({ content: [{ type: "text", text: '{"action":"create","name":"deploy-staging","reason":"repeated"}' }] }),
			},
			ui: { notify: (message: string) => notices.push(message), confirm: async () => true, editor: async (_title: string, text: string) => text },
		};
		const emit = async (name: string, event: Record<string, unknown> = {}) => {
			for (const handler of hooks[name] ?? []) await handler({ type: name, ...event }, ctx);
		};

		// The real task: six tool calls, a final answer with something left for the user.
		await emit("session_start", { reason: "startup" });
		await emit("before_agent_start", { prompt: "deploy feat/x to staging" });
		for (let index = 0; index < 6; index++) await emit("tool_call", { toolName: "bash", input: { command: `step ${index}` } });
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Deployed. The DB migration still needs a manual run." }] } });
		await emit("agent_settled", { aborted: false });
		assert.equal(briefs.length, 1, "the brief is sent after the task");

		// The brief run: the agent calls propose_skill; the result asks for the recap of the real task.
		await emit("before_agent_start", { prompt: briefs[0] });
		const result = await toolDefs.propose_skill!.execute("t1", { name: "deploy-staging", content: DRAFT }, undefined, undefined, ctx);
		const text = result.content[0].text as string;
		assert.match(text, /A short recap of the task/);
		assert.match(text, /The DB migration still needs a manual run/, "the original final answer reaches the recap request");
		assert.match(text, /deploy feat\/x to staging/);
		assert.equal(sent.length, 0, "nothing about the skill is shown before the agent's recap");
		assert.ok(!notices.some((notice) => /Run \/reload/.test(notice)), "no early reload notice");

		// The agent writes its recap; the run ends; only now the saved block appears.
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done: deployed. Needs you: run the DB migration." }] } });
		await emit("agent_settled", { aborted: false });
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.customType, "auto-skill-saved");
		assert.equal(sent[0]?.message.display, true);
		assert.match(sent[0]?.message.content, /🧩 Skill "deploy-staging" created/);
		assert.match(sent[0]?.message.content, /deploy-staging\/SKILL\.md/);
		assert.match(sent[0]?.message.content, /Run \/reload to use it\./);
		assert.equal(briefs.length, 1, "the recap run is not judged into another skill");

		// And it is announced once.
		await emit("agent_settled", { aborted: false });
		assert.equal(sent.length, 1);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("if the user moves on before the recap, the saved block is not shown late", async () => {
	const { root, agentDir } = projectWithReference();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { pi, hooks, toolDefs, sent, briefs } = fakePi();
		autoSkillExtension(pi);
		const ctx: any = {
			cwd: root,
			hasUI: true,
			model: { provider: "p", id: "m" },
			modelRegistry: { complete: async () => ({ content: [{ type: "text", text: '{"action":"create","name":"deploy-staging","reason":"r"}' }] }) },
			ui: { notify: () => {}, confirm: async () => true, editor: async (_t: string, text: string) => text },
		};
		const emit = async (name: string, event: Record<string, unknown> = {}) => {
			for (const handler of hooks[name] ?? []) await handler({ type: name, ...event }, ctx);
		};
		await emit("session_start", { reason: "startup" });
		await emit("before_agent_start", { prompt: "task" });
		for (let index = 0; index < 6; index++) await emit("tool_call", { toolName: "bash", input: { command: `s${index}` } });
		await emit("agent_settled", { aborted: false });
		await emit("before_agent_start", { prompt: briefs[0] });
		await toolDefs.propose_skill!.execute("t1", { name: "deploy-staging", content: DRAFT }, undefined, undefined, ctx);

		// The user types something else instead of waiting.
		await emit("before_agent_start", { prompt: "now do something else" });
		await emit("agent_settled", { aborted: false });
		assert.equal(sent.length, 0, "the block would be out of place now");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("REGRESSION issue #1: a run started by a custom message (no prompt) does not throw and keeps the task", async () => {
	delete process.env.PI_AUTO_SKILL_PARENT;
	const { pi, hooks } = fakePi();
	autoSkillExtension(pi);
	const ctx: any = { cwd: process.cwd(), hasUI: true, ui: { notify: () => {} } };
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		for (const handler of hooks[name] ?? []) await handler({ type: name, ...event }, ctx);
	};
	await emit("session_start", { reason: "startup" });
	await emit("before_agent_start", { prompt: "the real task" });
	await emit("tool_call", { toolName: "bash", input: { command: "step 1" } });
	// pi.sendMessage(..., { triggerTurn: true }): messageType "custom", no prompt.
	await assert.doesNotReject(emit("before_agent_start", { messageType: "custom", message: { role: "custom", content: "background task done" } }));
});
