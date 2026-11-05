import { BadRequestException, Injectable } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AuthUser, requireTeacher, requireStudent } from '@/common/auth';

// 根据截止时间动态归一化状态：数据库仅存 active，过期后应视为 ended
function resolveTaskStatus(status: string, end_at: string): string {
  if (status !== 'active') return 'ended';
  return Date.now() <= new Date(end_at).getTime() ? 'active' : 'ended';
}

export interface TaskRow {
  id: string;
  course_id: string;
  created_by?: string;
  mode: string;
  start_at: string;
  end_at: string;
  status: string;
  created_at: string;
  courses?: { id: string; name: string } | null;
  course_name?: string;
  total?: number;
  signed_count?: number;
  makeup_count?: number;
  my_status?: string;
}

@Injectable()
export class AttendanceService {
  async createTask(
    user: AuthUser,
    body: { course_id: string; duration_minutes: number; mode?: string },
  ) {
    requireTeacher(user);
    const courseId = (body.course_id || '').trim();
    const minutes = Number(body.duration_minutes);
    if (!courseId) throw new BadRequestException('请选择课程');
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
      throw new BadRequestException('签到时长需在 1~1440 分钟之间');
    }

    const client = getSupabaseClient();
    const { data: course, error: courseErr } = await client
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('teacher_user_id', user.id)
      .maybeSingle();
    if (courseErr || !course) throw new BadRequestException('课程不存在或无权操作');

