const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { registerHooks } = require('node:module');
const { join } = require('node:path');
const { afterEach, beforeEach, mock, test } = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');
const { LLMClient } = require('coze-coding-dev-sdk');
const XLSX = require('xlsx');

// Load the Nest source with its TypeScript decorators and path alias, without bootstrapping AppModule.
const sourceRoot = join(__dirname, '../src');
const sourceUrl = pathToFileURL(sourceRoot).href + '/';
const sourceHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/') || (specifier.startsWith('./') && context.parentURL?.startsWith(sourceUrl))) {
      const url = specifier.startsWith('@/')
        ? pathToFileURL(join(sourceRoot, specifier.slice(2) + '.ts'))
        : new URL(specifier + '.ts', context.parentURL);
      return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceUrl) || !url.endsWith('.ts')) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const source = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
        experimentalDecorators: true,
      },
    }).outputText;
    return { format: 'commonjs', source, shortCircuit: true };
  },
});

const database = require('@/storage/database/supabase-client');
const { AttendanceService } = require('@/modules/attendance/attendance.service');
const { AttendanceController } = require('@/modules/attendance/attendance.controller');
const { AgentService } = require('@/modules/agent/agent.service');
const { AgentController } = require('@/modules/agent/agent.controller');
const { CoursesService } = require('@/modules/courses/courses.service');
const { issueQr, validateQr } = require('@/modules/attendance/attendance-proof');
sourceHooks.deregister();

const teacher = { id: 'teacher-a', role: 'teacher', name: '教师 A', student_no: null };
const student = { id: 'student-a', role: 'student', name: '学生 A', student_no: '001' };
const participant = { student_no: '001', student_name: '学生 A' };
const otherParticipant = { student_no: '002', student_name: '学生 B' };
const signedAt = '2026-11-05T00:00:00.000Z';
const task = {
  id: 'task-a',
  course_id: 'course-a',
  mode: 'normal',
  start_at: signedAt,
  end_at: new Date(Date.now() + 60_000).toISOString(),
  created_at: signedAt,
  status: 'active',
  courses: { name: '课程 A' },
};

let attendance;
let agent;
let requests;
let fetchAssertions;
let databaseMock;
let model;

beforeEach(() => {
  requests = [];
  fetchAssertions = [];
  const client = createClient('https://attendance.test', 'fake-key', {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      // Intercept the real Supabase query builder's HTTP requests. No socket is opened.
      fetch: async (input, init) => {
        try {
          const request = requests.shift();
          assert.ok(request, `Unexpected database call: ${init.method} ${input}`);
          const url = new URL(input);
          assert.equal(url.origin, 'https://attendance.test');
          assert.equal(url.pathname, `/rest/v1/${request.table}`);
          assert.equal(init.method, request.method);
          for (const [key, value] of Object.entries(request.filters)) {
            assert.equal(url.searchParams.get(key), value, `${request.table} query parameter ${key}`);
          }
          if (request.body) {
            const body = JSON.parse(init.body);
            if (Array.isArray(request.body)) assert.deepEqual(body, request.body);
            else for (const [key, value] of Object.entries(request.body)) assert.deepEqual(body[key], value);
          }
          return Response.json(request.data);
        } catch (error) {
          fetchAssertions.push(error);
          throw error;
        }
      },
    },
  });
  databaseMock = mock.method(database, 'getSupabaseClient', () => client);
  model = mock.method(LLMClient.prototype, 'invoke', async () => {
    throw new Error('Unexpected model invocation');
  });
  const service = new AttendanceService();
  attendance = new AttendanceController(service);
  agent = new AgentController(new AgentService(service));
});

afterEach(() => {
  databaseMock.mock.restore();
  model.mock.restore();
  assert.deepEqual(fetchAssertions, []);
  assert.deepEqual(requests, []);
});

function expectQuery(table, filters, data, method = 'GET', body) {
  requests.push({ table, filters, data, method, body });
}

const columns = 'id,course_id,mode,start_at,normal_end_at,end_at,ended_at,status,created_at,location_name,location_radius_m';
const taskIdFilter = { task_id: 'eq.task-a' };
const notFound = { status: 404, message: '签到任务不存在或无权访问' };

function expectTeacherTask(id, result) {
  expectQuery('rpc/attendance_report', {}, result, 'POST', { p_actor: 'teacher-a', p_task: id });
}

