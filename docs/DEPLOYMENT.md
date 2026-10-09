# RM Command V2.1 部署指南（Cloudflare 免费优先）

目标：先部署为独立测试地址，完成功能和角色测试，再选择是否替换 `https://luojiafox.206858817.workers.dev/`。

## 0. 重要约定

1. 此工程是 **Workers Static Assets + Workers API + D1** 的单 Worker 架构，**不是**纯静态 Pages 项目，不可只拖 ZIP 进 Pages 后期待数据库能用。
2. **身份登录由 Cloudflare Access 负责**。首次访问先经过 Access 邮箱验证。由于 Workers Static Assets 内部路由不会转发 `ctx.access`，Worker 必须读取并**验证签名** `Cf-Access-Jwt-Assertion`，确保 `issuer`、`audience` 和有效期正确，再与 D1 用户表做权限映射。未经正确配置的 Access 应用及 JWT 验证，不会授予线上 API 权限。
3. **角色和兵种权限** 存在 D1 中。加入 Access 允许名单 ≠ 获得管理权限；只有管理员在网页“成员”页创建并分配角色后才可操作。
4. 站点默认为 `luojiafox-v21` 测试 Worker，故不会覆盖原 `luojiafox` 页面。
5. `database_id` 是占位 UUID，必须替换为自己账号下真实的 D1 Database ID。

## 1. 本机准备

安装 Node.js 22 LTS，解压工程，在工程目录执行（Windows Terminal / PowerShell 或 Linux 终端）：

```bash
node -v
npm -v
npm install
npx wrangler login
```

浏览器会弹出 Cloudflare 授权页。确认登录的是负责当前 Worker 的 Cloudflare 账号。

## 2. 创建数据库

```bash
npx wrangler d1 create rm-command-db
```

返回类似：

```json
{"binding":"DB","database_name":"rm-command-db","database_id":"YOUR-REAL-UUID"}
```

打开 `wrangler.jsonc`，将数据库配置中的：

```json
"database_id": "00000000-0000-4000-8000-000000000001"
```

替换为 Cloudflare 返回的真实 UUID，保持 `binding` 为 `DB`、`database_name` 为 `rm-command-db`。

此操作只创建数据库，**还没有初始化数据表**。

## 3. 初始化本地数据库并开发验证

```bash
npm run db:migrate:local
```

创建 `.dev.vars`（仅本机，已加入 `.gitignore`）。Windows PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

将 `DEV_AUTH_EMAIL` 和 `BOOTSTRAP_ADMIN_EMAIL` 改成相同的个人邮箱。这个模拟身份**只在请求主机为 127.0.0.1 或 localhost 时有效**。

先构建一次（Wrangler 的静态资源目录需要存在）：

```bash
npm run build
```

打开两个终端分别运行：

```bash
npm run dev:api
```

```bash
npm run dev:web
```

打开 `http://127.0.0.1:5173`。本地接口模拟登录成功后会创建首位管理员，界面内可以新增任务、兵种采购与成员。

> Cloudflare 2026 年的 Wrangler 也支持在 `wrangler.jsonc` 的 `access.dev` 中指定本地模拟 identity。这里为避免把测试身份意外同步到生产配置，采用 `.dev.vars` + localhost 双条件方案。**不要**把 `DEV_AUTH_EMAIL` 上传为线上 Secret。

## 4. 初始化远程数据库

确认本地可用后：

```bash
npm run db:migrate:remote
```

这是直接操作生产 D1，会执行 `migrations/0001_initial.sql` 创建业务表，并通过 `0002_heavy_units.sql` 合并英雄、工程为重装，最终包含 7 个兵种。新库中不会自动填入示例任务、预算或虚构队员。

可以检查：

```bash
npx wrangler d1 execute rm-command-db --remote --command "SELECT id,name,version FROM units ORDER BY code;"
```

应返回 7 个兵种。

## 5. 部署到测试 Worker

```bash
npm run deploy
```

当前 `wrangler.jsonc` 的 Worker 名称为 `luojiafox-v21`。若账号 Workers 子域名仍是 `206858817`，测试地址通常为：

`https://luojiafox-v21.206858817.workers.dev/`

