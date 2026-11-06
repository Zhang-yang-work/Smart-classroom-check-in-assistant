const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
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
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(join(sourceRoot, specifier.slice(2) + '.ts')).href, shortCircuit: true };
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
            else for (const [key, value] of Object.entries(request.body)) assert.equal(body[key], value);
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

const columns = 'id,course_id,mode,start_at,normal_end_at,end_at,ended_at,status,created_at';
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

async function chat(proposal) {
  expectQuery('courses', { teacher_user_id: 'eq.teacher-a', select: 'id,name' }, []);
  expectQuery('courses', { teacher_user_id: 'eq.teacher-a', select: 'id,name' }, []);
  model.mock.mockImplementationOnce(async () => ({ content: JSON.stringify(proposal) }));
  model.mock.mockImplementation(async () => ({ content: '{"type":"reply","content":"查询结束"}' }));
  return agent.chat(teacher, { headers: {} }, { messages: [{ role: 'user', content: '测试工具调用' }] });
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
  assert.deepEqual(toolResult('get_absentees').absentees, [otherParticipant]);
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
