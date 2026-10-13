# Scope: design

Date: 2026-10-13. Reshaped the same day from "walk the code" to "walk the decisions".

## The problem

Coding agents write changes faster than a person can review them. People end up approving code they do not understand, and the code is often heavier than it needs to be.

## What the real issue is

The first version of Scope reordered the code and attached a claim to each piece. It was still a lot of code to read.

Forum threads and research point somewhere else. People are missing the decisions, not the code.

- Understanding comes from making the decisions, not from reading the result. When an agent makes them, the person never builds the mental model (the most common reason given across three Hacker News threads; Naur's "programming as theory building"; Storey's "cognitive debt").
- The "why" is missing. Code shows what it does, not what it was meant to do, and never the options that were rejected.
- The mistake is often upstream: a wrong assumption, neatly built on.
- Agent code looks tidy even when it is wrong, so the usual warning signs are gone.
- There is too much of it: repeats, extra layers, edge cases nobody asked for.
- People catch wrong AI claims only about half the time (arXiv 2607.08885), and passive reading of AI output lowers comprehension (arXiv 2601.20245).

What people report works: reviewing assumptions before code, being quizzed, looking at behaviour first and lines last.

## The goal

A local tool that puts the decisions behind a change in front of one person, in plain words, with the code available as evidence. It also shows where the change is heavier than it needs to be.

Success means that, across five real changes:

1. The reviewer catches something a normal diff would have hidden.
2. The reviewer can explain the change afterwards without looking.
3. It takes less time than reading the diff.

## Decisions made

- Local tool. One command opens a local web page.
- The tool has no AI of its own. Whatever coding agent the person uses writes the review, following an instructions file.
- Decisions first, code last. Code is hidden until asked for.
- Scope never runs anything: no tests, no linter, no command from anywhere. A proof is a line of text the person can run themselves.
- Cleanliness is measured by the tool where it can be. Naming and design taste are out of scope.
- The reviewer's verdicts save to a notes file the agent can read.
- No framework, no build step, nothing to install. One vendored file for the orb animation.

## How one review runs

1. The person tells their agent "scope this".
2. The agent follows `.scope/INSTRUCTIONS.md` and writes `.scope/review.json`.
3. The agent runs `scope check` and fixes what it reports.
4. The person runs `scope`. It checks the file, starts a local server and opens the page.
5. The person reads what changed, gives a verdict on each decision, then goes through the clean-up list.
6. The person tells the agent "fix the scope notes".

## The review file

`.scope/review.json`. See `INSTRUCTIONS.md` for a full example.

- `title`, and optionally `base` (the git ref to compare against, default `HEAD`).
- `asked`: the person's request in their own words.
- `changes`: what the software does differently, as `{ before, after }` pairs. Behaviour, not files.
- `decisions`: each a choice that could have gone another way.
  - `title`: what the code now does.
  - `origin`: `asked` or `assumed`.
  - `risk`: `high`, `medium` or `low`.
  - `why`, and optionally `instead` (the option not taken), `proof` (text), `guess` (`{ question, answer }`).
  - `code`: the places that carry it out, each `{ file, lines: [first, last] }`.
- `added`: every new function, class or module, each with `name`, `file`, `lines`, and `similar`: `null`, or the place and a `why` for existing code that does the same job.
- `boring`: files nobody needs to read, each with a `why`.
- `quiz`: up to three `{ question, answer }` pairs for the end.
- `terms`: hard words, each `{ term, meaning }`, with the meaning written for this change.

## Trust rules

The review file is written by an agent, so the tool does not trust it.

- The agent never supplies code. It names files and lines, and the tool reads the real code from disk and the real removed lines from git.
- Every path must resolve inside the project, after following symlinks.
- Nothing is ever run.
- All agent text reaches the page as text, never as markup.
- The server listens on 127.0.0.1 only and rejects requests from other hosts or origins.

## Checks

Errors stop the tool: invalid JSON, a missing or wrong field, a path outside the project, a missing file, a line range outside the file, a name in `added` that is not at the lines given, a base git cannot find.

Warnings do not: no `asked`, more than three guess questions, a guess on a decision that is not high risk.

Two things make `scope check` fail but still let the page open, so the person sees them:

