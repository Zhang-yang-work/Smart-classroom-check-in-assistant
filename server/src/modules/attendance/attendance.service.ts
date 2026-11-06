import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AuthUser, requireTeacher, requireStudent } from '@/common/auth';

const TASK_COLUMNS = 'id, course_id, mode, start_at, normal_end_at, end_at, ended_at, status, created_at';
const FINAL_STATUSES = ['present', 'late', 'excused', 'absent'] as const;
type FinalStatus = typeof FINAL_STATUSES[number];
type AttendanceStatus = FinalStatus | 'unsigned';

function taskStatus(task: { status: string; end_at: string; ended_at?: string | null }) {
  return task.status === 'active' && !task.ended_at && Date.now() < new Date(task.end_at).getTime()
    ? 'active' : 'ended';
}

function resultStatus(record: string | null | undefined, active: boolean): AttendanceStatus {
  if (record === 'signed' || record === 'makeup') return 'present';
  if (record && FINAL_STATUSES.includes(record as FinalStatus)) return record as FinalStatus;
  return active ? 'unsigned' : 'absent';
}

function emptySummary() {
  return { total: 0, present: 0, late: 0, excused: 0, absent: 0, unsigned: 0 };
}

function addResult(summary: ReturnType<typeof emptySummary>, status: AttendanceStatus) {
  summary.total++;
  summary[status]++;
}

const unavailableTask = () => new NotFoundException('签到任务不存在或无权访问');

@Injectable()
export class AttendanceService {
  async createTask(user: AuthUser, body: {
    course_id: string; group_ids?: string[]; duration_minutes: number; late_minutes?: number;
  }, allGroups = false) {
    requireTeacher(user);
    const course = typeof body?.course_id === 'string' ? body.course_id.trim() : '';
    const normal = body?.duration_minutes;
    const late = body?.late_minutes === undefined ? 5 : body.late_minutes;
    if (!course) throw new BadRequestException('请选择课程');
    if (!Number.isInteger(normal) || normal < 1 || normal > 1440
      || !Number.isInteger(late) || late < 0 || late > 1440) {
      throw new BadRequestException('请填写有效的正常及迟到签到时长');
    }
    const groups = body.group_ids;
    if (!allGroups && (!Array.isArray(groups) || !groups.length || groups.length > 100
      || groups.some(id => typeof id !== 'string' || !id || id.length > 36))) {
      throw new BadRequestException('请选择一个或多个教学班');
    }
    const { data, error } = await getSupabaseClient().rpc('attendance_publish', {
      p_actor: user.id, p_course: course, p_groups: allGroups ? null : [...new Set(groups)],
      p_normal: normal, p_late: late,
    });
    if (error || !data) throw new ServiceUnavailableException('暂时无法发布签到');
    if (data.error === 'not_found') throw new NotFoundException('课程不存在或无权访问');
    if (data.error === 'empty_roster') throw new BadRequestException('所选教学班暂无学生名单');
    if (data.error) throw new BadRequestException('请确认所选教学班及签到时间');
    return data;
  }

  async listTasksForTeacher(user: AuthUser) {
    requireTeacher(user);
    const client = getSupabaseClient();
    const { data: courses, error: courseError } = await client.from('courses')
      .select('id, name').eq('teacher_user_id', user.id);
    if (courseError) throw new ServiceUnavailableException('读取课程失败');
    if (!courses?.length) return [];
    const names = new Map(courses.map(c => [c.id, c.name]));
    const { data, error } = await client.from('attendance_tasks').select(TASK_COLUMNS)
      .in('course_id', [...names.keys()]).order('created_at', { ascending: false }).limit(100);
    if (error) throw new ServiceUnavailableException('查询签到失败');
    return (data || []).map(task => ({
      ...task, status: taskStatus(task), course_name: names.get(task.course_id),
    }));
  }

  async listTasksForStudent(user: AuthUser) {
    requireStudent(user);
    if (!user.student_no) return { ongoing: [], history: [] };
    const client = getSupabaseClient();
    const { data: tasks, error: taskError } = await this.studentTasks(client, user.student_no)
      .order('created_at', { ascending: false }).limit(100);
    if (taskError) throw new ServiceUnavailableException('查询签到失败');
    if (!tasks?.length) return { ongoing: [], history: [] };

    const { data: records, error: recordError } = await client.from('attendance_records')
      .select('task_id, status').in('task_id', tasks.map(task => task.id)).eq('student_no', user.student_no);
    if (recordError) throw new ServiceUnavailableException('读取签到记录失败');
    const statuses = new Map((records || []).map(record => [record.task_id, record.status]));
    const enriched = tasks.map(({ courses, attendance_participants, ...task }) => {
      const status = taskStatus(task);
      return {
        ...task, status,
        course_name: (courses as unknown as { name: string } | null)?.name || '未知课程',
        group_name: attendance_participants[0]?.group_name ?? null,
        my_status: resultStatus(statuses.get(task.id), status === 'active'),
      };
    });
    return {
      ongoing: enriched.filter(task => task.status === 'active'),
      history: enriched.filter(task => task.status === 'ended'),
    };
  }

