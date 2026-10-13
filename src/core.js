import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const RISKS = ['high', 'medium', 'low']
export const VERDICTS = ['agree', 'disagree', 'unsure', 'keep', 'remove', 'knew', 'missed']

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
const sha = (text) => createHash('sha256').update(text).digest('hex')
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const list = (v) => (Array.isArray(v) ? v : [])
const overlap = (a, b) => a[0] <= b[1] && a[1] >= b[0]
const where = (place) => (place.lines ? `${place.file}, lines ${place.lines[0]} to ${place.lines[1]}` : place.file)
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

export function findRoot(cwd) {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
}

function readLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// ponytail: paths git has to quote (quotes, backslashes, newlines) are not handled.
export function parseDiff(text) {
  const files = []
  let cur, hunk
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git a/')) {
      const rest = line.slice(13)
      cur = { path: rest.slice(0, (rest.length - 3) / 2), status: 'modified', hunks: [] }
      hunk = null
      files.push(cur)
    } else if (!cur) {
      continue
    } else if (hunk && line[0] === '-') {
      hunk.removed.push(line.slice(1))
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      hunk = { newStart: +m[1], newCount: m[2] === undefined ? 1 : +m[2], removed: [] }
      cur.hunks.push(hunk)
    } else if (hunk) {
      continue
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice(10)
    } else if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted'
    } else if (line.startsWith('new file mode')) {
      cur.status = 'added'
    }
  }
  return new Map(files.map(({ path, ...file }) => [path, file]))
}

// The real change: tracked edits against the base, plus untracked files.
export function readChange(root, base = 'HEAD') {
  if (typeof base !== 'string' || base.startsWith('-')) throw new Error(`The base "${base}" is not a valid git ref in this project.`)
  // A brand new project has no commits, so there is nothing to compare with and every file is new.
  const unborn = base === 'HEAD' && !git(root, ['rev-list', '-n', '1', '--all']).trim()
  let diff = ''
  if (!unborn) {
    let commit
    try {
      commit = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]).trim()
    } catch {
      throw new Error(`The base "${base}" is not a valid git ref in this project.`)
    }
    diff = git(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', '-M', commit, '--', '.', ':(exclude).scope'])
  }
  const files = parseDiff(diff)
  const hash = createHash('sha256').update(diff)
  for (const file of git(root, ['ls-files', unborn ? '-co' : '--others', '--exclude-standard', '-z']).split('\0')) {
    if (!file || file.startsWith('.scope/')) continue
    const abs = path.join(root, file)
    let count = 0
    if (fs.lstatSync(abs).isFile()) {
      const content = fs.readFileSync(abs)
      hash.update(`\0${file}\0`).update(content)
      if (!content.subarray(0, 8000).includes(0)) count = readLines(abs).length
    }
    files.set(file, { status: 'added', hunks: count ? [{ newStart: 1, newCount: count, removed: [] }] : [] })
  }
  return { files, hash: hash.digest('hex') }
}

const inside = (root, p) => {
  const rel = path.relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// The review file is written by an agent, so a path only counts if it stays inside the project, symlinks included.
export function resolveInside(root, file) {
  if (!isText(file) || path.isAbsolute(file)) return null
  const abs = path.resolve(root, file)
  if (!inside(root, abs)) return null
  try {
    if (!inside(fs.realpathSync(root), fs.realpathSync(abs))) return null
  } catch {
    // The file does not exist. The caller decides whether that is allowed.
  }
  return abs
}

// The first line of a function or class, in the languages that mark one with a keyword.
// ponytail: misses Java, C# and C-style methods and JS class methods, which look like calls. Use a real parser per language if that matters.
const DEFINITION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|def\s+([A-Za-z_]\w*)|func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*))/
const defined = (line) => DEFINITION.exec(line.trim())?.slice(1).find(Boolean)

