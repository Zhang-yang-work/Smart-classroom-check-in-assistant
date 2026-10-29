import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';

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

function extractToken(headers: Record<string, any>): string {
  const raw = headers?.authorization || headers?.Authorization || '';
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest();
    const token = extractToken(request.headers || {});
    if (!token) {
      throw new UnauthorizedException('未登录，请先绑定或登录');
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('users')
      .select('id, role, name, student_no')
      .eq('token', token)
      .maybeSingle();

    if (error || !data) {
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