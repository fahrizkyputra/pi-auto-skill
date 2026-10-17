#!/usr/bin/env node
/**
 * End-to-end check against a real Pi process and a scripted model.
 *
 * Run 1 (accept): the model does a 5-step task → pi-auto-skill asks the same
 * model to judge it → the test approves the dialog → the agent receives the
 * [auto-skill] brief (with writing-great-skills inside) and calls propose_skill
 * → the test edits the draft in the editor → the edited SKILL.md lands in
 * <repo>/.agents/skills/deploy-staging/.
 *
 * Run 2 (decline): another task, the test declines → the name is recorded in
 * <repo>/.pi/auto-skill.json and nothing is written.
 *
 * Usage:  npm run test:e2e
 *         PI_AUTO_SKILL_EXTENSION=npm:@fahrizkyputra/pi-auto-skill npm run test:e2e
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 150_000;
const extensionSpec =
	process.env.PI_AUTO_SKILL_EXTENSION ??
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "auto-skill.ts");

const root = mkdtempSync(join(tmpdir(), "pi-auto-skill-e2e-"));
const agentDir = join(root, "agent");
const repo = join(root, "repo");
const sessionDir = join(root, "sessions");
for (const dir of [agentDir, repo, sessionDir, join(repo, ".git")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
// A stand-in writing-great-skills; the brief must carry its marker to the agent.
mkdirSync(join(agentDir, "skills", "writing-great-skills"), { recursive: true });
writeFileSync(
	join(agentDir, "skills", "writing-great-skills", "SKILL.md"),
	"---\nname: writing-great-skills\ndescription: Reference.\ndisable-model-invocation: true\n---\nREFERENCE-MARKER-7f3a: leading words, completion criteria.\n",
);

const DRAFT = [
	"---",
	"name: deploy-staging",
	"description: Use when deploying a branch to staging.",
	"---",
	"",
	"# Deploy to staging",
	"",
	"1. Push the branch.",
	"   Completion: the branch is on origin.",
	"",
].join("\n");

const judged = [];
const briefs = [];
let task = 0;

function text(message) {
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}
const recapRequests = [];
function lastToolResult(body) {
	const last = [...body.messages].reverse().find((message) => message.role === "tool");
	return last ? text(last) : "";
}
function lastUser(body) {
	const last = [...body.messages].reverse().find((message) => message.role === "user");
	return last ? text(last) : "";
}

/** One scripted move per request, chosen from what the conversation contains. */
function nextMove(body) {
	const user = lastUser(body);
	const all = body.messages.map((message) => JSON.stringify(message)).join("\n");

	// The judge call: a single user message asking for a JSON verdict.
	if (user.includes("ONE line of JSON")) {
		judged.push(user);
		const name = task === 1 ? "deploy-staging" : "rotate-logs";
		return { text: JSON.stringify({ action: "create", name, reason: "repeated procedure" }) };
	}
	// The authoring brief.
	if (user.includes("[auto-skill]")) {
		if (!all.includes("call_propose")) {
			briefs.push(user);
			return { tool: { id: "call_propose", name: "propose_skill", args: { name: "deploy-staging", content: DRAFT } } };
		}
		// The tool result asks for a recap of the original task first: the stub follows it from the
		// facts it was given, and the skill line comes last.
		const result = lastToolResult(body);
		recapRequests.push(result);
		if (result.includes("A short recap of the task")) {
			return { text: "Done: staging deploy finished.\nNot done / needs you: run the DB migration manually.\nNext: check /health." };
		}
		return { text: "Skill saved; run /reload to use it." };
	}
	// A task: five quick read-only steps, then an answer.
	const done = new Set(all.match(new RegExp(`call_step_\\d+_${task}\\b`, "g")) ?? []).size;
	if (done < 5) return { tool: { id: `call_step_${done}_${task}`, name: "bash", args: { command: `echo step ${done}` } } };
	return { text: `Task ${task} finished. The DB migration still needs a manual run.` };
}

function sse(response, delta, finish) {
	response.write(
		`data: ${JSON.stringify({
			id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
			...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
		})}\n\n`,
	);
}

