import { Network } from '@/network';
import { getToken } from '@/utils/storage';
import type {
  User,
  Course,
  RosterItem,
  Task,
  TaskDetail,
  AgentChatResponse,
} from './types';

interface ApiEnvelope<T = any> {
  code: number;
  msg: string;
  data: T;
}

async function request<T = any>(options: {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: Record<string, any>;
}): Promise<T> {
  const { url, method = 'GET', data } = options;
  const header: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) header.Authorization = `Bearer ${token}`;

  console.log('[API REQUEST]', JSON.stringify({ url, method, data, header }));

  const res: any = await Network.request({
    url,
    method,
    data,
    header,
  } as any);

  console.log('[API RESPONSE]', JSON.stringify({ url, statusCode: res?.statusCode, data: res?.data }));

  const body = res?.data as ApiEnvelope<T> | undefined;
  if (!res || res.statusCode >= 400) {
    throw new Error(body?.msg || '网络请求失败，请稍后重试');
  }
  return (body?.data ?? null) as T;
}

// ---- 认证 ----
export function bindStudent(data: {
  student_no: string;
  name: string;
  binding_code: string;
}): Promise<{ token: string; user: User }> {
  return request({ url: '/api/auth/bind', method: 'POST', data });
}

export function studentLogin(data: {
  student_no: string;
  name: string;
}): Promise<{ token: string; user: User }> {
  return request({ url: '/api/auth/student-login', method: 'POST', data });
}

export function teacherLogin(data: {
  name: string;
  teacher_code: string;
}): Promise<{ token: string; user: User }> {
  return request({ url: '/api/auth/teacher-login', method: 'POST', data });
}

export function getMe(): Promise<User> {
  return request({ url: '/api/auth/me' });
}

// ---- 课程 ----
export function listCourses(): Promise<Course[]> {
  return request({ url: '/api/courses' });
}

export function createCourse(name: string): Promise<Course> {
  return request({ url: '/api/courses', method: 'POST', data: { name } });
}

export function importRoster(
  courseId: string,
  students: Array<{ student_no: string; student_name: string }>,
): Promise<RosterItem[]> {
  return request({
    url: `/api/courses/${courseId}/roster/import`,
    method: 'POST',
    data: { students },
  });
}

export function getRoster(courseId: string): Promise<RosterItem[]> {
  return request({ url: `/api/courses/${courseId}/roster` });
}

export function importRosterExcel(courseId: string, filePath: string): Promise<RosterItem[]> {
  const header: Record<string, string> = {};
  const token = getToken();
  if (token) header.Authorization = `Bearer ${token}`;

  const url = `/api/courses/${courseId}/roster/import-excel`;
  console.log('[API UPLOAD]', JSON.stringify({ url, name: 'file', filePath, header }));

  return (Network.uploadFile({
    url,
    filePath,
    name: 'file',
    header,
  } as any) as unknown as Promise<{ statusCode: number; data: string }>).then((res: any) => {
    console.log('[API UPLOAD RESPONSE]', JSON.stringify({ statusCode: res?.statusCode, data: res?.data }));
    let body: ApiEnvelope<RosterItem[]> | undefined;
    try {
      body = typeof res?.data === 'string' ? JSON.parse(res.data) : res?.data;
    } catch {
      body = undefined;
    }
    if (!res || res.statusCode >= 400 || !body || body.code !== 0) {
      throw new Error(body?.msg || '上传失败，请稍后重试');
    }
    return (body.data ?? null) as RosterItem[];
  });
}

// ---- 签到 ----
export function createTask(data: {
  course_id: string;
  duration_minutes: number;
}): Promise<Task> {
  return request({ url: '/api/attendance', method: 'POST', data });
}

export function listTeacherTasks(): Promise<Task[]> {
  return request({ url: '/api/attendance/teacher' });
}

export function listStudentTasks(): Promise<{ ongoing: Task[]; history: Task[] }> {
  return request({ url: '/api/attendance/student' });
}

export function getTaskDetail(taskId: string): Promise<TaskDetail> {
  return request({ url: `/api/attendance/${taskId}` });
}

export function signIn(taskId: string): Promise<{ id: string; status: string; signed_at: string }> {
  return request({ url: `/api/attendance/${taskId}/sign`, method: 'POST' });
}

export function makeup(
  taskId: string,
  data: { student_no: string; reason: string },
): Promise<{ id: string; status: string; makeup_at: string }> {
  return request({ url: `/api/attendance/${taskId}/makeup`, method: 'POST', data });
}

// ---- AI 助手 ----
export function agentChat(messages: Array<{ role: string; content: string }>): Promise<AgentChatResponse> {
  return request({ url: '/api/agent/chat', method: 'POST', data: { messages } });
}

export function agentConfirm(pendingId: string): Promise<{ type: string; content: string }> {
  return request({ url: '/api/agent/confirm', method: 'POST', data: { pending_id: pendingId } });
}