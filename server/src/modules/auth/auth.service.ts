import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

@Injectable()
export class AuthService {
  async bindStudent(body: {
    student_no: string;
    name: string;
    binding_code: string;
  }) {
    const studentNo = (body.student_no || '').trim();
    const name = (body.name || '').trim();
    const code = (body.binding_code || '').trim();
    if (!studentNo || !name || !code) {
      throw new BadRequestException('学号、姓名、绑定码均不能为空');
    }

    const client = getSupabaseClient();
    const { data: roster, error: rosterErr } = await client
      .from('course_roster')
      .select('id, course_id, student_no, student_name, linked_user_id')
      .eq('binding_code', code)
      .maybeSingle();
    if (rosterErr) throw new BadRequestException(`绑定码查询失败: ${rosterErr.message}`);
    if (!roster) throw new BadRequestException('绑定码无效，请核对后重试');
    if (roster.linked_user_id) throw new BadRequestException('该绑定码已被使用，请联系老师');

    if (roster.student_no !== studentNo || roster.student_name !== name) {
      throw new BadRequestException('学号或姓名与名单不一致，请核对后重试');
    }

    // 找到或创建学生账号
    let userId: string;
    const { data: existing } = await client
      .from('users')
      .select('id')
      .eq('role', 'student')
      .eq('student_no', studentNo)
      .maybeSingle();
    if (existing) {
      userId = existing.id;
    } else {
      const { data: created, error: createErr } = await client
        .from('users')
        .insert({ role: 'student', name, student_no: studentNo })
        .select('id')
        .single();
      if (createErr) throw new BadRequestException(`创建账号失败: ${createErr.message}`);
      userId = created.id;
    }

    // 链接同一学号的所有名单项（跨课程）
    const { error: linkErr } = await client
      .from('course_roster')
      .update({ linked_user_id: userId })
      .eq('student_no', studentNo)
      .is('linked_user_id', null);
    if (linkErr) throw new BadRequestException(`绑定失败: ${linkErr.message}`);

    const token = randomUUID();
    const { error: tokenErr } = await client
      .from('users')
      .update({ token })
      .eq('id', userId);
    if (tokenErr) throw new BadRequestException(`登录失败: ${tokenErr.message}`);

    return {
      token,
      user: { id: userId, role: 'student' as const, name, student_no: studentNo },
    };
  }

  async teacherLogin(body: { name: string; teacher_code: string }) {
    const name = (body.name || '').trim();
    const code = (body.teacher_code || '').trim();
    if (!name || !code) throw new BadRequestException('姓名与教师口令均不能为空');

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('users')
      .select('id, role, name')
      .eq('role', 'teacher')
      .eq('teacher_code', code)
      .eq('name', name)
      .maybeSingle();
    if (error) throw new BadRequestException(`登录失败: ${error.message}`);
    if (!data) throw new BadRequestException('教师口令或姓名不正确');

    const token = randomUUID();
    const { error: tokenErr } = await client
      .from('users')
      .update({ token })
      .eq('id', data.id);
    if (tokenErr) throw new BadRequestException(`登录失败: ${tokenErr.message}`);

    return {
      token,
      user: { id: data.id, role: 'teacher' as const, name: data.name, student_no: null },
    };
  }
}