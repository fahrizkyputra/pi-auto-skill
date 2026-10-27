# pi-auto-skill

After you finish a task in Pi, this package asks whether it is a procedure worth keeping as a **project skill** — and if you agree, the agent writes one, following the [writing-great-skills](#requirements) reference, and you review it before it is saved to the repo.

Instead of explaining the same deploy, migration, or release routine every time, the next session finds a skill for it.

## Install

```bash
pi install npm:@fahrizkyputra/pi-auto-skill
```

## How it works

1. You work as usual. When the agent finishes a run, the package checks a minimum bar: **at least 5 tool calls, or at least one file changed**. Plain questions and short chats are never judged.
2. If the bar is met, the **active model** is asked once (a small call) whether the task is a procedure that will be repeated in this project. It also sees the project's existing skills and the names you declined before.
3. If yes, a dialog asks: *Create skill `deploy-staging`?* — or *Update skill `deploy-production`?* when an existing skill covers the procedure but the task revealed new steps.
4. On **Yes**, the agent in your session writes the skill from the task it just finished, following writing-great-skills: a reusable procedure, with values that change between runs (branches, IDs, versions) turned into named inputs.
5. The draft opens in an **editor**. Edit it, then save to keep it or cancel to discard it. Nothing is written to disk before this point.
6. On **No**, that name is never suggested again in this project.
7. After you save, the agent **restates your original task** — what is done, what is not done or needs you, and the next step (at most 8 lines, in the language you wrote in) — and the package puts a fixed block right under it:
   ```
   🧩 Skill "deploy-staging" created
      .agents/skills/deploy-staging/SKILL.md
      Run /reload to use it.
   ```
   Writing the skill pushes your task far up the chat, so without this you would have to scroll back to find what was left for you to do. The recap uses the original request, the files changed, and the agent's own final answer from the task, which the package kept; it does not describe the skill. If you type something else before the recap ends, the block is not shown late.

The skill lands in the repo's skills folder: `.agents/skills/` if it exists, else `.pi/skills/` if it exists, else `.agents/skills/` (the Agent Skills location other agents read too). Run `/reload` to load it.

## Commands

| Command | What it does |
|---|---|
| `/auto-skill` | Turn the last task into a skill now — no minimum bar, ignores the off switch and declined names |
| `/auto-skill off` · `/auto-skill on` | Stop or resume suggestions for this project |
| `/auto-skill status` | Project root, skills folder, existing skills, declined names, and whether writing-great-skills was found |

Per-project state (on/off and declined names) is kept in `<repo>/.pi/auto-skill.json`. Commit it to share declines with the team, or add it to `.gitignore`.

## Requirements

The package does not ship a skill-writing guide of its own. It reads **writing-great-skills** from `~/.pi/agent/skills/writing-great-skills/` (or `$PI_CODING_AGENT_DIR/skills/writing-great-skills/`): `SKILL.md` is embedded in the agent's brief, and `GLOSSARY.md` is referenced by path. If it is not installed, nothing is judged and `/auto-skill` tells you why.

## Behaviour details

- The agent hands the draft over through a `propose_skill` tool, never by writing the file itself. Drafts with invalid frontmatter (name format, missing or over-long description, empty body) go back to the agent to fix before you see them.
- Updating a skill moves the previous `SKILL.md` to the trash first (`trash` CLI), or keeps a `.bak` copy when the trash is unavailable.
- If you type a new message while the judgement is still running, the suggestion is dropped.
- Subagents and non-interactive runs (RPC without dialogs, print mode) are never judged, so no hidden model calls happen there.
- Version 1 writes one `SKILL.md` per skill; supporting reference files are not generated.

## jcode

In [jcode](https://github.com/1jehuang/jcode) the package is a `/auto-skill` skill you call yourself. jcode has no hook that can start a turn after a task, so there is no automatic suggestion:

```bash
npx -y @fahrizkyputra/pi-auto-skill jcode install     # needs Node 22.18+
```

Then, after a task in jcode: `/auto-skill` or `/auto-skill deploy-staging`. The agent:

1. picks a name for the procedure (or stops if the task was a one-off),
2. runs `jcode-auto-skill brief <name>`, which prints the same authoring brief and writing-great-skills reference as in Pi, plus the existing skill when the name is taken,
3. writes the draft to a scratch file under `~/.jcode/auto-skill-drafts/` and checks it with `jcode-auto-skill check <name>` (same validation as Pi),
4. shows you the draft and waits; you ask for changes in the chat,
5. on your yes, runs `jcode-auto-skill save <name>`, which writes `<repo>/.agents/skills/<name>/SKILL.md` (the old version goes to the trash),
6. restates your original task.

writing-great-skills is read from `~/.jcode/skills`, `~/.pi/agent/skills`, or `~/.agents/skills`, in that order. The installer copies the code to `~/.jcode/plugins/pi-auto-skill/`, links the skill into `~/.jcode/skills` (never over an existing folder), and links `jcode-auto-skill` into `~/.local/bin` when that is on `PATH` and free. Update: run the install line again. Remove: `jcode-auto-skill uninstall` (saved project skills are kept).

## Cost

One small model call per task that meets the minimum bar, plus one agent turn when you accept a suggestion.

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck
npm run test:e2e  # real Pi over RPC with a scripted model: judge → approve → propose_skill → edit → save; decline
```

## License

MIT
