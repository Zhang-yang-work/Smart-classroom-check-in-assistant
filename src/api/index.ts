import { Network } from '@/network';
import Taro from '@tarojs/taro';
import { clearSession, getToken } from '@/utils/storage';
import type {
  User,
  Course,
  RosterItem,
  Task,
  TaskDetail,
  AgentChatResponse,
  TeachingGroup,
  FinalAttendanceStatus,
  AttendanceMode,
  AttendanceLocation,
} from './types';

interface ApiEnvelope<T = any> {
  code: number;
  msg: string;
  data: T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function returnToLogin(status: number | undefined, token: string) {
  if (status === 401 && token && token === getToken()) {
    clearSession();
    void Taro.reLaunch({ url: '/pages/index/index' });
  }
}

async function request<T = any>(options: {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: Record<string, any>;
  credential?: string;
}): Promise<T> {
  const { url, method = 'GET', data } = options;
  const header: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = options.credential ?? getToken();
  if (token) header.Authorization = `Bearer ${token}`;

  const path = url.split(/[?#]/, 1)[0];
  console.log('[API REQUEST]', { method, path });

  const res: any = await Network.request({
    url,
    method,
    data,
    header,
  } as any);

  console.log('[API RESPONSE]', { method, path, statusCode: res?.statusCode });

  const body = res?.data as ApiEnvelope<T> | undefined;
  if (!res || res.statusCode >= 400) {
    if (!url.startsWith('/api/auth/')) returnToLogin(res?.statusCode, token);
    throw new ApiError(body?.msg || '网络请求失败，请稍后重试', res?.statusCode);
  }
  return (body?.data ?? null) as T;
}

// ---- 认证 ----
type LoginSession = { token: string; user: User };

export function wechatLogin(code: string): Promise<LoginSession | { binding_token: string }> {
  return request({ url: '/api/auth/wechat/login', method: 'POST', data: { code }, credential: '' });
}

export function bindStudent(credential: string, data: {
  student_no: string;
  name: string;
}): Promise<LoginSession> {
  return request({ url: '/api/auth/student/bind', method: 'POST', data, credential });
}

export function activateTeacher(credential: string, data: {
  employee_no: string;
  name: string;
  activation_code: string;
}): Promise<LoginSession> {
  return request({ url: '/api/auth/teacher/activate', method: 'POST', data, credential });
}

export function logoutSession(): Promise<{ revoked: boolean }> {
  return request({ url: '/api/auth/logout', method: 'POST' });
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

export function createGroup(courseId: string, name: string): Promise<TeachingGroup> {
  return request({ url: `/api/courses/${courseId}/groups`, method: 'POST', data: { name } });
}

export function importRoster(
  courseId: string,
  groupId: string,
  students: Array<{ student_no: string; student_name: string }>,
): Promise<RosterItem[]> {
  return request({
    url: `/api/courses/${courseId}/groups/${groupId}/roster/import`,
    method: 'POST',
    data: { students },
  });
}

export function getRoster(courseId: string, groupId: string): Promise<RosterItem[]> {
  return request({ url: `/api/courses/${courseId}/groups/${groupId}/roster` });
}

export function importRosterExcel(courseId: string, groupId: string, filePath: string, fileName?: string): Promise<RosterItem[]> {
  const header: Record<string, string> = {};
  const token = getToken();
  if (token) header.Authorization = `Bearer ${token}`;

  const url = `/api/courses/${courseId}/groups/${groupId}/roster/import-excel`;
  console.log('[API UPLOAD]', { method: 'POST', path: '/api/courses/:courseId/groups/:groupId/roster/import-excel' });

  return (Network.uploadFile({
    url,
    filePath,
    ...(fileName ? { fileName } : {}),
    name: 'file',
    header,
  } as any) as unknown as Promise<{ statusCode: number; data: string }>).then((res: any) => {
    console.log('[API UPLOAD RESPONSE]', { statusCode: res?.statusCode });
    let body: ApiEnvelope<RosterItem[]> | undefined;
    try {
      body = typeof res?.data === 'string' ? JSON.parse(res.data) : res?.data;
    } catch {
      body = undefined;
    }
    if (!res || res.statusCode >= 400 || !body || body.code !== 0) {
      returnToLogin(res?.statusCode, token);
      throw new Error(body?.msg || '上传失败，请稍后重试');
    }
    return (body.data ?? null) as RosterItem[];
  });
}

// ---- 签到 ----
export function createTask(data: {
  course_id: string;
  group_ids: string[];
  duration_minutes: number;
  late_minutes: number;
  mode: AttendanceMode;
  location?: AttendanceLocation;
  location_preset_id?: string;
  radius_m?: number;
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

export function listLocationPresets(): Promise<Array<{ id: string; name: string }>> {
  return request({ url: '/api/attendance/location-presets' });
}

export function getAttendanceQr(taskId: string): Promise<{ rows: string[]; refresh_in_ms: number }> {
  return request({ url: `/api/attendance/${taskId}/qr` });
}

export function signIn(taskId: string, data?: { location?: AttendanceLocation; qr_token?: string }):
Promise<{ id: string; status: string; signed_at: string }> {
  return request({ url: `/api/attendance/${taskId}/sign`, method: 'POST', data });
}

export function endTask(taskId: string) {
  return request({ url: `/api/attendance/${taskId}/end`, method: 'POST' });
}

export function adjustAttendance(
  taskId: string,
  data: { student_no: string; reason?: string | null; status: FinalAttendanceStatus },
): Promise<{ id: string; status: string; makeup_at: string }> {
  return request({ url: `/api/attendance/${taskId}/adjust`, method: 'POST', data });
}

// ---- AI 助手 ----
export function agentChat(
  messages: Array<{ role: string; content: string }>, location?: AttendanceLocation,
  options?: { location_supported: boolean; location_preset_id?: string },
): Promise<AgentChatResponse> {
  return request({ url: '/api/agent/chat', method: 'POST', data: { messages, location, ...options } });
}

export function agentConfirm(pendingId: string): Promise<{ type: string; content: string }> {
  return request({ url: '/api/agent/confirm', method: 'POST', data: { pending_id: pendingId } });
}
