import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { codeFor, loadReview, renderNotes } from '../src/core.js'

const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
const mailer = (name) => `export function ${name}(to, subject, body) {
  const message = { to, subject, body }
  log('sending mail to ' + to)
  const sent = Date.now()
  return transport.send({ ...message, sent })
}
`

// A repo where a.js has line 3 replaced and line 8 deleted, c.js is deleted, and b.js and util.js are new and untracked.
// util.js holds a copy of the mailer already in lib.js, plus one new function.
function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-')))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'a.js'), numbered(10))
  fs.writeFileSync(path.join(root, 'c.js'), 'gone 1\ngone 2\n')
  fs.writeFileSync(path.join(root, 'lib.js'), mailer('sendMail'))
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const lines = numbered(10).split('\n')
  lines[2] = 'line 3 changed'
  lines.splice(7, 1)
  fs.writeFileSync(path.join(root, 'a.js'), lines.join('\n'))
  fs.rmSync(path.join(root, 'c.js'))
  fs.writeFileSync(path.join(root, 'b.js'), numbered(4, 'new'))
  fs.writeFileSync(path.join(root, 'util.js'), `${mailer('sendCopy')}\nexport function hashToken(value) {\n  return createHash('sha256').update(value).digest('hex')\n}\n`)
  fs.mkdirSync(path.join(root, '.scope'))
  return root
}

const decision = (code, extra = {}) => ({ title: 'Does a thing', origin: 'asked', risk: 'high', why: 'Because.', code, ...extra })
const place = (file, lines) => ({ file, lines })
const good = () => ({
  title: 'Change',
  asked: 'Change the thing.',
  changes: [{ before: 'It did not.', after: 'Now it does.' }],
  decisions: [decision([place('a.js', [1, 9])]), decision([place('b.js', [1, 4]), place('util.js', [1, 10])]), decision([{ file: 'c.js' }])],
  added: [
    { name: 'sendCopy', file: 'util.js', lines: [1, 6], similar: { file: 'lib.js', lines: [1, 6], why: 'Both send one email.' } },
    { name: 'hashToken', file: 'util.js', lines: [8, 10], similar: null },
  ],
})

function writeReview(root, review) {
  fs.writeFileSync(path.join(root, '.scope', 'review.json'), JSON.stringify(review))
  return loadReview(root)
}
const kinds = (result) => result.items.map((item) => item.kind)

test('a review that gives every change a reason passes', () => {
  const result = writeReview(makeRepo(), good())
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.leftOut, [])
  assert.deepEqual(result.unchecked, [])
  assert.equal(result.stale, false)
  assert.deepEqual(kinds(result), ['decision', 'decision', 'decision', 'similar'])
})

test('a decision that points at a file that does not exist is an error', () => {
  const review = good()
  review.decisions[0].code.push(place('nope.js', [1, 2]))
  assert.match(writeReview(makeRepo(), review).errors.join('\n'), /Decision 1, place 2.*nope\.js.*does not exist/)
})

test('a line range outside the file is an error', () => {
  const review = good()
  review.decisions[0].code[0] = place('a.js', [1, 50])
  assert.match(writeReview(makeRepo(), review).errors.join('\n'), /lines 1 to 50 are outside "a\.js", which has 9 lines/)
})

test('a decision must say what it is, where it came from and why', () => {
  const review = good()
  review.decisions[0] = { risk: 'high', code: [place('a.js', [1, 9])] }
  const errors = writeReview(makeRepo(), review).errors.join('\n')
  assert.match(errors, /Decision 1: needs a "title"/)
  assert.match(errors, /Decision 1: "origin" must be asked or assumed/)
  assert.match(errors, /Decision 1: needs a "why"/)
})

test('a review must say what changed, before and after', () => {
  const review = good()
  review.changes = []
  assert.match(writeReview(makeRepo(), review).errors.join('\n'), /"changes" must be a list/)
})

test('every hard word in the word list needs a meaning', () => {
  const review = good()
  review.terms = [{ term: 'token', meaning: 'A long random code inside the reset link.' }]
  assert.deepEqual(writeReview(makeRepo(), review).errors, [])
  review.terms.push({ term: 'hash' })
  assert.match(writeReview(makeRepo(), review).errors.join('\n'), /"terms" must be a list of \{ "term", "meaning" \}/)
})

