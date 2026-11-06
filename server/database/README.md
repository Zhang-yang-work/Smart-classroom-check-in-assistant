# 微信身份迁移与启用

`migrations/001-wechat-identity.sql` 是第一批身份变更的执行依据。它在同一事务中扩展用户与会话结构、安装 RPC 和名单触发器，并清空旧 token、教师口令。部署环境应记录执行版本和 SHA。已成功的版本只执行一次，重复核对使用下述只读检查。避免用自动 schema 同步代替 SQL，因为 RPC、权限和触发器也属于迁移。

## 独立验证与切换

1. 使用独立本机 PostgreSQL 及空白专用数据库。设置 `WECHAT_TEST_DATABASE_URL` 指向该库，数据库名须为 `wechat_identity_test` 或该名称加下划线和字母数字后缀。执行 `node --test server/test/*.test.cjs`。测试会创建合成表和数据，拒绝包含现有用户表的数据库。RPC 测试通过 PostgreSQL 直连模拟 Supabase RPC 转发，微信适配器使用合成响应。
2. 云端执行前确认 develop/product 的实际连接目标、备份权限与可恢复性，在独立目标恢复并核对原有 users、courses、course_roster、attendance_participants 和 attendance_records 的主键与字段。保留备份 ID、库版本和旧应用 SHA。备份恢复能力未确认时暂停。
3. 在批准的维护窗口暂停写入，排空旧实例，记录迁移前行数、课程归属和历史摘要。使用具备 DDL 权限的账号执行脚本，启用遇错即停。若学号有空值、空格或重复，先核实原始数据及历史关联，再单独处理。
4. 配置服务端 `WX_APP_ID`、`WX_APP_SECRET` 与现有 Supabase service-role key。AppID 须与微信开发者工具及构建所用 AppID 一致。确认微信小程序 HTTPS request 域名和后端 code2session 出站连通。在平台侧配置登录与绑定入口的来源限流。进程内微信兑换上限是单实例兜底，绑定尝试在 PostgreSQL 按微信身份计数。
5. 按核实过的旧教师 ID 预登记并安全发码。验证两种角色、后续自动登录、退出撤销和旧接口失效，再解除维护。旧登录路径已经删除，H5 入口只展示预览提示。代码通过测试替换微信适配器，运行版本没有模拟登录开关。

## 教师预登记及发码

每个教师使用经核实的原 `users.id`、现有姓名和唯一工号。新教师如尚无用户，由部署者先建立角色为 teacher 的稳定用户。激活码使用 `randomBytes(32).toString('base64url')` 生成，每次补发生成新码。原码只交付给教师，数据库写 SHA-256 十六进制摘要，日志不记录两者。以下为参数化 SQL，`$1/$2/$3/$4` 分别对应旧 ID、核实姓名、工号、摘要，预登记成功必须返回一条记录。

```sql
WITH registered AS (
  UPDATE public.users SET employee_no = $3, activation_hash = $4,
    activation_expires_at = now() + interval '7 days'
  WHERE id = $1 AND role = 'teacher' AND name = $2 AND wx_open_id IS NULL
  RETURNING id
)
INSERT INTO public.operation_logs (operator_user_id, action, details)
SELECT id, 'wechat_register_teacher', '{"actor":"database_operator"}' FROM registered
RETURNING operator_user_id;
```

## 核对、撤销与恢复

- 比较迁移前后课程归属、历史快照和考勤记录。切换前后这些数据应一致。确认 `SELECT count(*) FROM public.users WHERE token IS NOT NULL OR teacher_code IS NOT NULL` 返回 0。
- 核验 `pg_indexes` 中学生学号、工号及微信组合键的唯一索引。检查 `auth_sessions` 启用 RLS，anon/authenticated 无表权限，且无法调用身份 RPC。确认 service_role 可调用应用使用的四个 RPC。上线后可按保留策略清理已过期会话，保留仍在十分钟限流窗口中的 onboarding 行。
- 当前设备退出会撤销对应会话。数据库运维可调用 `public.auth_revoke_user_sessions(目标用户ID)` 撤销当前全部正式会话并记录审计，用户仍可通过已绑定微信重新登录。解绑与改绑界面、撤销后的旧微信再认领规则，以及对已经通过鉴权的在途业务写入做事务围栏，均由后续任务实施。
- 脚本执行失败时 PostgreSQL 回滚整个事务。切换后若故障，优先保持维护并向前修复。恢复备份前保存切换后的业务与身份增量，并防止恢复激活码或旧会话。不要直接启用接受旧弱认证的应用。
