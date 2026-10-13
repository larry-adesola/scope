# Scope instructions

These are for a coding agent. A person will use your output to understand and judge a change on a local page.

The person did not write this code, so they never made its decisions. That is what they are missing, more than the code itself. Your job is to hand them the decisions in plain words, with the code as evidence they can open when they want it. They check what you say against the real code, so accuracy matters more than polish.

## When asked to "scope this"

Write `.scope/review.json` describing the current change, then run `scope check` and fix what it reports.

If you can start a sub-agent or a fresh session, do the review there. Give it the change and the person's request, not the reasoning that produced the code. An author explaining their own work tends to defend it, and the reader needs a description, not a defence.

### 1. Find the change

Compare the working tree with the base the person names. If they name none, use `HEAD` when there are uncommitted changes, otherwise the branch this work started from. Include new files that are not yet tracked.

### 2. Say what was asked

Put the person's request in `asked`, in their own words. If the request was long, keep the part that says what they wanted.

### 3. Say what changed

In `changes`, list what the software does differently, as before and after. Three to five entries. Describe behaviour a user or caller would notice, never files or functions.

- Good: before "There was no way to reset a password." after "A user can ask for an email link that works for 15 minutes."
- Bad: "Added reset.js and updated tokens.js."

### 4. List the decisions

A decision is a choice that could have gone another way. This is the heart of the review.

For each one give:

- `title`: the choice, as a plain statement of what the code now does. "A reset link can be used more than once."
- `origin`: `asked` if the person requested it, `assumed` if you chose it without being told. Be strict. If they did not say it, it is assumed. Assumed decisions are shown first, because that is where the code drifts from what the person wanted.
- `risk`: `high`, `medium` or `low`. High means money, login, permissions, data loss, or anything hard to undo.
- `why`: one or two sentences on why the code does this, or what it means in practice.
- `instead`: the option not taken. Leave it out only when there was no real alternative.
- `code`: the places that carry out this decision, each a file and a line range in the file as it is now. Never paste code. The tool reads the real code itself. Keep each place tight: the few lines that make the decision true, not the whole function around them. For a deleted file, give the file and no lines.
- `proof` (optional): a test name or command that shows it is true, as text. The tool never runs it.

Include the choices you would rather not draw attention to: a shortcut, an edge case you skipped, something you built that nobody asked for. Those are the ones the person most needs.

Every changed block must belong to a decision or be in the boring pile. `scope check` fails otherwise. Code that serves no decision is probably not needed, so consider deleting it before you look for a decision to hang it on.

### 5. Add guess questions, sparingly

On high-risk decisions only, and three at most in the whole review, add a `guess`: a question the person answers in their head before seeing your answer. Ask about behaviour at an edge: "What happens if the link is used twice?" The answer says what the code really does, even when that is the wrong behaviour.

### 6. List every new function and look for copies

In `added`, list every function, class or module this change creates. For each one, search the project for existing code that does the same job, including code that is worded differently or lives somewhere unexpected. Then answer in `similar`:

- `null` if nothing in the project does the same job.
- Otherwise the file and lines of the existing code, and a `why` saying what the two have in common.

`scope check` fails if a new function is missing from this list. The tool also compares text across the project, and shows the person any near-identical block you did not declare.

### 7. Put noise in the boring pile

Files nobody needs to read go in `boring`, each with a reason: generated files, lock files, formatting, pure renames. Do not move awkward code here to make the check pass. The person sees this pile too.

### 8. Add up to three quiz questions

In `quiz`, write up to three questions that someone who understood this change could answer, with the answers. Ask about how the pieces fit: "What stops an old link from working?" The person sees these at the end to check their own understanding.

### 9. Explain the hard words

In `terms`, list every word in your text that someone who does not program might not know: technical words such as "token" or "hash", and names from this project. Give each one a single plain sentence that says what it is here, in this change. "A long random code inside the reset link. It proves the person clicking owns the email." beats a dictionary definition.

The page underlines these words wherever they appear in what you wrote, and shows the meaning when the person clicks one. A meaning can use other words from the list.

### The file format

```json
{
  "title": "Add password reset",
  "base": "main",
  "asked": "Let users reset their password by email.",
  "changes": [
    { "before": "There was no way to reset a password.", "after": "A user can ask for an email link that works for 15 minutes." }
  ],
  "decisions": [
    {
      "title": "A reset link can be used more than once",
      "origin": "assumed",
      "risk": "high",
      "why": "Nothing removes the token after the password is set, so the link keeps working until it expires.",
      "instead": "Delete the token as soon as it is used.",
      "guess": {
        "question": "What happens if the same link is opened twice?",
        "answer": "It works both times."
      },
      "code": [{ "file": "src/routes/reset.js", "lines": [15, 18] }]
    },
    {
      "title": "Only a hash of the token is stored",
      "origin": "assumed",
      "risk": "medium",
      "why": "If the database leaks, the stored values cannot be used as reset links.",
      "instead": "Store the token as it is, which is simpler to debug.",
      "proof": "npm test -- tokens",
      "code": [
        { "file": "src/lib/tokens.js", "lines": [5, 12] },
        { "file": "src/routes/reset.js", "lines": [8, 8] }
      ]
    }
  ],
  "added": [
    { "name": "hashToken", "file": "src/lib/tokens.js", "lines": [10, 12], "similar": null },
    {
      "name": "sendResetMail",
      "file": "src/utils/sendMail.js",
      "lines": [1, 4],
      "similar": { "file": "src/lib/mail.js", "lines": [1, 3], "why": "Both send one email through the same transport." }
    }
  ],
  "boring": [{ "file": "package-lock.json", "why": "Generated file" }],
  "quiz": [{ "question": "What stops a link from working after 15 minutes?", "answer": "confirmReset rejects any token whose expiry time has passed." }],
  "terms": [
    { "term": "token", "meaning": "A long random code inside the reset link. It proves the person clicking owns the email." },
    { "term": "hash", "meaning": "A scrambled version of the token. You can check a token against it, but you cannot turn it back into the token." }
  ]
}
```

`base`, `asked`, `instead`, `proof`, `guess`, `added`, `boring`, `quiz` and `terms` are optional. `added` is required as soon as the change creates a function.

### 10. Check it

Run `scope check`. Fix every problem it lists, and read the warnings. When it passes, tell the person to run `scope`.

## When asked to "fix the scope notes"

Read `.scope/notes.md`. It holds the person's verdicts.

- **Disagree**: the person does not want this decision. Change the code to the other option, or to what their note says.
- **Remove**: delete the code. If it copied something, use the existing code instead.
- **I don't get it**: explain it in plain words in the chat. If the code is hard to follow, simplify it.
- **Other notes**: act on each one.

Then offer to scope the change again, since line numbers will have moved.
