const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { registerHooks } = require('node:module');
const { join } = require('node:path');
const { test } = require('node:test');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { Pool } = require('pg');
const ts = require('typescript');

const root = join(__dirname, '../src');
const rootUrl = pathToFileURL(root).href + '/';
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/') || (specifier.startsWith('./') && context.parentURL?.startsWith(rootUrl))) {
      const url = specifier.startsWith('@/')
        ? pathToFileURL(join(root, specifier.slice(2) + '.ts'))
        : new URL(specifier + '.ts', context.parentURL);
      return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(rootUrl) || !url.endsWith('.ts')) return next(url, context);
    const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
        experimentalDecorators: true,
      },
    }).outputText;
    return { format: 'commonjs', source, shortCircuit: true };
  },
});
const { WechatLogin } = require('@/modules/auth/wechat-login');
const { AuthService } = require('@/modules/auth/auth.service');
const { AuthGuard, requireTeacher } = require('@/common/auth');
const database = require('@/storage/database/supabase-client');
hooks.deregister();

const digest = (value) => createHash('sha256').update(value).digest('hex');
const activationCode = 'T'.repeat(43);

test('code2session uses server credentials, accepts only a successful OpenID and hides provider errors', async (t) => {
  const oldAppId = process.env.WX_APP_ID;
  const oldSecret = process.env.WX_APP_SECRET;
  process.env.WX_APP_ID = 'fixture-app';
  process.env.WX_APP_SECRET = 'fixture-secret';
  t.after(() => {
    if (oldAppId === undefined) delete process.env.WX_APP_ID;
    else process.env.WX_APP_ID = oldAppId;
    if (oldSecret === undefined) delete process.env.WX_APP_SECRET;
    else process.env.WX_APP_SECRET = oldSecret;
  });
  const provider = new WechatLogin();
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.equal(url.searchParams.get('appid'), 'fixture-app');
    assert.equal(url.searchParams.get('secret'), 'fixture-secret');
    assert.equal(url.searchParams.get('js_code'), 'fixture-code');
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(options.redirect, 'error');
    return Response.json({ openid: 'fixture-wx-id', session_key: 'never-return-this' });
  });
  assert.deepEqual(await provider.exchange('fixture-code'), { appId: 'fixture-app', openId: 'fixture-wx-id' });
  fetchMock.mock.mockImplementation(async () => Response.json({ errcode: 40029, openid: 'reject-this' }));
  await assert.rejects(provider.exchange('fixture-code'), { status: 401 });
  fetchMock.mock.mockImplementation(async () => { throw new Error('fixture-secret'); });
  await assert.rejects(provider.exchange('fixture-code'), (err) => err.status === 503 && !err.message.includes('fixture-secret'));
  await assert.rejects(new AuthService(provider).login({ code: 'fixture-code', openid: 'forged' }), { status: 400 });
});