这个地址会部署编译后的 Vue 页面和同一个 Worker 的 `/api/*` 后端。此时 API 暂时返回 503 `ACCESS_CONFIG` 或身份认证错误是**预期的安全结果**：需先完成 Access 策略及 JWT 配置，不能为了绕过验证删除鉴权代码。

## 6. Cloudflare Access 登录配置（必做）

按 Cloudflare 官方当前 [Workers Access 文档](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)：

1. 打开 Cloudflare Dashboard → Workers & Pages → 选中 `luojiafox-v21`。
2. 进入 **Access** → **Protect this Worker behind Access**（或对应的“启用 Access”选项）。
3. 选择保护 **Production and preview / All traffic**，而不仅是 Preview。
4. 在 Zero Trust / Access 策略中使用 **Include → Emails**，先只允许管理员本人邮箱；确认 Access 的身份提供商（例如 Email OTP）已配置并可正常验证。
5. 保存策略，使用新的浏览器无痕窗口访问测试域名，确认先出现 Access 登录页。

不要把 *任何邮箱* 或公共邮箱域名作为战队管理站的宽泛允许策略。只允许实际队员。

## 7. 配置 Access JWT 验证与唯一首位管理员

**必须先完成上一步 Access 应用保护，再获取该应用的 AUD**。前往 Zero Trust → Access controls → Applications → 对应 Worker Access 应用 → Additional settings，复制 **Application Audience (AUD) Tag**；在 Zero Trust 中找到团队域名，格式为 `https://你的团队名.cloudflareaccess.com`。

在工程目录执行三次 Secret 设置：

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
# 输入：https://你的团队名.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD
# 输入：对应 Access 应用的 Audience (AUD) Tag
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
# 输入：你通过 Access 登录的管理员邮箱（小写）
```

这些值只保存在 Cloudflare Worker Secret 中，不应提交公开代码仓库。**即使已经开启 Access，也必须配置 TEAM_DOMAIN 和 AUD，否则 API 会拒绝认证。** JWT 在服务端用 Web Crypto 校验 RS256 签名、签发域名、应用受众及有效期。Access 公钥缓存 10 分钟，减小请求开销。

注意：如果界面提示 `503 ACCESS_CONFIG`，检查前两项 Secret；若返回 `401 INVALID_ACCESS_TOKEN`，检查 Audience Tag 是否与当前 Worker 被保护的 Access 应用一致。

首次使用这个邮箱通过 Access 登录并调用 `/api/me` 时：

- 若 `users` 表为空，Worker 使用 `INSERT ... WHERE NOT EXISTS(...)` 只创建**第一个管理员**。
- 若 `users` 表已有用户，不会因为修改 Secret 再自动创建管理员。
- 其他邮箱即使通过 Access，若未被加入 D1 用户表，也返回 403。

请检查左下角“CLOUD WORKSPACE · 云端同步”，并进入“成员”页确认管理员角色。

## 8. 邀请成员和分配权限

1. 在 Cloudflare Access 策略增加成员邮箱；只有通过 Access 验证的成员才能访问 Worker。
2. 用管理员账户打开战队网站 → 战队成员 → 添加管理员 / 添加成员。
3. 填写邮箱（要与 Access 用户邮箱一致）、姓名、`admin / leader / member / viewer`，勾选所属兵种。
4. 新成员使用相同邮箱登录，即可看到战队数据，并按角色获得对应写权限。

普通成员只能编辑**自己负责**的、自己所属兵种的任务；负责人可以编辑自己管理兵种的任务、采购与风险；管理员拥有全站管理权限。

## 9. 旧 V2.0 本地 JSON 迁移

旧站 `https://luojiafox.206858817.workers.dev/` 的记录保存在各个浏览器自己的 localStorage，不会因为新 Worker 启动而自动同步：

1. 在**有真实数据的原电脑/浏览器**登录旧版网页，进入“工作区设置”，执行“导出全部数据”。
2. 保留该 JSON 文件作为迁移前备份。不要用旧版自动生成的虚构任务覆盖真实工作区。
3. 打开新的 V2.1 测试站点，以管理员身份进入“工作区设置” → “导入旧版 JSON”。
4. 后端只在任务、里程碑、风险、采购四表均为空时允许导入，避免覆盖现有团队记录。
5. 已导入的旧负责人名称保留在 `owner_label`，但**不会**转换为可以登录的账户；管理员需要在“成员”页建立真实邮箱用户，然后重新分配责任人。
6. 超过 240 条历史业务记录的单次导入目前不支持；需要先备份后使用专项离线迁移脚本。最多 240 条的导入使用合并多行 INSERT，减少 D1 请求次数。

