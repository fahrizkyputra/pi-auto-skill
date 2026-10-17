/**
 * @fahrizkyputra/pi-auto-skill — after a task, propose turning it into a
 * project skill, written with writing-great-skills and reviewed before saving.
 */

import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AutoSkillController, type AutoSkillHost } from "../src/controller.ts";
import { readState, writeState } from "../src/project-state.ts";
import { loadReferenceSkill, PROPOSE_TOOL, savedBlock, type TaskDigest } from "../src/prompts.ts";
import { listProjectSkills, projectRoot, saveSkill, skillsDir } from "../src/skill-files.ts";

/** Set for child processes so subagents never judge or propose skills. */
const CHILD_FLAG = "PI_AUTO_SKILL_PARENT";
const SAVED_TYPE = "auto-skill-saved";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.join("");
}

function describeCall(toolName: string, input: Record<string, unknown>): string {
	if (typeof input.command === "string") return `${toolName}: ${input.command}`;
	if (typeof input.path === "string") return `${toolName}: ${input.path}`;
	const json = JSON.stringify(input);
	return `${toolName}: ${json.length > 160 ? `${json.slice(0, 159)}…` : json}`;
}

export default function autoSkillExtension(pi: ExtensionAPI) {
	// A subagent inherits the parent's environment; the parent marks itself once loaded.
	const parentPid = process.env[CHILD_FLAG]?.trim();
	const isSubagent = parentPid !== undefined && parentPid.length > 0 && parentPid !== String(process.pid);

	let digest: TaskDigest = { request: "", steps: [], changedFiles: [], finalAnswer: "" };
	let toolCalls = 0;
	let writingRun = false;
	let lastCtx: ExtensionContext | undefined;
	let controller: AutoSkillController | undefined;

	const hostFor = (ctx: ExtensionContext): AutoSkillHost => {
		const root = projectRoot(ctx.cwd);
		return {
			hasUI: ctx.hasUI,
			isSubagent,
			projectRoot: root,
			skillsDir: skillsDir(root),
			readState: () => readState(root),
			writeState: (state) => writeState(root, state),
			listSkills: () => listProjectSkills(root),
			readSkill: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
			loadReference: () => loadReferenceSkill(),
			judge: async (prompt) => {
				const model = ctx.model;
				if (!model) throw new Error("no active model");
				const response = await ctx.modelRegistry.complete(model, {
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				});
				return textOf(response.content);
			},
			confirm: (title, message) => ctx.ui.confirm(title, message),
			notify: (message, type) => ctx.ui.notify(message, type ?? "info"),
			edit: (title, text) => ctx.ui.editor(title, text),
			sendBrief: (text) => {
				writingRun = true;
				pi.sendUserMessage(text);
			},
			saveSkill: (name, content) => saveSkill(skillsDir(root), name, content),
		};
	};

	const controllerFor = (ctx: ExtensionContext): AutoSkillController => {
		lastCtx = ctx;
		controller = new AutoSkillController({
			...hostFor(ctx),
			// Always resolve against the latest context, so UI calls never hit a stale one.
			confirm: (title, message) => (lastCtx ?? ctx).ui.confirm(title, message),
			notify: (message, type) => (lastCtx ?? ctx).ui.notify(message, type ?? "info"),
			edit: (title, text) => (lastCtx ?? ctx).ui.editor(title, text),
		});
		return controller;
	};

	pi.on("session_start", (_event, ctx) => {
		if (!isSubagent) process.env[CHILD_FLAG] = String(process.pid);
		controllerFor(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		const isBrief = event.prompt.startsWith("[auto-skill]");
		if (!isBrief) {
			controller?.onUserPrompt();
			if (writingRun) {
				// The user moved on before the agent proposed the skill.
				controller?.cancelPending();
				writingRun = false;
			}
		}
		digest = { request: event.prompt, steps: [], changedFiles: [], finalAnswer: "" };
		toolCalls = 0;
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === PROPOSE_TOOL) return undefined;
		toolCalls++;
		digest.steps.push(describeCall(event.toolName, event.input as Record<string, unknown>));
		return undefined;
	});

	pi.on("tool_result", (event) => {
		if (event.isError) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path === "string" && !digest.changedFiles.includes(path)) digest.changedFiles.push(path);
		return undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role === "assistant") {
			const text = textOf(message.content).trim();
			if (text.length > 0) digest.finalAnswer = text;
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		lastCtx = ctx;
		const instance = controller ?? controllerFor(ctx);
		if (event.aborted) {
			if (writingRun) instance.cancelPending();
			writingRun = false;
			return;
		}
		if (writingRun) {
			// This run was the agent writing the skill; it is never judged itself.
			writingRun = false;
			instance.onWritingRunEnded();
			return;
		}
		// The run that saved the skill has ended: its recap of the task is now the last thing in
		// the chat, so the fixed "saved, run /reload" block goes right under it. Never judged.
		const saved = instance.takeSaved();
		if (saved) {
			const block = savedBlock(saved.action, saved.name, saved.path);
			if (typeof pi.sendMessage === "function") pi.sendMessage({ customType: SAVED_TYPE, content: block, display: true });
			else ctx.ui.notify(block, "info");
			return;
		}
		await instance.onTaskFinished({ ...digest, steps: [...digest.steps], changedFiles: [...digest.changedFiles] }, toolCalls);
	});

	pi.registerMessageRenderer?.(SAVED_TYPE, (message, { outputPad }, theme) => {
		const raw = typeof message.content === "string" ? message.content : textOf(message.content);
		const [head = "", ...rest] = raw.split("\n");
		const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text([theme.fg("accent", theme.bold(head)), ...rest.map((line) => theme.fg("dim", line))].join("\n"), 0, 0));
		return box;
	});

	pi.registerTool({
		name: PROPOSE_TOOL,
		label: "Propose skill",
		description:
			"Submit a drafted project skill (full SKILL.md content) for the user to review. Use only after an [auto-skill] brief asks for it; the user edits and saves it.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name, exactly as given in the [auto-skill] brief" }),
			content: Type.String({ description: "Complete SKILL.md content, starting with the --- frontmatter block" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const instance = controller ?? controllerFor(ctx);
			const result = await instance.onProposal({ name: params.name, content: params.content });
			if (result.ok) writingRun = false;
			return { content: [{ type: "text", text: result.message }], details: undefined, ...(result.ok ? {} : { isError: true }) };
		},
	});

	pi.registerCommand("auto-skill", {
		description: "Turn the last task into a project skill now, or toggle suggestions for this project (on | off | status)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on — suggest skills after tasks in this project" },
				{ value: "off", label: "off — stop suggesting in this project" },
				{ value: "status", label: "status — project, skills folder, declined names" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const instance = controller ?? controllerFor(ctx);
			const host = hostFor(ctx);
			const action = args.trim().toLowerCase();

			if (action === "on" || action === "off") {
				host.writeState({ ...host.readState(), enabled: action === "on" });
				ctx.ui.notify(`auto-skill ${action === "on" ? "on" : "off"} for ${host.projectRoot}.`, "info");
				return;
			}

			if (action === "status") {
				const state = host.readState();
				const skills = host.listSkills();
				ctx.ui.notify(
					[
						`auto-skill: ${state.enabled ? "on" : "off"} for ${host.projectRoot}`,
						`skills folder: ${host.skillsDir}`,
						`project skills: ${skills.length > 0 ? skills.map((skill) => skill.name).join(", ") : "(none)"}`,
						`declined: ${state.declined.length > 0 ? state.declined.join(", ") : "(none)"}`,
						`writing-great-skills: ${host.loadReference() ? "found" : "NOT FOUND (~/.pi/agent/skills/writing-great-skills)"}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (action.length > 0) {
				ctx.ui.notify(`Unknown argument "${action}". Use /auto-skill, /auto-skill on | off | status.`, "warning");
				return;
			}

			if (digest.steps.length === 0 && digest.finalAnswer.length === 0) {
				ctx.ui.notify("auto-skill: no finished task in this session yet.", "info");
				return;
			}
			await instance.onTaskFinished({ ...digest, steps: [...digest.steps], changedFiles: [...digest.changedFiles] }, toolCalls, { force: true });
		},
	});
}