function expectStudentTasks(filters, result) {
  expectQuery('attendance_tasks', {
    select: `${columns},courses(name),attendance_participants(group_name)`,
    'attendance_participants.student_no': 'eq.001',
    attendance_participants: 'not.is.null',
    ...filters,
  }, result.map(taskRow => ({ ...taskRow, attendance_participants: [{ group_name: null }] })));
}

function expectTeacherDetail(ended = false) {
  expectTeacherTask('task-a', {
    task: ended ? { ...task, status: 'ended' } : task,
    participants: [{ ...participant, status: 'signed', signed_at: signedAt }, otherParticipant],
  });
}

function expectMakeup(id = 'task-a', result = { id: 'm1', status: 'present' }) {
  expectQuery('rpc/attendance_change', {}, result, 'POST',
    { p_actor: 'teacher-a', p_task: id, p_action: 'adjust', p_student: '002', p_status: 'present', p_reason: '补签' });
}

test('教师可查询本人任务及考勤统计', async () => {
  expectTeacherDetail();
  const detail = await attendance.detail(teacher, 'task-a');
  assert.deepEqual(detail.summary, { total: 2, present: 1, late: 0, excused: 0, absent: 0, unsigned: 1 });
  assert.deepEqual(detail.participants.map(({ student_no, status }) => [student_no, status]), [
    ['001', 'present'], ['002', 'unsigned'],
  ]);
});

test('教师跨课程详情与补签返回统一 404，且不继续读取或写入', async () => {
  expectTeacherTask('task-b', null);
  await assert.rejects(attendance.detail(teacher, 'task-b'), notFound);
  expectTeacherTask('missing-task', null);
  await assert.rejects(attendance.detail(teacher, 'missing-task'), notFound);
  expectMakeup('task-b', { error: 'not_found' });
  await assert.rejects(attendance.makeup(teacher, 'task-b', { student_no: '002', reason: '补签' }), notFound);
});

test('学生详情仅查询本人记录，不包含名单或全班统计', async () => {
  expectStudentTasks({ id: 'eq.task-a' }, [task]);
  expectQuery('attendance_records', { ...taskIdFilter, student_no: 'eq.001', select: 'status,signed_at' }, [
    { status: 'signed', signed_at: signedAt },
  ]);
  assert.deepEqual(await attendance.detail(student, 'task-a'), {
    task: { ...task, group_name: null }, my_status: 'present', signed_at: signedAt,
  });
});

test('学生无法读取或签到未参与的任务，即使拥有任务 ID', async () => {
  expectStudentTasks({ id: 'eq.task-b' }, []);
  await assert.rejects(attendance.detail(student, 'task-b'), notFound);
  expectQuery('rpc/attendance_change', {}, { error: 'not_found' }, 'POST',
    { p_actor: 'student-a', p_task: 'task-b', p_action: 'sign', p_student: null });
  await assert.rejects(attendance.signIn(student, 'task-b'), notFound);
  await assert.rejects(attendance.detail({ ...student, student_no: null }, 'task-a'), notFound);
});

test('学生列表根据快照保留历史，且只查询本人的考勤', async () => {
  const historicalTask = { ...task, id: 'old-task', course_id: 'old-course', end_at: signedAt };
  expectStudentTasks({ order: 'created_at.desc', limit: '100' }, [task, historicalTask]);
  expectQuery('attendance_records', { student_no: 'eq.001', task_id: 'in.(task-a,old-task)', select: 'task_id,status' }, [
    { task_id: 'old-task', status: 'makeup' },
  ]);
  const { ongoing, history } = await attendance.listForStudent(student);
  assert.deepEqual(ongoing.map(({ id, my_status }) => [id, my_status]), [['task-a', 'unsigned']]);
  assert.deepEqual(history.map(({ id, my_status }) => [id, my_status]), [['old-task', 'present']]);
  assert.equal(ongoing[0].course_name, '课程 A');
  assert.ok(!('total' in ongoing[0]));
});

test('合法签到和补签仍写入对应考勤及操作日志', async () => {
  expectQuery('rpc/attendance_change', {}, { id: 'r1', status: 'present' }, 'POST',
    { p_actor: 'student-a', p_task: 'task-a', p_action: 'sign', p_student: null });
  assert.equal((await attendance.signIn(student, 'task-a')).status, 'present');

  expectMakeup();
  assert.equal((await attendance.makeup(teacher, 'task-a', { student_no: '002', reason: '补签' })).status, 'present');
});

