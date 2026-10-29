import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AuthUser, requireTeacher } from '@/common/auth';

function randomCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

@Injectable()
export class CoursesService {
  async createCourse(user: AuthUser, body: { name: string }) {
    requireTeacher(user);
    const name = (body.name || '').trim();
    if (!name) throw new BadRequestException('课程名不能为空');

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('courses')
      .insert({ name, teacher_user_id: user.id })
      .select('id, name, created_at')
      .single();
    if (error) throw new BadRequestException(`创建课程失败: ${error.message}`);

    await this.logAction(user.id, 'create_course', null, null, { course_id: data.id, name });
    return data;
  }

  async listCourses(user: AuthUser) {
    const client = getSupabaseClient();
    if (user.role === 'teacher') {
      const { data, error } = await client
        .from('courses')
        .select('id, name, created_at')
        .eq('teacher_user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw new BadRequestException(`查询课程失败: ${error.message}`);
      return data || [];
    }

    // 学生：通过名单关联的课程
    const { data: rosterRows, error } = await client
      .from('course_roster')
      .select('course_id, courses(id, name)')
      .eq('linked_user_id', user.id);
    if (error) throw new BadRequestException(`查询课程失败: ${error.message}`);

    const seen = new Set<string>();
    const courses: Array<{ id: string; name: string }> = [];
    for (const row of rosterRows || []) {
      const c = row.courses as unknown as { id: string; name: string } | null;
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        courses.push(c);
      }
    }
    return courses;
  }

  async importRoster(
    user: AuthUser,
    courseId: string,
    students: Array<{ student_no: string; student_name: string; binding_code?: string }>,
  ) {
    requireTeacher(user);
    if (!Array.isArray(students) || students.length === 0) {
      throw new BadRequestException('名单不能为空');
    }

    const client = getSupabaseClient();
    const { data: course, error: courseErr } = await client
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('teacher_user_id', user.id)
      .maybeSingle();
    if (courseErr || !course) throw new BadRequestException('课程不存在或无权操作');

    const normalized = students
      .map((s) => ({
        student_no: (s.student_no || '').trim(),
        student_name: (s.student_name || '').trim(),
        binding_code: (s.binding_code || '').trim() || randomCode(),
      }))
      .filter((s) => s.student_no && s.student_name);

    if (normalized.length === 0) throw new BadRequestException('名单无有效学生信息');

    // 去重（同一学号只保留一条）
    const unique = new Map<string, (typeof normalized)[number]>();
    for (const s of normalized) {
      if (!unique.has(s.student_no)) unique.set(s.student_no, s);
    }

    const rows = Array.from(unique.values()).map((s) => ({ ...s, course_id: courseId }));
    const { data, error } = await client.from('course_roster').insert(rows).select('student_no, student_name, binding_code');
    if (error) throw new BadRequestException(`导入名单失败: ${error.message}`);

    await this.logAction(user.id, 'import_roster', null, null, {
      course_id: courseId,
      count: rows.length,
    });
    return data || [];
  }

  async getRoster(user: AuthUser, courseId: string) {
    requireTeacher(user);
    const client = getSupabaseClient();
    const { data: course, error: courseErr } = await client
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('teacher_user_id', user.id)
      .maybeSingle();
    if (courseErr || !course) throw new BadRequestException('课程不存在或无权操作');

    const { data, error } = await client
      .from('course_roster')
      .select('id, student_no, student_name, binding_code, linked_user_id')
      .eq('course_id', courseId)
      .order('student_no', { ascending: true });
    if (error) throw new BadRequestException(`查询名单失败: ${error.message}`);
    return data || [];
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