test('微信身份闭环在独立 PostgreSQL 上保持事务、权限和历史', {
  skip: !process.env.WECHAT_TEST_DATABASE_URL && '需要新建的本地隔离数据库',
}, async (t) => {
  const connectionString = process.env.WECHAT_TEST_DATABASE_URL;
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname)
    && /^\/wechat_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname)
    && !url.search && !url.hash, '仅允许本机专用测试库');
  const admin = new Pool({ connectionString });
  const service = new Pool({ connectionString, options: '-c role=service_role' });
  t.after(async () => { await Promise.all([admin.end(), service.end()]); });
  // No reset or DROP. Refuse to seed a database that already has application tables.
  const { rows: [empty] } = await admin.query("SELECT to_regclass('public.users') IS NULL AS ok");
  assert.ok(empty.ok, '测试必须使用空白数据库');
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    CREATE TABLE public.users (
      id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(), role varchar(20) NOT NULL,
      name varchar(64) NOT NULL, student_no varchar(64), token varchar(64), teacher_code varchar(64)
    );
    CREATE TABLE public.courses (
      id varchar(36) PRIMARY KEY, teacher_user_id varchar(36) REFERENCES public.users(id)
    );
    CREATE TABLE public.course_roster (
      id varchar(36) PRIMARY KEY, course_id varchar(36) REFERENCES public.courses(id),
      student_no varchar(64) NOT NULL, student_name varchar(64) NOT NULL,
      linked_user_id varchar(36) REFERENCES public.users(id), UNIQUE(course_id, student_no)
    );
    CREATE TABLE public.attendance_participants (task_id text, student_no text, student_name text);
    CREATE TABLE public.attendance_records (task_id text, student_no text, status text);
    CREATE TABLE public.operation_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_user_id varchar(36) NOT NULL REFERENCES public.users(id), action text NOT NULL, details jsonb
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    INSERT INTO public.users VALUES
      ('s-old','student','测试学生','001','old-token',NULL),
      ('t-old','teacher','测试教师',NULL,NULL,'old-code');
    INSERT INTO public.courses VALUES ('course-1','t-old'), ('course-2','t-old');
    INSERT INTO public.course_roster VALUES
      ('roster-1','course-1','001','测试学生','s-old'),
      ('roster-2','course-2','001','测试学生',NULL),
      ('roster-3','course-1','002','新学生',NULL),
      ('roster-4','course-1','003','回滚学生',NULL);
    INSERT INTO public.attendance_participants VALUES ('historic-task','001','原始姓名');
    INSERT INTO public.attendance_records VALUES ('historic-task','001','signed');
  `);
  await admin.query(readFileSync(join(__dirname, '../database/migrations/001-wechat-identity.sql'), 'utf8'));
  await admin.query(`UPDATE public.users SET employee_no='T001', activation_hash=$1,
    activation_expires_at=now()+interval '1 day' WHERE id='t-old'`, [digest(activationCode)]);
  const functions = new Set(['auth_wechat_session', 'auth_bind_wechat', 'auth_resolve_session', 'auth_logout']);
  t.mock.method(database, 'getSupabaseClient', () => ({
    async rpc(name, params) {
      assert.ok(functions.has(name));
      const values = Object.values(params);
      const args = values.map((_, index) => '$' + (index + 1)).join(',');
      try {
        const { rows: [row] } = await service.query(`SELECT public.${name}(${args}) AS data`, values);
        return { data: row.data, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  }));
  const auth = new AuthService({
    exchange: async (code) => ({ appId: 'fixture-app', openId: 'fixture-' + code }),
  });
  const guard = new AuthGuard();
  const login = (code) => auth.login({ code });
  const verify = async (token) => {
    const request = { headers: { authorization: 'Bearer ' + token } };
    await guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) });
    return request.user;
  };
  const student = { student_no: '001', name: '测试学生' };
  const teacher = { employee_no: 'T001', name: '测试教师', activation_code: activationCode };
  const [wx1, wx2] = await Promise.all([login('student-a'), login('student-b')]);
  await assert.rejects(verify(wx1.binding_token), { status: 401 });
  await assert.rejects(verify('old-token'), { status: 401 });
  const results = await Promise.allSettled([
    auth.bindStudent(wx1.binding_token, student),
    auth.bindStudent(wx2.binding_token, student),
  ]);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(results[1 - winner].reason.status, 409);
  const studentSession = results[winner].value;
  assert.equal(studentSession.user.id, 's-old');
  assert.equal((await verify(studentSession.token)).student_no, '001');
  assert.throws(() => requireTeacher(studentSession.user), { status: 403 });
  await assert.rejects(auth.bindStudent([wx1, wx2][winner].binding_token, student), { status: 401 });
  const automatic = await login(['student-a', 'student-b'][winner]);
  assert.equal(automatic.user.id, 's-old');
  await auth.logout(studentSession.token);
  await assert.rejects(verify(studentSession.token), { status: 401 });
  assert.equal((await verify(automatic.token)).id, 's-old');
  await admin.query("UPDATE public.auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [digest(automatic.token)]);
  await assert.rejects(verify(automatic.token), { status: 401 });

  const [wxTeacher, wxOther] = await Promise.all([login('teacher-a'), login('teacher-b')]);
  const activations = await Promise.allSettled([
    auth.activateTeacher(wxTeacher.binding_token, teacher), auth.activateTeacher(wxOther.binding_token, teacher),
  ]);
  const active = activations.find((result) => result.status === 'fulfilled');
  assert.ok(active);
  assert.equal(activations.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(activations.find((result) => result.status === 'rejected').reason.status, 400);
  assert.equal((await verify(active.value.token)).id, 't-old');
  assert.deepEqual((await admin.query("SELECT activation_hash, teacher_code FROM public.users WHERE id='t-old'")).rows[0],
    { activation_hash: null, teacher_code: null });
  assert.equal((await admin.query("SELECT teacher_user_id FROM public.courses WHERE id='course-1'")).rows[0].teacher_user_id, 't-old');
  await admin.query("SELECT public.auth_revoke_user_sessions('t-old')");
  await assert.rejects(verify(active.value.token), { status: 401 });

  const first = await login('new-student');
  const second = await login('new-student');
  await assert.rejects(auth.bindStudent(first.binding_token, { student_no: '002', name: '新学生' }), { status: 401 });
  const created = await auth.bindStudent(second.binding_token, { student_no: '002', name: '新学生' });
  await admin.query("INSERT INTO public.course_roster VALUES ('later','course-2','002','新学生',NULL)");
  assert.equal((await admin.query("SELECT linked_user_id FROM public.course_roster WHERE id='later'")).rows[0].linked_user_id, created.user.id);

  // Force the last write in the binding transaction to fail. User, roster, ticket and session all roll back.
  await admin.query(`ALTER TABLE public.operation_logs ADD CONSTRAINT test_fail_bind
    CHECK (action <> 'wechat_bind_student') NOT VALID`);
  const rollback = await login('rollback');
  const retryIdentity = { student_no: '003', name: '回滚学生' };
  await assert.rejects(auth.bindStudent(rollback.binding_token, retryIdentity), { status: 503 });
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.users WHERE student_no='003'")).rows[0].n, 0);
  assert.equal((await admin.query("SELECT linked_user_id FROM public.course_roster WHERE id='roster-4'")).rows[0].linked_user_id, null);
  await admin.query('ALTER TABLE public.operation_logs DROP CONSTRAINT test_fail_bind');
  assert.equal((await auth.bindStudent(rollback.binding_token, retryIdentity)).user.student_no, '003');

  const rateTicket = await login('guesses');
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(auth.bindStudent(rateTicket.binding_token, { student_no: '999', name: '不存在' }), { status: 400 });
  }
  const refreshed = await login('guesses');
  await assert.rejects(auth.bindStudent(refreshed.binding_token, student), { status: 429 });
  assert.equal((await admin.query('SELECT student_name FROM public.attendance_participants')).rows[0].student_name, '原始姓名');
  assert.equal((await admin.query('SELECT status FROM public.attendance_records')).rows[0].status, 'signed');
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.course_roster WHERE student_no='001' AND linked_user_id='s-old'")).rows[0].n, 2);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.operation_logs WHERE action='wechat_activate_teacher'")).rows[0].n, 1);
  const { rows: [permissions] } = await admin.query(`
    SELECT has_function_privilege('anon','public.auth_wechat_session(text,text,text)','EXECUTE') AS anonymous_rpc,
           has_table_privilege('authenticated','public.auth_sessions','SELECT') AS user_table,
           has_any_column_privilege('anon','public.users','SELECT') AS anonymous_users,
           has_function_privilege('service_role','public.auth_revoke_user_sessions(text)','EXECUTE') AS runtime_revoke_all
  `);
  assert.deepEqual(permissions, { anonymous_rpc: false, user_table: false, anonymous_users: false, runtime_revoke_all: false });
});
