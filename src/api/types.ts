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
}

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
  status: string;
  created_at: string;
  total?: number;
  signed_count?: number;
  makeup_count?: number;
  my_status?: 'signed' | 'makeup' | 'unsigned';
}

export interface Participant {
  student_no: string;
  student_name: string;
  status: 'signed' | 'makeup' | 'absent';
  signed_at: string | null;
  makeup_at: string | null;
  makeup_reason: string | null;
}

export interface TaskDetail {
  task: Task & { course_id: string; course_name?: string };
  participants?: Participant[];
  summary?: {
    total: number;
    signed: number;
    makeup: number;
    absent: number;
  };
  my_status?: 'signed' | 'makeup' | 'unsigned';
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
