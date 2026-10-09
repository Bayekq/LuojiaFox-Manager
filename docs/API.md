# V2.1 API / 乐观锁约定

所有请求默认同源 HTTPS，`/api/*` 由同一 Cloudflare Worker 处理。访问受 Cloudflare Access 保护，用户必须在 D1 `users` 表中被授权。除 `/api/health` 以外所有接口都必须验证 Cloudflare Access 签发的 JWT：从 `Cf-Access-Jwt-Assertion` 标头读取，匹配 `ACCESS_TEAM_DOMAIN` 的公钥及 `ACCESS_AUD`，验证 RS256 签名、发行者、受众与到期时间，再映射到 D1 邮箱白名单。**Static Assets 路由不提供 `ctx.access`，不可依赖它获取身份。**

## 路由

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 服务版本（无用户数据） |
| GET | `/api/me` | 注册队员 | Access 身份映射 D1 用户；首位管理员按 Secret 引导 |
| GET | `/api/state` | 注册队员 | 7 个兵种、任务、节点、风险、采购、成员、最近审计等 |
| POST | `/api/tasks` | 管理员 / 所属兵种负责人 / 所属兵种成员 | 创建任务，普通成员只能将负责人设为自己 |
| PATCH | `/api/tasks/:id` | 管理员 / 对应负责人 / 任务本人 | 修改任务，必须传 `version` |
| DELETE | `/api/tasks/:id` | 管理员 / 对应负责人 | 删除任务，必须传 `version` |
| POST/PATCH/DELETE | `/api/milestones` / `/:id` | 管理员 / 对应负责人 | 里程碑管理 |
| POST/PATCH/DELETE | `/api/risks` / `/:id` | 管理员 / 对应负责人 | 风险管理 |
| POST/PATCH/DELETE | `/api/purchases` / `/:id` | 管理员 / 对应负责人 | 采购管理 |
| PATCH | `/api/units/:id` | 管理员 / 对应负责人 | 兵种预算和目标 |
| POST | `/api/users` | 管理员 | 添加邮箱、角色、兵种 |
| PATCH | `/api/users/:id` | 管理员 | 成员姓名、角色、兵种、停用 |
| PATCH | `/api/settings` | 管理员 | 战队名、赛季、总预算 |
| POST | `/api/import` | 管理员 | 迁入旧 V1/V2 JSON，仅允许空白业务表 |
| GET | `/api/export` | 管理员 | 导出云端 JSON 快照，不含登录令牌 |

## 乐观锁（重点）

所有可修改业务表含 `version INTEGER NOT NULL DEFAULT 1`，例如：

```http
PATCH /api/tasks/73ee71d8-a3d5-46a9-a21a-2a9f17e97cbf
Content-Type: application/json

{"status":"doing", "version":5}
```

更新 SQL：

```sql
UPDATE tasks
SET status='doing', version=version+1, updated_at=?
WHERE id=? AND version=5;
```

如果两个用户都读取了版本 5：

- A 先修改成功，数据库版本变为 6。
- B 仍携带 5，`meta.changes===0`，接口返回 409，携带数据库最新记录。

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "记录已被他人修改，请比较最新版本再保存",
    "current": { "id": "...", "status": "doing", "version": 6 }
  }
}
```

**不可**先 `SELECT` 版本号，再进行不带版本条件的 `UPDATE`；那样会产生竞态。数据库条件更新是本项目正确性的关键。

前端处理：保留 B 的草稿，展示服务器最新数据及本地草稿，用户可加载最新服务器记录、复制草稿，或在看过差异后主动将草稿基准版本更新到最新再提交。不会自动无限重试，也不会无提示覆盖。

删除同样通过 `DELETE ... WHERE id=? AND version=?` 校验版本，避免删除他人刚修改的记录。

## 数据表关系

```text
users (Access email -> role, unit_ids, version)
units (7 ids, lead_id -> users.id, budget, version)
tasks (unit_id -> units.id, owner_id -> users.id, version)
milestones (unit_id -> units.id, version)
risks (unit_id -> units.id, owner_id -> users.id, version)
purchases (unit_id -> units.id, owner_id -> users.id, quantity, unit_price, version)
settings (id=1, version)
audit_logs (actor_id, action, entity_type, entity_id)
```

当前“预算占用”定义为 `quantity × unit_price` 之和；不是会计实付款。旧版任务的 `owner_label` 记录迁移前负责人文本，分配真实账号后以 `owner_id` 为准。

## 测试

后端测试使用 Node.js 内置 SQLite 实现轻量 D1 适配器，覆盖授权、初始管理员、CRUD、版本冲突、越权、数据迁移。云端 Worker+Access 的真实运行环境仍需部署回归。运行：

```bash
node --test tests/api.test.js
```
