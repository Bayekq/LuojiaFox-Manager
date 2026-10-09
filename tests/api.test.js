import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { generateKeyPairSync, sign } from 'node:crypto'
import worker from '../worker/index.js'

class MockD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
  }
  prepare(sql) {
    const handle = this.db.prepare(sql)
    return {
      bind: (...params) => ({
        first: async () => handle.get(...params) || null,
        run: async () => ({ success: true, meta: { changes: handle.run(...params).changes } }),
        all: async () => ({ results: handle.all(...params) })
      }),
      first: async () => handle.get() || null,
      run: async () => ({ success: true, meta: { changes: handle.run().changes } }),
      all: async () => ({ results: handle.all() })
    }
  }
  async batch(stmts) {
    this.db.exec('BEGIN')
    try {
      const result = []
      for (const stmt of stmts) {
        const selected = await stmt.all()
        result.push({ results: selected.results, success: true, meta: { changes: 0 } })
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
const fixture = () => ({ DB: new MockD1(), BOOTSTRAP_ADMIN_EMAIL: 'captain@whu.edu.cn', ACCESS_TEAM_DOMAIN: 'https://test-luojiafox.cloudflareaccess.com', ACCESS_AUD: 'team-rm-command-v21-test-aud' })
async function call(env, method, path, body, email = 'captain@whu.edu.cn', origin) {
  const opts = { method, headers: {} }
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json' }
  if (origin) opts.headers.origin = origin
  if (email === null) delete env.DEV_AUTH_EMAIL
  else env.DEV_AUTH_EMAIL = email
  const req = new Request(`http://127.0.0.1:8787/api/${path}`, opts)
  const res = await worker.fetch(req, env, {})
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}
async function ready() { const env = fixture(); assert.equal((await call(env, 'GET', 'me')).status, 200); return env }

test('anonymous cannot spoof headers; local dev identity is restricted to localhost', async () => {
  const env = fixture()
  assert.equal((await call(env, 'GET', 'me', undefined, null)).status, 401)
  assert.equal((await call(env, 'GET', 'health', undefined, null)).status, 200)
})

test('production verifies signed Access JWT, issuer, audience, expiry, and rejects spoofed email headers', async () => {
  const env = fixture()
  env.ACCESS_TEAM_DOMAIN = 'https://test-luojiafox.cloudflareaccess.com'
  env.ACCESS_AUD = 'team-rm-command-v21-test-aud'
  env.DEV_AUTH_EMAIL = 'captain@whu.edu.cn' // must not work on production host
  const uri = 'https://rm.example.test/api/me'
  const bare = await worker.fetch(new Request(uri, {
    headers: { 'Cf-Access-Authenticated-User-Email': 'captain@whu.edu.cn' }
  }), env, { access: { getIdentity: async () => ({ email: 'captain@whu.edu.cn' }) } })
  assert.equal(bare.status, 401, 'static asset Worker may not trust ctx.access or unsigned header')

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'v21-test-kid', alg: 'RS256', use: 'sig' }
  const base64url = s => Buffer.from(s).toString('base64url')
  function jwt(claims) {
    const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', kid: 'v21-test-kid', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`
    return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`
  }
  const now = Math.floor(Date.now()/1000)
  const claims = { email: 'captain@whu.edu.cn', iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], exp: now+300, iat: now-5, type: 'app' }
  const oldFetch = globalThis.fetch
  let keysFetched = 0
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://test-luojiafox.cloudflareaccess.com/cdn-cgi/access/certs')
    keysFetched++
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
  }
  try {
    const signed = jwt(claims)
    const good = await worker.fetch(new Request(uri, { headers: { 'Cf-Access-Jwt-Assertion': signed } }), env, {})
    assert.equal(good.status, 200)
    assert.equal((await good.json()).user.role, 'admin')
    assert.equal(keysFetched, 1)
    const tampered = signed.slice(0, -4) + 'abcd'
    assert.equal((await worker.fetch(new Request(uri, { headers: { 'Cf-Access-Jwt-Assertion': tampered } }), env, {})).status, 401)
    assert.equal((await worker.fetch(new Request(uri, { headers: { 'Cf-Access-Jwt-Assertion': jwt({ ...claims, aud: ['other-app'] }) } }), env, {})).status, 401)
    assert.equal((await worker.fetch(new Request(uri, { headers: { 'Cf-Access-Jwt-Assertion': jwt({ ...claims, exp: now-100 }) } }), env, {})).status, 401)
    assert.equal((await worker.fetch(new Request(uri, { headers: { 'Cf-Access-Jwt-Assertion': jwt({ ...claims, iss: 'https://evil.cloudflareaccess.com' }) } }), env, {})).status, 401)
    assert.equal(keysFetched, 1, 'JWKS reused after first retrieval')
  } finally { globalThis.fetch = oldFetch }
})

test('first admin bootstrap, 8 unit rows and no fake demo tasks', async () => {
  const env = await ready()
  const { data } = await call(env, 'GET', 'state')
  assert.equal(data.units.length, 8)
  assert.equal(data.users.length, 1)
  assert.equal(data.users[0].role, 'admin')
  assert.equal(data.tasks.length, 0)
  assert.equal(data.settings.team_budget, 0)
})

test('RBAC: leader writes assigned unit; member owns tasks; viewer read-only', async () => {
  const env = await ready()
  const leaderRes = await call(env, 'POST', 'users', { email: 'leader@whu.edu.cn', name: '哨兵负责人', role: 'leader', unit_ids: ['sentry'] })
  assert.equal(leaderRes.status, 201)
  const memberRes = await call(env, 'POST', 'users', { email: 'member@whu.edu.cn', name: '视觉成员', role: 'member', unit_ids: ['sentry'] })
  assert.equal(memberRes.status, 201)
  assert.equal((await call(env, 'POST', 'users', { email: 'viewer@whu.edu.cn', name: '评审成员', role: 'viewer', unit_ids: [] })).status, 201)
  const task = await call(env, 'POST', 'tasks', { unit_id: 'sentry', title: '自瞄延时回归测试', owner_id: memberRes.data.id }, 'leader@whu.edu.cn')
  assert.equal(task.status, 201)
  assert.equal(task.data.version, 1)
  assert.equal((await call(env, 'POST', 'tasks', { unit_id: 'hero', title: '不允许' }, 'leader@whu.edu.cn')).status, 403)
  assert.equal((await call(env, 'PATCH', `tasks/${task.data.id}`, { version: 1, status: 'doing' }, 'member@whu.edu.cn')).status, 200)
  assert.equal((await call(env, 'PATCH', `tasks/${task.data.id}`, { version: 2, owner_id: leaderRes.data.id }, 'member@whu.edu.cn')).status, 403)
  assert.equal((await call(env, 'PATCH', 'units/sentry', { version: 1, budget: 9000 }, 'member@whu.edu.cn')).status, 403)
  assert.equal((await call(env, 'POST', 'risks', { title: '越权', unit_id: 'sentry' }, 'member@whu.edu.cn')).status, 403)
  assert.equal((await call(env, 'POST', 'tasks', { unit_id: 'sentry', title: '越权' }, 'viewer@whu.edu.cn')).status, 403)
  assert.equal((await call(env, 'GET', 'state', undefined, 'viewer@whu.edu.cn')).status, 200)
  const unit = await call(env, 'PATCH', 'units/sentry', { version: 1, budget: 9000 }, 'leader@whu.edu.cn')
  assert.equal(unit.status, 200)
  assert.equal(unit.data.version, 2)
})

test('optimistic locks: atomic revision match, 409 current payload, stale delete fails', async () => {
  const env = await ready()
  const task = (await call(env, 'POST', 'tasks', { title: '底盘闭环测试', unit_id: 'sentry', status: 'todo' })).data
  const first = await call(env, 'PATCH', `tasks/${task.id}`, { version: 1, status: 'doing' })
  assert.equal(first.status, 200)
  assert.equal(first.data.version, 2)
  const stale = await call(env, 'PATCH', `tasks/${task.id}`, { version: 1, status: 'done' })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.error.code, 'VERSION_CONFLICT')
  assert.equal(stale.data.error.current.status, 'doing')
  assert.equal(stale.data.error.current.version, 2)
  assert.equal((await call(env, 'DELETE', `tasks/${task.id}`, { version: 1 })).status, 409)
  assert.equal((await call(env, 'DELETE', `tasks/${task.id}`, { version: 2 })).status, 200)
  assert.equal((await call(env, 'GET', 'state')).data.tasks.length, 0)
})

test('schema CRUD milestones risks purchases settings and 409', async () => {
  const env = await ready()
  const cases = [
    ['milestones', { title: '第一次联调', unit_id: 'engineer', due_date: '2026-11-11', done: false }, { done: true }],
    ['risks', { title: '回环带宽异常', unit_id: 'radar', level: 'critical' }, { status: 'watch' }],
    ['purchases', { name: '线束连接器', unit_id: 'sentry', quantity: 2, unit_price: 300 }, { quantity: 3 }]
  ]
  for (const [kind, input, delta] of cases) {
    const create = await call(env, 'POST', kind, input)
    assert.equal(create.status, 201, `${kind} create`)
    const patchResult = await call(env, 'PATCH', `${kind}/${create.data.id}`, { version: 1, ...delta })
    assert.equal(patchResult.status, 200, `${kind} patch`)
    assert.equal(patchResult.data.version, 2)
    assert.equal((await call(env, 'PATCH', `${kind}/${create.data.id}`, { version: 1, ...delta })).status, 409)
  }
  assert.equal((await call(env, 'PATCH', 'settings', { version: 1, team_budget: 12000 })).status, 200)
  assert.equal((await call(env, 'PATCH', 'settings', { version: 1, team_budget: 0 })).status, 409)
  assert.equal((await call(env, 'GET', 'state')).data.activity.length > 0, true)
})

test('non-same-origin write blocked, field validation, user self-lockout', async () => {
  const env = await ready()
  assert.equal((await call(env, 'POST', 'tasks', { title: 'X', unit_id: 'sentry' }, 'captain@whu.edu.cn', 'https://evil.test')).status, 403)
  assert.equal((await call(env, 'POST', 'tasks', { title: '', unit_id: 'sentry' })).status, 422)
  assert.equal((await call(env, 'POST', 'tasks', { title: 'a', unit_id: 'xx' })).status, 422)
  assert.equal((await call(env, 'POST', 'tasks', { title: 'a', unit_id: 'sentry', due_date: '2026-02-30' })).status, 422)
  const admin = (await call(env, 'GET', 'me')).data.user
  assert.equal((await call(env, 'PATCH', `users/${admin.id}`, { version: 1, disabled: true })).status, 422)
})

test('legacy import V2 preserves task and unlinked owner labels, non-empty DB denies import', async () => {
  const env = await ready()
  const old = {
    version: 2,
    settings: { name: '珞珈狐', season: 'RM 2027', budget: 1200 },
    units: { sentry: { budget: 500, stage: '联调', description: '哨兵', goal: '闭环' } },
    members: [{ id: 'm0', name: '原负责人' }],
    tasks: [{ unit: 'sentry', title: '排查时间同步', status: 'doing', priority: 'high', owner: 'm0' }],
    milestones: [], risks: [], purchases: []
  }
  const result = await call(env, 'POST', 'import', old)
  assert.equal(result.status, 200)
  assert.equal(result.data.imported, 1)
  const snapshot = (await call(env, 'GET', 'state')).data
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.tasks[0].owner_label, '原负责人')
  assert.equal(snapshot.units.find(x => x.id === 'sentry').budget, 500)
  assert.equal((await call(env, 'POST', 'import', old)).status, 409)
  assert.equal((await call(env, 'GET', 'export')).status, 200)
})

test('simultaneous PATCH with the same version cannot both commit', async () => {
  const env = await ready()
  const task = (await call(env, 'POST', 'tasks', { unit_id: 'sentry', title: '云台伺服控制' })).data
  const pair = await Promise.all([
    call(env, 'PATCH', `tasks/${task.id}`, { version: 1, status: 'review' }),
    call(env, 'PATCH', `tasks/${task.id}`, { version: 1, status: 'done' })
  ])
  assert.deepEqual(pair.map(x => x.status).sort(), [200, 409])
  const saved = (await call(env, 'GET', 'state')).data.tasks.find(x => x.id === task.id)
  assert.equal(saved.version, 2)
})

test('last admin guard with two authorized admins cannot leave zero active admins', async () => {
  const env = await ready()
  const second = (await call(env, 'POST', 'users', { email: 'second@whu.edu.cn', name: '副队长', role: 'admin', unit_ids: [] })).data
  const first = (await call(env, 'GET', 'me')).data.user
  const removeOne = await call(env, 'PATCH', `users/${second.id}`, { version: 1, role: 'viewer' })
  assert.equal(removeOne.status, 200)
  assert.equal((await call(env, 'PATCH', `users/${first.id}`, { version: 1, role: 'viewer' }, 'second@whu.edu.cn')).status, 403)
  const activeAdmins = (await call(env, 'GET', 'state')).data.users.filter(x => x.role === 'admin' && !x.disabled)
  assert.equal(activeAdmins.length, 1)
})

test('importing 240 records uses compact transactional batches within free-tier query ceiling', async () => {
  const env = await ready()
  const runBatch = env.DB.batch.bind(env.DB)
  let largest = 0
  env.DB.batch = async stmts => {
    largest = Math.max(largest, stmts.length)
    assert.ok(stmts.length <= 50, `too many D1 SQL statements in one batch: ${stmts.length}`)
    return runBatch(stmts)
  }
  const old = {
    version: 2, members: [], milestones: [], risks: [], purchases: [],
    tasks: Array.from({ length: 240 }, (_, index) => ({ unit: index % 2 ? 'sentry' : 'hero', title: `批量任务-${index}` }))
  }
  const imported = await call(env, 'POST', 'import', old)
  assert.equal(imported.status, 200)
  assert.equal(imported.data.imported, 240)
  assert.ok(largest < 40)
  const snapshot = (await call(env, 'GET', 'state')).data
  assert.equal(snapshot.tasks.length, 240)
  assert.equal(snapshot.tasks.filter(t => t.unit_id === 'sentry').length, 120)
})
