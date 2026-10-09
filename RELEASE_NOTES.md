# RM Command V2.1 · 交付说明

## 已实现

- Vue 3 + Vite 全战队管理前端；8 兵种独立页面与全队汇总。
- Cloudflare Worker API + D1：任务、研发节点、风险、采购、成员、兵种、设置、审计。
- Cloudflare Access 邮箱登录：服务端验证 RSA JWT（签名、issuer、aud、有效期），再检查 D1 角色白名单。
- 按战队管理员、兵种负责人、普通成员、只读成员划分操作权限。
- 更新/删除使用数据库 version 条件 SQL，冲突以 HTTP 409 返回最新服务器记录，前端保留修改草稿。
- 支持旧本地 V1/V2 JSON 导入空白数据库，支持云端 JSON 与 SQL 备份；批量导入≤240 条。
- 移动端适配、任务看板拖拽/状态切换、手动及定期云端同步。

## 已完成的自动化校验

- Node 22 内置 SQLite 模拟 D1：11 项 Worker API 集成测试通过。
- 含 RSA 签名 JWT 校验、角色权限、并发 409、旧版 JSON 批量迁移、输入校验。
- Worker 与 Vue 脚本的 JS 语法校验通过。
- Vue 模板经过结构性 HTML 解析，CSS 未发现语法级解析错误。

## 尚需在可安装 npm 的开发环境验证

- `npm install && npm run build`：真实 Vue 3 SFC 编译。
- Wrangler 远端 D1 迁移、静态资源部署与 Cloudflare Access JWT 端到端验证。
- 两个实际账号、两个浏览器、移动端与生产并发使用测试。

**当前没有自动操作或覆盖现有 luojiafox Worker；请先使用 luojiafox-v21 测试地址。**
