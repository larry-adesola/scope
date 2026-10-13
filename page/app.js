// The thinking-orbs engine, used without React. The published file exports short aliases:
// M = MODE_FRAMES (geometry per state), p = paintFrame, r = resolvePreset.
import { M as MODE_FRAMES, p as paintFrame, r as resolvePreset } from '/orbs.js'

const app = document.getElementById('app')
const RANK = { high: 0, medium: 1, low: 2 }
const MARK = { agree: '✓', keep: '✓', knew: '✓', disagree: '✗', remove: '✗', unsure: '?', missed: '?' }
const DECIDE = [['agree', 'Agree'], ['disagree', 'Disagree'], ['unsure', "I don't get it"]]
const TIDY = [['keep', 'Keep'], ['remove', 'Remove']]
const RECALL = [['knew', 'I knew it'], ['missed', "I didn't"]]

let data
let decisions = []
let tidy = []
let quiz = []
const revealed = new Set()
const opened = new Set()
let fresh = null
let shown = -1
let hard = null

const calm = matchMedia('(prefers-reduced-motion: reduce)')
const dark = matchMedia('(prefers-color-scheme: dark)')
let clock = 2
let rate = 1
let lastTick = 0

// Everything from the review file reaches the page as text nodes, never as markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else if (value !== false && value != null) el.setAttribute(key, value === true ? '' : value)
  }
  el.append(...children.flat(Infinity).filter((child) => child != null && child !== false))
  return el
}

// A dotted orb from thinking-orbs. It is decoration, so screen readers skip it.
function orb(state, size) {
  const dpr = Math.min(2, devicePixelRatio || 1)
  const canvas = h('canvas', { class: 'orb', width: Math.round(size * dpr), height: Math.round(size * dpr), style: `width:${size}px;height:${size}px`, 'aria-hidden': 'true' })
  canvas.orb = { ...resolvePreset(state, size), size, dpr }
  return canvas
}

// One clock drives every orb, so an orb that is redrawn after a click carries on from where it was.
// With reduced motion switched on, the clock stands still and each orb is a still picture.
function drawOrbs(now) {
  if (!calm.matches) clock += Math.min(0.05, (now - lastTick) / 1000) * rate
  lastTick = now
  for (const canvas of document.querySelectorAll('canvas.orb')) {
    const { mode, speed, opts, size, dpr } = canvas.orb
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    paintFrame(ctx, MODE_FRAMES[mode](size, clock * speed, opts), dark.matches)
  }
  requestAnimationFrame(drawOrbs)
}

// The tile on the home screen leans towards the pointer, and its orb speeds up while the pointer is near.
function lean(e) {
  const tile = e.currentTarget.querySelector('.hero-tile')
  const box = tile.getBoundingClientRect()
  const clamp = (v) => Math.max(-1, Math.min(1, v))
  tile.style.setProperty('--ry', `${clamp((e.clientX - box.left - box.width / 2) / 220) * 18}deg`)
  tile.style.setProperty('--rx', `${clamp((e.clientY - box.top - box.height / 2) / 220) * -18}deg`)
  rate = 2.5
}
function settle(e) {
  const tile = e.currentTarget.querySelector('.hero-tile')
  tile.style.removeProperty('--rx')
  tile.style.removeProperty('--ry')
  rate = 1
}

// Text from the review, with every word from the word list turned into a button that shows its meaning.
// `skip` is the word being explained, so a meaning does not underline itself.
function rich(text, skip) {
  if (!hard || !text) return text
  const out = []
  let last = 0
  for (const match of text.matchAll(hard)) {
    const term = data.terms.find((t) => match[1].toLowerCase() === t.term.toLowerCase())
    if (term.term === skip) continue
    out.push(text.slice(last, match.index), h('button', { class: 'term', 'data-term': term.term, 'aria-expanded': 'false', onclick: explain }, match[0]))
    last = match.index + match[0].length
  }
  return [...out, text.slice(last)]
}

const markOpen = () => {
  const openers = new Set([...document.querySelectorAll('.meaning')].map((card) => card.opener))
  for (const button of document.querySelectorAll('.term')) button.setAttribute('aria-expanded', String(openers.has(button)))
}
function closeMeanings(keep) {
  for (const card of document.querySelectorAll('.meaning')) if (!card.contains(keep)) card.remove()
  markOpen()
}