test('教师四种考勤调整允许空原因，且不伪造理由', async () => {
  for (const status of ['present', 'late', 'excused', 'absent']) {
    for (const reason of [undefined, null, '', '  ']) {
      expectQuery('rpc/attendance_change', {}, { status }, 'POST', {
        p_actor: teacher.id, p_action: 'adjust', p_student: '001', p_status: status, p_reason: null,
      });
      assert.equal((await attendance.adjust(teacher, task.id, { student_no: '001', status, reason })).status, status);
    }
  }
  assert.throws(() => attendance.adjust(teacher, task.id, { student_no: '001', status: 'absent', reason: 'x'.repeat(257) }), /最多 256/);
});

async function chat(proposal, location, options = {}) {
  expectQuery('courses', { teacher_user_id: 'eq.teacher-a', select: 'id,name,groups:teaching_groups(id,name)' }, [
    { id: 'course-a', name: '课程 A', groups: [{ id: 'group-1', name: '教学一班' }, { id: 'group-2', name: '教学二班' }] },
  ]);
  expectQuery('courses', { teacher_user_id: 'eq.teacher-a', select: 'id,name' }, []);
  model.mock.mockImplementationOnce(async () => ({ content: JSON.stringify(proposal) }));
  model.mock.mockImplementation(async () => ({ content: '{"type":"reply","content":"查询结束"}' }));
  return agent.chat(teacher, { headers: {} }, { messages: [{ role: 'user', content: '测试工具调用' }], location, ...options });
}

function toolResult(tool) {
  const messages = model.mock.calls.at(-1).arguments[0];
  const prefix = `工具 ${tool} 执行结果：`;
  const result = messages.find((message) => message.content.startsWith(prefix));
  assert.ok(result);
  return JSON.parse(result.content.slice(prefix.length));
}

test('Agent 详情和缺勤工具继承权限，合法查询仍返回业务结果', async () => {
  for (const tool of ['get_attendance', 'get_absentees']) {
    const response = chat({ type: 'query', tool, arguments: { task_id: 'task-b' } });
    expectTeacherTask('task-b', null);
    await response;
    assert.deepEqual(toolResult(tool), { error: notFound.message });
    model.mock.resetCalls();
  }
  const response = chat({ type: 'query', tool: 'get_absentees', arguments: { task_id: 'task-a' } });
  expectTeacherDetail(true);
  await response;
  const result = toolResult('get_absentees');
  assert.equal(result.task_status, 'ended');
  assert.deepEqual(result.unsigned, []);
  assert.deepEqual(result.absentees, [otherParticipant]);
});

test('Agent 分开返回进行中的未签到和教师已标记缺勤', async () => {
  const manuallyAbsent = { student_no: '003', student_name: '学生 C' };
  const response = chat({ type: 'query', tool: 'get_absentees', arguments: { task_id: 'task-a' } });
  expectTeacherTask('task-a', {
    task,
    participants: [
      { ...participant, status: 'present' },
      { ...otherParticipant, status: null },
      { ...manuallyAbsent, status: 'absent' },
      { student_no: '004', student_name: '学生 D', status: 'excused' },
    ],
  });
  await response;
  const result = toolResult('get_absentees');
  assert.equal(result.task_status, 'active');
  assert.deepEqual(result.unsigned, [otherParticipant]);
  assert.deepEqual(result.absentees, [manuallyAbsent]);
  const prompt = model.mock.calls.at(-1).arguments[0].find(message => message.role === 'system').content;
  assert.match(prompt, /尚未签到.*教师已标记缺勤.*最终缺勤/);
});

test('Agent 确认无法越权补签，合法补签仍可执行', async () => {
  const propose = (id) => chat({
    type: 'confirm', tool: 'makeup_attendance', arguments: { task_id: id, student_no: '002', reason: '补签' },
  });
  const forbidden = await propose('task-b');
  expectMakeup('task-b', { error: 'not_found' });
  await assert.rejects(agent.confirm(teacher, { pending_id: forbidden.pending_id }), notFound);

  const allowed = await propose('task-a');
  expectMakeup();
  assert.match((await agent.confirm(teacher, { pending_id: allowed.pending_id })).content, /完成补签/);
});

