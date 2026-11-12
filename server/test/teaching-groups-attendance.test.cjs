const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { randomBytes } = require('node:crypto');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

function loadSource(file, dependencies) {
  const { outputText } = ts.transpileModule(readFileSync(join(__dirname, '../src', file + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true },
  });
  const exports = {};
  runInNewContext(outputText, { exports, process, Buffer, Date,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
  });
  return exports;
}

test('教学班与普通签到迁移在独立 PostgreSQL 保留历史并串行化考勤写入', {
  skip: !process.env.TEACHING_TEST_DATABASE_URL && '需要空白本机测试数据库',
}, async (t) => {
  const connectionString = process.env.TEACHING_TEST_DATABASE_URL;
  const url = new URL(connectionString);
  assert.ok(url.protocol === 'postgresql:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && /^\/teaching_attendance_test(?:_[a-z0-9]+)?$/.test(url.pathname) && !url.search && !url.hash);
  const admin = new Pool({ connectionString });
  const service = new Pool({ connectionString, options: '-c role=service_role' });
  t.after(async () => { await Promise.all([admin.end(), service.end()]); });
  const query = (sql, args) => admin.query(sql, args);
  const scalar = async (sql, args) => Object.values((await query(sql, args)).rows[0])[0];
  assert.ok(await scalar("SELECT to_regclass('public.users') IS NULL"), '测试数据库必须为空');

  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    CREATE TABLE users (id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
      role varchar(20) NOT NULL, name varchar(64) NOT NULL, student_no varchar(64), token varchar(64), teacher_code varchar(64));
    CREATE TABLE courses (id varchar(36) PRIMARY KEY, name text NOT NULL, teacher_user_id varchar(36) REFERENCES users(id));
    CREATE TABLE course_roster (id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(), course_id varchar(36) NOT NULL REFERENCES courses(id),
      student_no varchar(64) NOT NULL, student_name varchar(64) NOT NULL, linked_user_id varchar(36) REFERENCES users(id),
      UNIQUE(course_id,student_no));
    CREATE TABLE attendance_tasks (id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(), course_id varchar(36) REFERENCES courses(id),
      created_by varchar(36) REFERENCES users(id), mode text NOT NULL DEFAULT 'normal', start_at timestamptz NOT NULL,
      end_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE attendance_participants (id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id varchar(36) REFERENCES attendance_tasks(id) ON DELETE CASCADE, student_no varchar(64) NOT NULL,
      student_name varchar(64) NOT NULL, course_roster_id varchar(36) REFERENCES course_roster(id) ON DELETE SET NULL,
      UNIQUE(task_id,student_no));
    CREATE TABLE attendance_records (id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id varchar(36) REFERENCES attendance_tasks(id) ON DELETE CASCADE, student_no varchar(64) NOT NULL,
      status varchar(20) NOT NULL, signed_at timestamptz, makeup_at timestamptz,
      makeup_by varchar(36) REFERENCES users(id), makeup_reason varchar(256), updated_at timestamptz,
      UNIQUE(task_id,student_no));
    CREATE TABLE operation_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operator_user_id varchar(36) REFERENCES users(id),
      action text NOT NULL, task_id varchar(36), student_no varchar(64), details jsonb);
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    INSERT INTO users(id,role,name,student_no) VALUES
      ('teacher','teacher','甲老师',NULL),('foreign-teacher','teacher','乙老师',NULL),
      ('s1','student','同学一','001'),('s2','student','同学二','002'),('s3','student','同学三','003'),
      ('s4','student','同学四','004');
    INSERT INTO courses VALUES ('course','一号课程','teacher'),('other','二号课程','foreign-teacher');
    INSERT INTO course_roster(id,course_id,student_no,student_name,linked_user_id)
      VALUES ('legacy-roster','course','001','同学一','s1');
    INSERT INTO attendance_tasks(id,course_id,created_by,start_at,end_at)
      VALUES ('legacy-task','course','teacher','2024-01-01','2024-01-02');
    INSERT INTO attendance_participants(task_id,student_no,student_name,course_roster_id)
      VALUES ('legacy-task','001','历史姓名','legacy-roster');
    INSERT INTO attendance_records(id,task_id,student_no,status,makeup_at,makeup_by,makeup_reason)
      VALUES ('legacy-record','legacy-task','001','makeup','2024-01-03','teacher','历史补签');
  `);
  const oldTask = await scalar("SELECT to_jsonb(t) FROM attendance_tasks t WHERE id='legacy-task'");
  const oldSnapshot = await scalar("SELECT to_jsonb(p) FROM attendance_participants p WHERE task_id='legacy-task'");
  const oldRecord = await scalar("SELECT to_jsonb(r) FROM attendance_records r WHERE id='legacy-record'");
  for (const migration of ['001-wechat-identity.sql', '002-teaching-groups-attendance.sql', '003-location-qr-attendance.sql']) {
    await query(readFileSync(join(__dirname, '../database/migrations', migration), 'utf8'));
  }
  assert.deepEqual(await scalar(`SELECT to_jsonb(t) - ARRAY['normal_end_at','ended_at','group_snapshot',
    'location_latitude','location_longitude','location_radius_m','location_name']
    FROM attendance_tasks t WHERE id='legacy-task'`), oldTask);
  assert.deepEqual(await scalar("SELECT to_jsonb(p)-'group_id'-'group_name' FROM attendance_participants p WHERE task_id='legacy-task'"), oldSnapshot);
  assert.deepEqual(await scalar("SELECT to_jsonb(r) FROM attendance_records r WHERE id='legacy-record'"), oldRecord);
  const oldGroup = await scalar("SELECT group_id FROM course_roster WHERE id='legacy-roster'");
  assert.equal(await scalar("SELECT name FROM teaching_groups WHERE id=$1", [oldGroup]), '原课程名单');

  await query("INSERT INTO teaching_groups(id,course_id,name) VALUES ('g2','course','合班二'),('g3','course','未选班'),('g4','other','其他课程'),('empty','course','空班')");
  await query(`INSERT INTO course_roster(course_id,student_no,student_name,group_id)
    VALUES ('course','002','同学二','g2'),('course','003','同学三','g2'),('course','004','同学四','g3')`);
  assert.equal(await scalar("SELECT linked_user_id FROM course_roster WHERE student_no='002'"), 's2');
  await assert.rejects(query("INSERT INTO course_roster(course_id,student_no,student_name,group_id) VALUES ('course','001','同学一','g2')"), { code: '23505' });
  await assert.rejects(query("INSERT INTO course_roster(course_id,student_no,student_name,group_id) VALUES ('course','005','非法','g4')"), { code: '23503' });

  async function publish(actor, groups, late = 5) {
    const { rows } = await service.query('SELECT attendance_publish($1,$2,$3,$4,$5) AS result',
      [actor, 'course', groups, 5, late]);
    return rows[0].result;
  }
  async function change(actor, task, action, student = null, status = null, reason = null) {
    const { rows } = await service.query('SELECT attendance_change($1,$2,$3,$4,$5,$6) AS result',
      [actor, task, action, student, status, reason]);
    return rows[0].result;
  }
  async function report(actor, task) {
    const { rows } = await service.query('SELECT attendance_report($1,$2) AS result', [actor, task]);
    return rows[0].result;
  }

  assert.deepEqual(await publish('foreign-teacher', [oldGroup]), { error: 'not_found' });
  assert.deepEqual(await publish('teacher', ['g4']), { error: 'invalid_groups' });
  const taskCount = await scalar('SELECT count(*)::int FROM attendance_tasks');
  assert.deepEqual(await publish('teacher', ['empty']), { error: 'empty_roster' });
  assert.equal(await scalar('SELECT count(*)::int FROM attendance_tasks'), taskCount);
  const task = await publish('teacher', [oldGroup, 'g2']);
  assert.equal(task.total, 3);
  const taskId = task.id;
  assert.deepEqual(await change('s4', taskId, 'sign', '001'), { error: 'not_found' });
  assert.deepEqual(await change('foreign-teacher', taskId, 'end'), { error: 'not_found' });
  assert.deepEqual(await change('foreign-teacher', taskId, 'adjust', '001', 'present', '越权'), { error: 'not_found' });
  assert.equal(await report('foreign-teacher', taskId), null);
  const signs = await Promise.all([change('s1', taskId, 'sign'), change('s1', taskId, 'sign')]);
  assert.equal(signs.filter(r => r.status === 'present').length, 1);
  assert.equal(signs.filter(r => r.error === 'duplicate').length, 1);
  await query("UPDATE attendance_tasks SET start_at=now()-interval '10 minutes', normal_end_at=now()-interval '1 minute' WHERE id=$1", [taskId]);
  assert.equal((await change('s2', taskId, 'sign')).status, 'late');
  await query("ALTER TABLE operation_logs ADD CONSTRAINT test_audit_failure CHECK(action <> 'adjust_attendance') NOT VALID");
  await assert.rejects(change('teacher', taskId, 'adjust', '002', 'excused', '审计失败'), { code: '23514' });
  assert.equal(await scalar("SELECT status FROM attendance_records WHERE task_id=$1 AND student_no='002'", [taskId]), 'late');
  await query('ALTER TABLE operation_logs DROP CONSTRAINT test_audit_failure');
  assert.equal((await change('teacher', taskId, 'adjust', '002', 'excused', '批准请假')).status, 'excused');
  const audit = await scalar("SELECT details FROM operation_logs WHERE task_id=$1 AND action='adjust_attendance'", [taskId]);
  assert.equal(audit.before, 'late');
  assert.equal(audit.after, 'excused');
  assert.equal(audit.reason, '批准请假');

  const frozen = (await report('teacher', taskId)).participants;
  await query("UPDATE teaching_groups SET name='改名后' WHERE id='g2'");
  const blocker = await admin.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM attendance_tasks WHERE id=$1 FOR UPDATE', [taskId]);
    await blocker.query("UPDATE attendance_tasks SET status='ended', ended_at=clock_timestamp() WHERE id=$1", [taskId]);
    const signing = change('s3', taskId, 'sign');
    await blocker.query('COMMIT');
    assert.deepEqual(await signing, { error: 'closed' });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.deepEqual((await report('teacher', taskId)).participants, frozen);
  const noLate = await publish('teacher', [oldGroup], 0);
  assert.equal(noLate.normal_end_at, noLate.end_at);
  assert.deepEqual(await change('teacher', noLate.id, 'end'), { status: 'ended' });
  assert.deepEqual(await change('s1', noLate.id, 'sign'), { error: 'closed' });
  const expired = await publish('teacher', [oldGroup], 0);
  await query("UPDATE attendance_tasks SET end_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  assert.deepEqual(await change('s1', expired.id, 'sign'), { error: 'closed' });
  assert.equal(await scalar(`SELECT has_function_privilege('anon',
    'public.attendance_change(text,text,text,text,text,text,double precision,double precision,double precision,bigint,bigint)','EXECUTE')`), false);

  async function publishMode(mode, options = []) {
    const params = ['teacher', 'course', [oldGroup, 'g2'], 5, 5, mode, ...options];
    const args = params.map((_, index) => '$' + (index + 1)).join(',');
    return (await service.query(`SELECT attendance_publish(${args}) AS result`, params)).rows[0].result;
  }
  async function withProof(actor, id, location, expires = null) {
    const { rows } = await service.query(`SELECT attendance_change(
      $1,$2,'sign',NULL,NULL,NULL,$3,$4,$5,$6,$7) AS result`,
      [actor, id, ...(location ?? [null, null, null, null]), expires]);
    return rows[0].result;
  }

  assert.deepEqual(await publishMode('location', [91, 121, 100, '测试楼']), { error: 'invalid_location' });
  const locationTask = await publishMode('location', [31, 121, 50, '测试楼']);
  assert.equal(locationTask.mode, 'location');
  assert.equal(locationTask.location_name, '测试楼');
  assert.ok(!('location_latitude' in locationTask));
  assert.deepEqual(await change('s1', locationTask.id, 'sign'), { error: 'invalid_location' });
  assert.deepEqual(await withProof('s4', locationTask.id, [31, 121, 10, Date.now()]), { error: 'not_found' });
  assert.deepEqual(await withProof('s1', locationTask.id, [31, 121, 80, Date.now()]), { error: 'invalid_location' });
  assert.deepEqual(await withProof('s1', locationTask.id, [31, 121, 10, Date.now() - 61000]), { error: 'stale_location' });
  assert.deepEqual(await withProof('s1', locationTask.id, [31.001, 121, 10, Date.now()]), { error: 'out_of_range' });
  assert.equal((await withProof('s1', locationTask.id, [31.0002, 121, 10, Date.now()])).status, 'present');
  assert.deepEqual(await withProof('s1', locationTask.id, [31, 121, 10, Date.now()]), { error: 'duplicate' });
  await query("UPDATE attendance_tasks SET start_at=now()-interval '10 minutes', normal_end_at=now()-interval '1 second' WHERE id=$1", [locationTask.id]);
  assert.deepEqual(await withProof('s2', locationTask.id, [31.001, 121, 10, Date.now()]), { error: 'out_of_range' });
  assert.equal((await withProof('s2', locationTask.id, [31, 121, 10, Date.now()])).status, 'late');
  await change('teacher', locationTask.id, 'end');
  assert.deepEqual(await withProof('s3', locationTask.id, [31, 121, 10, Date.now()]), { error: 'closed' });

  const qrTask = await publishMode('qr');
  assert.deepEqual(await change('s1', qrTask.id, 'sign'), { error: 'expired_qr' });
  assert.deepEqual(await withProof('s1', qrTask.id, null, Date.now() - 1), { error: 'expired_qr' });
  assert.deepEqual(await withProof('s4', qrTask.id, null, Date.now() + 5000), { error: 'not_found' });
  assert.deepEqual(await change('foreign-teacher', qrTask.id, 'end'), { error: 'not_found' });
  const sameCodeExpiry = Date.now() + 5000;
  const qrConcurrent = await Promise.all([withProof('s1', qrTask.id, null, sameCodeExpiry), withProof('s1', qrTask.id, null, sameCodeExpiry)]);
  assert.equal(qrConcurrent.filter(record => record.status === 'present').length, 1);
  assert.equal(qrConcurrent.filter(record => record.error === 'duplicate').length, 1);
  await query("UPDATE attendance_tasks SET start_at=now()-interval '10 minutes', normal_end_at=now()-interval '1 second' WHERE id=$1", [qrTask.id]);
  assert.equal((await withProof('s2', qrTask.id, null, sameCodeExpiry)).status, 'late');

  const lock = await admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM attendance_tasks WHERE id=$1 FOR UPDATE', [qrTask.id]);
    const expiring = withProof('s3', qrTask.id, null, Date.now() + 100);
    await lock.query('SELECT pg_sleep(0.2)');
    await lock.query('COMMIT');
    assert.deepEqual(await expiring, { error: 'expired_qr' });
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await query("UPDATE attendance_tasks SET end_at=now()-interval '1 second' WHERE id=$1", [qrTask.id]);
  assert.deepEqual(await withProof('s3', qrTask.id, null, Date.now() + 5000), { error: 'closed' });

  // Exercise Agent -> shared attendance service -> actual SQL with named RPC parameters.
  const previousSecret = process.env.ATTENDANCE_QR_SECRET;
  const previousPresets = process.env.ATTENDANCE_LOCATION_PRESETS;
  process.env.ATTENDANCE_QR_SECRET = randomBytes(32).toString('base64url');
  process.env.ATTENDANCE_LOCATION_PRESETS = JSON.stringify([
    { id: 'library', name: '测试图书馆', latitude: 31, longitude: 121 },
  ]);
  t.after(() => {
    if (previousSecret === undefined) delete process.env.ATTENDANCE_QR_SECRET;
    else process.env.ATTENDANCE_QR_SECRET = previousSecret;
    if (previousPresets === undefined) delete process.env.ATTENDANCE_LOCATION_PRESETS;
    else process.env.ATTENDANCE_LOCATION_PRESETS = previousPresets;
  });
  const database = { getSupabaseClient: () => ({
    async rpc(name, parameters) {
      assert.equal(name, 'attendance_publish');
      assert.equal(parameters.p_groups, null);
      const names = Object.keys(parameters);
      assert.ok(names.every(key => /^p_[a-z_]+$/.test(key)));
      const args = names.map((key, i) => key + ' => $' + (i + 1)).join(',');
      const { rows } = await service.query('SELECT public.attendance_publish(' + args + ') AS result', Object.values(parameters));
      return { data: rows[0].result, error: null };
    },
  }) };
  const common = loadSource('common/auth', { '@/storage/database/supabase-client': database });
  const proof = loadSource('modules/attendance/attendance-proof', {});
  const dependencies = {
    '@/storage/database/supabase-client': database, '@/common/auth': common, './attendance-proof': proof,
    '@/modules/attendance/attendance-proof': proof,
  };
  const { AttendanceService } = loadSource('modules/attendance/attendance.service', dependencies);
  const { AgentService } = loadSource('modules/agent/agent.service', dependencies);
  const agent = new AgentService(new AttendanceService());
  agent.buildContext = async () => ({ courses: [{ id: 'course', name: '一号课程' }], tasks: [], location_presets: [{ id: 'library', name: '测试图书馆' }] });
  const teacher = { id: 'teacher', role: 'teacher', name: '甲老师', student_no: null };
  const create = async (mode, settings = {}, location) => {
    agent.client.invoke = async () => ({ content: JSON.stringify({ type: 'confirm', tool: 'create_attendance',
      arguments: { course_id: 'course', mode, duration_minutes: 7, late_minutes: 2, ...settings } }) });
    return agent.chat(teacher, {}, { messages: [{ role: 'user', content: '发布签到' }], location });
  };
  for (const [mode, settings, attachment] of [
    ['normal', {}], ['qr', {}], ['location', { location_preset_id: 'library', radius_m: 50 }],
    ['location', { radius_m: 200 }, { latitude: 30, longitude: 120, accuracy: 10, captured_at_ms: Date.now() }],
  ]) {
    const before = await scalar('SELECT count(*)::int FROM attendance_tasks');
    const pending = await create(mode, settings, attachment);
    assert.equal(pending.type, 'confirm');
    assert.equal(await scalar('SELECT count(*)::int FROM attendance_tasks'), before);
    await agent.confirm(teacher, { pending_id: pending.pending_id });
    const created = (await query('SELECT * FROM attendance_tasks ORDER BY created_at DESC LIMIT 1')).rows[0];
    assert.equal(created.mode, mode);
    assert.equal(created.group_snapshot.length, 4);
    assert.equal((await report('teacher', created.id)).participants.length, 4);
    assert.equal(new Date(created.normal_end_at) - new Date(created.start_at), 7 * 60_000);
    assert.equal(new Date(created.end_at) - new Date(created.normal_end_at), 2 * 60_000);
    if (mode === 'location') {
      assert.equal(created.location_radius_m, settings.radius_m);
      assert.equal(created.location_latitude, attachment?.latitude ?? 31);
    }
  }
  const beforeMissing = await scalar('SELECT count(*)::int FROM attendance_tasks');
  const missing = await create('location');
  assert.equal(missing.type, 'reply');
  assert.match(missing.content, /附带当前位置/);
  assert.equal(await scalar('SELECT count(*)::int FROM attendance_tasks'), beforeMissing);
});
