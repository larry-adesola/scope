#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, loadReview, plural } from '../src/core.js'
import { startServer } from '../src/server.js'

const RULE = 'When asked to "scope this" or "fix the scope notes", follow `.scope/INSTRUCTIONS.md`.'
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const list = (heading, items) => items.length && console.error(`\n${heading}\n${items.map((item) => `  - ${item}`).join('\n')}`)

const [command] = process.argv.slice(2)
const root = findRoot(process.cwd())
if (!root && [undefined, 'init', 'check'].includes(command)) fail('This folder is not a git project. Scope uses git to see what changed.')

function load() {
  let loaded
  try {
    loaded = loadReview(root)
  } catch (e) {
    fail(e.message)
  }
  list('Problems in .scope/review.json:', loaded.errors)
  list('Warnings:', loaded.warnings)
  return loaded
}

if (command === 'init') {
  const dir = path.join(root, '.scope')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(fileURLToPath(new URL('../INSTRUCTIONS.md', import.meta.url)), path.join(dir, 'INSTRUCTIONS.md'))
  fs.writeFileSync(path.join(dir, '.gitignore'), 'review.json\nstate.json\nnotes.md\n')
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(root, name)
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (!text.includes('.scope/INSTRUCTIONS.md')) fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${RULE}\n`)
  }
  console.log('Scope is set up. Tell your agent: "scope this".')
} else if (command === 'check') {
  const { errors, leftOut, unchecked, items } = load()
  const where = ({ file, lines }) => (lines ? `${file}, lines ${lines[0]} to ${lines[1]}` : file)
  list('Changed code that no decision explains. Give it a decision, or put the file in "boring":', leftOut.map(where))
  list('New functions missing from "added". List each one and say whether something similar already exists:', unchecked.map(({ name, file, line }) => `${name} in ${file}, line ${line}`))
  if (errors.length || leftOut.length || unchecked.length) process.exit(1)
  const count = (kind) => items.filter((item) => item.kind === kind).length
  console.log(`The review is good: ${plural(count('decision'), 'decision')}, ${plural(count('similar') + count('copy'), 'possible copy', 'possible copies')}.`)
} else if (!command) {
  if (load().errors.length) fail('\nAsk your agent to fix these, then run scope again.')
  const server = await startServer(root)
  const url = `http://127.0.0.1:${server.address().port}`
  console.log(`Scope is open at ${url}\nPress Ctrl+C to stop.`)
  const [opener, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(opener, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
} else {
  fail('Usage:\n  scope init    set up this project\n  scope check   check the review file\n  scope         open the review')
}
