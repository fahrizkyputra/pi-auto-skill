/**
 * The flow, behind an injected host so it runs and is tested without Pi:
 *
 *   run settles → minimum bar → judge (one model call) → ask the user →
 *   agent writes via propose_skill → user edits in an editor → save
 */

import { isDeclined, type ProjectState } from "./project-state.ts";
import {
	authoringBrief,
	judgePrompt,
	parseVerdict,
	type ReferenceSkill,
	type TaskDigest,
	type Verdict,
	wrapUpMessage,
} from "./prompts.ts";
import { type ExistingSkill, validateSkill } from "./skill-files.ts";

export const MIN_TOOL_CALLS = 5;

export interface AutoSkillHost {
	/** Interactive UI available (TUI or RPC with dialogs). */
	hasUI: boolean;
	/** True inside a pi-subagents child process. */
	isSubagent: boolean;
	projectRoot: string;
	skillsDir: string;
	readState(): ProjectState;
	writeState(state: ProjectState): void;
	listSkills(): ExistingSkill[];
	readSkill(path: string): string | undefined;
	loadReference(): ReferenceSkill | undefined;
	/** One model call with the active model; returns the reply text. */
	judge(prompt: string): Promise<string>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Opens a multi-line editor prefilled with `text`; undefined when cancelled. */
	edit(title: string, text: string): Promise<string | undefined>;
	/** Sends the authoring brief to the session's agent as a new turn. */
	sendBrief(text: string): void;
	saveSkill(name: string, content: string): string;
}

export interface Proposal {
	name: string;
	content: string;
}

export type Outcome =
	| { kind: "skipped"; reason: string }
	| { kind: "declined"; name: string }
	| { kind: "briefed"; name: string; action: "create" | "update" }
	| { kind: "error"; reason: string };

/** A skill that was just saved, waiting to be announced under the agent's recap of the task. */
export interface SavedSkill {
	action: "create" | "update";
	name: string;
	path: string;
}

export class AutoSkillController {
	private readonly host: AutoSkillHost;
	/**
	 * The skill the agent was asked to write; propose_skill must match it. `digest` is the task the
	 * skill came from: the run that writes the skill replaces the extension's own digest, so the
	 * task is kept here for the recap that follows.
	 */
	private pending: { name: string; action: "create" | "update"; digest: TaskDigest } | undefined;
	private saved: SavedSkill | undefined;
	/** Bumped by every user prompt, so a judgement that finishes late is dropped. */
	private generation = 0;

	constructor(host: AutoSkillHost) {
		this.host = host;
	}

	onUserPrompt(): void {
		this.generation++;
		// A skill saved just before: the user went on to something else, so its recap is no longer
		// "the last thing in the chat" and the saved block would be out of place.
		this.saved = undefined;
	}

	isWriting(): boolean {
		return this.pending !== undefined;
	}

