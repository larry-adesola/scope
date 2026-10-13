# Scope

Understand what your coding agent just did, without reading a wall of code.

Scope turns a change into a short list of **decisions**, in plain words. You agree or disagree with each one. The code stays hidden until you ask for it. Your verdicts go into a notes file, and your agent fixes what you did not like.

## Why

Coding agents write changes faster than anyone can review them. A diff viewer does not help much, because the real problem is not the code:

- **You did not make the decisions.** Understanding comes from making choices, not from reading the result. When an agent makes them, you never build the picture in your head.
- **The "why" is missing.** Code shows what it does. It does not show what it was meant to do, or what the agent chose not to do.
- **Agent code looks tidy even when it is wrong.** The usual warning signs are gone.
- **There is too much of it.** Repeats, extra layers, things nobody asked for.

So Scope puts the decisions in front of you first, marks the ones the agent **assumed** without being told, and measures the bloat for you.

## What you need

- [Node.js](https://nodejs.org) 20 or newer
- [git](https://git-scm.com)
- A coding agent that reads `AGENTS.md` or `CLAUDE.md`, such as Claude Code, Codex or Cursor
- A browser from 2024 or later

Scope has no AI of its own and nothing else to install.

## Install

```bash
npm install -g github:larry-adesola/scope
```

Check it worked:

```bash
scope help
```

You should see a short list of commands.

To remove it later:

```bash
npm uninstall -g scope-review
```

## Use it

### 1. Set up a project. Once per project.

In the project you want to review:

```bash
scope init
```

This adds a `.scope` folder with instructions for your agent, and one line to `AGENTS.md` and `CLAUDE.md` so the agent knows where they are. Both files are created if they do not exist.

The project needs to use git. It does not need any commits yet.

### 2. Let your agent work, as normal.

### 3. Tell your agent: `scope this`

It writes a review of the change and checks it. Wait until it says the review is ready.

### 4. Open the page

```bash
scope
```

Your browser opens on a local page. Press Ctrl+C in the terminal when you are done.

### 5. Go through it

You can stop at any point. You do not have to finish everything.

### 6. Tell your agent: `fix the scope notes`

It reads your verdicts and makes the changes.

## What you see

**Overview.** What you asked for, what changed as "before" and "now", and the list of decisions. No code.

**Decisions.** One per screen. The ones the agent assumed come first, riskiest at the top. Each shows the choice, why, and the option the agent did not take. Risky ones start with a question you answer in your head before seeing the answer. A button shows the few lines of code behind the decision, and hides them again. You press Agree, Disagree, or I don't get it.

**Clean-up.** How many lines each decision cost, new code that copies code you already have, changed code that no decision explains, and every new function.

**Map and quiz.** What you have and have not looked at, then up to three questions to check you understood the change.

Hard words such as "token" have a dotted underline. Click one to see what it means in this change.

### Keys

| Key | What it does |
| --- | --- |
| Left and right arrows | Previous and next decision |
| 1, 2, 3 | Agree, Disagree, I don't get it |
| Escape | Close a word's meaning |

## How it stays honest

The review is written by an agent, so Scope does not trust it.

- **The agent never supplies code.** It names a file and line numbers. Scope reads the real lines from your disk.
- **Nothing is hidden.** Scope compares the review with the real change from git. Changed code that no decision explains is listed on the clean-up screen.
- **Copies are checked twice.** Scope finds near-identical blocks itself. The agent must also say, for every new function, whether something similar already exists. If it skips one, the check fails.
- **Scope runs nothing.** No tests, no linter, no command from the review. The only program it starts is git.
- **It stays on your machine.** The page is served on `127.0.0.1` only and refuses requests from other websites. Nothing is sent anywhere.

## Commands

| Command | What it does |
| --- | --- |
| `scope init` | Set up the current project |
| `scope check` | Check the review file. Your agent runs this. |
| `scope` | Open the review in your browser |

## Limits

Scope is new. It has been used by its author on a handful of changes.

- **The plain words are the agent's account.** You can open the code behind any decision, but a choice the agent never wrote down only shows up if its code is left unexplained.
- **Finding new functions works by pattern.** It knows JavaScript, TypeScript, Python, Ruby, Go and Rust. It misses Java, C# and C-style code, and it counts small helpers inside other functions, so the list can get long.
- **Brand-new files are checked loosely.** A whole new file counts as explained if any decision points at part of it.
- **The copy finder only sees near-identical text.** Reworded copies rest on the agent's answer.
- **Editing the review file wipes your verdicts.** So does asking the agent to scope again.
- **Only tested with Claude Code so far.** Other agents should work if they read `AGENTS.md`. Reports are welcome.

## Files Scope writes

All inside `.scope/` in your project:

| File | What it is | In git? |
| --- | --- | --- |
| `INSTRUCTIONS.md` | How your agent should write a review | Yes |
| `review.json` | The review your agent wrote | No |
| `state.json` | Your progress | No |
| `notes.md` | Your verdicts, for the agent | No |

## Working on Scope

```bash
git clone https://github.com/larry-adesola/scope.git
cd scope
npm link
npm test
```

There is no build step and there are no dependencies. The page is plain HTML, CSS and JavaScript in `page/`. The checker is `src/core.js`. The design and the research behind it are in [docs/superpowers/specs](docs/superpowers/specs/2026-10-13-scope-design.md).

The format of the review file is described in [INSTRUCTIONS.md](INSTRUCTIONS.md), which is also what your agent reads.

## Credits

The dotted orb animation is [thinking-orbs](https://libraries.dev/orbs) by Jakub Antalik, MIT licensed. Its engine file is included in `page/vendor/`.

## Licence

[MIT](LICENSE)
