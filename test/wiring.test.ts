import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoSkillExtension from "../extensions/auto-skill.ts";

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const hooks: Record<string, Handler[]> = {};
	const tools: string[] = [];
	const commands: string[] = [];
	const pi = {
		on: (name: string, handler: Handler) => {
			hooks[name] = [...(hooks[name] ?? []), handler];
		},
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return { pi, hooks, tools, commands };
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