- **Code with no reason.** The tool compares the review with the real change (`git diff` against the base, plus untracked files). Any changed block that no decision points at, in a file that is not boring, is listed.
- **New functions not checked for copies.** The tool looks for function and class definitions on added lines. Any that is missing from `added` is listed. A name that also appears in the removed lines was moved or edited, so it is skipped.

A review also goes stale: the tool keeps a fingerprint of the change, and warns when the code has changed since.

## Cleanliness

Measured by the tool, with no AI:

- **Weight.** Lines added and removed, in total, and added lines per decision. A heavy decision stands out without reading anything.
- **Code with no reason.** As above. Bloat is code without a reason.
- **Near-identical copies.** New blocks of four or more matching lines found elsewhere in the project, ignoring spacing and trivial lines.

Declared by the agent, and forced:

- **Reworded copies.** The tool cannot match meaning, so the agent must answer for every new function whether existing code does the same job. When it says yes, the page shows the two together.

A copy the agent already declared is not listed a second time by the tool.

## The page

Large text, generous spacing, left aligned, one thing at a time. The look follows the reference the user chose (dribbble.com/shots/25000009-ChronoTask-Landing-Page): a soft grey page, white floating cards, a two-tone headline, pill labels, one blue, a yellow sticky note for the note box.

1. **Overview.** What you asked, what changed, then the decisions. No code.
2. **Decision.** One per screen. Assumed decisions come first, then the riskiest. Shows where it came from, the choice, why, the other option, a guess question if there is one, and a button that reveals the code behind it. The same button hides the code again. Verdicts: Agree, Disagree, I don't get it. Arrow keys move between decisions. Keys 1, 2 and 3 give a verdict.
3. **Clean-up.** Weight of each decision as bars, copies shown as "New" against "Already there", code with no reason, and the list of new things. Verdicts: Keep, Remove.
4. **Map.** One square per decision and clean-up item, coloured by what was done, then the quiz. Each quiz answer is hidden until asked for, and marked "I knew it" or "I didn't".

Every screen says that you can stop at any point and tell the agent "fix the scope notes", with a count of the notes waiting. Nobody has to finish every decision first.

### Hard words

The plain text still uses words like "token" that a person who does not program may not know. Every word in `terms` gets a dotted underline wherever it appears in the agent's text. Clicking it opens its meaning right under that line. Clicking again or pressing Escape closes it. A meaning can contain other underlined words, which open inside it. A simple plural counts as the same word.

### Motion

- A new screen arrives piece by piece: sideways between decisions, upwards otherwise.
- On the route strip, the line draws up to the decision you arrive at and its circle lands.
- Cards, buttons and squares lift on hover. Revealed code and answers unfold. Weight bars grow.
- The overview has a floating tile that leans towards the pointer.
- Dotted orbs from `thinking-orbs` (MIT, Jakub Antalik) appear on the overview tile and on a guess card until the answer is shown. The engine is one vendored file, used without React.
- All motion is off when the device asks for reduced motion.

## The notes file

`.scope/notes.md` is rewritten after every verdict. It lists only what needs action: Disagree, Remove, I don't get it (including quiz questions the person could not answer), other notes, and a count. Progress is kept in `.scope/state.json`.

## Parts

- `src/core.js`: read the change from git, check the review, find code with no reason, unchecked functions and copies, weigh decisions, build the lines for a place, keep state, write notes.
- `src/server.js`: local server for the page, the review data and verdict saves.
- `bin/scope.js`: the `init`, `check` and open commands.
- `page/`: the four screens.
- `INSTRUCTIONS.md`: for the agent.

## Testing

Automatic tests, with Node's built-in runner and a throwaway git repo, cover the checker, the copy finder, weights, notes, stale reviews, path safety, and the server including overlapping saves. The page is checked by hand on a real change.

## Not built

- Running tests, linters or any command
- Judging naming or design taste
- Explaining a flow when there is no change
- Review history
- GitHub pull requests
- Live chat with the agent

## Known limits

- Finding new functions uses a pattern that knows JavaScript, TypeScript, Python, Ruby, Go and Rust. It misses Java, C# and C-style methods and JavaScript class methods.
- The copy finder only sees near-identical text. Reworded copies rest on the agent's answer.
- Everything in plain words is the agent's account. The person can open the code behind any decision, but a decision the agent never wrote down only shows up if its code is left unexplained.
- File paths with characters git must quote are not handled.
- Each unexplained block is listed on its own, so a file with many small unexplained edits produces many entries.
