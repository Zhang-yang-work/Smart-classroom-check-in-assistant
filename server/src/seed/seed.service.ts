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
    try {
      await this.seed();
    } catch (e) {
      this.logger.warn(`初始化种子数据失败（不影响启动）: ${(e as Error).message}`);
    }
  }

  private async seed(): Promise<void> {
    const client = getSupabaseClient();

    // 1. 默认教师
    let teacherId: string | undefined;
    const { data: existingTeacher } = await client
      .from('users')
      .select('id')
      .eq('teacher_code', 'TEACHER2026')
      .maybeSingle();
    if (existingTeacher) {
      teacherId = existingTeacher.id;
    } else {
      const { data: created, error } = await client
        .from('users')
        .insert({ role: 'teacher', name: '王老师', teacher_code: 'TEACHER2026' })
        .select('id')
        .single();
      if (error) throw new Error(`创建教师失败: ${error.message}`);
      teacherId = created.id;
    }

    // 2. 示例课程 + 名单
    const { data: existingCourse } = await client
      .from('courses')
      .select('id')
      .eq('name', '数据库系统概论')
      .eq('teacher_user_id', teacherId)
      .maybeSingle();

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

    this.logger.log('种子数据就绪：教师口令 TEACHER2026；示例课程「数据库系统概论」含 3 名学生。');
  }
}