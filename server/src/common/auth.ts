import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { createHash } from 'node:crypto';

export interface AuthUser {
  id: string;
  role: 'student' | 'teacher';
  name: string;
  student_no: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

export function readSessionToken(authorization: unknown): string {
  if (typeof authorization !== 'string') return '';
  return /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] ?? '';
}

export function hashCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest();
    const token = readSessionToken(request.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException('未登录，请先绑定或登录');
    }

    const client = getSupabaseClient();
    const { data, error } = await client.rpc('auth_resolve_session', { p_hash: hashCredential(token) });

    if (error) throw new ServiceUnavailableException('暂时无法验证登录，请稍后重试');
    if (!data) {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    request.user = {
      id: data.id,
      role: data.role,
      name: data.name,
      student_no: data.student_no,
    } as AuthUser;

    return true;
  }
}

export function requireTeacher(user: AuthUser): void {
  if (!user || user.role !== 'teacher') {
    throw new ForbiddenException('仅教师可执行此操作');
  }
}

export function requireStudent(user: AuthUser): void {
  if (!user || user.role !== 'student') {
    throw new ForbiddenException('仅学生可执行此操作');
  }
}