test('Agent 三种签到传递实际类型、覆盖全部教学班并展示真实确认参数', async t => {
  const oldSecret = process.env.ATTENDANCE_QR_SECRET;
  const oldPresets = process.env.ATTENDANCE_LOCATION_PRESETS;
  process.env.ATTENDANCE_QR_SECRET = randomBytes(32).toString('base64url');
  process.env.ATTENDANCE_LOCATION_PRESETS = JSON.stringify([
    { id: 'library', name: '测试图书馆', latitude: 31, longitude: 121 },
  ]);
  t.after(() => {
    if (oldSecret === undefined) delete process.env.ATTENDANCE_QR_SECRET;
    else process.env.ATTENDANCE_QR_SECRET = oldSecret;
    if (oldPresets === undefined) delete process.env.ATTENDANCE_LOCATION_PRESETS;
    else process.env.ATTENDANCE_LOCATION_PRESETS = oldPresets;
  });
  for (const [mode, label] of [['normal', '普通签到'], ['location', '位置签到'], ['qr', '二维码签到']]) {
    const parameters = { course_id: 'course-a', duration_minutes: 7, late_minutes: 0, mode, all_groups: true };
    if (mode === 'location') Object.assign(parameters, { location_preset_id: 'library', radius_m: 50 });
    const proposal = await chat({
      type: 'confirm', tool: 'create_attendance', arguments: parameters, summary: '模型给出的错误类型和时长',
    });
    assert.equal(proposal.type, 'confirm');
    assert.equal(proposal.arguments.mode, mode);
    assert.match(proposal.summary, new RegExp(label));
    assert.match(proposal.summary, /课程 A.*全部教学班.*7 分钟.*关闭迟到窗口/);
    assert.ok(!proposal.summary.includes('错误类型'));
    if (mode === 'location') assert.match(proposal.summary, /测试图书馆.*50 米/);
    await assert.rejects(agent.confirm(student, { pending_id: proposal.pending_id }), { status: 403 });
    const expected = { p_actor: 'teacher-a', p_course: 'course-a', p_normal: 7, p_late: 0,
      p_groups: null, p_mode: mode === 'normal' ? undefined : mode };
    if (mode === 'location') Object.assign(expected, { p_lat: 31, p_lng: 121, p_radius: 50, p_location_name: '测试图书馆' });
    expectQuery('rpc/attendance_publish', {}, { ...task, mode, total: 2 }, 'POST', expected);
    const result = await agent.confirm(teacher, { pending_id: proposal.pending_id });
    assert.match(result.content, new RegExp('已发布' + label));
    await assert.rejects(agent.confirm(teacher, { pending_id: proposal.pending_id }), /已失效/);
    model.mock.resetCalls();

    const failed = await chat({ type: 'confirm', tool: 'create_attendance', arguments: parameters });
    expectQuery('rpc/attendance_publish', {}, { error: 'invalid' }, 'POST', expected);
    await assert.rejects(agent.confirm(teacher, { pending_id: failed.pending_id }), /确认所选教学班及签到时间/);
    model.mock.resetCalls();
  }
});

test('Agent 位置签到只使用显式定位附件并在确认执行时重新检查有效期', async () => {
  const location = { latitude: 31.987654, longitude: 121.987654, accuracy: 20, captured_at_ms: Date.now() };
  const proposal = await chat({ type: 'confirm', tool: 'create_attendance', arguments: {
    course_id: 'course-a', mode: 'location', all_groups: true, location: { latitude: 0, longitude: 0, accuracy: 1 },
  } }, location);
  assert.equal(proposal.type, 'confirm');
  assert.equal(proposal.arguments.radius_m, 100);
  assert.deepEqual(proposal.arguments.location, location);
  assert.match(proposal.summary, /位置签到.*5 分钟.*关闭迟到窗口.*31\.987654.*100 米/);
  assert.ok(!JSON.stringify(model.mock.calls[0].arguments[0]).includes('31.987654'));
  expectQuery('rpc/attendance_publish', {}, { ...task, mode: 'location', total: 2 }, 'POST', {
    p_mode: 'location', p_groups: null, p_lat: location.latitude, p_lng: location.longitude, p_radius: 100,
  });
  await agent.confirm(teacher, { pending_id: proposal.pending_id });
  model.mock.resetCalls();
  const expiring = await chat({ type: 'confirm', tool: 'create_attendance', arguments: {
    course_id: 'course-a', mode: 'location', all_groups: true,
  } }, location);
  mock.method(Date, 'now', () => location.captured_at_ms + 60_001);
  try {
    await assert.rejects(agent.confirm(teacher, { pending_id: expiring.pending_id }), /重新定位/);
  } finally { Date.now.mock.restore(); }
});

