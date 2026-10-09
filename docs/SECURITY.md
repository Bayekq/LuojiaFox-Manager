# 安全边界与上线检查

## 身份认证

- 不接受客户端提交的 `X-User-Role`、`Cf-Access-*` 等可伪造 HTTP 标头作为登录依据。
- 线上从 `Cf-Access-Jwt-Assertion` 读取 JWT，用 Cloudflare Access 公钥进行 **RS256 签名、issuer、audience、exp、nbf 校验**，获取签名内邮箱后才进行 D1 权限校验。不能直接信任邮件标头或仅解码 JWT。
- Cloudflare Workers 静态资源内部路由不会传递 `ctx.access`；这是采用独立 JWT 验签而非依赖 `ctx.access` 的原因。生产必需 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 两项 Secret。
- `.dev.vars` 中 `DEV_AUTH_EMAIL` 只用于 Worker 接收到 `http://localhost` 或 `http://127.0.0.1` URL 的本地开发；严禁在线上写入此 Secret。生产环境应启用 Worker 级 Access 策略并限制允许邮箱。
- 首次管理员由 `BOOTSTRAP_ADMIN_EMAIL` 指定，只有整个用户表为空才自动授予 admin 角色。不可把它当作永久超级管理员后门。

## API 授权

- 所有读写接口在 Worker 获取可信 Actor 后执行。
- 服务器根据数据库中的角色及 `unit_ids` 校验写权限，绝不依赖前端菜单的显隐状态。
- 成员仅能创建/更新本人负责的所属兵种任务；不可以转移任务所有权。
- 负责人仅可操作被分配兵种；跨兵种任务转移须对源/目标均具备管理权限。
- 预算、成员授权必须由适当权限角色编辑；禁用账户登录 API 自动拒绝。
- 所有 SQL 值通过 D1 Prepared Statement `.bind()` 传入，不拼接用户文本做 SQL。

## 并发

- 任务、里程碑、采购、风险、兵种、成员、设置采用条件 SQL 的单行乐观锁。
- `UPDATE ... WHERE id=? AND version=?`、`DELETE ... WHERE id=? AND version=?`；`meta.changes===0` 返回 409 和服务器最新记录。
- 用户可显式确认重试。不可默默覆盖。

## Web 安全

- Vite 构建后本地静态资源，同源 `/api/*`，默认无 CORS 放行。
- 非 GET 请求检测 `Origin` 及 `Sec-Fetch-Site`，拒绝明显跨站写入。
- 数据请求要求 `Content-Type: application/json`，限制请求体字节/长度。
- Vue 自动转义用户文字；本版不通过 `v-html` 渲染不可信 HTML。
- 静态资源 `_headers` 设置 CSP、no-sniff、frame deny 等；API 返回 no-store。
- 线上必须使用 HTTPS 与严格的 Cloudflare Access 邮箱白名单。

## 范围及限制

- 当前日志为最佳努力记录，不满足不可篡改审计/财务合规要求。
- 用户停用和改权后，在下一次 API 请求即基于 D1 新角色校验；已打开的前端 UI 可能到下一次刷新才更新显示。
- 任务列表采用一次性返回，数百到数千行仍可正常使用；超过此规模应增加分页和索引优化。
- 不包含登录攻击防护模块，因为登录由 Cloudflare Access 负责；请在 Access 配置多因子认证、允许邮箱名单以及适当会话有效期。
- 没有实现密钥加密文件管理，禁止将 API Tokens、Wi-Fi 密码、SSH 私钥、商业敏感源代码直接存到任务说明。
- 仅完成本地接口逻辑集成测试，**正式上线前必须对真实 Access、真实 D1、跨浏览器、多账号并发做验收**。

## 验收清单

- [ ] Cloudflare Access 保护生产域名及预览域名；无痕访问首先进入登录。
- [ ] 已配置对应 Access 应用的 `ACCESS_TEAM_DOMAIN` 与 `ACCESS_AUD`；使用**真实签发**的 JWT 测试有效签名可登录，篡改签名/错误 AUD 均返回 401。
- [ ] 未加入用户表的邮箱即便通过 Access，也无法读取业务数据（403）。
- [ ] 只读成员直接调用 PATCH/DELETE 得 403。
- [ ] 兵种负责人不能编辑其他兵种记录。
- [ ] 两个浏览器读同一任务 version=1，先保存变 version=2，另一个提交得 409。
- [ ] `Origin: https://evil.example` 的写入请求得 403。
- [ ] D1 备份成功，已留存迁移前旧 JSON。
- [ ] 没有将 `.dev.vars`、Cloudflare API Token、Secret 提交到代码库。
- [ ] Worker 名称切换前已核对新旧站点的 Access 策略及数据库绑定。
