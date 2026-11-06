import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * 演示种子数据：默认教师账号 + 示例课程与名单。
 * 幂等：仅当不存在时才创建。
 */
@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV !== 'test' || process.env.ENABLE_DEMO_SEED !== 'true') return;

    const url = URL.parse(process.env.COZE_SUPABASE_URL || '');
    const teacherCode = process.env.DEMO_SEED_TEACHER_CODE?.trim();
    if (!url || !['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()
      || !teacherCode || teacherCode.length < 32 || teacherCode.length > 64) {
      this.logger.warn('已跳过演示种子：需要独立的本机测试库、服务端密钥和 32 至 64 字符的测试口令。');
      return;
    }

    try {
      await this.seed(teacherCode);
    } catch {
      this.logger.warn('初始化演示种子失败，请检查本机测试数据库配置。');
    }
  }

  private async seed(teacherCode: string): Promise<void> {
    const client = getSupabaseClient();

    // 1. 默认教师
    let teacherId: string | undefined;
    const { data: existingTeacher, error: teacherErr } = await client
      .from('users')
      .select('id')
      .eq('role', 'teacher')
      .eq('teacher_code', teacherCode)
      .maybeSingle();
    if (teacherErr) throw teacherErr;
    if (existingTeacher) {
      teacherId = existingTeacher.id;
    } else {
      const { data: created, error } = await client
        .from('users')
        .insert({ role: 'teacher', name: '王老师', teacher_code: teacherCode })
        .select('id')
        .single();
      if (error) throw new Error(`创建教师失败: ${error.message}`);
      teacherId = created.id;
    }

    // 2. 示例课程 + 名单
    const { data: existingCourse, error: lookupErr } = await client
      .from('courses')
      .select('id')
      .eq('name', '数据库系统概论')
      .eq('teacher_user_id', teacherId)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    if (!existingCourse) {
      const { data: course, error: courseErr } = await client
        .from('courses')
        .insert({ name: '数据库系统概论', teacher_user_id: teacherId })
        .select('id')
        .single();
      if (courseErr) throw new Error(`创建课程失败: ${courseErr.message}`);

      const roster = [
        { student_no: '20260001', student_name: '张三', binding_code: 'ABC123' },
        { student_no: '20260002', student_name: '李四', binding_code: 'DEF456' },
        { student_no: '20260003', student_name: '王五', binding_code: 'GHI789' },
      ].map((s) => ({ ...s, course_id: course.id }));

      const { error: rosterErr } = await client.from('course_roster').insert(roster);
      if (rosterErr) throw new Error(`创建名单失败: ${rosterErr.message}`);
    }

    this.logger.log('本机测试库演示种子已就绪。');
  }
}