test('Agent 缺少或无效定位、建筑、半径、类型及二维码配置时明确拒绝且无发布调用', async t => {
  const previous = process.env.ATTENDANCE_QR_SECRET;
  delete process.env.ATTENDANCE_QR_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.ATTENDANCE_QR_SECRET;
    else process.env.ATTENDANCE_QR_SECRET = previous;
  });
  const valid = { course_id: 'course-a', mode: 'location', all_groups: true };
  const location = { latitude: 31, longitude: 121, accuracy: 10, captured_at_ms: Date.now() };
  const cases = [
    [valid, undefined, /预设建筑/],
    [{ ...valid, location }, undefined, /预设建筑/],
    [valid, { ...location, latitude: 91 }, /预设建筑/],
    [valid, { ...location, captured_at_ms: Date.now() - 61_000 }, /重新定位/],
    [{ ...valid, radius_m: 50 }, { ...location, accuracy: 80 }, /重新定位/],
    [{ ...valid, location_preset_id: 'missing' }, undefined, /预设建筑不可用/],
    [{ ...valid, radius_m: 75 }, location, /有效.*半径/],
    [{ ...valid, mode: 'invalid' }, location, /明确签到类型/],
    [{ course_id: 'course-a' }, undefined, /明确签到类型/],
    [{ ...valid, mode: 'qr' }, undefined, /二维码签到尚未配置/],
  ];
  for (const [parameters, attachment, message] of cases) {
    const result = await chat({ type: 'confirm', tool: 'create_attendance', arguments: parameters }, attachment);
    assert.equal(result.type, 'reply');
    assert.equal(result.pending_id, undefined);
    assert.match(result.content, message);
    model.mock.resetCalls();
  }
});

test('Agent 指定单班或多班原样传参，未提迟到为零，确认卡显示真实班名', async () => {
  for (const [groupIds, late] of [[['group-1'], undefined], [['group-1','group-2'], 3]]) {
    const pending = await chat({ type: 'confirm', tool: 'create_attendance', arguments: {
      course_id: 'course-a', mode: 'normal', group_ids: groupIds, duration_minutes: 5,
      ...(late === undefined ? {} : { late_minutes: late }),
    } });
    assert.equal(pending.type, 'confirm');
    assert.match(pending.summary, /课程 A.*教学一班.*普通|普通签到.*课程 A.*教学一班/);
    assert.equal(pending.summary.includes('全部教学班'), false);
    assert.equal(pending.summary.includes('教学二班'), groupIds.length === 2);
    assert.match(pending.summary, late === undefined ? /关闭迟到窗口.*5 分钟后截止/ : /迟到窗口 3 分钟.*8 分钟后截止/);
    expectQuery('rpc/attendance_publish', {}, { ...task, total: 2 }, 'POST', {
      p_groups: groupIds, p_late: late ?? 0, p_normal: 5,
    });
    await agent.confirm(teacher, { pending_id: pending.pending_id });
    const prompt = model.mock.calls[0].arguments[0][0].content;
    assert.match(prompt, /教学一班（id=group-1）.*教学二班（id=group-2）/);
    model.mock.resetCalls();
  }
});

test('Agent 范围不明、冲突或跨课程教学班时询问或拒绝，绝不改成全部', async () => {
  for (const selection of [{}, { group_ids: ['foreign-group'] }, { all_groups: true, group_ids: ['group-1'] }, { group_ids: ['group-1','group-1'] }]) {
    const result = await chat({ type: 'confirm', tool: 'create_attendance', arguments: {
      course_id: 'course-a', mode: 'normal', ...selection,
    } });
    assert.equal(result.type, 'reply');
    assert.equal(result.pending_id, undefined);
    assert.match(result.content, /教学班/);
    model.mock.resetCalls();
  }
});