const server = createServer((request, response) => {
	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		const parsed = JSON.parse(raw || "{}");
		const body = { ...parsed, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
		const move = body.messages.length > 0 ? nextMove(body) : { text: "ok" };
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (move.tool) {
			sse(response, { role: "assistant", tool_calls: [{ index: 0, id: move.tool.id, type: "function", function: { name: move.tool.name, arguments: JSON.stringify(move.tool.args) } }] }, null);
			sse(response, {}, "tool_calls");
		} else {
			sse(response, { role: "assistant", content: move.text }, null);
			sse(response, {}, "stop");
		}
		response.end("data: [DONE]\n\n");
	});
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const stubExtension = join(root, "stub-provider.ts");
writeFileSync(stubExtension, `export default function (pi) {
	pi.registerProvider("stub", { baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "stub-key", api: "openai-completions",
		models: [{ id: "stub-model", name: "Stub", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2048 }] });
}
`);

let confirmAnswer = true;
const confirms = [];
const editors = [];
const notices = [];
const extensionErrors = [];
const assistantTexts = [];
const settled = [];
const customMessages = [];
const stderr = [];
let finished = false;

const child = spawn("pi", ["--mode", "rpc", "-e", stubExtension, "-e", extensionSpec], {
	cwd: repo,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_AUTO_SKILL_PARENT: "" },
	stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type === "extension_error") extensionErrors.push(line.slice(0, 300));
		if (event.type === "agent_settled") settled.push(event);
		if (event.type === "message_end" && event.message?.role === "custom") customMessages.push(event.message);
		if (event.type === "message_end" && event.message?.role === "assistant") assistantTexts.push(JSON.stringify(event.message.content));
		if (event.type !== "extension_ui_request") continue;
		if (event.method === "notify") notices.push(String(event.message));
		if (event.method === "confirm") {
			confirms.push(event);
			send({ type: "extension_ui_response", id: event.id, confirmed: confirmAnswer });
		}
		if (event.method === "editor") {
			editors.push(event);
			const edited = String(event.prefill).replace("1. Push the branch.", "1. Push the branch (edited by the user).");
			send({ type: "extension_ui_response", id: event.id, value: edited });
		}
	}
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitUntil(predicate, label, ms = 40_000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
		await sleep(100);
	}
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	console.error(`state: judged=${judged.length} briefs=${briefs.length} confirms=${confirms.length} editors=${editors.length} settled=${settled.length}`);
	if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-500)}`);
	finish(1);
}
function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child.kill("SIGKILL");
	server.close();
	rmSync(root, { recursive: true, force: true });
	if (code === 0) console.log("e2e ok: task → judged → approved → brief → propose_skill → edited → saved → agent recaps the ORIGINAL task → saved block after the recap, once; decline recorded");
	process.exit(code);
}
const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

try {
	await sleep(3000);
	send({ id: "m", type: "set_model", provider: "stub", modelId: "stub-model" });
	await sleep(500);

	// Run 1: accept.
	task = 1;
	send({ id: "p1", type: "prompt", message: "deploy feat/x to staging" });
	const skillFile = join(repo, ".agents", "skills", "deploy-staging", "SKILL.md");
	await waitUntil(() => existsSync(skillFile), "the skill file to be saved", 60_000);

	if (judged.length !== 1) throw new Error(`expected 1 judge call, saw ${judged.length}`);
	if (!judged[0].includes("echo step 4")) throw new Error("the judge did not see the task steps");
	if (confirms.length !== 1 || !/Create skill "deploy-staging"/.test(confirms[0].title)) throw new Error(`unexpected dialog: ${confirms[0]?.title}`);
	if (!briefs[0]?.includes("REFERENCE-MARKER-7f3a")) throw new Error("the brief did not carry writing-great-skills");
	if (editors.length !== 1) throw new Error(`expected the editor once, saw ${editors.length}`);
	const saved = readFileSync(skillFile, "utf8");
	if (!saved.includes("(edited by the user)")) throw new Error("the user's edit was not saved");
	if (!saved.startsWith("---\nname: deploy-staging")) throw new Error("saved skill lost its frontmatter");

	// The recap: the agent was asked to restate the original task, with the facts it kept, and
	// the "saved" block is shown only after that recap.
	await waitUntil(() => customMessages.some((message) => message.customType === "auto-skill-saved"), "the saved block", 20_000);
	const recapRequest = recapRequests.find((request) => request.includes("A short recap of the task"));
	if (!recapRequest) throw new Error("the agent was never asked to recap the original task");
	if (!recapRequest.includes("The DB migration still needs a manual run")) throw new Error("the recap request lost the original final answer");
	if (!recapRequest.includes("deploy feat/x to staging")) throw new Error("the recap request lost the original request");
	if (recapRequest.includes("REFERENCE-MARKER-7f3a")) throw new Error("the skill reference leaked into the recap request");
	const blocks = customMessages.filter((message) => message.customType === "auto-skill-saved");
	if (blocks.length !== 1) throw new Error(`expected the saved block once, saw ${blocks.length}`);
	const blockText = typeof blocks[0].content === "string" ? blocks[0].content : JSON.stringify(blocks[0].content);
	if (!/Skill "deploy-staging" created/.test(blockText) || !/Run \/reload to use it\./.test(blockText)) throw new Error(`saved block: ${blockText}`);
	const recapIndex = assistantTexts.findIndex((entry) => entry.includes("Not done / needs you"));
	if (recapIndex < 0) throw new Error("no recap from the agent");
	if (/Run \/reload/.test(assistantTexts[recapIndex] ?? "")) throw new Error("the agent repeated the reload notice that the extension prints");
	if (!/Do not mention the skill or \/reload/.test(recapRequest)) throw new Error("the agent was not told to leave the notice to the extension");
	if (notices.some((notice) => /Run \/reload/.test(notice))) throw new Error("a reload notice came before the recap");
	// Nothing else is judged after the recap: still exactly one judge call.
	await sleep(1000);
	if (judged.length !== 1) throw new Error(`the recap run was judged again: ${judged.length} judge calls`);

	// Run 2: decline.
	await sleep(500);
	confirmAnswer = false;
	task = 2;
	const confirmsBefore = confirms.length;
	send({ id: "p2", type: "prompt", message: "rotate the app logs" });
	await waitUntil(() => confirms.length > confirmsBefore, "the second suggestion", 40_000);
	await sleep(800);
	const state = JSON.parse(readFileSync(join(repo, ".pi", "auto-skill.json"), "utf8"));
	if (!state.declined.includes("rotate-logs")) throw new Error(`decline not recorded: ${JSON.stringify(state)}`);
	if (existsSync(join(repo, ".agents", "skills", "rotate-logs"))) throw new Error("a declined skill was written");
	if (extensionErrors.length) throw new Error(`extension error: ${extensionErrors[0]}`);

	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
