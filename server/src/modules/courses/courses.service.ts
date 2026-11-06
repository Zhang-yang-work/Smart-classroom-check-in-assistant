import { BadRequestException, Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as XLSX from 'xlsx';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AuthUser, requireTeacher } from '@/common/auth';

export interface UploadedFileLike {
  originalname?: string;
  buffer?: Buffer;
  path?: string;
  mimetype?: string;
  size?: number;
}

function normalizeCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

function parseExcelToStudents(
  buffer: Buffer,
): Array<{ student_no: string; student_name: string }> {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new BadRequestException(`无法解析 Excel 文件: ${(e as Error).message}`);
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new BadRequestException('Excel 文件内容为空');

  const sheet = workbook.Sheets[sheetName];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
  });
  if (!rows || rows.length === 0) throw new BadRequestException('Excel 无数据行');

  // 首行判定是否为表头
  const header = rows[0].map((c) =>
    String(c ?? '').trim().toLowerCase().replace(/\s+/g, ''),
  );
  const hasHeader = header.some(
    (h) =>
      h.includes('学号') ||
      h.includes('姓名') ||
      h.includes('名字') ||
      h.includes('编号') ||
      h.includes('name') ||
      h.includes('student'),
  );

  let noCol = -1;
  let nameCol = -1;
  let dataStart = 0;

  if (hasHeader) {
    noCol = header.findIndex(
      (h) =>
        h.includes('学号') ||
        h.includes('编号') ||
        h.includes('student') ||
        h.includes('no') ||
        h.includes('id'),
    );
    nameCol = header.findIndex(
      (h) =>
        h.includes('姓名') ||
        h.includes('名字') ||
        h.includes('name') ||
        h.includes('学生'),
    );
    if (noCol < 0) noCol = 0;
    if (nameCol < 0) nameCol = 1;
    dataStart = 1;
  } else {
    noCol = 0;
    nameCol = 1;
    dataStart = 0;
  }

  const students: Array<{ student_no: string; student_name: string }> = [];
  for (let i = dataStart; i < rows.length; i++) {
    const no = normalizeCell(rows[i]?.[noCol]);
    const name = String(rows[i]?.[nameCol] ?? '').trim();
    if (no && name) students.push({ student_no: no, student_name: name });
  }
  return students;
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
    students: Array<{ student_no: string; student_name: string }>,
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
      }))
      .filter((s) => s.student_no && s.student_name);

    if (normalized.length === 0) throw new BadRequestException('名单无有效学生信息');

    // 去重（同一学号只保留一条）
    const unique = new Map<string, (typeof normalized)[number]>();
    for (const s of normalized) {
      if (!unique.has(s.student_no)) unique.set(s.student_no, s);
    }

    // Match the database's per-student locking by keeping batch lock order deterministic.
    const rows = Array.from(unique.keys()).sort().map((no) => ({ ...unique.get(no)!, course_id: courseId }));
    const { data, error } = await client.from('course_roster').insert(rows).select('student_no, student_name');
    if (error) throw new BadRequestException(`导入名单失败: ${error.message}`);

    await this.logAction(user.id, 'import_roster', null, null, {
      course_id: courseId,
      count: rows.length,
    });
    return data || [];
  }

  async importRosterExcel(user: AuthUser, courseId: string, file: UploadedFileLike) {
    requireTeacher(user);
    if (!file) throw new BadRequestException('请选择要上传的 Excel 文件');

    const filename = (file.originalname || '').toLowerCase();
    if (!filename.endsWith('.xlsx') && !filename.endsWith('.xls')) {
      throw new BadRequestException('仅支持 .xlsx / .xls 格式的 Excel 文件');
    }

    let buffer: Buffer;
    if (file.buffer && file.buffer.length > 0) {
      buffer = file.buffer;
    } else if (file.path) {
      buffer = await fs.readFile(file.path);
    } else {
      throw new BadRequestException('无法读取上传文件内容');
    }

    const students = parseExcelToStudents(buffer);
    if (students.length === 0) {
      throw new BadRequestException('Excel 中未解析到有效学生（需包含学号、姓名两列）');
    }

    return this.importRoster(user, courseId, students);
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
      .select('id, student_no, student_name, linked_user_id')
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
