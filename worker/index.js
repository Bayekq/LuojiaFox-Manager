import { verifyAccessToken, AccessAuthError } from './access-jwt.js'

/**
 * RM Command 2.1 - Cloudflare Worker API.
 * Authentication is delegated to Cloudflare Access, then independently
 * verified with Cloudflare Access RSA JWT signature and audience checks.
 * Required for Workers Static Assets, which cannot use ctx.access.
 * Never trust unverified email headers or unverified JWT payloads.
 */
const UNIT_IDS = new Set(['hero', 'engineer', 'infantry3', 'infantry4', 'aerial', 'sentry', 'dart', 'radar'])
const ROLES = ['admin', 'leader', 'member', 'viewer']
const timestamp = () => new Date().toISOString()
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
})
class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra }
}
const fail = (status, code, message, extra) => { throw new ApiError(status, code, message, extra) }
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const owner = row => row ? ({ ...row, disabled: !!row.disabled, unit_ids: safeUnits(row.unit_ids) }) : null
const safeUnits = value => {
  try { const list = Array.isArray(value) ? value : JSON.parse(value || '[]'); return Array.isArray(list) ? [...new Set(list.filter(id => UNIT_IDS.has(id)))] : [] } catch { return [] }
}
const text = (value, field, max = 300, required = false) => {
  if (typeof value !== 'string') fail(422, 'INVALID_FIELD', `${field} 必须为文本`)
  const s = value.trim()
  if ((required && !s) || s.length > max) fail(422, 'INVALID_FIELD', `${field} 长度不合法（最多 ${max} 字）`)
  return s
}
const choice = (value, field, choices) => choices.includes(value) ? value : fail(422, 'INVALID_FIELD', `${field} 取值不合法`)
const number = (value, field, max = 1e9) => {
  if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max) fail(422, 'INVALID_FIELD', `${field} 应为有效非负数字`)
  return Number(value)
}
const asBoolean = (value, field) => typeof value === 'boolean' ? (value ? 1 : 0) : fail(422, 'INVALID_FIELD', `${field} 应为布尔值`)
const date = value => {
  const s = text(value, '日期', 10)
  if (!s) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) fail(422, 'INVALID_FIELD', '日期需要 YYYY-MM-DD 格式')
  return s
}
const idValue = (value, field, nullable = false) => {
  if (nullable && (value === '' || value === null)) return null
  return text(value, field, 120, true)
}
const unitValue = value => UNIT_IDS.has(value) ? value : fail(422, 'INVALID_UNIT', '不存在此兵种')

async function readBody(request, max = 80_000) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请使用 application/json')
  const size = Number(request.headers.get('content-length') || 0)
  if (size > max) fail(413, 'TOO_LARGE', '请求内容过大')
  const body = await request.text()
  if (body.length > max) fail(413, 'TOO_LARGE', '请求内容过大')
  try { const data = JSON.parse(body); if (!isRecord(data)) throw Error('non-object'); return data } catch { fail(400, 'BAD_JSON', 'JSON 格式错误') }
}
function checkRequestOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
  const origin = request.headers.get('origin')
  const host = new URL(request.url).origin
  if (origin && origin !== host) fail(403, 'BAD_ORIGIN', '跨站写入请求已拒绝')
  if (!origin) {
    const site = request.headers.get('sec-fetch-site')
    if (site && !['same-origin', 'none'].includes(site)) fail(403, 'BAD_ORIGIN', '跨站写入请求已拒绝')
  }
}
async function identityEmail(request, env) {
  const host = new URL(request.url).hostname
  // Wrangler-only local convenience; production hostnames NEVER use this path.
  if (['localhost', '127.0.0.1', '[::1]'].includes(host) && env.DEV_AUTH_EMAIL)
    return String(env.DEV_AUTH_EMAIL).trim().toLowerCase()
  return verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), env)
}