export function validate(root, review, change) {
  const errors = []
  const warnings = []
  const decisions = []
  const added = []
  const boring = new Set()
  const covered = new Map()
  const cover = (file, range) => {
    if (range === 'all' || covered.get(file) === 'all') covered.set(file, 'all')
    else covered.set(file, [...(covered.get(file) ?? []), range])
  }
  const keyOf = (abs) => path.relative(root, abs).split(path.sep).join('/')
  const fail = (message) => void errors.push(message)

  // A file and line range from the review, checked against the disk. A deleted file has no lines to point at.
  const place = (at, item) => {
    const abs = resolveInside(root, item?.file)
    if (!abs) return fail(`${at}: "${item?.file}" is not a path inside this project.`)
    const file = keyOf(abs)
    if (change.files.get(file)?.status === 'deleted') return { file }
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) return fail(`${at}: file "${file}" does not exist.`)
    const [start, end] = list(item.lines)
    if (item.lines?.length !== 2 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return fail(`${at}: "lines" must be [first, last], counting from 1.`)
    const total = readLines(abs).length
    if (end > total) return fail(`${at}: lines ${start} to ${end} are outside "${file}", which has ${plural(total, 'line')}.`)
    return { file, lines: [start, end] }
  }

  if (!review || typeof review !== 'object' || Array.isArray(review)) return { errors: ['The review file must be a JSON object.'], warnings, leftOut: [], unchecked: [], decisions, added, boring }
  if (!isText(review.title)) fail('The review needs a "title".')
  if (!isText(review.asked)) warnings.push('The review has no "asked". Add the request in the person\'s own words.')
  if (!list(review.changes).length || !review.changes.every((c) => isText(c?.before) && isText(c?.after))) fail('"changes" must be a list of { "before", "after" } with at least one entry.')
  if (!list(review.decisions).length) fail('"decisions" must be a list with at least one decision.')

  let guesses = 0
  for (const [i, decision] of list(review.decisions).entries()) {
    const at = `Decision ${i + 1}`
    if (!decision || typeof decision !== 'object') {
      fail(`${at}: must be an object.`)
      continue
    }
    if (!isText(decision.title)) fail(`${at}: needs a "title".`)
    if (decision.origin !== 'asked' && decision.origin !== 'assumed') fail(`${at}: "origin" must be asked or assumed.`)
    if (!RISKS.includes(decision.risk)) fail(`${at}: "risk" must be high, medium or low.`)
    if (!isText(decision.why)) fail(`${at}: needs a "why".`)
    if (decision.instead !== undefined && !isText(decision.instead)) fail(`${at}: "instead" must be text.`)
    if (decision.proof !== undefined && !isText(decision.proof)) fail(`${at}: "proof" must be text.`)
    if (decision.guess !== undefined) {
      guesses++
      if (!isText(decision.guess?.question) || !isText(decision.guess?.answer)) fail(`${at}: "guess" needs a "question" and an "answer".`)
      if (decision.risk !== 'high') warnings.push(`${at} has a guess question but is not high risk.`)
    }
    if (!list(decision.code).length) {
      fail(`${at}: "code" must list at least one place.`)
      continue
    }
    const code = decision.code.map((item, j) => place(`${at}, place ${j + 1}`, item)).filter(Boolean)
    for (const item of code) cover(item.file, item.lines ?? 'all')
    decisions.push({ ...decision, code })
  }
  if (guesses > 3) warnings.push(`The review has ${guesses} guess questions. Keep it to 3 at most.`)

  if (review.added !== undefined && !Array.isArray(review.added)) fail('"added" must be a list.')
  for (const [i, item] of list(review.added).entries()) {
    if (!isText(item?.name)) {
      fail(`Added item ${i + 1}: needs a "name".`)
      continue
    }
    const at = `Added item ${i + 1} (${item.name})`
    const here = place(at, item)
    if (!here) continue
    if (!Object.hasOwn(item, 'similar')) {
      fail(`${at}: needs "similar". Use null if nothing in the project does the same job.`)
      continue
    }
    let similar = null
    if (item.similar !== null) {
      similar = place(`${at}, similar`, item.similar)
      if (!similar) continue
      if (!isText(item.similar.why)) {
        fail(`${at}, similar: needs a "why" that says what the two have in common.`)
        continue
      }
      similar.why = item.similar.why
    }
    if (here.lines && !readLines(path.join(root, here.file)).slice(here.lines[0] - 1, here.lines[1]).some((line) => line.includes(item.name))) {
      fail(`${at}: the name does not appear at lines ${here.lines[0]} to ${here.lines[1]} of "${here.file}".`)
      continue
    }
    added.push({ name: item.name, ...here, similar })
  }

  if (review.boring !== undefined && !Array.isArray(review.boring)) fail('"boring" must be a list.')
  for (const [i, item] of list(review.boring).entries()) {
    const abs = resolveInside(root, item?.file)
    if (!abs) fail(`Boring item ${i + 1}: "${item?.file}" is not a path inside this project.`)
    else if (!isText(item.why)) fail(`Boring item ${i + 1}: needs a "why".`)
    else {
      boring.add(keyOf(abs))
      cover(keyOf(abs), 'all')
    }
  }

  if (review.quiz !== undefined && (!Array.isArray(review.quiz) || review.quiz.length > 3 || !review.quiz.every((q) => isText(q?.question) && isText(q?.answer)))) {
    fail('"quiz" must be a list of at most 3 { "question", "answer" }.')
  }

  if (review.terms !== undefined && (!Array.isArray(review.terms) || !review.terms.every((t) => isText(t?.term) && isText(t?.meaning)))) {
    fail('"terms" must be a list of { "term", "meaning" }.')
  }

  // Changed code that no decision explains. ponytail: one entry per changed block; merge neighbours if a file with many small edits gets noisy.
  const leftOut = []
  // New functions the agent did not list in "added", so nobody has checked them for copies.
  const unchecked = []
  const before = new Set([...change.files.values()].flatMap((file) => file.hunks.flatMap((hunk) => hunk.removed.map(defined))))
  const listed = new Set(added.map((item) => `${item.file}\0${item.name}`))
  for (const [file, { status, hunks }] of change.files) {
    const ranges = covered.get(file)
    if (!hunks.length || status === 'deleted') {
      if (!ranges) leftOut.push({ file })
      continue
    }
    const text = readLines(path.join(root, file))
    for (const hunk of hunks) {
      const first = hunk.newStart
      const last = hunk.newCount ? first + hunk.newCount - 1 : first + 1
      if (ranges !== 'all' && !ranges?.some((range) => overlap(range, [first, last]))) {
        const shown = [Math.max(1, first), Math.min(text.length, last)]
        leftOut.push(shown[0] <= shown[1] ? { file, lines: shown } : { file })
      }
      for (let n = first; !boring.has(file) && n < first + hunk.newCount; n++) {
        const name = defined(text[n - 1] ?? '')
        // A name that also left the diff was moved or edited, not added.
        if (name && !before.has(name) && !listed.has(`${file}\0${name}`)) unchecked.push({ name, file, line: n })
      }
    }
  }
  return { errors, warnings, leftOut, unchecked, decisions, added, boring }
}

