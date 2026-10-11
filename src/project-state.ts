/**
 * Per-project state in `<root>/.pi/auto-skill.json`: whether suggestions are
 * on for this project, and which skill names the user declined.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectState {
	enabled: boolean;
	declined: string[];
}

export function statePath(root: string): string {
	return join(root, ".pi", "auto-skill.json");
}

export function readState(root: string): ProjectState {
	const path = statePath(root);
	if (!existsSync(path)) return { enabled: true, declined: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectState>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
			declined: Array.isArray(raw.declined) ? raw.declined.filter((name): name is string => typeof name === "string") : [],
		};
	} catch {
		return { enabled: true, declined: [] };
	}
}

export function writeState(root: string, state: ProjectState): void {
	const path = statePath(root);
	mkdirSync(join(root, ".pi"), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ enabled: state.enabled, declined: [...new Set(state.declined)].sort() }, null, 2)}\n`);
	renameSync(temporary, path);
}

export function isDeclined(state: ProjectState, name: string): boolean {
	return state.declined.includes(name);
}