**注意**：旧版演示数据可能有 8 兵种大量虚构记录。请审查 JSON 再导入。

## 10. 完成验收后替换原站

在确认无痕窗口能通过 Access、两个不同账号的数据同步正常、任务冲突提示正常、权限不可越权以后，再考虑替换原站。步骤：

1. 备份新 D1 数据。可以使用 `npx wrangler d1 export rm-command-db --remote --output=backup.sql`。
2. 在 `wrangler.jsonc` 将 `name` 从 `luojiafox-v21` 改为 `luojiafox`，保持 D1 database_id 不变。
3. 确认**原 Worker `luojiafox` 也启用了 Cloudflare Access**，且保护生产流量。测试部署到另一个 Worker 的 Access 配置不一定自动沿用。**Access 应用 AUD 和 Worker Secrets 也通常不同**，必须针对原 Worker 重新设置 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`BOOTSTRAP_ADMIN_EMAIL` 并验证。
4. 执行 `npm run deploy`，然后用不同账号进行回归测试。
5. 保留旧站 ZIP 和备份 SQL；Worker 代码可回滚，但 D1 数据库不会因代码回滚自动恢复，因此谨慎执行迁移。

**不建议未完成 Access 设置就把真实战队管理数据上线公开。**

## 11. 数据备份与预算控制

SQL 导出：

```bash
npx wrangler d1 export rm-command-db --remote --output=backup.sql
```

全站 JSON 快照：管理员打开“工作区设置”点击“导出云端快照”。两类备份互补。请将备份存放在战队受控目录，不要公开上传。

API 每 3 分钟仅在前台页面自动刷新一次，也可手动刷新，降低 Workers 请求与 D1 行读取量。Cloudflare 免费额度可能调整，部署前应在官方文档核对 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)。如果战队有几十人且长期全天打开，请通过 Cloudflare Usage 观察实际消耗。

## 12. 常见故障

| 错误 / 现象 | 原因和处理 |
|---|---|
| 访问网站却提示 401 `ACCESS_REQUIRED` | 请求缺少 Access JWT；检查 Worker → Access 策略是否保护生产流量以及登录 Cookie，勿伪造 HTTP 请求头。 |
| 503 `ACCESS_CONFIG` | `ACCESS_TEAM_DOMAIN` 或 `ACCESS_AUD` Secret 缺失；确认团队域名格式以 `https://` 开头。 |
| 401 `INVALID_ACCESS_TOKEN` | 签名、Issuer、AUD 或过期校验失败；对照 Zero Trust 当前应用的 Audience Tag。 |
| 503 `ACCESS_KEYS_UNAVAILABLE` | Worker 暂时无法获取 Access 公钥；检查团队域名和网络日志。 |
| 通过 Cloudflare 登录后显示 403 `NOT_MEMBER` | 当前邮箱尚未被创建为 D1 用户；由管理员新增，或检查首位管理员 Secret 是否正确且 D1 用户表是否真的为空。 |
| API 显示 500 服务异常 | 通常未执行远程 migration，或 D1 绑定名与 `DB` 不一致。查看 Workers Logs。 |
| 请求显示 409 `VERSION_CONFLICT` | 同一记录已被他人更新，前端会显示服务器版本与草稿，选择加载最新或显式再提交。 |
| `Database not found` | `wrangler.jsonc` 中 database_id 仍为示例值，或 CLI 登错 Cloudflare 账号。 |
| 页面有 UI 但无法编译 / 访问空白 | 需要运行 `npm install`、`npm run build`；不是将源码文件夹作为静态文件直接上传。 |
| 改了旧域名但数据不同步 | 新版数据都在 D1；旧版的 localStorage 必须手动导出迁移。 |

官方参考： [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) · [D1 Migrations](https://developers.cloudflare.com/d1/platform/migrations/) · [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