	/** After a run settles: decide, ask, and brief the agent. */
	async onTaskFinished(digest: TaskDigest, toolCalls: number, options: { force?: boolean } = {}): Promise<Outcome> {
		const host = this.host;
		if (!host.hasUI) return { kind: "skipped", reason: "no interactive UI" };
		if (host.isSubagent) return { kind: "skipped", reason: "subagent" };
		if (this.pending) return { kind: "skipped", reason: "already writing a skill" };

		const state = host.readState();
		if (!options.force && !state.enabled) return { kind: "skipped", reason: "disabled for this project" };
		if (!options.force && toolCalls < MIN_TOOL_CALLS && digest.changedFiles.length === 0) {
			return { kind: "skipped", reason: "below the minimum bar" };
		}

		const reference = host.loadReference();
		if (!reference) {
			if (options.force) {
				host.notify("auto-skill: writing-great-skills is not installed (~/.pi/agent/skills/writing-great-skills), so no skill was written.", "error");
			}
			return { kind: "error", reason: "writing-great-skills not found" };
		}

		const existing = host.listSkills();
		const declined = options.force ? [] : state.declined;
		const generation = this.generation;

		let verdict: Verdict;
		try {
			const reply = await host.judge(judgePrompt(digest, existing, declined));
			verdict = parseVerdict(reply, existing, declined);
		} catch (error) {
			return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
		}
		if (generation !== this.generation) return { kind: "skipped", reason: "the user moved on" };

		if (verdict.action === "skip" || !verdict.name) {
			if (options.force) host.notify(`auto-skill: the task does not look like a reusable procedure${verdict.reason ? ` (${verdict.reason})` : ""}.`, "info");
			return { kind: "skipped", reason: verdict.reason ?? "judge said skip" };
		}

		const updating = verdict.action === "update";
		const target = existing.find((skill) => skill.name === verdict.name);
		const approved = await host.confirm(
			updating ? `Update skill "${verdict.name}"?` : `Create skill "${verdict.name}"?`,
			[
				verdict.reason ?? "",
				"",
				updating && target ? `Existing: ${target.path}` : `Location: ${host.skillsDir}/${verdict.name}/SKILL.md`,
				"The agent drafts it with writing-great-skills; you review and edit it before it is saved.",
				"No = never suggest this name again in this project.",
			].join("\n"),
		);
		if (generation !== this.generation) return { kind: "skipped", reason: "the user moved on" };

		if (!approved) {
			if (!isDeclined(state, verdict.name)) host.writeState({ ...state, declined: [...state.declined, verdict.name] });
			return { kind: "declined", name: verdict.name };
		}

		const existingContent = target ? host.readSkill(target.path) : undefined;
		this.pending = { name: verdict.name, action: updating ? "update" : "create", digest };
		host.sendBrief(
			authoringBrief({
				verdict: { ...verdict, name: verdict.name },
				reference,
				skillsDir: host.skillsDir,
				...(existingContent === undefined ? {} : { existingContent }),
			}),
		);
		return { kind: "briefed", name: verdict.name, action: this.pending.action };
	}

	/**
	 * The propose_skill tool: validate, let the user edit, save. Returns the text
	 * the agent sees as the tool result.
	 */
	async onProposal(proposal: Proposal): Promise<{ ok: boolean; message: string }> {
		const host = this.host;
		const pending = this.pending;
		if (!pending) {
			return { ok: false, message: "No skill was requested. Only call propose_skill after an [auto-skill] brief." };
		}
		if (proposal.name !== pending.name) {
			return { ok: false, message: `The requested skill is "${pending.name}", not "${proposal.name}". Propose it under that name.` };
		}
		const check = validateSkill(proposal.name, proposal.content);
		if (!check.ok) {
			return { ok: false, message: `The draft is not valid yet:\n- ${check.problems.join("\n- ")}\nFix these and call propose_skill again.` };
		}
		if (!host.hasUI) {
			this.pending = undefined;
			return { ok: false, message: "No interactive UI to review the draft; nothing was saved." };
		}

		const edited = await host.edit(`Review skill "${proposal.name}" — save to keep, cancel to discard`, proposal.content);
		if (edited === undefined || edited.trim().length === 0) {
			this.pending = undefined;
			host.notify(`auto-skill: "${proposal.name}" discarded.`, "info");
			return { ok: true, message: "The user discarded the draft. Nothing was saved. Do not propose it again; just acknowledge briefly." };
		}

		const final = validateSkill(proposal.name, edited);
		if (!final.ok) {
			this.pending = undefined;
			host.notify(`auto-skill: the edited "${proposal.name}" is not a valid skill (${final.problems.join("; ")}). Nothing saved.`, "warning");
			return { ok: true, message: `The user's edit made the skill invalid (${final.problems.join("; ")}); nothing was saved. Acknowledge briefly.` };
		}

		const path = host.saveSkill(proposal.name, edited);
		this.pending = undefined;
		// The "saved, run /reload" block is shown after the agent's recap (see takeSaved), not now.
		this.saved = { action: pending.action, name: proposal.name, path };
		return {
			ok: true,
			message: wrapUpMessage({ action: pending.action, name: proposal.name, path, edited: edited !== proposal.content, digest: pending.digest }),
		};
	}

	/** The skill saved by the run that just ended, once; undefined when nothing was saved. */
	takeSaved(): SavedSkill | undefined {
		const saved = this.saved;
		this.saved = undefined;
		return saved;
	}

	/** The run that was meant to write the skill ended without a proposal. */
	onWritingRunEnded(): void {
		if (!this.pending) return;
		this.host.notify(`auto-skill: the agent did not propose "${this.pending.name}"; nothing was saved.`, "warning");
		this.pending = undefined;
	}

	cancelPending(): void {
		this.pending = undefined;
		this.saved = undefined;
	}
}
