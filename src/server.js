import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERDICTS, codeFor, loadReview, saveState } from './core.js'

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'page')
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/orbs.js': ['vendor/thinking-orbs.js', 'text/javascript'],
}

// Only this machine may talk to the server: a web page elsewhere must not be able to read code or post verdicts.
const local = (host) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? '')

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 65536) throw new Error('Body too large.')
  }
  return JSON.parse(body)
}

async function handle(root, req, res) {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
  }
  const { origin, host } = req.headers
  if (!local(host) || (origin && !(URL.canParse(origin) && local(new URL(origin).host)))) return send(403, { errors: ['Not allowed.'] })
  const url = req.url.split('?')[0]

  if (req.method === 'GET' && STATIC[url]) {
    const [file, type] = STATIC[url]
    return send(200, fs.readFileSync(path.join(PAGE, file)), type)
  }
  if (url !== '/api/review' && url !== '/api/verdict') return send(404, { errors: ['Not found.'] })

  // The whole request is read before any state is loaded, so load-and-save is one step and saves cannot overwrite each other.
  let body
  if (req.method === 'POST') {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return send(403, { errors: ['Not allowed.'] })
    try {
      body = await readJson(req)
    } catch {
      return send(400, { errors: ['Bad request.'] })
    }
  }

  let loaded
  try {
    loaded = loadReview(root)
  } catch (e) {
    return send(422, { errors: [e.message] })
  }
  const { review, change, errors, warnings, items, state, stale } = loaded
  if (errors.length) return send(422, { errors })

  if (req.method === 'GET' && url === '/api/review') {
    // Each place gets its real lines attached here, read from disk and git.
    const lit = (place) => place && { ...place, text: codeFor(root, change, place.file, place.lines) }
    const full = (item) => ({ ...(item.file ? lit(item) : item), code: item.code?.map(lit), similar: lit(item.similar), match: lit(item.match) })
    return send(200, {
      title: review.title,
      asked: review.asked,
      changes: review.changes,
      terms: review.terms ?? [],
      stale,
      warnings,
      boring: review.boring ?? [],
      verdicts: state.verdicts,
      weight: loaded.weight,
      added: loaded.added,
      unchecked: loaded.unchecked,
      items: items.map(full),
    })
  }

  if (req.method === 'POST' && url === '/api/verdict') {
    const { key, verdict = null, note = '' } = body ?? {}
    const ok = items.some((item) => item.key === key) && (verdict === null || VERDICTS.includes(verdict)) && typeof note === 'string' && note.length <= 2000
    if (!ok) return send(400, { errors: ['Bad request.'] })
    state.verdicts[key] = { verdict, note }
    saveState(root, state, review.title, items)
    return send(200, { ok: true })
  }
  return send(404, { errors: ['Not found.'] })
}

export function startServer(root, port = 4747) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) =>
      handle(root, req, res).catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ errors: [e.message] }))
      }),
    )
    server.once('error', (e) => (e.code === 'EADDRINUSE' && port ? resolve(startServer(root, 0)) : reject(e)))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