const isAdded = (change, file, n) => change.files.get(file)?.hunks.some((hunk) => n >= hunk.newStart && n < hunk.newStart + hunk.newCount) ?? false

// New code that matches code elsewhere in the project, found by comparing text.
// It only catches near-identical blocks: four lines in a row that match once spacing is ignored.
// Reworded copies are the agent's job to declare in "added".
const RUN = 4
export function findCopies(root, change, skip) {
  const index = new Map()
  const runs = new Map()
  const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0')
  // ponytail: reads up to 5000 text files under 256 KB on first load of each review; index incrementally if a huge repo makes that slow.
  for (const file of files.filter((f) => f && !f.startsWith('.scope/') && !skip.has(f)).slice(0, 5000)) {
    const abs = path.join(root, file)
    const stat = fs.lstatSync(abs, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size > 262144) continue
    const content = fs.readFileSync(abs)
    if (content.subarray(0, 8000).includes(0)) continue
    // Lines with almost nothing on them, like a closing bracket, match everywhere and mean nothing.
    const solid = content
      .toString('utf8')
      .split('\n')
      .map((line, i) => ({ n: i + 1, text: line.trim().replace(/\s+/g, ' ') }))
      .filter((line) => line.text.replace(/[^A-Za-z0-9]/g, '').length >= 4)
    const mine = []
    for (let i = 0; i + RUN <= solid.length; i++) {
      const run = { file, key: solid.slice(i, i + RUN).map((line) => line.text).join('\n'), start: solid[i].n, end: solid[i + RUN - 1].n }
      mine.push(run)
      index.set(run.key, [...(index.get(run.key) ?? []), run])
    }
    runs.set(file, mine)
  }

  const copies = []
  for (const file of change.files.keys()) {
    let last
    for (const run of runs.get(file) ?? []) {
      if (!isAdded(change, file, run.start) || !isAdded(change, file, run.end)) continue
      const others = index.get(run.key).filter((other) => other !== run)
      // Code that was already there wins. Two new blocks that match each other are reported once, from the later one.
      const match = others.find((other) => !isAdded(change, other.file, other.start)) ?? others.find((other) => other.file < file || (other.file === file && other.start < run.start))
      if (!match) continue
      if (last && last.match.file === match.file && run.start <= last.lines[1] + 1) {
        last.lines[1] = Math.max(last.lines[1], run.end)
        last.match.lines[1] = Math.max(last.match.lines[1], match.end)
      } else {
        last = { file, lines: [run.start, run.end], match: { file: match.file, lines: [match.start, match.end] } }
        copies.push(last)
      }
    }
  }
  return copies
}

