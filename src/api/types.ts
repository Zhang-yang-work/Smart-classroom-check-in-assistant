export interface User {
  id: string;
  role: 'student' | 'teacher';
  name: string;
  student_no: string | null;
}

export interface Course {
  id: string;
  name: string;
  created_at?: string;
  groups?: TeachingGroup[];
  group?: TeachingGroup | null;
}

export interface TeachingGroup {
  id: string;
  name: string;
}

export type FinalAttendanceStatus = 'present' | 'late' | 'excused' | 'absent';
export type AttendanceStatus = FinalAttendanceStatus | 'unsigned';
export type AttendanceSummary = Record<AttendanceStatus | 'total', number>;

export interface RosterItem {
  id: string;
  student_no: string;
  student_name: string;
  linked_user_id: string | null;
}

export interface Task {
  id: string;
  course_id: string;
  course_name?: string;
  mode: string;
  start_at: string;
  end_at: string;
  normal_end_at?: string | null;
  ended_at?: string | null;
  group_name?: string | null;
  status: string;
  created_at: string;
  total?: number;
  my_status?: AttendanceStatus;
}

export interface Participant {
  student_no: string;
  student_name: string;
  status: AttendanceStatus;
  group_id: string | null;
  group_name: string | null;
  signed_at: string | null;
  makeup_at: string | null;
  makeup_reason: string | null;
}

export interface TaskDetail {
  task: Task & { course_id: string; course_name?: string };
  participants?: Participant[];
  summary?: AttendanceSummary;
  groups?: Array<{ id: string | null; name: string; summary: AttendanceSummary }>;
  my_status?: AttendanceStatus;
  signed_at?: string | null;
}

export interface AgentChatResponse {
  type: 'reply' | 'confirm';
  content?: string;
  pending_id?: string;
  tool?: string;
  summary?: string;
  arguments?: Record<string, any>;
}