    const { data: roster, error: rosterErr } = await client
      .from('course_roster')
      .select('id, student_no, student_name')
      .eq('course_id', courseId);
    if (rosterErr) throw new BadRequestException(`读取名单失败: ${rosterErr.message}`);
    if (!roster || roster.length === 0) throw new BadRequestException('请先为该课程导入学生名单');

    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + minutes * 60 * 1000);

    const { data: task, error: taskErr } = await client
      .from('attendance_tasks')
      .insert({
        course_id: courseId,
        created_by: user.id,
        mode: body.mode || 'normal',
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        status: 'active',
      })
      .select('id, course_id, mode, start_at, end_at, status, created_at')
      .single();
    if (taskErr) throw new BadRequestException(`创建签到失败: ${taskErr.message}`);

    const participants = roster.map((r) => ({
      task_id: task.id,
      student_no: r.student_no,
      student_name: r.student_name,
      course_roster_id: r.id,
    }));
    const { error: partErr } = await client.from('attendance_participants').insert(participants);
    if (partErr) throw new BadRequestException(`签到名单快照失败: ${partErr.message}`);

    await this.logAction(user.id, 'create_task', task.id, null, {
      course_id: courseId,
      duration_minutes: minutes,
      total: participants.length,
    });

    return { ...task, total: participants.length, signed_count: 0, makeup_count: 0 };
  }

  // 教师：查看自己课程下的签到任务（含统计）
  async listTasksForTeacher(user: AuthUser) {
    requireTeacher(user);
    const client = getSupabaseClient();
    const { data: courses, error: cErr } = await client
      .from('courses')
      .select('id, name')
      .eq('teacher_user_id', user.id);
    if (cErr) throw new BadRequestException(`查询课程失败: ${cErr.message}`);
    if (!courses || courses.length === 0) return [];

    const courseIds = courses.map((c) => c.id);
    const courseName = new Map(courses.map((c) => [c.id, c.name]));

    const { data: tasks, error: tErr } = await client
      .from('attendance_tasks')
      .select('id, course_id, mode, start_at, end_at, status, created_at')
      .in('course_id', courseIds)
      .order('created_at', { ascending: false })
      .limit(100);
    if (tErr) throw new BadRequestException(`查询签到失败: ${tErr.message}`);

    return this.enrichTasks(client, tasks || [], courseName, null);
  }

  // 学生：进行中 + 历史（含本人签到状态）
  async listTasksForStudent(user: AuthUser) {
    requireStudent(user);
    const client = getSupabaseClient();
    const { data: roster, error: rErr } = await client
      .from('course_roster')
      .select('course_id')
      .eq('linked_user_id', user.id);
    if (rErr) throw new BadRequestException(`查询课程失败: ${rErr.message}`);
    const courseIds = Array.from(new Set((roster || []).map((r) => r.course_id)));
    if (courseIds.length === 0) return { ongoing: [], history: [] };

    const { data: courses, error: cErr } = await client
      .from('courses')
      .select('id, name')
      .in('id', courseIds);
    if (cErr) throw new BadRequestException(`查询课程失败: ${cErr.message}`);
    const courseName = new Map((courses || []).map((c) => [c.id, c.name]));

    const { data: tasks, error: tErr } = await client
      .from('attendance_tasks')
      .select('id, course_id, mode, start_at, end_at, status, created_at')
      .in('course_id', courseIds)
      .order('created_at', { ascending: false })
      .limit(100);
    if (tErr) throw new BadRequestException(`查询签到失败: ${tErr.message}`);

    const enriched = await this.enrichTasks(client, tasks || [], courseName, user.student_no);

    const now = Date.now();
    const ongoing = enriched.filter((t) => t.status === 'active' && new Date(t.end_at).getTime() > now);
    const history = enriched.filter((t) => !(t.status === 'active' && new Date(t.end_at).getTime() > now));

    return { ongoing, history };
  }

  // 任务详情：教师看到全员名单状态，学生看到本人状态
  async getTaskDetail(user: AuthUser, taskId: string) {
    const client = getSupabaseClient();
    const { data: task, error } = await client
      .from('attendance_tasks')
      .select('id, course_id, mode, start_at, end_at, status, created_at, courses(name)')
      .eq('id', taskId)
      .maybeSingle();
    if (error || !task) throw new BadRequestException('签到任务不存在');

    const taskView = { ...task, status: resolveTaskStatus(task.status, task.end_at) };

    const { data: participants, error: pErr } = await client
      .from('attendance_participants')
      .select('student_no, student_name')
      .eq('task_id', taskId)
      .order('student_no', { ascending: true });
    if (pErr) throw new BadRequestException(`读取名单失败: ${pErr.message}`);

    const { data: records, error: recErr } = await client
      .from('attendance_records')
      .select('student_no, status, signed_at, makeup_at, makeup_reason')
      .eq('task_id', taskId);
    if (recErr) throw new BadRequestException(`读取签到记录失败: ${recErr.message}`);

    const recordMap = new Map((records || []).map((r) => [r.student_no, r]));

    if (user.role === 'teacher') {
      return {
        task: taskView,
        participants: (participants || []).map((p) => {
          const rec = recordMap.get(p.student_no);
          return {
            student_no: p.student_no,
            student_name: p.student_name,
            status: rec?.status || 'absent',
            signed_at: rec?.signed_at || null,
            makeup_at: rec?.makeup_at || null,
            makeup_reason: rec?.makeup_reason || null,
          };
        }),
        summary: {
          total: (participants || []).length,
          signed: (records || []).filter((r) => r.status === 'signed').length,
          makeup: (records || []).filter((r) => r.status === 'makeup').length,
          absent:
            (participants || []).length -
            (records || []).filter((r) => r.status === 'signed' || r.status === 'makeup').length,
        },
      };
    }

    // 学生：仅返回本人是否已签到
    const myRecord = recordMap.get(user.student_no || '');
    return {
      task: taskView,
      my_status: myRecord?.status || 'unsigned',
      signed_at: myRecord?.signed_at || null,
    };
  }

  async signIn(user: AuthUser, taskId: string) {
    requireStudent(user);
    const client = getSupabaseClient();
    const { data: task, error } = await client
      .from('attendance_tasks')
      .select('id, start_at, end_at, status')
      .eq('id', taskId)
      .maybeSingle();
    if (error || !task) throw new BadRequestException('签到任务不存在');
    if (task.status !== 'active') throw new BadRequestException('签到已结束');
    if (new Date(task.end_at).getTime() < Date.now()) throw new BadRequestException('签到已过期，无法签到');

    // 确认学生在本次任务名册中
    const { data: participant, error: partErr } = await client
      .from('attendance_participants')
      .select('id')
      .eq('task_id', taskId)
      .eq('student_no', user.student_no || '')
      .maybeSingle();
    if (partErr || !participant) throw new BadRequestException('你不在本次签到名单中');

    const { data: existing } = await client
      .from('attendance_records')
      .select('id, status')
      .eq('task_id', taskId)
      .eq('student_no', user.student_no || '')
      .maybeSingle();
    if (existing) {
      if (existing.status === 'signed') throw new BadRequestException('你已签到，请勿重复操作');
      throw new BadRequestException('你已通过补签记录在案');
    }

    const now = new Date().toISOString();
    const { data: record, error: insErr } = await client
      .from('attendance_records')
      .insert({ task_id: taskId, student_no: user.student_no, status: 'signed', signed_at: now })
      .select('id, status, signed_at')
      .single();
    if (insErr) throw new BadRequestException(`签到失败: ${insErr.message}`);

    await this.logAction(user.id, 'sign_in', taskId, user.student_no ?? null, {});
    return record;
  }

  async makeup(
    user: AuthUser,
    taskId: string,
    body: { student_no: string; reason: string },
  ) {
    requireTeacher(user);
    const studentNo = (body.student_no || '').trim();
    const reason = (body.reason || '').trim();
    if (!studentNo) throw new BadRequestException('请选择学生');
    if (!reason) throw new BadRequestException('请填写补签原因');

    const client = getSupabaseClient();
    const { data: participant, error: pErr } = await client
      .from('attendance_participants')
      .select('id')
      .eq('task_id', taskId)
      .eq('student_no', studentNo)
      .maybeSingle();
    if (pErr || !participant) throw new BadRequestException('该学生不在本次签到名单中');

    const now = new Date().toISOString();
    const payload = {
      task_id: taskId,
      student_no: studentNo,
      status: 'makeup',
      makeup_at: now,
      makeup_by: user.id,
      makeup_reason: reason,
      updated_at: now,
    };
    const { data: record, error: upsertErr } = await client
      .from('attendance_records')
      .upsert(payload, { onConflict: 'task_id,student_no' })
      .select('id, status, makeup_at')
      .single();
    if (upsertErr) throw new BadRequestException(`补签失败: ${upsertErr.message}`);

    await this.logAction(user.id, 'makeup', taskId, studentNo, { reason });
    return record;
  }

  // ---- 私有工具 ----
  private async enrichTasks(
    client: ReturnType<typeof getSupabaseClient>,
    tasks: TaskRow[],
    courseName: Map<string, string>,
    studentNo: string | null,
  ): Promise<TaskRow[]> {
    if (tasks.length === 0) return [];

    const taskIds = tasks.map((t) => t.id);

    const { data: participants } = await client
      .from('attendance_participants')
      .select('task_id, student_no')
      .in('task_id', taskIds);

    const { data: records } = await client
      .from('attendance_records')
      .select('task_id, student_no, status')
      .in('task_id', taskIds);

    const totalMap = new Map<string, number>();
    for (const p of participants || []) {
      totalMap.set(p.task_id, (totalMap.get(p.task_id) || 0) + 1);
    }
    const recordMap = new Map<string, string>();
    for (const r of records || []) {
      recordMap.set(`${r.task_id}::${r.student_no}`, r.status);
      if (studentNo === null) {
        // 仅教师视角需要统计数
      }
    }

    return tasks.map((t) => {
      let signedCount = 0;
      let makeupCount = 0;
      for (const r of records || []) {
        if (r.task_id !== t.id) continue;
        if (r.status === 'signed') signedCount++;
        else if (r.status === 'makeup') makeupCount++;
      }
      const result: TaskRow = {
        ...t,
        status: resolveTaskStatus(t.status, t.end_at),
        course_name: courseName.get(t.course_id) || '未知课程',
        total: totalMap.get(t.id) || 0,
        signed_count: signedCount,
        makeup_count: makeupCount,
      };
      if (studentNo !== null) {
        result.my_status = recordMap.get(`${t.id}::${studentNo}`) || 'unsigned';
      }
      return result;
    });
  }

  private async logAction(
    operatorUserId: string,
    action: string,
    taskId: string | null,
    studentNo: string | null,
    details: Record<string, any>,
  ) {
    try {
      const client = getSupabaseClient();
      await client.from('operation_logs').insert({
        operator_user_id: operatorUserId,
        action,
        task_id: taskId,
        student_no: studentNo,
        details,
      });
    } catch {
      // 审计日志失败不影响主流程
    }
  }
}