// The lines shown for a place. Text always comes from disk and from git, never from the review file.
export function codeFor(root, change, file, lines) {
  const hunks = change.files.get(file)?.hunks ?? []
  const removed = (hunk) => hunk.removed.map((text) => ({ type: 'del', text }))
  if (!lines) return hunks.flatMap(removed)
  const text = readLines(path.join(root, file))
  const [start, end] = lines
  const out = []
  for (let n = start; n <= end + 1; n++) {
    for (const hunk of hunks) {
      const before = hunk.newCount ? hunk.newStart : hunk.newStart + 1
      if (before === n && (n <= end || !hunk.newCount)) out.push(...removed(hunk))
    }
    if (n > end) break
    out.push({ n, type: isAdded(change, file, n) ? 'add' : 'ctx', text: text[n - 1] ?? '' })
  }
  return out
}

function entry(item, note) {
  const lines = {
    decision: () => [item.title, `Why the agent did it: ${item.why}`, `Code: ${item.code.map(where).join('; ')}`],
    similar: () => [`${item.name} in ${where(item)}`, `Does the same job as ${where(item.similar)}: ${item.similar.why}`],
    copy: () => [where(item), `Matches ${where(item.match)}.`],
    orphan: () => [where(item), 'The review gave no reason for this code.'],
    quiz: () => [item.question],
  }[item.kind]()
  if (note) lines.push(`Your note: ${note}`)
  return `- ${lines.join('\n  ')}`
}