// The meaning opens right under the line the word is in. Clicking the word again closes it.
// A word inside a meaning opens its own card inside that one, so a chain of words can be followed.
function explain(e) {
  const button = e.currentTarget
  const block = button.closest('p, h1')
  const wasOpen = block.nextElementSibling?.dataset.term === button.dataset.term
  closeMeanings(button)
  if (wasOpen) return
  const { term, meaning } = data.terms.find((t) => t.term === button.dataset.term)
  const card = h('div', { class: 'meaning', 'data-term': term }, h('p', {}, h('strong', {}, term), rich(meaning, term)))
  card.opener = button
  block.after(card)
  markOpen()
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const href = (item) => `#/d/${item.key.slice(2)}`
const verdictOf = (item) => data.verdicts[item.key]?.verdict
const stateOf = (item) => (verdictOf(item) ? 'done' : item.kind === 'orphan' ? 'left' : data.verdicts[item.key] ? 'seen' : 'new')
const stateWords = { done: 'verdict given', seen: 'opened, no verdict', new: 'not looked at', left: 'no reason given' }
const where = (place) => (place.lines ? `${place.file}, lines ${place.lines[0]} to ${place.lines[1]}` : place.file)
const label = (item) => (item.kind === 'decision' ? item.title : item.kind === 'similar' ? item.name : where(item))

// Saves go out one at a time, in the order they were made, so a quick second click cannot be overtaken by the first.
let saving = Promise.resolve()
async function save(key, patch) {
  data.verdicts[key] = { verdict: null, note: '', ...data.verdicts[key], ...patch }
  const body = JSON.stringify({ key, ...data.verdicts[key] })
  const res = await (saving = saving.then(() => fetch('/api/verdict', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => null)))
  document.getElementById('save-error')?.remove()
  if (!res?.ok) app.prepend(h('p', { id: 'save-error', class: 'banner', role: 'alert' }, 'That did not save. Check that scope is still running in your terminal.'))
}

const risk = (item) => h('span', { class: `risk risk-${item.risk}` }, `${item.risk[0].toUpperCase()}${item.risk.slice(1)} risk`)
const origin = (item) => h('span', { class: `tag tag-${item.origin}` }, item.origin === 'assumed' ? 'Assumed' : 'Asked')

function verdicts(item, options, keys = false) {
  return h(
    'div',
    { class: keys ? 'verdicts keyed' : 'verdicts' },
    options.map(([verdict, text], n) =>
      h('button', { 'aria-pressed': String(verdictOf(item) === verdict), onclick: () => (save(item.key, { verdict: verdictOf(item) === verdict ? null : verdict }), render()) }, keys && h('kbd', {}, n + 1), text),
    ),
  )
}

function banners() {
  return [
    data.stale && h('p', { class: 'banner', role: 'alert' }, 'The code has changed since this review was written, so line numbers may point at the wrong place. Ask your agent to scope this again.'),
    data.warnings.length > 0 && h('details', { class: 'quiet' }, h('summary', {}, plural(data.warnings.length, 'warning')), h('ul', {}, data.warnings.map((w) => h('li', {}, w)))),
  ]
}

function code(place, caption) {
  const sign = { add: '+', del: '−', ctx: '' }
  return [
    h('p', { class: 'file' }, caption ? `${caption}: ` : '', where(place)),
    place.text.length
      ? h('div', { class: 'code' }, place.text.map((line) => h('div', { class: `line line-${line.type}` }, h('span', { class: 'num' }, line.n ?? ''), h('span', { class: 'sign' }, sign[line.type]), h('span', { class: 'text' }, line.text || ' '))))
      : h('p', { class: 'quiet' }, 'There is no text to show here. This is a binary file, a rename, or an empty file.'),
  ]
}

// Code stays out of sight until it is asked for.
function peek(key, places, captions = []) {
  const lines = places.reduce((n, place) => n + place.text.length, 0)
  const open = () => ((fresh = key), opened.add(key), render(), (fresh = null))
  const close = () => (opened.delete(key), render())
  if (!opened.has(key)) return h('p', {}, h('button', { class: 'peek', 'aria-expanded': 'false', onclick: open }, `Show the code, ${plural(lines, 'line')}${places.length > 1 ? ` in ${places.length} places` : ''}`))
  return [h('p', {}, h('button', { class: 'peek', 'aria-expanded': 'true', onclick: close }, 'Hide the code')), h('div', { class: fresh === key ? 'peeked fresh' : 'peeked' }, places.map((place, n) => code(place, captions[n])))]
}

function reveal(key, answer, after) {
  if (revealed.has(key)) return [h('p', { class: fresh === key ? 'answer fresh' : 'answer' }, rich(answer)), after]
  return h('button', { onclick: () => ((fresh = key), revealed.add(key), render(), (fresh = null)) }, 'Show answer')
}

// Shown on every screen, so nobody thinks they must finish everything before handing back to the agent.
function stopHint(foot) {
  const waiting = Object.values(data.verdicts).filter((v) => ['disagree', 'remove', 'unsure', 'missed'].includes(v.verdict) || v.note).length
  return h(
    'p',
    { class: foot ? 'hint foot' : 'hint' },
    'You can stop at any point. You do not have to go through everything. When you want changes made, tell your agent: ',
    h('strong', {}, 'fix the scope notes'),
    waiting ? `. ${plural(waiting, 'note')} waiting so far.` : '. Nothing is waiting for it yet.',
  )
}

function home() {
  const assumed = decisions.filter((item) => item.origin === 'assumed').length
  const done = decisions.filter(verdictOf).length
  const next = decisions.find((item) => !verdictOf(item)) ?? decisions[0]
  return [
    h(
      'div',
      { class: 'hero-block', onpointermove: lean, onpointerleave: settle },
      h('div', { class: 'hero-tile' }, orb('searching', 64)),
      h('h1', { class: 'hero' }, data.title, h('span', {}, `${plural(decisions.length, 'decision')}, ${assumed} assumed`)),
      h('p', { class: 'lede' }, `${plural(data.weight.added, 'line')} added, ${data.weight.removed} removed.`),
    ),
    banners(),
    data.asked && h('section', { class: 'story' }, h('p', { class: 'pill' }, 'You asked'), h('p', { class: 'asked' }, rich(data.asked))),
    h(
      'section',
      { class: 'story' },
      h('h2', {}, 'What changed'),
      h('ul', { class: 'changes' }, data.changes.map((change) => h('li', {}, h('p', { class: 'before' }, h('span', { class: 'tag' }, 'Before'), rich(change.before)), h('p', {}, h('span', { class: 'tag tag-now' }, 'Now'), rich(change.after))))),
    ),
    h(
      'p',
      { class: 'actions' },
      h('a', { class: 'button primary', href: href(next) }, done ? 'Carry on' : 'Start with the decisions'),
      tidy.length > 0 && h('a', { class: 'button', href: '#/clean' }, `Clean-up, ${tidy.length}`),
      h('a', { class: 'button', href: '#/map' }, 'Map'),
    ),
    stopHint(),
    h('h2', { class: 'heading' }, 'Decisions'),
    h(
      'ol',
      { class: 'rows' },
      decisions.map((item) => h('li', {}, h('a', { href: href(item), 'data-state': stateOf(item), title: stateWords[stateOf(item)] }, h('span', { class: 'row-title' }, item.title), origin(item), h('span', { class: 'quiet' }, plural(item.weight, 'line'))))),
    ),
    data.boring.length > 0 &&
      h('details', { class: 'quiet' }, h('summary', {}, `Boring pile, ${plural(data.boring.length, 'file')}`), h('ul', {}, data.boring.map((item) => h('li', {}, h('code', {}, item.file), ` ${item.why}`)))),
  ]
}

function decisionView(index) {
  const item = decisions[index]
  const { key } = item
  if (!data.verdicts[key]) save(key, {})
  const next = decisions[index + 1]
  return [
    h('p', { class: 'story-name' }, `Decision ${index + 1} of ${decisions.length}`, ' ', risk(item)),
    h(
      'ol',
      { class: 'route', 'aria-label': 'All decisions' },
      decisions.map((other, n) => h('li', { class: n <= index ? 'passed' : null }, h('a', { href: href(other), 'data-state': stateOf(other), 'aria-current': other === item ? 'step' : null, 'aria-label': `Decision ${n + 1}, ${stateWords[stateOf(other)]}` }))),
    ),
    banners(),
    h(
      'section',
      { class: 'claim' },
      h('p', { class: `pill pill-${item.origin}` }, item.origin === 'assumed' ? 'The agent assumed this' : 'You asked for this'),
      h('h1', {}, rich(item.title)),
      h('p', { class: 'why' }, rich(item.why)),
      item.instead && h('p', { class: 'instead' }, h('span', { class: 'tag' }, 'The other option'), rich(item.instead)),
      item.proof && h('p', { class: 'proof' }, 'Proof you can run yourself: ', h('code', {}, item.proof)),
    ),
    item.guess &&
      h(
        'section',
        { class: 'guess' },
        h('div', { class: 'guess-head' }, h('p', { class: 'pill' }, 'Guess before you look'), !revealed.has(key) && h('span', { class: 'orb-tile' }, orb('solving', 32))),
        h('p', { class: 'question' }, rich(item.guess.question)),
        reveal(key, item.guess.answer),
      ),
    peek(key, item.code),
    verdicts(item, DECIDE, true),
    h('label', { for: 'note' }, 'Note for your agent'),
    h('textarea', { id: 'note', rows: '2', maxlength: '2000', onchange: (e) => save(key, { note: e.target.value.trim() }) }, data.verdicts[key]?.note ?? ''),
    h(
      'nav',
      { class: 'steps' },
      index > 0 ? h('a', { class: 'button', href: href(decisions[index - 1]), id: 'prev' }, 'Back') : h('span'),
      h('a', { class: 'button primary', href: next ? href(next) : tidy.length ? '#/clean' : '#/map', id: 'next' }, next ? 'Next decision' : tidy.length ? 'Clean-up' : 'See the map'),
    ),
  ]
}

function cleanView() {
  const heavy = [...decisions].sort((a, b) => b.weight - a.weight)
  const most = Math.max(1, heavy[0]?.weight ?? 0)
  const copies = tidy.filter((item) => item.kind !== 'orphan')
  const orphans = tidy.filter((item) => item.kind === 'orphan')
  const status = (item) => (item.similar ? `similar to ${where(item.similar)}` : 'nothing similar found')
  return [
    h('h1', {}, 'Clean-up'),
    h('p', { class: 'lede' }, `This change added ${plural(data.weight.added, 'line')} and removed ${data.weight.removed}.`),
    banners(),
    h(
      'section',
      { class: 'story' },
      h('h2', {}, 'Weight of each decision'),
      h('ul', { class: 'bars' }, heavy.map((item, n) => h('li', {}, h('a', { href: href(item) }, item.title), h('span', { class: 'bar', style: `--w:${(item.weight / most) * 100}%;--n:${n}` }), h('span', { class: 'quiet' }, plural(item.weight, 'line'))))),
    ),
    copies.length > 0 && h('h2', { class: 'heading' }, 'Copies'),
    copies.map((item) =>
      h(
        'section',
        { class: 'story', 'data-state': stateOf(item) },
        item.kind === 'similar'
          ? [h('h2', {}, h('code', {}, item.name), ' does a job the project already does'), h('p', {}, rich(item.similar.why))]
          : [h('h2', {}, 'These lines match code already in the project'), h('p', {}, 'The agent did not mention this. The tool found it by comparing text.')],
        peek(item.key, [item, item.similar ?? item.match], ['New', 'Already there']),
        verdicts(item, TIDY),
      ),
    ),
    orphans.length > 0 && h('h2', { class: 'heading' }, 'Code with no reason'),
    orphans.map((item) => h('section', { class: 'story', 'data-state': stateOf(item) }, h('h2', {}, where(item)), h('p', {}, 'No decision explains this change.'), peek(item.key, [item]), verdicts(item, TIDY))),
    h('h2', { class: 'heading' }, 'New things'),
    data.added.length + data.unchecked.length === 0 && h('p', { class: 'quiet' }, 'This change adds no new functions.'),
    h(
      'ul',
      { class: 'things' },
      data.added.map((item) => h('li', {}, h('code', {}, item.name), h('span', { class: 'quiet' }, `${item.file}, ${status(item)}`))),
      data.unchecked.map((item) => h('li', { class: 'unchecked' }, h('code', {}, item.name), h('span', {}, `${item.file}, line ${item.line}. The agent did not check this for copies.`))),
    ),
    h('nav', { class: 'steps' }, h('a', { class: 'button', href: href(decisions.at(-1)), id: 'prev' }, 'Back'), h('a', { class: 'button primary', href: '#/map', id: 'next' }, 'See the map')),
  ]
}

function mapView() {
  const all = [...decisions, ...tidy]
  const count = (state) => all.filter((item) => stateOf(item) === state).length
  const squares = (items, link) =>
    h('div', { class: 'squares' }, items.map((item, n) => h('a', { class: 'square', style: `--n:${n}`, href: link(item), 'data-state': stateOf(item), title: `${label(item)}: ${stateWords[stateOf(item)]}` }, MARK[verdictOf(item)] ?? '')))
  return [
    h('h1', {}, 'What you checked'),
    h('ul', { class: 'legend' }, ['done', 'seen', 'new', 'left'].map((state) => h('li', {}, h('span', { class: 'square', 'data-state': state }), `${count(state)} ${stateWords[state]}`))),
    banners(),
    h('section', { class: 'story' }, h('h2', {}, 'Decisions'), squares(decisions, href)),
    tidy.length > 0 && h('section', { class: 'story' }, h('h2', {}, 'Clean-up'), squares(tidy, () => '#/clean')),
    quiz.length > 0 && h('h2', { class: 'heading' }, 'Check yourself'),
    quiz.map((item) => h('section', { class: 'guess' }, h('p', { class: 'question' }, rich(item.question)), reveal(item.key, item.answer, verdicts(item, RECALL)))),
  ]
}

// `moved` is true when the screen changed, as opposed to the same screen being redrawn after a click.
// Only then do things animate in: sideways when stepping between decisions, upwards otherwise.
function render(moved = false) {
  const [, view, id] = location.hash.split('/')
  const index = view === 'd' ? decisions.findIndex((item) => item.key === `d.${id}`) : -1
  if (!moved) delete app.dataset.enter
  else app.dataset.enter = index >= 0 && shown >= 0 ? (index > shown ? 'forward' : 'back') : 'rise'
  if (moved) shown = index
  const bar = h(
    'header',
    { class: 'bar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'tile', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Scope'),
    h('nav', {}, h('a', { href: '#/' }, 'Overview'), tidy.length > 0 && h('a', { href: '#/clean' }, 'Clean-up'), h('a', { href: '#/map' }, 'Map')),
  )
  const screen = index >= 0 ? decisionView(index) : view === 'clean' ? cleanView() : view === 'map' ? mapView() : home()
  app.replaceChildren(bar, ...screen.flat(Infinity).filter(Boolean), ...(index >= 0 || view === 'clean' || view === 'map' ? [stopHint(true)] : []))
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMeanings()
  if (e.target.matches?.('textarea, input') || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'ArrowRight') document.getElementById('next')?.click()
  if (e.key === 'ArrowLeft') document.getElementById('prev')?.click()
  if ('123'.includes(e.key)) document.querySelectorAll('.verdicts.keyed button')[e.key - 1]?.click()
})
window.addEventListener('hashchange', () => {
  render(true)
  window.scrollTo(0, 0)
})

const res = await fetch('/api/review')
const body = await res.json()
if (!res.ok) {
  app.replaceChildren(h('h1', {}, 'The review file has problems'), h('ul', {}, body.errors.map((error) => h('li', {}, error))), h('p', {}, 'Ask your agent to fix these, then reload this page.'))
} else {
  data = body
  // What the agent assumed comes first, then the riskiest. Keys keep the review file's own numbering.
  const rank = (item) => (item.origin === 'assumed' ? 0 : 3) + RANK[item.risk]
  decisions = data.items.filter((item) => item.kind === 'decision').sort((a, b) => rank(a) - rank(b))
  tidy = data.items.filter((item) => ['similar', 'copy', 'orphan'].includes(item.kind))
  quiz = data.items.filter((item) => item.kind === 'quiz')
  // Longest words first, so "reset link" wins over "link". A plain plural counts as the same word.
  const words = data.terms.map((t) => t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
  if (words.length) hard = new RegExp(`(?<![\\w-])(${words.join('|')})(?:e?s)?(?![\\w-])`, 'gi')
  document.title = `Scope: ${data.title}`
  render(true)
  requestAnimationFrame(drawOrbs)
}