  async getTaskDetail(user: AuthUser, taskId: string) {
    const client = getSupabaseClient();
    if (user.role === 'teacher') {
      const { data, error } = await client.rpc('attendance_report', { p_actor: user.id, p_task: taskId });
      if (error) throw new ServiceUnavailableException('查询签到失败');
      if (!data) throw unavailableTask();
      const status = taskStatus(data.task);
      const summary = emptySummary();
      const groups = new Map<string | null, { id: string | null; name: string; summary: typeof summary }>();
      for (const group of data.task.group_snapshot ?? []) {
        groups.set(group.id, { id: group.id, name: group.name, summary: emptySummary() });
      }
      const participants = (data.participants as Array<{
        group_id: string | null; group_name: string | null; status: string | null;
      }>).map(participant => {
        const result = resultStatus(participant.status, status === 'active');
        const groupId = participant.group_id ?? null;
        if (!groups.has(groupId)) {
          groups.set(groupId, { id: groupId, name: participant.group_name ?? '历史名单', summary: emptySummary() });
        }
        addResult(summary, result);
        addResult(groups.get(groupId)!.summary, result);
        return { ...participant, status: result };
      });
      return { task: { ...data.task, status }, participants, summary, groups: [...groups.values()] };
    }

    requireStudent(user);
    if (!user.student_no) throw unavailableTask();
    const { data: task, error: taskError } = await this.studentTasks(client, user.student_no)
      .eq('id', taskId).maybeSingle();
    if (taskError) throw new ServiceUnavailableException('查询签到失败');
    if (!task) throw unavailableTask();
    const { data: record, error } = await client.from('attendance_records').select('status, signed_at')
      .eq('task_id', taskId).eq('student_no', user.student_no).maybeSingle();
    if (error) throw new ServiceUnavailableException('读取签到记录失败');
    const { attendance_participants, ...view } = task;
    const status = taskStatus(task);
    return {
      task: { ...view, status, group_name: attendance_participants[0]?.group_name ?? null },
      my_status: resultStatus(record?.status, status === 'active'), signed_at: record?.signed_at ?? null,
    };
  }

  signIn(user: AuthUser, taskId: string) {
    requireStudent(user);
    return this.change(user.id, taskId, 'sign');
  }

  end(user: AuthUser, taskId: string) {
    requireTeacher(user);
    return this.change(user.id, taskId, 'end');
  }

  adjust(user: AuthUser, taskId: string, body: { student_no: string; reason: string; status: FinalStatus }) {
    requireTeacher(user);
    const student = typeof body?.student_no === 'string' ? body.student_no.trim() : '';
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!student || !reason || reason.length > 256 || !FINAL_STATUSES.includes(body?.status)) {
      throw new BadRequestException('请选择考勤状态并填写调整原因（最多 256 字）');
    }
    return this.change(user.id, taskId, 'adjust', student, body.status, reason);
  }

  // The existing Agent tool still records a manual present result.
  makeup(user: AuthUser, taskId: string, body: { student_no: string; reason: string }) {
    return this.adjust(user, taskId, { ...body, status: 'present' });
  }

  private async change(actor: string, task: string, action: 'sign' | 'end' | 'adjust',
    student: string | null = null, status: FinalStatus | null = null, reason: string | null = null) {
    const { data, error } = await getSupabaseClient().rpc('attendance_change', {
      p_actor: actor, p_task: task, p_action: action, p_student: student, p_status: status, p_reason: reason,
    });
    if (error || !data) throw new ServiceUnavailableException('暂时无法更新签到');
    if (data.error === 'not_found') throw unavailableTask();
    if (data.error === 'duplicate') throw new BadRequestException('已有考勤记录，请勿重复签到');
    if (data.error === 'closed') throw new BadRequestException('当前不在签到时段');
    if (data.error === 'not_participant') throw new BadRequestException('该学生不在本次签到名单中');
    if (data.error) throw new BadRequestException('请检查考勤调整内容');
    return data;
  }

  private studentTasks(client: ReturnType<typeof getSupabaseClient>, studentNo: string) {
    return client.from('attendance_tasks').select(`${TASK_COLUMNS}, courses(name), attendance_participants(group_name)`)
      .eq('attendance_participants.student_no', studentNo).not('attendance_participants', 'is', null);
  }
}