async function getActor(request, env, ctx) {
  const email = await identityEmail(request, env)
  if (!email) fail(401, 'ACCESS_REQUIRED', '请先通过 Cloudflare Access 登录')
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
  if (!user && env.BOOTSTRAP_ADMIN_EMAIL && email === String(env.BOOTSTRAP_ADMIN_EMAIL).trim().toLowerCase()) {
    // Atomic first-admin bootstrap. Cannot create another admin once any user exists.
    await env.DB.prepare(`INSERT INTO users(id,email,name,role,unit_ids)
      SELECT ?, ?, ?, 'admin', '[]' WHERE NOT EXISTS(SELECT 1 FROM users LIMIT 1)`)
      .bind(crypto.randomUUID(), email, '初始管理员').run()
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
  }
  if (!user || user.disabled) fail(403, 'NOT_MEMBER', '已验证邮箱，但未加入战队成员名单或账号已停用')
  return owner(user)
}
const isAdmin = actor => actor?.role === 'admin'
const assigned = (actor, unit) => isAdmin(actor) || actor.unit_ids.includes(unit)
const canManage = (actor, unit) => isAdmin(actor) || (actor.role === 'leader' && assigned(actor, unit))
function canCreate(actor, type, unit) {
  if (canManage(actor, unit)) return true
  return actor.role === 'member' && type === 'tasks' && assigned(actor, unit)
}
const assertAdmin = actor => { if (!isAdmin(actor)) fail(403, 'FORBIDDEN', '仅战队管理员可以操作') }
const assertManager = (actor, unit) => { if (!canManage(actor, unit)) fail(403, 'FORBIDDEN', '没有此兵种的管理权限') }
const assertCreate = (actor, type, unit) => { if (!canCreate(actor, type, unit)) fail(403, 'FORBIDDEN', '没有此兵种的创建权限') }

