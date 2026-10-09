<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bell,
  CalendarDays, Check, ChevronRight, CircleHelp, ClipboardList, Clock3, Cloud, Code2,
  Database, FileJson, Flag, FolderKanban, GitBranch, History, LayoutDashboard, Layers3,
  ListTodo, LockKeyhole, Menu, MoreHorizontal, Plus, RefreshCw, Search, Settings, ShieldCheck,
  Target, Trash2, UploadCloud, UserRound, Users, Wallet, X, Columns3, LogIn, Save,
  GripVertical, Edit3, CheckCircle2, PackageOpen, ExternalLink
} from 'lucide-vue-next'
import { request, post, patch, remove } from './api.js'
import {
  NAV, TABS, STATUS, PRIORITY, RISK_LEVEL, RISK_STATUS, PURCHASE_STATUS, ROLES,
  LABELS, money, dateLabel, dateDistance, pct, roleLabel, statusLabel
} from './constants.js'

const ICONS = { LayoutDashboard, Columns3, CalendarDays, AlertTriangle, Wallet, Users, Settings, History }
const clonePlain = value => JSON.parse(JSON.stringify(value))
const me = ref(null)
const data = ref({ settings: null, units: [], users: [], tasks: [], milestones: [], risks: [], purchases: [], activity: [] })
const booting = ref(true)
const loading = ref(false)
const accessError = ref('')
const message = ref('')
const messageBad = ref(false)
const mobileNav = ref(false)
const route = ref('overview')
const selectedUnit = ref('')
const tab = ref('overview')
const search = ref('')
const filterUnit = ref('')
const filterPriority = ref('')
const editing = ref(null)
const editingKind = ref('')
const form = ref({})
const editingId = ref('')
const conflict = ref(null)
const modalReadonly = ref(false)
const dragging = ref('')
const importing = ref(false)
const fileInput = ref(null)
let poller = null
let toastTimer = null
const today = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(new Date())