export function renderNotes(title, items, verdicts) {
  const groups = { disagree: [], remove: [], unsure: [], other: [] }
  let fine = 0
  let open = 0
  for (const item of items) {
    const { verdict, note } = verdicts[item.key] ?? {}
    const group = verdict === 'missed' ? 'unsure' : verdict
    if (groups[group]) groups[group].push(entry(item, note))
    else if (verdict && note) groups.other.push(entry(item, note))
    if (verdict && !groups[group]) fine++
    if (!verdict) open++
  }
  const sections = [['disagree', 'Disagree'], ['remove', 'Remove'], ['unsure', "I don't get it"], ['other', 'Other notes']]
  const blocks = sections.filter(([key]) => groups[key].length).map(([key, heading]) => `## ${heading}\n${groups[key].join('\n')}`)
  const are = (n) => (n === 1 ? 'is' : 'are')
  const summary = [`- ${plural(fine, 'item')} ${are(fine)} fine as ${fine === 1 ? 'it is' : 'they are'}.`, `- ${plural(open, 'item')} ${open === 1 ? 'has' : 'have'} no verdict yet.`]
  return [`# Scope notes: ${title}`, ...blocks, `## Summary\n${summary.join('\n')}`].join('\n\n') + '\n'
}

const statePath = (root) => path.join(root, '.scope', 'state.json')

export function saveState(root, state, title, items) {
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2))
  fs.writeFileSync(path.join(root, '.scope', 'notes.md'), renderNotes(title, items, state.verdicts))
}

// Searching the whole project for copies is the slow part, so its answer is kept until the review or the code changes.
let memo = {}

// Reads and checks everything fresh. Throws when there is nothing usable to check.
export function loadReview(root) {
  let text
  try {
    text = fs.readFileSync(path.join(root, '.scope', 'review.json'), 'utf8')
  } catch {
    throw new Error('There is no review yet. Ask your agent to scope this.')
  }
  let review
  try {
    review = JSON.parse(text)
  } catch (e) {
    throw new Error(`.scope/review.json is not valid JSON: ${e.message}`)
  }
  const change = readChange(root, review?.base ?? 'HEAD')
  const checked = validate(root, review, change)
  const { errors, warnings, leftOut, unchecked } = checked

  // Everything the person gives a verdict on, in one list. The key is how a verdict finds its item again.
  const items = []
  if (!errors.length) {
    const id = `${root}\0${change.hash}\0${sha(text)}`
    if (memo.id !== id) memo = { id, copies: findCopies(root, change, checked.boring) }
    const flagged = (copy) => checked.added.some((item) => item.similar && item.file === copy.file && item.lines && overlap(item.lines, copy.lines))
    const weigh = (place) => (place.lines ? codeFor(root, change, place.file, place.lines).filter((line) => line.type === 'add').length : 0)
    checked.decisions.forEach((decision, i) => items.push({ key: `d.${i}`, kind: 'decision', ...decision, weight: decision.code.reduce((n, place) => n + weigh(place), 0) }))
    checked.added.forEach((item, i) => item.similar && items.push({ key: `a.${i}`, kind: 'similar', ...item }))
    memo.copies.filter((copy) => !flagged(copy)).forEach((copy, i) => items.push({ key: `c.${i}`, kind: 'copy', ...copy }))
    leftOut.forEach((item, i) => items.push({ key: `x.${i}`, kind: 'orphan', ...item }))
    list(review.quiz).forEach((question, i) => items.push({ key: `q.${i}`, kind: 'quiz', ...question }))
  }
  const hunks = [...change.files.values()].flatMap((file) => file.hunks)
  const weight = { added: hunks.reduce((n, hunk) => n + hunk.newCount, 0), removed: hunks.reduce((n, hunk) => n + hunk.removed.length, 0) }

  let state
  try {
    state = JSON.parse(fs.readFileSync(statePath(root), 'utf8'))
  } catch {
    // No saved progress yet.
  }
  if (state?.reviewHash !== sha(text)) {
    state = { reviewHash: sha(text), changeHash: change.hash, verdicts: {} }
    if (!errors.length) saveState(root, state, review.title, items)
  }
  return { review, change, errors, warnings, leftOut, unchecked, items, added: checked.added, weight, state, stale: state.changeHash !== change.hash }
}