const DEFINITIONS = {
  tasks: {
    fields: {
      unit_id: unitValue, title: x => text(x, '任务标题', 160, true), description: x => text(x, '描述', 4000), subsystem: x => text(x, '子系统', 70),
      owner_id: x => idValue(x, '负责人', true), priority: x => choice(x, '优先级', ['high', 'medium', 'low']),
      status: x => choice(x, '状态', ['todo', 'doing', 'review', 'done']), due_date: date
    },
    defaults: { description: '', subsystem: '', owner_id: null, owner_label: '', priority: 'medium', status: 'todo', due_date: '' }
  },
  milestones: {
    fields: { unit_id: unitValue, title: x => text(x, '节点标题', 160, true), description: x => text(x, '说明', 4000), subsystem: x => text(x, '子系统', 70), due_date: date, done: x => asBoolean(x, '是否完成') },
    defaults: { description: '', subsystem: '', due_date: '', done: 0 }
  },
  risks: {
    fields: { unit_id: unitValue, title: x => text(x, '风险标题', 160, true), description: x => text(x, '应对措施', 4000), level: x => choice(x, '风险等级', ['critical', 'medium', 'low']), status: x => choice(x, '状态', ['open', 'watch', 'closed']), owner_id: x => idValue(x, '负责人', true) },
    defaults: { description: '', level: 'medium', status: 'open', owner_id: null, owner_label: '' }
  },
  purchases: {
    fields: { unit_id: unitValue, name: x => text(x, '物料名称', 160, true), description: x => text(x, '采购说明', 4000), subsystem: x => text(x, '子系统', 70), quantity: x => number(x, '数量', 100_000), unit_price: x => number(x, '单价', 100_000_000), status: x => choice(x, '采购状态', ['planned', 'ordered', 'arrived']), owner_id: x => idValue(x, '负责人', true) },
    defaults: { description: '', subsystem: '', quantity: 1, unit_price: 0, status: 'planned', owner_id: null, owner_label: '' }
  }
}
const columns = type => Object.keys(DEFINITIONS[type].fields)
const selectOne = (db, type, id) => db.prepare(`SELECT * FROM ${type} WHERE id=?`).bind(id).first()
async function audit(db, actor, action, kind, id, summary = '') {
  try { await db.prepare('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,summary) VALUES(?,?,?,?,?)').bind(actor?.id ?? null, action, kind, id, summary.slice(0, 160)).run() }
  catch (error) { console.error('audit failed', error) }
}
function parseChanges(result) { return Number(result?.meta?.changes || 0) }
function ensureVersion(body) {
  const v = body?.version
  if (!Number.isSafeInteger(v) || v <= 0) fail(422, 'VERSION_REQUIRED', '修改/删除必须携带有效 version')
  return v
}
function conflict(current) { fail(409, 'VERSION_CONFLICT', '记录已被他人修改，请比较最新版本再保存', { current }) }
function normalizedRow(type, row) {
  if (!row) return null
  if (type === 'milestones') return { ...row, done: !!row.done }
  return row
}
async function validateOwner(db, ownerId, unit) {
  if (ownerId == null) return
  const row = await db.prepare('SELECT id,disabled,role,unit_ids FROM users WHERE id=?').bind(ownerId).first()
  if (!row || row.disabled) fail(422, 'INVALID_OWNER', '负责人不存在或已停用')
  const units = safeUnits(row.unit_ids)
  if (row.role !== 'admin' && !units.includes(unit)) fail(422, 'INVALID_OWNER', '负责人未被分配至该兵种')
}
async function createEntity(db, actor, type, body) {
  const def = DEFINITIONS[type]
  const data = { ...def.defaults }
  for (const [key, parser] of Object.entries(def.fields)) {
    if (Object.hasOwn(body, key)) data[key] = parser(body[key])
  }
  if (!data.unit_id || !(type === 'purchases' ? data.name : data.title)) fail(422, 'MISSING_FIELDS', '兵种与名称必填')
  assertCreate(actor, type, data.unit_id)
  if (actor.role === 'member') {
    if (body.owner_id && body.owner_id !== actor.id) fail(403, 'FORBIDDEN', '普通成员只能为自己创建任务')
    data.owner_id = actor.id
  }
  if ('owner_id' in data) await validateOwner(db, data.owner_id, data.unit_id)
  const id = crypto.randomUUID()
  const fields = Object.keys(data)
  const extra = type === 'tasks' ? ',created_by' : ''
  const stmt = `INSERT INTO ${type}(id,${fields.join(',')}${extra}) VALUES(?,${fields.map(() => '?').join(',')}${type === 'tasks' ? ',?' : ''})`
  await db.prepare(stmt).bind(id, ...fields.map(k => data[k]), ...(type === 'tasks' ? [actor.id] : [])).run()
  await audit(db, actor, 'create', type, id, data.title || data.name)
  return normalizedRow(type, await selectOne(db, type, id))
}
async function patchEntity(db, actor, type, id, body) {
  const def = DEFINITIONS[type]
  const current = await selectOne(db, type, id)
  if (!current) fail(404, 'NOT_FOUND', '记录不存在')
  const expected = ensureVersion(body)
  if (actor.role === 'member' && type === 'tasks') {
    if (!assigned(actor, current.unit_id) || current.owner_id !== actor.id) fail(403, 'FORBIDDEN', '普通成员只能修改自己负责的任务')
  } else assertManager(actor, current.unit_id)
  const values = {}
  for (const [key, parser] of Object.entries(def.fields)) {
    if (Object.hasOwn(body, key)) values[key] = parser(body[key])
  }
  const futureUnit = values.unit_id ?? current.unit_id
  if (futureUnit !== current.unit_id) assertManager(actor, futureUnit)
  if (actor.role === 'member' && type === 'tasks' && Object.hasOwn(values, 'owner_id') && values.owner_id !== actor.id) fail(403, 'FORBIDDEN', '普通成员不能转移任务负责人')
  if ('owner_id' in current && (Object.hasOwn(values, 'owner_id') || futureUnit !== current.unit_id))
    await validateOwner(db, values.owner_id === undefined ? current.owner_id : values.owner_id, futureUnit)
  if (!Object.keys(values).length) fail(422, 'NO_FIELDS', '没有可修改字段')
  const fields = Object.keys(values)
  // Conditional atomic UPDATE avoids lost writes even under concurrent requests.
  const result = await db.prepare(`UPDATE ${type} SET ${fields.map(k => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(...fields.map(k => values[k]), timestamp(), id, expected).run()
  if (!parseChanges(result)) {
    const latest = await selectOne(db, type, id)
    if (!latest) fail(404, 'NOT_FOUND', '记录已删除')
    conflict(normalizedRow(type, latest))
  }
  await audit(db, actor, 'update', type, id, String(current.title || current.name || ''))
  return normalizedRow(type, await selectOne(db, type, id))
}
async function deleteEntity(db, actor, type, id, body) {
  const current = await selectOne(db, type, id)
  if (!current) fail(404, 'NOT_FOUND', '记录不存在')
  const expected = ensureVersion(body)
  assertManager(actor, current.unit_id)
  const result = await db.prepare(`DELETE FROM ${type} WHERE id=? AND version=?`).bind(id, expected).run()
  if (!parseChanges(result)) {
    const latest = await selectOne(db, type, id)
    if (!latest) fail(404, 'NOT_FOUND', '记录已删除')
    conflict(normalizedRow(type, latest))
  }
  await audit(db, actor, 'delete', type, id, String(current.title || current.name || ''))
  return { deleted: id }
}
async function patchUnit(db, actor, id, body) {
  unitValue(id)
  assertManager(actor, id)
  const current = await db.prepare('SELECT * FROM units WHERE id=?').bind(id).first()
  if (!current) fail(404, 'NOT_FOUND', '兵种不存在')
  const version = ensureVersion(body)
  const validators = { description: x => text(x, '兵种简介', 1600), stage: x => text(x, '研发阶段', 80), goal: x => text(x, '赛季目标', 600), budget: x => number(x, '兵种预算'), lead_id: x => idValue(x, '兵种负责人', true) }
  const updates = Object.fromEntries(Object.entries(validators).filter(([k]) => Object.hasOwn(body, k)).map(([k, fn]) => [k, fn(body[k])]))
  if (!Object.keys(updates).length) fail(422, 'NO_FIELDS', '没有可修改字段')
  if (updates.lead_id) await validateOwner(db, updates.lead_id, id)
  const keys = Object.keys(updates)
  const res = await db.prepare(`UPDATE units SET ${keys.map(k => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(...keys.map(k => updates[k]), timestamp(), id, version).run()
  if (!parseChanges(res)) conflict(await db.prepare('SELECT * FROM units WHERE id=?').bind(id).first())
  await audit(db, actor, 'update', 'units', id, current.name)
  return await db.prepare('SELECT * FROM units WHERE id=?').bind(id).first()
}
async function patchSettings(db, actor, body) {
  assertAdmin(actor)
  const ver = ensureVersion(body)
  const values = {}
  if (Object.hasOwn(body, 'team_name')) values.team_name = text(body.team_name, '战队名称', 100, true)
  if (Object.hasOwn(body, 'season')) values.season = text(body.season, '赛季', 60, true)
  if (Object.hasOwn(body, 'team_budget')) values.team_budget = number(body.team_budget, '全队预算')
  const keys = Object.keys(values)
  if (!keys.length) fail(422, 'NO_FIELDS', '没有可修改字段')
  const res = await db.prepare(`UPDATE settings SET ${keys.map(k => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=1 AND version=?`)
    .bind(...keys.map(k => values[k]), timestamp(), ver).run()
  if (!parseChanges(res)) conflict(await db.prepare('SELECT * FROM settings WHERE id=1').first())
  await audit(db, actor, 'update', 'settings', '1', '战队工作区设置')
  return await db.prepare('SELECT * FROM settings WHERE id=1').first()
}
async function createUser(db, actor, body) {
  assertAdmin(actor)
  const email = text(body.email, '邮箱', 254, true).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(422, 'INVALID_EMAIL', '请输入有效邮箱')
  const name = text(body.name, '成员姓名', 100, true)
  const role = choice(body.role ?? 'member', '角色', ROLES)
  if (!Array.isArray(body.unit_ids) || body.unit_ids.some(u => !UNIT_IDS.has(u))) fail(422, 'INVALID_UNIT', '所属兵种格式错误')
  const unit_ids = safeUnits(body.unit_ids)
  const id = crypto.randomUUID()
  try {
    await db.prepare('INSERT INTO users(id,email,name,role,unit_ids) VALUES(?,?,?,?,?)').bind(id, email, name, role, JSON.stringify(unit_ids)).run()
  } catch (e) {
    if (String(e).includes('UNIQUE')) fail(409, 'DUPLICATE_EMAIL', '此邮箱已注册')
    throw e
  }
  await audit(db, actor, 'create', 'users', id, name)
  return owner(await db.prepare('SELECT * FROM users WHERE id=?').bind(id).first())
}
async function patchUser(db, actor, id, body) {
  assertAdmin(actor)
  const version = ensureVersion(body)
  const current = await db.prepare('SELECT * FROM users WHERE id=?').bind(id).first()
  if (!current) fail(404, 'NOT_FOUND', '成员不存在')
  const updates = {}
  if (Object.hasOwn(body, 'name')) updates.name = text(body.name, '姓名', 100, true)
  if (Object.hasOwn(body, 'role')) updates.role = choice(body.role, '角色', ROLES)
  if (Object.hasOwn(body, 'unit_ids')) {
    if (!Array.isArray(body.unit_ids) || body.unit_ids.some(u => !UNIT_IDS.has(u))) fail(422, 'INVALID_UNIT', '兵种格式错误')
    updates.unit_ids = JSON.stringify(safeUnits(body.unit_ids))
  }
  if (Object.hasOwn(body, 'disabled')) updates.disabled = asBoolean(body.disabled, '禁用状态')
  if (current.id === actor.id && (updates.disabled === 1 || (updates.role && updates.role !== 'admin'))) fail(422, 'SELF_LOCKOUT', '不能停用或降权当前管理员账号')
  if (current.role === 'admin' && (updates.disabled === 1 || (updates.role && updates.role !== 'admin'))) {
    const activeAdmins = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").first()
    if (Number(activeAdmins?.n) <= 1) fail(422, 'LAST_ADMIN', '不能移除最后一名管理员')
  }
  const keys = Object.keys(updates)
  if (!keys.length) fail(422, 'NO_FIELDS', '没有可修改字段')
  const removingAdmin = current.role === 'admin' && (updates.disabled === 1 || (updates.role && updates.role !== 'admin'))
  // Check the remaining administrator count in the same conditional UPDATE to
  // prevent concurrent demotions from removing all administrators.
  const adminGuard = removingAdmin ? " AND (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0)>1" : ''
  const res = await db.prepare(`UPDATE users SET ${keys.map(k => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=? AND version=?${adminGuard}`)
    .bind(...keys.map(k => updates[k]), timestamp(), id, version).run()
  if (!parseChanges(res)) {
    const latest = owner(await db.prepare('SELECT * FROM users WHERE id=?').bind(id).first())
    if (latest?.version !== version) conflict(latest)
    if (removingAdmin) fail(422, 'LAST_ADMIN', '不能移除最后一名管理员')
    conflict(latest)
  }
  await audit(db, actor, 'update', 'users', id, current.name)
  return owner(await db.prepare('SELECT * FROM users WHERE id=?').bind(id).first())
}
async function state(db) {
  const results = await db.batch([
    db.prepare('SELECT * FROM settings WHERE id=1'),
    db.prepare('SELECT * FROM units ORDER BY code'),
    db.prepare('SELECT id,email,name,role,unit_ids,disabled,version,created_at,updated_at FROM users ORDER BY created_at'),
    db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC'),
    db.prepare('SELECT * FROM milestones ORDER BY due_date ASC'),
    db.prepare('SELECT * FROM risks ORDER BY updated_at DESC'),
    db.prepare('SELECT * FROM purchases ORDER BY updated_at DESC'),
    db.prepare('SELECT id,actor_id,action,entity_type,entity_id,summary,created_at FROM audit_logs ORDER BY id DESC LIMIT 20')
  ])
  return {
    settings: results[0].results[0] ?? null,
    units: results[1].results,
    users: results[2].results.map(owner),
    tasks: results[3].results,
    milestones: results[4].results.map(r => normalizedRow('milestones', r)),
    risks: results[5].results,
    purchases: results[6].results,
    activity: results[7].results
  }
}
function legacyRows(body) {
  if (![1, 2].includes(Number(body.version))) fail(422, 'INVALID_IMPORT', '仅支持 RM Command V1/V2 JSON 导出格式')
  for (const key of ['tasks','milestones','risks','purchases','members']) if (!Array.isArray(body[key])) fail(422, 'INVALID_IMPORT', `缺少 ${key} 数组`)
  const total = body.tasks.length + body.milestones.length + body.risks.length + body.purchases.length
  if (total > 240) fail(413, 'IMPORT_LIMIT', '单次最多迁移 240 条业务记录，请分批整理')
  const memberMap = Object.fromEntries(body.members.filter(isRecord).map(m => [String(m.id), String(m.name || '')]))
  return { total, memberMap, sentryOnly: Number(body.version) === 1 }
}
async function importLegacy(db, actor, body) {
  assertAdmin(actor)
  const { total, memberMap, sentryOnly } = legacyRows(body)
  const counts = await db.batch(['tasks','milestones','risks','purchases'].map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)))
  if (counts.some(r => Number(r.results[0].n) > 0)) fail(409, 'DATA_EXISTS', '云端已有业务数据；为防止覆盖，请在空数据库中迁移')
  const stmt = []
  const imported = { tasks: [], milestones: [], risks: [], purchases: [] }
  const unitOf = obj => sentryOnly ? 'sentry' : unitValue(obj.unit || 'sentry')
  const labelOf = obj => text(memberMap[String(obj.owner)] || '', '导入负责人', 100)
  for (const raw of body.tasks) {
    if (!isRecord(raw)) fail(422,'INVALID_IMPORT','任务记录格式错误')
    imported.tasks.push([crypto.randomUUID(), unitOf(raw), text(String(raw.title||''),'任务标题',160,true),text(String(raw.description||''),'描述',4000),text(String(raw.subsystem||''),'子系统',70),labelOf(raw),['high','medium','low'].includes(raw.priority)?raw.priority:'medium',['todo','doing','review','done'].includes(raw.status)?raw.status:'todo',date(String(raw.due||'')),actor.id])
  }
  for (const raw of body.milestones) {
    if (!isRecord(raw)) fail(422,'INVALID_IMPORT','里程碑格式错误')
    imported.milestones.push([crypto.randomUUID(),unitOf(raw),text(String(raw.title||''),'节点标题',160,true),text(String(raw.note||raw.description||''),'说明',4000),text(String(raw.subsystem||''),'子系统',70),date(String(raw.date||raw.due||'')),raw.done?1:0])
  }
  for (const raw of body.risks) {
    if (!isRecord(raw)) fail(422,'INVALID_IMPORT','风险记录格式错误')
    imported.risks.push([crypto.randomUUID(),unitOf(raw),text(String(raw.title||''),'风险标题',160,true),text(String(raw.plan||raw.description||''),'应对措施',4000),['critical','medium','low'].includes(raw.level)?raw.level:'medium',['open','watch','closed'].includes(raw.status)?raw.status:'open',labelOf(raw)])
  }
  for (const raw of body.purchases) {
    if (!isRecord(raw)) fail(422,'INVALID_IMPORT','采购记录格式错误')
    imported.purchases.push([crypto.randomUUID(),unitOf(raw),text(String(raw.name||''),'物料名称',160,true),text(String(raw.description||''),'说明',4000),text(String(raw.subsystem||''),'子系统',70),number(raw.quantity??1,'数量',100000),number(raw.unitPrice??raw.unit_price??0,'单价',100000000),['planned','ordered','arrived'].includes(raw.status)?raw.status:'planned',labelOf(raw)])
  }
  // One multi-row INSERT per group (<= 90 parameters each) keeps a full
  // 240-record import well below the free plan's per-invocation query ceiling.
  // The entire batch remains transactional: invalid rows never partially load.
  const importColumns = {
    tasks: ['id','unit_id','title','description','subsystem','owner_label','priority','status','due_date','created_by'],
    milestones: ['id','unit_id','title','description','subsystem','due_date','done'],
    risks: ['id','unit_id','title','description','level','status','owner_label'],
    purchases: ['id','unit_id','name','description','subsystem','quantity','unit_price','status','owner_label']
  }
  for (const [table, rows] of Object.entries(imported)) {
    const cols = importColumns[table]
    const groupSize = Math.floor(90 / cols.length)
    for (let i = 0; i < rows.length; i += groupSize) {
      const group = rows.slice(i, i + groupSize)
      const tuple = '(' + cols.map(() => '?').join(',') + ')'
      stmt.push(db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${group.map(() => tuple).join(',')}`)
        .bind(...group.flat()))
    }
  }
  if (isRecord(body.settings)) {
    const teamName = text(String(body.settings.name||'武汉大学 · 珞珈狐战队'),'战队名称',100,true)
    const season = text(String(body.settings.season||'RM 2027'),'赛季',60,true)
    const teamBudget = number(body.settings.budget??0,'预算')
    stmt.push(db.prepare('UPDATE settings SET team_name=?,season=?,team_budget=?,version=version+1 WHERE id=1').bind(teamName,season,teamBudget))
  }
  if (isRecord(body.units)) {
    for (const [unitId, raw] of Object.entries(body.units)) {
      if (!UNIT_IDS.has(unitId) || !isRecord(raw)) continue
      stmt.push(db.prepare('UPDATE units SET budget=?,stage=?,description=?,goal=?,version=version+1 WHERE id=?')
        .bind(number(raw.budget??0,'兵种预算'),text(String(raw.stage||'待规划'),'阶段',80),text(String(raw.description||''),'简介',1600),text(String(raw.goal||''),'目标',600),unitId))
    }
  } else if (sentryOnly && isRecord(body.settings)) {
    stmt.push(db.prepare('UPDATE units SET budget=?,version=version+1 WHERE id=?').bind(number(body.settings.budget??0,'预算'),'sentry'))
  }
  if (stmt.length) await db.batch(stmt) // D1 batch is a transactional execution.
  await audit(db, actor, 'import', 'workspace', 'legacy', `导入 ${total} 条业务记录`)
  return { imported: total, note: '旧版成员名称以负责人文本保留；登录账户需在成员管理中另行建立。' }
}
async function apiHandler(request, env, ctx) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method
  if (path === '/api/health' && method === 'GET') return json({ status: 'ok', service: 'rm-command', version: '2.1.0' })
  checkRequestOrigin(request)
  if (!env.DB) fail(503, 'MISSING_D1', '未绑定 D1 数据库，请核对 wrangler.jsonc')
  const actor = await getActor(request, env, ctx)
  if (path === '/api/me' && method === 'GET') return json({ user: actor, auth_provider: 'cloudflare-access' })
  if (path === '/api/state' && method === 'GET') return json(await state(env.DB))
  if (path === '/api/export' && method === 'GET') {
    assertAdmin(actor)
    return json({ version: 2.1, exported_at: timestamp(), ...(await state(env.DB)) }, 200, { 'Content-Disposition': 'attachment; filename="rm-command-backup.json"' })
  }
  if (path === '/api/import' && method === 'POST') return json(await importLegacy(env.DB, actor, await readBody(request, 900_000)))
  if (path === '/api/settings' && method === 'PATCH') return json(await patchSettings(env.DB, actor, await readBody(request)))
  if (path === '/api/users' && method === 'POST') return json(await createUser(env.DB, actor, await readBody(request)), 201)
  const userMatch = path.match(/^\/api\/users\/([\w-]+)$/)
  if (userMatch && method === 'PATCH') return json(await patchUser(env.DB, actor, userMatch[1], await readBody(request)))
  const unitMatch = path.match(/^\/api\/units\/(\w+)$/)
  if (unitMatch && method === 'PATCH') return json(await patchUnit(env.DB, actor, unitMatch[1], await readBody(request)))
  const resource = path.match(/^\/api\/(tasks|milestones|risks|purchases)(?:\/([\w-]+))?$/)
  if (resource) {
    const [,type,id] = resource
    if (!id && method === 'POST') return json(await createEntity(env.DB, actor, type, await readBody(request)), 201)
    if (id && method === 'PATCH') return json(await patchEntity(env.DB, actor, type, id, await readBody(request)))
    if (id && method === 'DELETE') return json(await deleteEntity(env.DB, actor, type, id, await readBody(request)))
  }
  fail(404, 'NOT_FOUND', '接口不存在')
}
export default {
  async fetch(request, env, ctx) {
    try {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith('/api/')) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 405 })
        return await apiHandler(request, env, ctx)
      }
      if (env.ASSETS) return env.ASSETS.fetch(request)
      return json({ error: { code: 'NOT_FOUND', message: '静态资源未配置' } }, 404)
    } catch (error) {
      if (error instanceof ApiError || error instanceof AccessAuthError) return json({ error: { code: error.code, message: error.message, ...error.extra } }, error.status)
      console.error('API unexpected error', error)
      return json({ error: { code: 'INTERNAL', message: '服务异常；请确认 D1 已初始化，并查看 Worker 日志' } }, 500)
    }
  }
}