test('paths outside the project are refused', () => {
  const root = makeRepo()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-out-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  const review = good()
  review.decisions[0].code.push(place('../' + path.basename(outside) + '/secret.txt', [1, 1]), place(path.join(outside, 'secret.txt'), [1, 1]), place('link.txt', [1, 1]))
  const errors = writeReview(root, review).errors
  assert.equal(errors.filter((e) => /not a path inside this project/.test(e)).length, 3)
})

test('changed code that no decision explains is found, including untracked and deleted files', () => {
  const review = { ...good(), decisions: [decision([place('a.js', [1, 5])])], added: [] }
  const result = writeReview(makeRepo(), review)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.leftOut, [{ file: 'a.js', lines: [7, 8] }, { file: 'c.js' }, { file: 'b.js', lines: [1, 4] }, { file: 'util.js', lines: [1, 10] }])
  assert.equal(kinds(result).filter((kind) => kind === 'orphan').length, 4)
})

test('a file in the boring pile counts as explained', () => {
  const review = { ...good(), decisions: [decision([place('a.js', [1, 9])])], added: [], boring: ['b.js', 'c.js', 'util.js'].map((file) => ({ file, why: 'Generated' })) }
  const result = writeReview(makeRepo(), review)
  assert.deepEqual(result.leftOut, [])
  assert.deepEqual(result.unchecked, [])
})

test('a new function the agent did not check for copies is reported', () => {
  const review = good()
  review.added.pop()
  assert.deepEqual(writeReview(makeRepo(), review).unchecked, [{ name: 'hashToken', file: 'util.js', line: 8 }])
})

test('an added item must answer whether something similar exists, and must really be there', () => {
  const review = good()
  delete review.added[1].similar
  review.added[0].name = 'notThere'
  const errors = writeReview(makeRepo(), review).errors.join('\n')
  assert.match(errors, /Added item 2 \(hashToken\): needs "similar"/)
  assert.match(errors, /Added item 1 \(notThere\): the name does not appear at lines 1 to 6 of "util\.js"/)
})

test('the tool finds a copy the agent said was not one', () => {
  const review = good()
  review.added[0].similar = null
  const result = writeReview(makeRepo(), review)
  assert.deepEqual(
    result.items.filter((item) => item.kind === 'copy').map(({ file, lines, match }) => ({ file, lines, match })),
    [{ file: 'util.js', lines: [2, 5], match: { file: 'lib.js', lines: [2, 5] } }],
  )
})

test('a copy the agent already flagged is not listed twice', () => {
  assert.equal(kinds(writeReview(makeRepo(), good())).includes('copy'), false)
})

test('weight counts added and removed lines, in total and for each decision', () => {
  const result = writeReview(makeRepo(), good())
  assert.deepEqual(result.weight, { added: 15, removed: 4 })
  assert.deepEqual(result.items.filter((item) => item.kind === 'decision').map((item) => item.weight), [1, 14, 0])
})

test('a base that looks like a git option is refused', () => {
  const root = makeRepo()
  fs.writeFileSync(path.join(root, '.scope', 'review.json'), JSON.stringify({ ...good(), base: '--output=pwned' }))
  assert.throws(() => loadReview(root), /base/)
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false)
})

test('a project with no commits yet counts every file as new', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-new-')))
  execFileSync('git', ['init', '-q'], { cwd: root })
  fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo\n')
  fs.writeFileSync(path.join(root, 'staged.js'), 'three\n')
  execFileSync('git', ['add', 'staged.js'], { cwd: root })
  fs.mkdirSync(path.join(root, '.scope'))
  const result = writeReview(root, { ...good(), decisions: [decision([place('a.js', [1, 2])])], added: [] })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.weight, { added: 3, removed: 0 })
  assert.deepEqual(result.leftOut, [{ file: 'staged.js', lines: [1, 1] }])
})

test('a missing review file says what to do', () => {
  assert.throws(() => loadReview(makeRepo()), /Ask your agent to scope this/)
})

test('misplaced guesses and a missing request give warnings, not errors', () => {
  const review = good()
  delete review.asked
  review.decisions[0].risk = 'low'
  review.decisions[0].guess = { question: 'Q?', answer: 'A.' }
  const { errors, warnings } = writeReview(makeRepo(), review)
  assert.deepEqual(errors, [])
  assert.match(warnings.join('\n'), /Decision 1 has a guess question but is not high risk/)
  assert.match(warnings.join('\n'), /"asked"/)
})

