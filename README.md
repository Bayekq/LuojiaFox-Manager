# RM Command V2.1 · 珞珈狐战队管理平台

将原 V2.0 浏览器本地项目管理页改为 **Vue 3 + Vite + Cloudflare Workers + D1 + Cloudflare Access** 的全队在线协作工程。

- **战队首页**：七兵种研发矩阵、任务完成度、采购预算、交付节点与风险汇总。
- **兵种工作区**：重装、步兵 3、步兵 4、空中、哨兵、飞镖、雷达，各自拥有综合概览 / 任务看板 / 研发节点 / 风险 / 采购 / 人员分工。
- **云端存储**：所有成员操作共享 D1 数据，而非各自浏览器的 localStorage。
- **账户**：Cloudflare Access 邮箱登录，Worker 使用 Access 公钥验签 JWT（支持 Static Assets 路由），D1 白名单成员管理；战队管理员、兵种负责人、成员、只读角色。
- **乐观锁**：任务、里程碑、风险、采购、兵种资料、成员、工作区设置全部带 `version`，更新和删除时进行 SQL 原子校验；冲突返回 HTTP 409 及服务器最新记录。
- **协作体验**：任务拖拽，成员分配，自动按 3 分钟刷新（仅前台标签页）与手动刷新；编辑冲突保留草稿和显式再次保存。
- **审计**：记录最近 20 条新增、更新、删除；审计日志为尽力写入，非金融级审计保障。
- **旧版数据**：支持导入旧 RM Command V1/V2 的 JSON（需要空白数据库，旧负责人文本会保留）。

**注意**：这是一个需要 `npm install && npm run build` 才能发布的源代码工程，不是将 ZIP 直接上传到 Cloudflare Pages 即可使用的静态包。尚未与你的 Cloudflare 账号关联，也未直接替换 https://luojiafox.206858817.workers.dev/ 。

## 快速开始

要求：Node.js 20.19+ 或 Node.js 22+，npm，Cloudflare 账号。推荐 Node.js 22 LTS。

```bash
npm install
npx wrangler login
npx wrangler d1 create rm-command-db
```

将创建 D1 后返回的 `database_id` UUID 写入 `wrangler.jsonc`，覆盖示例占位 ID，然后运行：

```bash
npm run db:migrate:local
cp .dev.vars.example .dev.vars
npm run build
```

接着在两个终端运行：

```bash
npm run dev:api
```

```bash
npm run dev:web
```

浏览器打开 `http://127.0.0.1:5173`。本地 `.dev.vars` 使用模拟登录，仅用于本机开发。Windows PowerShell 中将 `cp` 改成 `Copy-Item` 即可。

**正式部署与 Access 账户设置请按 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 操作。**

## 目录

```text
src/App.vue               Vue3 主界面与全部兵种工作区
src/api.js                API 请求与错误处理
src/constants.js          兵种视图/任务状态枚举与工具函数
src/style.css             深色研发指挥台响应式样式
worker/index.js           Worker API、服务端 RBAC、乐观锁
worker/access-jwt.js      Cloudflare Access JWT 公钥验签（Static Assets 必需）
migrations/0001_initial.sql   D1 SQLite 原始建库
migrations/0002_heavy_units.sql  合并英雄、工程为重装，保留业务记录与成员归属
wrangler.jsonc            资源绑定、Worker 静态资源部署配置
public/_headers           静态资源安全响应头
.dev.vars.example         本地身份模拟与管理员 bootstrap 示例
tests/api.test.js         Node.js SQLite 模拟 D1 的后端接口集成测试
docs/DEPLOYMENT.md        正式部署教程、迁移、回滚
docs/API.md               API 与 SQL 乐观锁约定
docs/SECURITY.md          权限模型、威胁与上线检查
```

## 测试

```bash
npm run check
```

`npm run check` 检查 Worker 和 API JavaScript 语法并执行后端接口集成测试。

本工程提供基于 Node.js SQLite 的 Worker 逻辑集成测试；**Cloudflare 真实部署、真实 Access 策略以及 Vue 生产构建，需要在安装 npm 依赖后进一步验证**。Access 正式使用必须设置 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 和 `BOOTSTRAP_ADMIN_EMAIL` 三项 Secret，完整步骤见部署指南。

## 范围边界

本版不包含 R2 图纸/PDF 文件上传、GitHub Webhook、实时 WebSocket/在线用户存在检测，也没有试图为战队自动创建真实任务或人员。以上功能适合 V2.2。

空白数据库的任务和预算默认为 0。请不要把演示版 V2.0 自带的数据当作战队真实研发进度。

## 本次更新

英雄与工程合并为重装机器人。已有数据库需先执行 `npm run db:migrate:local`（线上使用 `npm run db:migrate:remote`），再构建部署。迁移合计两个工作区预算，保留研发说明和目标，转移全部任务、节点、风险、采购和成员归属；重装主要负责人优先沿用原英雄负责人，另一负责人保留重装成员归属，可在网页调整。

管理员可在“战队成员”或兵种“人员分工”中点击“添加管理员”或“添加成员”，填写姓名、邮箱并选择角色、所属兵种。新增账号仍使用 Cloudflare Access 邮箱登录，请将邮箱加入 Access 允许名单。