test('教师手动发布仍保留原有迟到窗口默认值', async () => {
  expectQuery('rpc/attendance_publish', {}, { ...task, total: 2 }, 'POST', {
    p_groups: ['group-1'], p_normal: 5, p_late: 5,
  });
  assert.equal((await attendance.create(teacher, {
    course_id: 'course-a', group_ids: ['group-1'], mode: 'normal', duration_minutes: 5,
  })).id, task.id);
});

test('Agent 在 WebView 不指向定位按钮，选择建筑可直接发布且使用真实预设', async t => {
  const previous = process.env.ATTENDANCE_LOCATION_PRESETS;
  process.env.ATTENDANCE_LOCATION_PRESETS = JSON.stringify([{ id: 'library', name: '图书馆', latitude: 31, longitude: 121 }]);
  t.after(() => { if(previous === undefined) delete process.env.ATTENDANCE_LOCATION_PRESETS; else process.env.ATTENDANCE_LOCATION_PRESETS=previous; });
  const guide = await chat({ type: 'clarify', question: '请点击附带当前位置' }, undefined, { location_supported: false });
  assert.match(guide.content, /WebView\/H5.*预设建筑/);
  assert.equal(guide.content.includes('附带当前位置'), false);
  model.mock.resetCalls();
  const pending = await chat({ type: 'confirm', tool: 'create_attendance', arguments: {
    course_id: 'course-a', mode: 'location', group_ids: ['group-1'],
  } }, undefined, { location_supported: false, location_preset_id: 'library' });
  assert.equal(pending.type, 'confirm');
  assert.match(pending.summary, /图书馆.*100 米/);
  expectQuery('rpc/attendance_publish', {}, { ...task, mode: 'location' }, 'POST', {
    p_groups: ['group-1'], p_mode: 'location', p_lat: 31, p_lng: 121, p_late: 0,
  });
  await agent.confirm(teacher, { pending_id: pending.pending_id });
});

test('二维码只为有权教师签发，签名绑定任务和有效期', async t => {
  const previous = process.env.ATTENDANCE_QR_SECRET;
  process.env.ATTENDANCE_QR_SECRET = randomBytes(32).toString('base64url');
  t.after(() => {
    if (previous === undefined) delete process.env.ATTENDANCE_QR_SECRET;
    else process.env.ATTENDANCE_QR_SECRET = previous;
  });
  const slot = Math.floor(Date.now() / 10000) * 10000;
  const { token, expiresAt } = issueQr(task.id, slot + 30000, slot + 1);
  assert.equal(issueQr(task.id, slot + 30000, slot + 9999).token, token);
  assert.notEqual(issueQr(task.id, slot + 30000, expiresAt).token, token);
  assert.equal(validateQr(task.id, token, expiresAt - 1), expiresAt);
  assert.throws(() => validateQr(task.id, token, expiresAt), /过期/);
  assert.throws(() => validateQr('other', token, slot), /不属于/);
  const forged = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.throws(() => validateQr(task.id, forged, slot), /无效/);
  await assert.rejects(attendance.qr(student, task.id), { status: 403 });
  const filter = { id: 'eq.task-a', 'courses.teacher_user_id': 'eq.teacher-a' };
  expectQuery('attendance_tasks', filter, []);
  await assert.rejects(attendance.qr(teacher, task.id), { status: 404 });
  expectQuery('attendance_tasks', filter, [{ ...task, mode: 'qr' }]);
  const image = await attendance.qr(teacher, task.id);
  assert.ok(image.rows.length >= 21 && image.rows.every(row => row.length === image.rows.length && /^[01]+$/.test(row)));
  assert.ok(image.refresh_in_ms >= 0 && image.refresh_in_ms <= 10000);

  const current = issueQr(task.id, Date.now() + 60000, Date.now() + 1000);
  expectQuery('rpc/attendance_change', {}, { status: 'present' }, 'POST',
    { p_actor: 'student-a', p_task: task.id, p_action: 'sign', p_qr_expires_ms: current.expiresAt });
  assert.equal((await attendance.signIn(student, task.id, { qr_token: current.token })).status, 'present');
  await assert.rejects(attendance.signIn(student, 'other', { qr_token: token }), /不属于/);
});