test('the code behind a decision comes from disk, with added and removed lines marked', () => {
  const root = makeRepo()
  const { change } = writeReview(root, good())
  assert.deepEqual(codeFor(root, change, 'a.js', [2, 4]), [
    { n: 2, type: 'ctx', text: 'line 2' },
    { type: 'del', text: 'line 3' },
    { n: 3, type: 'add', text: 'line 3 changed' },
    { n: 4, type: 'ctx', text: 'line 4' },
  ])
  assert.deepEqual(codeFor(root, change, 'a.js', [7, 8]), [
    { n: 7, type: 'ctx', text: 'line 7' },
    { type: 'del', text: 'line 8' },
    { n: 8, type: 'ctx', text: 'line 9' },
  ])
  assert.deepEqual(codeFor(root, change, 'c.js'), [
    { type: 'del', text: 'gone 1' },
    { type: 'del', text: 'gone 2' },
  ])
})

test('a review goes stale when the code changes after it was checked', () => {
  const root = makeRepo()
  assert.equal(writeReview(root, good()).stale, false)
  fs.appendFileSync(path.join(root, 'b.js'), 'new 5\n')
  assert.equal(loadReview(root).stale, true)
})

test('a rewritten review starts fresh, with no old verdicts', () => {
  const root = makeRepo()
  const first = writeReview(root, good())
  first.state.verdicts['d.0'] = { verdict: 'disagree', note: '' }
  fs.writeFileSync(path.join(root, '.scope', 'state.json'), JSON.stringify(first.state))
  assert.deepEqual(loadReview(root).state.verdicts, { 'd.0': { verdict: 'disagree', note: '' } })
  assert.deepEqual(writeReview(root, { ...good(), title: 'Second pass' }).state.verdicts, {})
})

test('notes list only what needs action', () => {
  const items = [
    { key: 'd.0', kind: 'decision', title: 'Links can be used twice', why: 'Nothing deletes the token.', code: [place('a.js', [1, 5]), place('b.js', [2, 3])] },
    { key: 'd.1', kind: 'decision', title: 'Tokens are hashed', why: 'Safer.', code: [place('a.js', [6, 9])] },
    { key: 'd.2', kind: 'decision', title: 'Fine', why: 'Fine.', code: [place('a.js', [1, 1])] },
    { key: 'a.0', kind: 'similar', name: 'sendCopy', file: 'util.js', lines: [1, 6], similar: { file: 'lib.js', lines: [1, 6], why: 'Both send one email.' } },
    { key: 'c.0', kind: 'copy', file: 'util.js', lines: [2, 5], match: { file: 'lib.js', lines: [2, 5] } },
    { key: 'x.0', kind: 'orphan', file: 'b.js', lines: [1, 4] },
    { key: 'q.0', kind: 'quiz', question: 'What stops a link being reused?', answer: 'Nothing.' },
  ]
  const notes = renderNotes('Add reset', items, {
    'd.0': { verdict: 'disagree', note: 'Make it single use.' },
    'd.1': { verdict: 'unsure', note: '' },
    'd.2': { verdict: 'agree', note: '' },
    'a.0': { verdict: 'remove', note: '' },
    'c.0': { verdict: 'keep', note: '' },
    'x.0': { verdict: 'remove', note: '' },
    'q.0': { verdict: 'missed', note: '' },
  })
  assert.equal(
    notes,
    `# Scope notes: Add reset

## Disagree
- Links can be used twice
  Why the agent did it: Nothing deletes the token.
  Code: a.js, lines 1 to 5; b.js, lines 2 to 3
  Your note: Make it single use.

## Remove
- sendCopy in util.js, lines 1 to 6
  Does the same job as lib.js, lines 1 to 6: Both send one email.
- b.js, lines 1 to 4
  The review gave no reason for this code.

## I don't get it
- Tokens are hashed
  Why the agent did it: Safer.
  Code: a.js, lines 6 to 9
- What stops a link being reused?

## Summary
- 2 items are fine as they are.
- 0 items have no verdict yet.
`,
  )
})
