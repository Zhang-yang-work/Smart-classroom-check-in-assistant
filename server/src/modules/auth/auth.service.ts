import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashCredential } from '@/common/auth';
import type { AuthUser } from '@/common/auth';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { WechatLogin } from './wechat-login';

const loginBody = z.strictObject({ code: z.string().trim().min(1).max(256) });
const identityField = z.string().trim().min(1).max(64);
const studentBody = z.strictObject({ student_no: identityField, name: identityField });
const teacherBody = z.strictObject({
  employee_no: identityField,
  name: identityField,
  activation_code: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/),
});

@Injectable()
export class AuthService {
  private loginWindowEndsAt = 0;
  private loginAttempts = 0;

  constructor(private readonly wechat: WechatLogin) {}

  async login(body: unknown) {
    const input = loginBody.safeParse(body);
    if (!input.success) throw new BadRequestException('请重新获取微信登录凭证');
    const now = Date.now();
    if (now >= this.loginWindowEndsAt) {
      this.loginWindowEndsAt = now + 60_000;
      this.loginAttempts = 0;
    }
    if (++this.loginAttempts > 600) {
      throw new HttpException('登录请求过多，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
    const { appId, openId } = await this.wechat.exchange(input.data.code);
    const token = randomBytes(32).toString('base64url');
    const { data, error } = await getSupabaseClient().rpc('auth_wechat_session', {
      p_app: appId, p_open: openId, p_hash: hashCredential(token),
    });
    if (error || !data) throw new ServiceUnavailableException('登录暂不可用，请稍后重试');
    return data.user ? { token, user: data.user as AuthUser } : { binding_token: token };
  }

  bindStudent(ticket: string, body: unknown) {
    const input = studentBody.safeParse(body);
    if (!input.success) throw new BadRequestException('请填写有效的学号与姓名');
    return this.bind(ticket, 'student', input.data.student_no, input.data.name, null);
  }

  activateTeacher(ticket: string, body: unknown) {
    const input = teacherBody.safeParse(body);
    if (!input.success) throw new BadRequestException('请填写有效的工号、姓名与激活码');
    return this.bind(ticket, 'teacher', input.data.employee_no, input.data.name,
      hashCredential(input.data.activation_code));
  }

  private async bind(ticket: string, role: AuthUser['role'], number: string, name: string, activation: string | null) {
    if (!ticket) throw new UnauthorizedException('绑定凭证已失效，请重新微信登录');
    const token = randomBytes(32).toString('base64url');
    const { data, error } = await getSupabaseClient().rpc('auth_bind_wechat', {
      p_ticket: hashCredential(ticket), p_hash: hashCredential(token), p_role: role,
      p_number: number, p_name: name, p_activation: activation,
    });
    if (error?.code === '23505') throw new ConflictException('身份绑定发生冲突，请重新登录');
    if (error || !data) throw new ServiceUnavailableException('绑定暂不可用，请重新登录确认');
    switch (data.error) {
      case 'expired': throw new UnauthorizedException('绑定凭证已失效，请重新微信登录');
      case 'limited': throw new HttpException('尝试次数过多，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
      case 'conflict': throw new ConflictException('身份已绑定，请联系老师或管理员');
      case 'mismatch': throw new BadRequestException(role === 'teacher'
        ? '教师预登记或激活码不匹配，请联系管理员'
        : '学号或姓名与名单不一致，请联系老师核对');
    }
    if (!data.user) throw new ServiceUnavailableException('绑定暂不可用，请重新登录确认');
    return { token, user: data.user as AuthUser };
  }

  async logout(token: string) {
    if (token) {
      const { error } = await getSupabaseClient().rpc('auth_logout', { p_hash: hashCredential(token) });
      if (error) throw new ServiceUnavailableException('暂时无法确认服务端退出');
    }
    return { revoked: true };
  }
}