test('建筑预设由服务端解析，位置签到拒绝非法坐标并传递有效定位', async t => {
  const previous = process.env.ATTENDANCE_LOCATION_PRESETS;
  process.env.ATTENDANCE_LOCATION_PRESETS = JSON.stringify([
    { id: 'library', name: '测试图书馆', latitude: 31, longitude: 121 },
  ]);
  t.after(() => {
    if (previous === undefined) delete process.env.ATTENDANCE_LOCATION_PRESETS;
    else process.env.ATTENDANCE_LOCATION_PRESETS = previous;
  });
  assert.throws(() => attendance.locationPresets(student), { status: 403 });
  assert.deepEqual(attendance.locationPresets(teacher), [{ id: 'library', name: '测试图书馆' }]);
  expectQuery('rpc/attendance_publish', {}, { mode: 'location' }, 'POST',
    { p_actor: 'teacher-a', p_mode: 'location', p_lat: 31, p_lng: 121, p_radius: 100, p_location_name: '测试图书馆' });
  await attendance.create(teacher, {
    course_id: 'course-a', group_ids: ['g1'], duration_minutes: 5,
    mode: 'location', location_preset_id: 'library', location: { latitude: 90, longitude: 0 },
  });
  const location = { latitude: 31, longitude: 121, accuracy: 12, captured_at_ms: Date.now() };
  await assert.rejects(attendance.signIn(student, task.id, { location: { ...location, latitude: 91 } }), /定位无效/);
  expectQuery('rpc/attendance_change', {}, { status: 'late' }, 'POST',
    { p_lat: 31, p_lng: 121, p_accuracy: 12, p_captured_ms: location.captured_at_ms });
  assert.equal((await attendance.signIn(student, task.id, { location })).status, 'late');
});

test('Agent 名单工具仅查询并返回学号和姓名', async () => {
  const response = chat({ type: 'query', tool: 'list_roster', arguments: { course_id: 'course-a' } });
  expectQuery('courses', { id: 'eq.course-a', teacher_user_id: 'eq.teacher-a' }, [{ id: 'course-a' }]);
  expectQuery('course_roster', { course_id: 'eq.course-a', select: 'student_no,student_name' }, [participant]);
  await response;
  assert.deepEqual(toolResult('list_roster'), [participant]);
});

test('结束后的整体和分班统计包含正常、迟到、请假、缺勤及空班', async () => {
  expectTeacherTask('task-a', {
    task: { ...task, status: 'ended', group_snapshot: [
      { id: 'g1', name: '合班一' }, { id: 'g2', name: '合班二' }, { id: 'g3', name: '空班' },
    ] },
    participants: [
      { group_id: 'g1', status: 'present' }, { group_id: 'g1', status: 'late' },
      { group_id: 'g2', status: 'excused' }, { group_id: 'g2', status: null },
    ],
  });
  const detail = await attendance.detail(teacher, 'task-a');
  assert.deepEqual(detail.summary, { total: 4, present: 1, late: 1, excused: 1, absent: 1, unsigned: 0 });
  assert.deepEqual(detail.groups.map(group => [group.name, group.summary.total, group.summary.late, group.summary.absent]), [
    ['合班一', 2, 1, 0], ['合班二', 2, 0, 1], ['空班', 0, 0, 0],
  ]);
});

test('Excel 导入到指定教学班，保留文本学号与格式化前导零，允许跨行政班', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['学号', '姓名', '行政班'], [7, '同学七', '行政一班'], ['008', '同学八', '行政二班'],
  ]);
  sheet.A2.z = '000';
  XLSX.utils.book_append_sheet(book, sheet, '名单');
  const file = { originalname: '名单.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
  const rows = [{ student_no: '007', student_name: '同学七' }, { student_no: '008', student_name: '同学八' }];
  expectQuery('courses', { id: 'eq.course-a', teacher_user_id: 'eq.teacher-a' }, [{ id: 'course-a' }]);
  expectQuery('teaching_groups', { id: 'eq.g1', course_id: 'eq.course-a' }, [{ id: 'g1' }]);
  expectQuery('course_roster', {}, rows, 'POST', rows.map(row => ({ ...row, course_id: 'course-a', group_id: 'g1' })));
  expectQuery('operation_logs', {}, null, 'POST', { action: 'import_roster' });
  assert.deepEqual(await new CoursesService().importRosterExcel(teacher, 'course-a', 'g1', file), rows);
  await assert.rejects(new CoursesService().importRosterExcel(student, 'course-a', 'g1', file), { status: 403 });
});