function notify(msg, bad = false) {
  message.value = msg; messageBad.value = bad
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { message.value = '' }, 4000)
}
function parseRoute() {
  const parts = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/').filter(Boolean)
  if (parts[0] === 'unit' && data.value.units.some(x => x.id === parts[1])) {
    route.value = 'unit'
    selectedUnit.value = parts[1]
    tab.value = TABS.some(t => t.id === parts[2]) ? parts[2] : 'overview'
  } else {
    route.value = NAV.some(n => n.id === parts[0]) ? parts[0] : 'overview'
    selectedUnit.value = ''
    tab.value = 'overview'
  }
  search.value = ''; filterUnit.value = ''; filterPriority.value = ''
  mobileNav.value = false
}
function go(name) {
  const target = '#/' + name
  if (location.hash === target) parseRoute()
  else location.hash = target
  if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
}
const currentUnit = computed(() => data.value.units.find(x => x.id === selectedUnit.value) || null)
const view = computed(() => route.value === 'unit' ? tab.value : route.value)
const isAdmin = computed(() => me.value?.role === 'admin')
function canManageUnit(unitId) {
  return isAdmin.value || (me.value?.role === 'leader' && me.value?.unit_ids?.includes(unitId))
}
function canCreateTask(unitId) {
  return canManageUnit(unitId) || (me.value?.role === 'member' && me.value?.unit_ids?.includes(unitId))
}
function canCreate(kind) {
  if (kind === 'user' || kind === 'settings') return isAdmin.value
  if (kind === 'unit') return canManageUnit(selectedUnit.value)
  if (kind === 'tasks') return selectedUnit.value ? canCreateTask(selectedUnit.value) : isAdmin.value || data.value.units.some(u => canCreateTask(u.id))
  if (selectedUnit.value) return canManageUnit(selectedUnit.value)
  return isAdmin.value || (me.value?.role === 'leader' && me.value?.unit_ids?.length > 0)
}
function canEdit(kind, row) {
  if (!row) return false
  if (kind === 'user' || kind === 'settings') return isAdmin.value
  if (kind === 'unit') return canManageUnit(row.id)
  if (canManageUnit(row.unit_id)) return true
  return kind === 'tasks' && me.value?.role === 'member' && me.value?.unit_ids?.includes(row.unit_id) && row.owner_id === me.value?.id
}
function canDelete(kind, row) { return canManageUnit(row.unit_id) }
function unitName(id) { return data.value.units.find(x => x.id === id)?.short_name || '未归属' }
function userName(id, legacy = '') { return data.value.users.find(x => x.id === id)?.name || legacy || '未分配' }
function userUnits(person) { return (person.unit_ids || []).map(unitName).join('、') || '未分配兵种' }
function getRows(kind, unit = selectedUnit.value) { return (data.value[kind] || []).filter(row => !unit || row.unit_id === unit) }
function taskCount(unit) { const all = getRows('tasks', unit); return { all: all.length, done: all.filter(t => t.status === 'done').length, doing: all.filter(t => ['doing', 'review'].includes(t.status)).length, progress: pct(all.filter(t => t.status === 'done').length, all.length) } }
function risksOpen(unit = '') { return getRows('risks', unit).filter(x => x.status !== 'closed') }
function purchaseSum(unit = '', includePlanned = true) { return getRows('purchases', unit).filter(p => includePlanned || p.status !== 'planned').reduce((n, p) => n + p.quantity * p.unit_price, 0) }
const boardTasks = computed(() => getRows('tasks').filter(t => {
  const text = `${t.title} ${t.description} ${t.subsystem} ${userName(t.owner_id, t.owner_label)}`.toLowerCase()
  return (!search.value || text.includes(search.value.toLowerCase())) && (!filterUnit.value || t.unit_id === filterUnit.value) && (!filterPriority.value || t.priority === filterPriority.value)
}))
const totalTasks = computed(() => taskCount(''))
const activeTasks = computed(() => data.value.tasks.filter(x => x.status !== 'done').sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.priority] - ({ high: 0, medium: 1, low: 2 })[b.priority] || (a.due_date || '9999').localeCompare(b.due_date || '9999')))
const upcoming = computed(() => data.value.milestones.filter(x => !x.done).sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')).slice(0, 5))
const scopedPeople = computed(() => !selectedUnit.value ? data.value.users : data.value.users.filter(u => u.unit_ids.includes(selectedUnit.value)))
const canAddHere = computed(() => view.value === 'tasks' ? (selectedUnit.value ? canCreateTask(selectedUnit.value) : canCreate('tasks')) : canCreate(view.value))
const heading = computed(() => {
  if (route.value === 'unit') return `${currentUnit.value?.name || ''} / ${TABS.find(t => t.id === tab.value)?.title || ''}`
  return NAV.find(n => n.id === route.value)?.title || '战队总览'
})
const pageIntro = computed(() => {
  if (route.value === 'unit') return `${currentUnit.value?.short_name || ''} · ${TABS.find(t => t.id === tab.value)?.title}`
  return { overview: '战队研发总览', tasks: '全队任务看板', milestones: '赛季交付节点', risks: '全队问题与风险', purchases: '采购与预算', people: '成员与权限', activity: '操作审计记录', settings: '工作区设置' }[route.value]
})
const pageDetail = computed(() => ({ overview: '统一跟踪兵种状态、任务、关键节点、风险和预算。', tasks: '跨兵种任务协同，支持拖拽、负责人分配及版本冲突检测。', milestones: '集中管理研发验收、阶段节点和交付时间。', risks: '跟踪风险等级、处理进度和责任人。', purchases: '采购计划、订单状态、预估预算占用。', people: '战队成员、人员分工与访问权限。', activity: '追踪最近发生的业务记录变更。', settings: '赛季配置、数据导入导出及部署信息。' })[view.value] || currentUnit.value?.description || '')

async function fetchState(silent = false) {
  if (loading.value) return false
  loading.value = true
  try {
    const next = await request('state')
    data.value = next
    if (selectedUnit.value && !next.units.some(x => x.id === selectedUnit.value)) go('overview')
    return true
  } catch (error) { if (!silent) notify(error.message, true); return false }
  finally { loading.value = false }
}
async function initialize() {
  booting.value = true
  try {
    const session = await request('me')
    me.value = session.user
    if (!(await fetchState())) throw Error('无法读取 D1 工作区，请先执行数据库迁移并检查 Worker 绑定')
    parseRoute()
    accessError.value = ''
  } catch (error) { accessError.value = error.message }
  finally { booting.value = false }
}
function refresh() { fetchState().then(ok => { if (ok) notify('已从云端同步最新记录') }) }
function defaultUnit(kind) {
  if (selectedUnit.value && (kind === 'tasks' ? canCreateTask(selectedUnit.value) : canManageUnit(selectedUnit.value))) return selectedUnit.value
  return data.value.units.find(u => kind === 'tasks' ? canCreateTask(u.id) : canManageUnit(u.id))?.id || data.value.units[0]?.id || ''
}
function newForm(kind) {
  const u = defaultUnit(kind)
  if (kind === 'tasks') return { unit_id: u, title: '', description: '', subsystem: '', owner_id: me.value?.role === 'member' ? me.value.id : null, priority: 'medium', status: 'todo', due_date: '' }
  if (kind === 'milestones') return { unit_id: u, title: '', description: '', subsystem: '', due_date: '', done: false }
  if (kind === 'risks') return { unit_id: u, title: '', description: '', level: 'medium', status: 'open', owner_id: null }
  if (kind === 'purchases') return { unit_id: u, name: '', description: '', subsystem: '', quantity: 1, unit_price: 0, status: 'planned', owner_id: null }
  if (kind === 'user') return { email: '', name: '', role: 'member', unit_ids: [], disabled: false }
  if (kind === 'settings') return { ...data.value.settings }
  if (kind === 'unit') return { ...currentUnit.value }
  return {}
}
function openEditor(kind, row = null) {
  if (!row && !canCreate(kind)) { notify('当前账号无权创建记录', true); return }
  modalReadonly.value = !!row && !canEdit(kind, row)
  editingKind.value = kind
  editing.value = row || null
  editingId.value = row?.id || ''
  form.value = row ? clonePlain(row) : newForm(kind)
  conflict.value = null
}
function closeEditor() { editingKind.value = ''; editing.value = null; editingId.value = ''; conflict.value = null; modalReadonly.value = false; form.value = {} }
function selectableUsers(unitId) { return data.value.users.filter(u => !u.disabled && (u.role === 'admin' || u.unit_ids.includes(unitId))) }
async function submitForm() {
  if (!editingKind.value || modalReadonly.value) return
  const kind = editingKind.value
  const body = { ...form.value }
  delete body.updated_at; delete body.created_at; delete body.owner_label; delete body.created_by
  loading.value = true
  try {
    if (kind === 'unit') await patch(`units/${editingId.value}`, body)
    else if (kind === 'settings') await patch('settings', body)
    else if (kind === 'user') {
      if (editingId.value) await patch(`users/${editingId.value}`, body)
      else await post('users', body)
    } else if (editingId.value) await patch(`${kind}/${editingId.value}`, body)
    else await post(kind, body)
    closeEditor()
    loading.value = false
    await fetchState()
    notify('已保存并同步到云端')
  } catch (err) {
    if (err.status === 409 && err.code === 'VERSION_CONFLICT' && err.current) {
      conflict.value = { current: err.current, draft: clonePlain(form.value), kind }
      notify('检测到版本冲突；已保留你的草稿', true)
    } else notify(err.message, true)
  } finally { loading.value = false }
}
function loadConflict() {
  if (!conflict.value) return
  const latest = conflict.value.current
  form.value = clonePlain(latest)
  editing.value = latest
  conflict.value = null
  notify('已加载最新服务器记录。可重新编辑。')
}
function overwriteConflict() {
  if (!conflict.value) return
  form.value.version = conflict.value.current.version
  conflict.value = null
  notify('已选择服务器最新版本作为基准，请检查修改后点击保存')
}
function copyDraft() {
  if (conflict.value) navigator.clipboard?.writeText(JSON.stringify(conflict.value.draft, null, 2)).then(() => notify('已复制你的草稿')).catch(() => notify('无法复制，请手动选择文本', true))
}
async function deleteRow(kind, row) {
  if (!canDelete(kind, row)) { notify('没有删除权限', true); return }
  if (!window.confirm(`确认删除「${row.title || row.name}」？此操作无法撤销。`)) return
  try { await remove(`${kind}/${row.id}`, row.version); await fetchState(); notify('记录已删除') }
  catch (err) {
    if (err.code === 'VERSION_CONFLICT') { notify('删除失败：服务器版本已变化，请刷新后重试', true); await fetchState(true) }
    else notify(err.message, true)
  }
}
function dragStart(task, event) {
  if (!canEdit('tasks', task)) return event.preventDefault()
  dragging.value = task.id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', task.id)
}
async function updateTaskStatus(task, status) {
  if (!task || task.status === status) return
  if (!canEdit('tasks', task)) { notify('仅任务负责人或兵种管理员可更新此任务', true); return }
  try {
    await patch(`tasks/${task.id}`, { version: task.version, status })
    await fetchState(true)
    notify('任务状态已同步')
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT') {
      openEditor('tasks', task)
      form.value.status = status
      conflict.value = { current: err.current, draft: clonePlain(form.value), kind: 'tasks' }
    } else notify(err.message, true)
  }
}
function dropTask(status, event) {
  const id = event.dataTransfer.getData('text/plain') || dragging.value
  const task = data.value.tasks.find(x => x.id === id)
  dragging.value = ''
  updateTaskStatus(task, status)
}
function toggleUserUnit(unit) {
  const values = Array.isArray(form.value.unit_ids) ? form.value.unit_ids : []
  form.value.unit_ids = values.includes(unit) ? values.filter(u => u !== unit) : [...values, unit]
}
async function importFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !isAdmin.value) return
  if (file.size > 900_000) { notify('JSON 文件超过 900KB 限制', true); return }
  try {
    const raw = JSON.parse(await file.text())
    if (![1, 2].includes(Number(raw.version))) throw Error('需要原 V1/V2 版工作区 JSON（不是 V2.1 备份）')
    if (!confirm('旧版导入仅允许在空白云端工作区执行。导入后旧成员名称将保留为文本，账号需要重新邀请。确定继续吗？')) return
    importing.value = true
    const result = await post('import', raw)
    await fetchState()
    notify(`已迁入 ${result.imported} 条记录`)
  } catch (err) { notify(err.message, true) }
  finally { importing.value = false }
}
async function exportData() {
  if (!isAdmin.value) return
  try {
    const payload = await request('export')
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    const url = URL.createObjectURL(blob)
    a.href = url; a.download = `珞珈狐-云端备份-${new Date().toISOString().slice(0,10)}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    notify('已导出云端 JSON 快照')
  } catch (err) { notify(err.message, true) }
}
function timeHint(due) {
  const d = dateDistance(due)
  if (d === null) return '未设置截止'
  if (d < 0) return `逾期 ${-d} 天`
  if (d === 0) return '今天截止'
  if (d <= 3) return `${d} 天后截止`
  return dateLabel(due)
}
function taskDueClass(task) { return task.status !== 'done' && dateDistance(task.due_date) !== null && dateDistance(task.due_date) <= 3 ? 'warning' : '' }
function activityText(log) { return ({ create: '新建', update: '修改', delete: '删除', import: '导入' }[log.action] || log.action) + ' ' + (LABELS[log.entity_type] || log.entity_type) }
function activeGlobalLink(name) { return route.value === name }

onMounted(() => {
  window.addEventListener('hashchange', parseRoute)
  initialize()
  poller = setInterval(() => { if (!document.hidden && me.value) fetchState(true) }, 180_000)
})
onUnmounted(() => {
  window.removeEventListener('hashchange', parseRoute)
  clearInterval(poller)
  clearTimeout(toastTimer)
})
</script>

<template>
  <div v-if="booting" class="boot-screen">
    <div class="brand-big"><span class="fox-mark">狐</span><div><strong>珞珈狐</strong><span>RM COMMAND · V2.1</span></div></div>
    <div class="boot-loading"><RefreshCw :size="17" class="spin" /> 正在连接战队云端工作区…</div>
  </div>
  <div v-else-if="accessError" class="access-screen">
    <div class="access-panel">
      <span class="access-icon"><ShieldCheck :size="27" /></span>
      <div class="eyebrow">SECURE WORKSPACE · CLOUDFLARE ACCESS</div>
      <h1>需要战队成员身份</h1>
      <p>{{ accessError }}</p>
      <div class="hint-card">正式部署时请为此 Worker 启用 Cloudflare Access，将成员邮箱加入 Access 允许列表；首位管理员邮箱需要设置 <code>BOOTSTRAP_ADMIN_EMAIL</code> Secret。开发环境可配置 <code>.dev.vars</code>。</div>
      <button class="button primary" @click="initialize"><RefreshCw :size="16"/> 重试身份验证</button>
      <a class="doc-link" href="https://developers.cloudflare.com/workers/configuration/cloudflare-access/" target="_blank" rel="noopener noreferrer">Cloudflare Access 官方说明 <ExternalLink :size="14" /></a>
    </div>
  </div>
  <div v-else class="shell">
    <div v-if="mobileNav" class="mobile-scrim" @click="mobileNav=false"></div>
    <aside class="sidebar" :class="{show:mobileNav}">
      <div class="brand"><span class="brand-icon"><Target :size="26" :stroke-width="1.8" /></span><span><b>珞珈狐</b><small>LUOJIA FOX · RM</small></span><button class="mobile-close icon-button" @click="mobileNav=false"><X :size="19"/></button></div>
      <div class="workspace"><span class="tiny-caps">CURRENT WORKSPACE</span><strong>{{ data.settings?.team_name || '武汉大学 · 珞珈狐战队' }}</strong><small>{{ data.settings?.season || 'RM 2027' }} · 战队研发平台</small></div>
      <div class="sidebar-scroll">
        <div class="nav-heading"><span>战队管理</span><span>TEAM</span></div>
        <div class="navigation">
          <button v-for="item in NAV" :key="item.id" class="nav-button" :class="{active:activeGlobalLink(item.id)}" @click="go(item.id)">
            <component :is="ICONS[item.icon]" :size="17" :stroke-width="1.8" />
            <span>{{ item.title }}</span>
            <span v-if="item.id === 'tasks' && data.tasks.length" class="nav-count">{{ data.tasks.length }}</span>
            <span v-else-if="item.id === 'risks' && risksOpen().length" class="nav-count">{{ risksOpen().length }}</span>
          </button>
        </div>
        <div class="nav-heading section-two"><span>兵种指挥部</span><span>0{{ data.units.length }} UNITS</span></div>
        <div class="navigation">
          <button v-for="unit in data.units" :key="unit.id" class="nav-button unit-nav" :class="{active:route==='unit' && selectedUnit===unit.id}" @click="go(`unit/${unit.id}/overview`)">
            <span class="unit-code" :style="{'--uc': unit.color}">{{ unit.code }}</span><span>{{ unit.name }}</span><span class="nav-pct">{{ taskCount(unit.id).progress }}%</span>
          </button>
        </div>
      </div>
      <div class="sidebar-foot">
        <div class="cloud-box"><div><span class="live-dot"></span><b> CLOUD WORKSPACE · 云端同步</b></div><p>D1 持久化 · 乐观锁冲突保护 · Access 身份验证</p></div>
        <small>RM COMMAND / TEAM EDITION V2.1</small>
      </div>
    </aside>
    <div class="main-area">
      <header class="topbar">
        <div class="bar-left"><button class="icon-button menu-toggle" aria-label="打开导航" @click="mobileNav=true"><Menu :size="21"/></button><div><span class="tiny-caps">WORKSPACE / RM COMMAND</span><strong>{{ heading }}</strong></div></div>
        <div class="bar-right"><span class="top-date">{{ today }}</span><span class="bar-line"></span><button class="icon-button refresh-btn" aria-label="刷新数据" :disabled="loading" @click="refresh"><RefreshCw :size="17" :class="{spin:loading}"/></button><button v-if="canCreate('tasks')" class="button primary top-create" @click="openEditor('tasks')"><Plus :size="16"/> <span>创建任务</span></button><div class="profile" :title="`${me.name} · ${roleLabel(me.role)}`">{{ me.name.slice(0,1) }}</div></div>
      </header>
      <main class="content">
        <div class="page-head"><div><div class="eyebrow">LUOJIA FOX / TEAM OPERATIONS</div><h1>{{ pageIntro }}</h1><p>{{ pageDetail }}</p></div><div class="head-actions"><span class="online-tag"><span class="live-dot"></span> 服务器同步已开启</span></div></div>

        <template v-if="route === 'unit' && currentUnit">
          <div class="unit-banner" :style="{'--uc':currentUnit.color}">
            <div class="unit-banner-body"><div class="tiny-caps">SYSTEM {{ currentUnit.code }} / ROBOT DEVELOPMENT</div><h2>{{ currentUnit.name }} <span class="phase-pill">{{ currentUnit.stage }}</span></h2><p>{{ currentUnit.description || '尚未填写兵种简介。' }}</p><div class="banner-info"><span><Users :size="15"/> 负责人：{{ userName(currentUnit.lead_id) }}</span><span><Flag :size="15"/> {{ currentUnit.goal || '暂无赛季目标' }}</span></div></div>
            <div class="unit-banner-aside"><span class="huge-unit">{{ currentUnit.code }}</span><div class="banner-stats"><span><b>{{ taskCount(currentUnit.id).progress }}%</b><small>研发完成率</small></span><span><b>{{ taskCount(currentUnit.id).doing }}</b><small>正在推进</small></span><span><b>{{ risksOpen(currentUnit.id).length }}</b><small>风险待处理</small></span></div></div>
            <button v-if="canManageUnit(currentUnit.id)" class="unit-edit button subtle" @click="openEditor('unit',currentUnit)"><Settings :size="15"/> 编辑兵种</button>
          </div>
          <div class="tab-bar"><button v-for="t in TABS" :key="t.id" class="tab-button" :class="{active:tab===t.id}" @click="go(`unit/${selectedUnit}/${t.id}`)">{{ t.title }}</button></div>
        </template>

        <template v-if="view==='overview'">
          <div v-if="!selectedUnit" class="hero-panel">
            <div><div class="hero-eyebrow"><span class="live-dot"></span> {{ data.settings?.season }} · COMMAND CENTER</div><h2>珞珈狐战队 <em>研发指挥台</em></h2><p>8 大兵种工作区独立推进，全队任务与采购实时汇总。统一责任人、交付节点和风险跟踪，让每一次联调都有迹可循。</p><div class="hero-facts"><span><Layers3 :size="14"/> {{ data.units.length }} 个兵种单元</span><span><ClipboardList :size="14"/> {{ data.tasks.length }} 项研发任务</span><span><Users :size="14"/> {{ data.users.filter(u=>!u.disabled).length }} 位成员</span></div></div>
            <div class="circle-meter" :style="{'--progress':totalTasks.progress}"><div><small>MISSION PROGRESS</small><strong>{{ totalTasks.progress }}<i>%</i></strong><span>全队任务完成率</span></div></div>
          </div>
          <div class="stat-grid"><div class="stat-card"><div class="stat-top"><span>已完成 / 总任务</span><span class="stat-icon green"><CheckCircle2 :size="18"/></span></div><strong>{{ getRows('tasks').filter(x=>x.status==='done').length }}<small> / {{ getRows('tasks').length }}</small></strong><p>已交付研发任务</p></div><div class="stat-card"><div class="stat-top"><span>正在推进</span><span class="stat-icon blue"><Activity :size="18"/></span></div><strong>{{ getRows('tasks').filter(x=>['doing','review'].includes(x.status)).length }}</strong><p>进行中 + 待验证</p></div><div class="stat-card"><div class="stat-top"><span>未解决风险</span><span class="stat-icon red"><AlertTriangle :size="18"/></span></div><strong>{{ risksOpen().length }}</strong><p>需要优先排查的事项</p></div><div class="stat-card"><div class="stat-top"><span>采购计划占用</span><span class="stat-icon orange"><Wallet :size="18"/></span></div><strong class="currency-stat">{{ money(purchaseSum()) }}</strong><p>预算 {{ money(selectedUnit ? currentUnit?.budget : data.settings?.team_budget) }}</p></div></div>
          <template v-if="!selectedUnit">
            <div class="section-head"><div><div class="eyebrow">ROBOT LINEUP / 兵种矩阵</div><h2>八大兵种工作区</h2><p>选择对应兵种，进入独立任务、节点、风险、采购和成员管理页面。</p></div><small>8 UNITS · {{ data.settings?.season }}</small></div>
            <div class="unit-grid"><button v-for="unit in data.units" :key="unit.id" class="unit-card" :style="{'--uc':unit.color}" @click="go(`unit/${unit.id}/overview`)"><div class="unit-card-head"><div class="u-title"><span class="unit-card-code">{{ unit.code }} <Target :size="15"/></span><span><small>ROBOT WORKSPACE</small><b>{{ unit.name }}</b></span></div><ArrowUpRight :size="17"/></div><div class="unit-card-progress"><span>研发任务完成度</span><strong>{{ taskCount(unit.id).progress }}%</strong></div><div class="track"><span :style="{width:taskCount(unit.id).progress+'%', background:unit.color}"></span></div><div class="unit-card-bottom"><span>{{ taskCount(unit.id).done }} / {{ taskCount(unit.id).all }} 项交付</span><span>{{ taskCount(unit.id).doing }} 正在推进</span><span>{{ risksOpen(unit.id).length }} 项风险</span></div><div class="unit-card-last"><span>{{ unit.stage }}</span><span>预算 {{ money(unit.budget) }}</span></div></button></div>
          </template>
          <div class="two-grid overview-lower"><section class="panel"><div class="panel-title"><div><h3>{{ selectedUnit ? '当前重点工作' : '战队任务状态' }}</h3><p>按交付状态汇总任务进展</p></div><button class="link-button" @click="go(selectedUnit ? `unit/${selectedUnit}/tasks`:'tasks')">查看看板 <ArrowRight :size="14"/></button></div><div class="distribution"><span v-for="s in STATUS" :key="s.value" :style="{width:pct(getRows('tasks').filter(t=>t.status===s.value).length,getRows('tasks').length)+'%',background:s.color}"></span></div><div class="legend"><span v-for="s in STATUS" :key="s.value"><i :style="{background:s.color}"></i>{{ s.label }} <b>{{ getRows('tasks').filter(t=>t.status===s.value).length }}</b></span></div><div class="separator"></div><div class="panel-title"><div><h3>近期交付节点</h3><p>按预计交付时间排序</p></div><button class="link-button" @click="go(selectedUnit ? `unit/${selectedUnit}/milestones`:'milestones')">全部节点 <ArrowRight :size="14"/></button></div><div v-if="getRows('milestones').filter(x=>!x.done).length===0" class="empty-state"><Flag :size="28"/><b>暂无待交付节点</b><span>可在里程碑页面创建研发验收节点</span></div><button v-for="item in getRows('milestones').filter(x=>!x.done).slice().sort((a,b)=>(a.due_date||'9999').localeCompare(b.due_date||'9999')).slice(0,5)" :key="item.id" class="list-line" @click="openEditor('milestones',item)"><span class="date-square">{{ dateLabel(item.due_date) }}</span><span><b>{{ item.title }}</b><small>{{ unitName(item.unit_id) }} · {{ item.subsystem || '系统联调' }}</small></span><ChevronRight :size="16"/></button></section><div class="stack"><section class="panel"><div class="panel-title"><div><h3>本期重点任务</h3><p>优先级与截止时间排序</p></div><button class="link-button" @click="go(selectedUnit ? `unit/${selectedUnit}/tasks`:'tasks')">查看全部 <ArrowRight :size="14"/></button></div><div v-if="!activeTasks.filter(t=>!selectedUnit||t.unit_id===selectedUnit).length" class="empty-state"><ListTodo :size="25"/><b>暂无未完成任务</b></div><button v-for="task in activeTasks.filter(t=>!selectedUnit||t.unit_id===selectedUnit).slice(0,6)" :key="task.id" class="list-line" @click="openEditor('tasks',task)"><i class="priority-dot" :class="task.priority"></i><span><b>{{ task.title }}</b><small>{{ unitName(task.unit_id) }} · {{ userName(task.owner_id,task.owner_label) }}</small></span><small :class="taskDueClass(task)">{{ timeHint(task.due_date) }}</small></button></section><section class="panel"><div class="panel-title"><div><h3>风险关注</h3><p>优先处理尚未关闭的问题</p></div><button class="link-button" @click="go(selectedUnit ? `unit/${selectedUnit}/risks`:'risks')">风险台账 <ArrowRight :size="14"/></button></div><div v-if="!risksOpen(selectedUnit).length" class="empty-state"><ShieldCheck :size="26"/><b>暂无未关闭风险</b></div><button v-for="r in risksOpen(selectedUnit).slice(0,4)" :key="r.id" class="list-line" @click="openEditor('risks',r)"><AlertTriangle :size="16" class="risk-text"/><span><b>{{ r.title }}</b><small>{{ unitName(r.unit_id) }} · {{ RISK_LEVEL.find(x=>x.value===r.level)?.label }}</small></span><ChevronRight :size="15"/></button></section></div></div>
        </template>

        <template v-else-if="view==='tasks'">
          <div class="tool-row"><div class="filters"><label class="search-box"><Search :size="16"/><input v-model="search" placeholder="搜索任务、子系统或负责人" /></label><select v-if="!selectedUnit" v-model="filterUnit" class="select"><option value="">全部兵种</option><option v-for="unit in data.units" :key="unit.id" :value="unit.id">{{ unit.name }}</option></select><select v-model="filterPriority" class="select"><option value="">全部优先级</option><option v-for="p in PRIORITY" :key="p.value" :value="p.value">{{ p.label }}</option></select></div><button v-if="canAddHere" class="button primary" @click="openEditor('tasks')"><Plus :size="17"/> 新建任务</button></div>
          <div class="kanban"><section v-for="stage in STATUS" :key="stage.value" class="kanban-column" @dragover.prevent @drop.prevent="dropTask(stage.value,$event)"><div class="kanban-head"><i :style="{background:stage.color}"></i><b>{{ stage.label }}</b><span>{{ boardTasks.filter(t=>t.status===stage.value).length }}</span></div><div class="kanban-cards"><div v-if="!boardTasks.some(t=>t.status===stage.value)" class="empty-column">将任务拖到这里或创建新任务</div><article v-for="task in boardTasks.filter(t=>t.status===stage.value)" :key="task.id" class="task-ticket" :draggable="canEdit('tasks',task)" @dragstart="dragStart(task,$event)" @dragend="dragging=''" @click="openEditor('tasks',task)"><div class="ticket-top"><span class="priority-label" :class="task.priority">● {{ PRIORITY.find(x=>x.value===task.priority)?.label }}</span><GripVertical v-if="canEdit('tasks',task)" :size="15"/></div><h3>{{ task.title }}</h3><div class="ticket-tags"><span v-if="!selectedUnit" class="mini-unit">{{ unitName(task.unit_id) }}</span><span class="soft-tag">{{ task.subsystem || '未归类' }}</span></div><p v-if="task.description" class="ticket-desc">{{ task.description }}</p><div class="ticket-footer"><span class="small-owner"><i>{{ userName(task.owner_id,task.owner_label).slice(0,1) }}</i>{{ userName(task.owner_id,task.owner_label) }}</span><span class="due-text" :class="taskDueClass(task)">{{ timeHint(task.due_date) }}</span></div><select v-if="canEdit('tasks',task)" class="mobile-task-state" :value="task.status" @click.stop @change.stop="updateTaskStatus(task,$event.target.value)"><option v-for="status in STATUS" :key="status.value" :value="status.value">{{ status.label }}</option></select></article></div></section></div>
        </template>

        <template v-else-if="view==='milestones' || view==='risks' || view==='purchases'">
          <div class="tool-row"><div class="inline-note"><Database :size="16"/> 记录云端共享，编辑时会校验最新版本 <b>version</b></div><button v-if="canCreate(view)" class="button primary" @click="openEditor(view)"><Plus :size="16"/> {{ view==='milestones'?'添加里程碑':view==='risks'?'登记风险':'添加采购' }}</button></div>
          <section class="panel data-panel"><div class="table-wrap"><table class="data-table"><thead><tr v-if="view==='milestones'"><th>里程碑 / 交付目标</th><th>兵种</th><th>子系统</th><th>计划日期</th><th>状态</th><th>操作</th></tr><tr v-else-if="view==='risks'"><th>风险标题 / 应对措施</th><th>兵种</th><th>严重程度</th><th>状态</th><th>责任人</th><th>操作</th></tr><tr v-else><th>采购项目</th><th>兵种</th><th>数量</th><th>单价</th><th>计划金额</th><th>采购进度</th><th>操作</th></tr></thead><tbody>
            <tr v-for="item in getRows(view)" :key="item.id"><template v-if="view==='milestones'"><td><b>{{ item.title }}</b><small>{{ item.description || '暂无备注' }}</small></td><td><span class="mini-unit">{{ unitName(item.unit_id) }}</span></td><td>{{ item.subsystem || '—' }}</td><td>{{ dateLabel(item.due_date) }}</td><td><span class="state-pill" :class="item.done?'good':'neutral'">{{ item.done?'已完成':'待验收' }}</span></td></template><template v-else-if="view==='risks'"><td><b>{{ item.title }}</b><small>{{ item.description || '尚无处理措施' }}</small></td><td><span class="mini-unit">{{ unitName(item.unit_id) }}</span></td><td><span class="state-pill" :class="item.level==='critical'?'danger':item.level==='medium'?'amber':'neutral'">{{ RISK_LEVEL.find(x=>x.value===item.level)?.label }}</span></td><td>{{ RISK_STATUS.find(x=>x.value===item.status)?.label }}</td><td>{{ userName(item.owner_id,item.owner_label) }}</td></template><template v-else><td><b>{{ item.name }}</b><small>{{ item.subsystem || item.description || '—' }}</small></td><td><span class="mini-unit">{{ unitName(item.unit_id) }}</span></td><td>{{ item.quantity }}</td><td>{{ money(item.unit_price) }}</td><td class="number-em">{{ money(item.quantity*item.unit_price) }}</td><td><span class="state-pill" :class="item.status==='arrived'?'good':'neutral'">{{ PURCHASE_STATUS.find(x=>x.value===item.status)?.label }}</span></td></template><td><div class="row-actions"><button v-if="canEdit(view,item)" class="small-icon" title="编辑" @click="openEditor(view,item)"><Edit3 :size="15"/></button><button v-if="canDelete(view,item)" class="small-icon danger-icon" title="删除" @click="deleteRow(view,item)"><Trash2 :size="15"/></button><span v-if="!canEdit(view,item)">只读</span></div></td></tr>
          </tbody></table></div><div v-if="!getRows(view).length" class="empty-state"><FolderKanban :size="28"/><b>暂无记录</b><span>有权限的成员可以创建第一条记录</span></div></section>
          <div v-if="view==='purchases'" class="budget-summary"><div><span>采购计划总额</span><b>{{ money(purchaseSum(selectedUnit)) }}</b></div><div><span>已下单 / 已到货金额</span><b>{{ money(purchaseSum(selectedUnit,false)) }}</b></div><div><span>配置预算</span><b>{{ money(selectedUnit?currentUnit?.budget:data.settings?.team_budget) }}</b></div></div>
        </template>

        <template v-else-if="view==='people'">
          <div class="tool-row"><div class="inline-note"><ShieldCheck :size="16"/> 权限由 Worker API 校验，不依赖前端隐藏按钮</div><button v-if="isAdmin" class="button primary" @click="openEditor('user')"><Plus :size="16"/> 添加战队成员</button></div>
          <div class="members-grid"><div v-for="person in scopedPeople" :key="person.id" class="member-card"><div class="member-head"><span class="member-avatar">{{ person.name.slice(0,1) }}</span><div><strong>{{ person.name }}</strong><small>{{ roleLabel(person.role) }}</small></div><button v-if="isAdmin" class="small-icon" @click="openEditor('user',person)"><Edit3 :size="16"/></button></div><p>{{ person.email }}</p><div class="member-tags"><span v-for="id in person.unit_ids" :key="id" class="mini-unit">{{ unitName(id) }}</span><span v-if="!person.unit_ids.length" class="soft-tag">未分配兵种</span><span v-if="person.disabled" class="state-pill danger">已停用</span></div></div></div>
          <div v-if="!scopedPeople.length" class="empty-state panel"><Users :size="27"/><b>暂无所属成员</b><span>管理员可以创建成员，分配兵种与访问角色</span></div>
          <div v-if="!selectedUnit" class="panel info-panel"><h3>角色与权限说明</h3><p><b>战队管理员：</b>全站读写、成员授权与预算编辑；<b>兵种负责人：</b>所负责兵种的任务和研发记录管理；<b>普通成员：</b>为自己创建和编辑所属兵种任务；<b>只读成员：</b>查看全部内容但不能修改。Cloudflare Access 允许名单与本站用户名单需要分别配置。</p></div>
        </template>

        <template v-else-if="view==='activity'"><section class="panel"><div class="panel-title"><div><h3>最近 20 条操作记录</h3><p>记录修改行为和负责人，便于定位协作问题</p></div></div><div v-if="!data.activity.length" class="empty-state"><History :size="26"/><b>暂无操作记录</b></div><div v-for="log in data.activity" :key="log.id" class="audit-line"><span class="audit-icon"><History :size="17"/></span><div><strong>{{ activityText(log) }}</strong><small>{{ log.summary || log.entity_id }} · {{ userName(log.actor_id) }}</small></div><time>{{ log.created_at }}</time></div></section></template>

        <template v-else-if="view==='settings'"><div class="two-grid settings-grid"><section class="panel"><div class="panel-title"><div><h3>战队工作区配置</h3><p>组织信息、赛季与整体预算</p></div><button v-if="isAdmin" class="button subtle" @click="openEditor('settings',data.settings)"><Edit3 :size="15"/> 编辑</button></div><div class="setting-row"><span>战队名称</span><b>{{ data.settings?.team_name }}</b></div><div class="setting-row"><span>当前赛季</span><b>{{ data.settings?.season }}</b></div><div class="setting-row"><span>总预算</span><b>{{ money(data.settings?.team_budget) }}</b></div><div class="setting-row"><span>数据版本</span><b>Cloudflare D1 · V2.1</b></div></section><section class="panel"><div class="panel-title"><div><h3>备份与旧数据迁移</h3><p>旧版浏览器 JSON 可以迁入空白 D1</p></div></div><p class="setting-description">云端现在是所有成员共享的数据库，不能依赖原来的 localStorage。请定期导出备份。旧版 V1/V2 导入仅允许在空数据库执行，不会覆盖已有任务。</p><div class="settings-buttons"><button class="button subtle" :disabled="!isAdmin" @click="exportData"><ArrowDownToLine :size="16"/> 导出云端快照</button><button class="button subtle" :disabled="!isAdmin||importing" @click="fileInput?.click()"><UploadCloud :size="16"/> {{ importing ? '正在迁移…':'导入旧版 JSON' }}</button><input ref="fileInput" class="hidden-file" type="file" accept=".json,application/json" @change="importFile"/></div><div class="tip-text">建议每周备份，也可在终端使用 <code>wrangler d1 export</code> 导出 SQL。</div></section><section class="panel"><div class="panel-title"><div><h3>服务器与安全状态</h3><p>Cloudflare Workers / Access / D1</p></div></div><div class="server-status"><span class="status-check"><Check :size="16"/></span><div><b>Cloudflare Access</b><span>{{ me.email }} 已验证并授权</span></div></div><div class="server-status"><span class="status-check"><Check :size="16"/></span><div><b>D1 多人数据库</b><span>所有编辑经版本号验证后同步</span></div></div><div class="server-status"><span class="status-check"><Check :size="16"/></span><div><b>基于兵种的角色权限</b><span>{{ roleLabel(me.role) }} · {{ userUnits(me) }}</span></div></div></section><section class="panel"><div class="panel-title"><div><h3>开发与部署</h3><p>当前版本 V2.1.0 · 云端协同版</p></div></div><p class="setting-description">推荐先部署到 <code>luojiafox-v21.workers.dev</code> 测试环境。通过后再将 Wrangler 的 Worker 名称改回 <code>luojiafox</code>，并确认两个环境使用的数据库及 Access 策略。</p><a class="link-button external" href="https://developers.cloudflare.com/d1/" target="_blank" rel="noopener noreferrer">Cloudflare D1 文档 <ExternalLink :size="15"/></a></section></div></template>
      </main>
    </div>

    <div v-if="editingKind" class="dialog-backdrop" @click.self="closeEditor">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="`编辑${LABELS[editingKind]||''}`"><div class="dialog-heading"><div><div class="eyebrow">RM COMMAND / EDITOR</div><h2>{{ modalReadonly ? '查看' : editingId ? '编辑' : '新建' }}{{ LABELS[editingKind] }}</h2><small v-if="editingId">版本 v{{ form.version }} · 保存时进行乐观锁校验</small></div><button class="icon-button" aria-label="关闭编辑" @click="closeEditor"><X :size="21"/></button></div>
        <div v-if="conflict" class="conflict-box"><div class="conflict-title"><AlertTriangle :size="19"/> 数据版本冲突（HTTP 409）</div><p>其他队员已经修改了这条记录，服务器当前版本为 <b>v{{ conflict.current.version }}</b>，你的草稿版本为 <b>v{{ conflict.draft.version }}</b>。不会自动覆盖任何一方数据。</p><div class="conflict-compare"><div><strong>服务器当前数据</strong><pre>{{ JSON.stringify(conflict.current,null,2) }}</pre></div><div><strong>你的编辑草稿</strong><pre>{{ JSON.stringify(conflict.draft,null,2) }}</pre></div></div><div class="conflict-actions"><button class="button subtle" @click="copyDraft"><FileJson :size="14"/> 复制草稿</button><button class="button subtle" @click="loadConflict"><RefreshCw :size="14"/> 加载服务器版本</button><button class="button danger-button" @click="overwriteConflict">保留草稿并重新校验</button></div></div>
        <form class="editor-form" @submit.prevent="submitForm">
          <fieldset class="editor-fieldset" :disabled="modalReadonly">
          <template v-if="['tasks','milestones','risks','purchases'].includes(editingKind)"><label class="field">所属兵种 <select v-model="form.unit_id" :disabled="me.role==='member'"><option v-for="unit in data.units.filter(u=>canManageUnit(u.id) || (editingKind==='tasks' && canCreateTask(u.id)) || (editingId && u.id===form.unit_id))" :key="unit.id" :value="unit.id">{{ unit.name }}</option></select></label></template>
          <template v-if="editingKind==='tasks'"><label class="field">任务标题 <input v-model="form.title" required maxlength="160" placeholder="例如：完成哨兵自瞄闭环验证" /></label><div class="field-grid"><label class="field">子系统 <input v-model="form.subsystem" maxlength="70" placeholder="视觉 / 电控 / 机械" /></label><label class="field">负责人 <select v-model="form.owner_id" :disabled="me.role==='member'"><option :value="null">未指派</option><option v-for="u in selectableUsers(form.unit_id)" :key="u.id" :value="u.id">{{ u.name }}</option></select></label></div><div class="field-grid"><label class="field">优先级 <select v-model="form.priority"><option v-for="x in PRIORITY" :key="x.value" :value="x.value">{{ x.label }}</option></select></label><label class="field">任务状态 <select v-model="form.status"><option v-for="x in STATUS" :key="x.value" :value="x.value">{{ x.label }}</option></select></label></div><label class="field">截止日期 <input type="date" v-model="form.due_date"/></label><label class="field">任务说明 <textarea v-model="form.description" rows="4" maxlength="4000" placeholder="任务验收标准、所需资源、联调记录等"></textarea></label></template>
          <template v-if="editingKind==='milestones'"><label class="field">节点名称 <input v-model="form.title" required maxlength="160" /></label><label class="field">子系统 <input v-model="form.subsystem" maxlength="70" /></label><label class="field">计划交付时间 <input v-model="form.due_date" type="date" /></label><label class="field check-field"><input type="checkbox" v-model="form.done"/> 已完成验收</label><label class="field">验收标准和备注 <textarea v-model="form.description" rows="4" maxlength="4000"></textarea></label></template>
          <template v-if="editingKind==='risks'"><label class="field">问题标题 <input v-model="form.title" required maxlength="160" /></label><div class="field-grid"><label class="field">风险等级 <select v-model="form.level"><option v-for="p in RISK_LEVEL" :key="p.value" :value="p.value">{{ p.label }}</option></select></label><label class="field">处理状态 <select v-model="form.status"><option v-for="p in RISK_STATUS" :key="p.value" :value="p.value">{{ p.label }}</option></select></label></div><label class="field">处理负责人 <select v-model="form.owner_id"><option :value="null">未分配</option><option v-for="u in selectableUsers(form.unit_id)" :key="u.id" :value="u.id">{{ u.name }}</option></select></label><label class="field">问题描述与解决方案 <textarea v-model="form.description" maxlength="4000" rows="4"/></label></template>
          <template v-if="editingKind==='purchases'"><label class="field">物料名称 <input v-model="form.name" required maxlength="160" /></label><label class="field">子系统 <input v-model="form.subsystem" maxlength="70" /></label><div class="field-grid"><label class="field">数量 <input type="number" min="0" max="100000" step="0.01" v-model.number="form.quantity" /></label><label class="field">预估单价（元） <input type="number" min="0" max="100000000" step="0.01" v-model.number="form.unit_price" /></label></div><div class="field-grid"><label class="field">采购状态 <select v-model="form.status"><option v-for="p in PURCHASE_STATUS" :key="p.value" :value="p.value">{{ p.label }}</option></select></label><label class="field">负责人 <select v-model="form.owner_id"><option :value="null">未分配</option><option v-for="u in selectableUsers(form.unit_id)" :key="u.id" :value="u.id">{{ u.name }}</option></select></label></div><label class="field">采购用途与备注 <textarea v-model="form.description" maxlength="4000" rows="3"/></label><div class="purchase-preview">计划占用金额 <strong>{{ money(form.quantity*form.unit_price) }}</strong></div></template>
          <template v-if="editingKind==='unit'"><div class="unit-form-code">{{ form.name }} · {{ form.code }}</div><label class="field">当前研发阶段 <input v-model="form.stage" maxlength="80"/></label><label class="field">兵种负责人 <select v-model="form.lead_id"><option :value="null">未分配</option><option v-for="u in selectableUsers(form.id)" :key="u.id" :value="u.id">{{ u.name }}</option></select></label><label class="field">研发预算（元） <input type="number" min="0" step="0.01" v-model.number="form.budget" /></label><label class="field">赛季目标 <textarea v-model="form.goal" rows="2" maxlength="600"/></label><label class="field">兵种简介 <textarea v-model="form.description" rows="3" maxlength="1600"/></label></template>
          <template v-if="editingKind==='settings'"><label class="field">战队名称 <input v-model="form.team_name" maxlength="100" required/></label><label class="field">赛季名称 <input v-model="form.season" maxlength="60" required/></label><label class="field">全队预算（元） <input type="number" min="0" step="0.01" v-model.number="form.team_budget"/></label></template>
          <template v-if="editingKind==='user'"><label class="field">邮箱地址 <input v-model="form.email" :disabled="!!editingId" type="email" required maxlength="254" placeholder="name@example.com"/></label><label class="field">成员姓名 <input v-model="form.name" required maxlength="100"/></label><label class="field">战队角色 <select v-model="form.role"><option v-for="r in ROLES" :key="r.value" :value="r.value">{{ r.label }}</option></select></label><div class="field"><span>所属兵种</span><div class="unit-checkboxes"><label v-for="u in data.units" :key="u.id" class="check-unit"><input type="checkbox" :checked="form.unit_ids?.includes(u.id)" @change="toggleUserUnit(u.id)"/> {{ u.short_name }}</label></div></div><label v-if="editingId" class="field check-field"><input v-model="form.disabled" type="checkbox"/> 停用此账号（保留历史任务）</label><div class="tip-text">请同时将此邮箱加入 Cloudflare Access 允许名单，否则成员仍无法登录。</div></template>
          </fieldset>
          <div class="dialog-foot"><button type="button" class="button subtle" @click="closeEditor">{{ modalReadonly ? '关闭' : '取消' }}</button><button v-if="!modalReadonly" class="button primary" type="submit" :disabled="loading||!!conflict"><Save :size="16"/> {{ loading?'保存中…':'保存到云端' }}</button></div>
        </form>
      </div>
    </div>
    <div v-if="message" class="toast" :class="{bad:messageBad}">{{ message }}</div>
  </div>
</template>
