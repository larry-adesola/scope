import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { startServer } from '../src/server.js'

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-srv-')))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo changed\n')
  fs.mkdirSync(path.join(root, '.scope'))
  const review = {
    title: 'Change',
    asked: 'Change two.',
    changes: [{ before: 'Two was plain.', after: 'Two is changed.' }],
    decisions: [
      { title: 'Two is changed in place', origin: 'asked', risk: 'low', why: 'Smallest edit.', code: [{ file: 'a.js', lines: [1, 2] }] },
      { title: 'One is kept', origin: 'assumed', risk: 'low', why: 'Not asked.', code: [{ file: 'a.js', lines: [1, 1] }] },
    ],
    quiz: [{ question: 'What changed?', answer: 'Line two.' }],
    terms: [{ term: 'line', meaning: 'One row of text in a file.' }],
  }
  fs.writeFileSync(path.join(root, '.scope', 'review.json'), JSON.stringify(review))
  const server = await startServer(root, 0)
  t.after(() => server.close())
  return { root, url: `http://127.0.0.1:${server.address().port}` }
}

const post = (url, body, headers = {}) =>
  fetch(`${url}/api/verdict`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('the page gets the review with real code attached', async (t) => {
  const { url } = await setup(t)
  const data = await (await fetch(`${url}/api/review`)).json()
  assert.equal(data.title, 'Change')
  assert.equal(data.asked, 'Change two.')
  assert.deepEqual(data.terms, [{ term: 'line', meaning: 'One row of text in a file.' }])
  assert.deepEqual(data.weight, { added: 1, removed: 1 })
  assert.deepEqual(data.items.map((item) => item.key), ['d.0', 'd.1', 'q.0'])
  assert.deepEqual(data.items[0].code, [
    {
      file: 'a.js',
      lines: [1, 2],
      text: [
        { n: 1, type: 'ctx', text: 'one' },
        { type: 'del', text: 'two' },
        { n: 2, type: 'add', text: 'two changed' },
      ],
    },
  ])
  assert.match(await (await fetch(url)).text(), /<title>Scope<\/title>/)
  const orbs = await fetch(`${url}/orbs.js`)
  assert.match(orbs.headers.get('content-type'), /javascript/)
  assert.match(await orbs.text(), /resolvePreset/)
})

test('a verdict is saved and written to the notes file', async (t) => {
  const { root, url } = await setup(t)
  const res = await post(url, { key: 'd.0', verdict: 'disagree', note: 'Off by one.' })
  assert.equal(res.status, 200)
  assert.match(fs.readFileSync(path.join(root, '.scope', 'notes.md'), 'utf8'), /## Disagree\n- Two is changed in place\n  Why the agent did it: Smallest edit\.\n  Code: a\.js, lines 1 to 2\n  Your note: Off by one\./)
  const data = await (await fetch(`${url}/api/review`)).json()
  assert.deepEqual(data.verdicts['d.0'], { verdict: 'disagree', note: 'Off by one.' })
})

test('bad verdicts and unknown stops are refused', async (t) => {
  const { url } = await setup(t)
  assert.equal((await post(url, { key: 'd.0', verdict: 'approve' })).status, 400)
  assert.equal((await post(url, { key: 'd.9', verdict: 'agree' })).status, 400)
})

test('requests from another site are refused', async (t) => {
  const { url } = await setup(t)
  assert.equal((await post(url, { key: 'd.0', verdict: 'agree' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await fetch(`${url}/api/verdict`, { method: 'POST', body: '{"key":"d.0","verdict":"agree"}' })).status, 403)
})

test('a broken review file is reported, not served', async (t) => {
  const { root, url } = await setup(t)
  fs.writeFileSync(path.join(root, '.scope', 'review.json'), '{"title":"x","changes":[{"before":"a","after":"b"}],"decisions":[]}')
  const res = await fetch(`${url}/api/review`)
  assert.equal(res.status, 422)
  assert.match((await res.json()).errors.join('\n'), /at least one decision/)
})

test('a slow save does not overwrite a save that finished while it was arriving', async (t) => {
  const { url } = await setup(t)
  const slow = http.request(`${url}/api/verdict`, { method: 'POST', headers: { 'content-type': 'application/json' } })
  const slowDone = new Promise((resolve) => slow.on('response', (res) => res.resume().on('end', resolve)))
  slow.flushHeaders()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal((await post(url, { key: 'd.1', verdict: 'agree' })).status, 200)
  slow.end(JSON.stringify({ key: 'd.0', verdict: 'disagree' }))
  await slowDone
  const { verdicts } = await (await fetch(`${url}/api/review`)).json()
  assert.deepEqual(verdicts, { 'd.0': { verdict: 'disagree', note: '' }, 'd.1': { verdict: 'agree', note: '' } })
})
