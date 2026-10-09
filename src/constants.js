export const NAV = [
  { id: 'overview', title: '战队总览', icon: 'LayoutDashboard' },
  { id: 'tasks', title: '全队任务', icon: 'Columns3' },
  { id: 'milestones', title: '赛季里程碑', icon: 'CalendarDays' },
  { id: 'risks', title: '问题风险', icon: 'AlertTriangle' },
  { id: 'purchases', title: '采购与预算', icon: 'Wallet' },
  { id: 'people', title: '战队成员', icon: 'Users' },
  { id: 'activity', title: '操作记录', icon: 'History' },
  { id: 'settings', title: '工作区设置', icon: 'Settings' }
]
export const TABS = [
  { id: 'overview', title: '综合概览' },
  { id: 'tasks', title: '任务看板' },
  { id: 'milestones', title: '研发节点' },
  { id: 'risks', title: '问题风险' },
  { id: 'purchases', title: '采购物资' },
  { id: 'people', title: '人员分工' }
]
export const STATUS = [
  { value: 'todo', label: '待开始', color: '#90a3b9' },
  { value: 'doing', label: '进行中', color: '#67afff' },
  { value: 'review', label: '待验证', color: '#f4c079' },
  { value: 'done', label: '已完成', color: '#65dab0' }
]
export const PRIORITY = [
  { value: 'high', label: '高优先级' },
  { value: 'medium', label: '中优先级' },
  { value: 'low', label: '低优先级' }
]
export const RISK_LEVEL = [
  { value: 'critical', label: '高风险' },
  { value: 'medium', label: '中风险' },
  { value: 'low', label: '低风险' }
]
export const RISK_STATUS = [
  { value: 'open', label: '待解决' },
  { value: 'watch', label: '跟进中' },
  { value: 'closed', label: '已关闭' }
]
export const PURCHASE_STATUS = [
  { value: 'planned', label: '待采购' },
  { value: 'ordered', label: '已下单' },
  { value: 'arrived', label: '已到货' }
]
export const ROLES = [
  { value: 'admin', label: '战队管理员' },
  { value: 'leader', label: '兵种负责人' },
  { value: 'member', label: '普通成员' },
  { value: 'viewer', label: '只读成员' }
]
export const LABELS = { tasks: '任务', milestones: '里程碑', risks: '风险', purchases: '采购', unit: '兵种资料', user: '成员', settings: '工作区' }
export const money = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
export const dateLabel = s => !s ? '未设置' : String(s).slice(5).replace('-', ' / ')
export const pct = (a, b) => b ? Math.round(100 * a / b) : 0
export const roleLabel = role => ROLES.find(x => x.value === role)?.label || role
export const statusLabel = key => STATUS.find(x => x.value === key)?.label || key
export const dateDistance = s => {
  if (!s) return null
  const d = new Date(`${s}T12:00:00`)
  const today = new Date(); today.setHours(12, 0, 0, 0)
  return Math.round((d - today) / 86_400_000)
}
