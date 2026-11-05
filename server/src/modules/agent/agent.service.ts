import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AuthUser, requireTeacher } from '@/common/auth';
import { AttendanceService } from '@/modules/attendance/attendance.service';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PendingAction {
  tool: string;
  arguments: Record<string, any>;
  user: AuthUser;
}

function extractJson(content: string): any {
  let text = (content || '').trim();
  // 去掉可能的 ```json 围栏
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型未返回有效 JSON');
  }
  return JSON.parse(text.slice(start, end + 1));
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly pending = new Map<string, PendingAction>();
  private readonly client = new LLMClient(new Config());

  constructor(private readonly attendanceService: AttendanceService) {}

  async chat(user: AuthUser, headers: Record<string, any>, body: { messages?: ChatMessage[] }) {
    requireTeacher(user);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) throw new BadRequestException('消息不能为空');

    const customHeaders = HeaderUtils.extractForwardHeaders(headers || {});
    const context = await this.buildContext(user);

    const system = this.buildSystemPrompt(user, context);
    const llmMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let step = 0; step < 6; step++) {
      const raw = await this.invoke(llmMessages, customHeaders);
      let parsed: any;
      try {
        parsed = extractJson(raw);
      } catch (e) {
        // 若模型未按协议返回，直接作为文本回复
        return { type: 'reply', content: raw };
      }

      if (parsed.type === 'reply') {
        return { type: 'reply', content: String(parsed.content || '') };
      }

      if (parsed.type === 'clarify') {
        return { type: 'reply', content: String(parsed.question || '请补充更多信息') };
      }

      if (parsed.type === 'confirm') {
        const pendingId = randomUUID();
        this.pending.set(pendingId, {
          tool: parsed.tool,
          arguments: parsed.arguments || {},
          user,
        });
        return {
          type: 'confirm',
          pending_id: pendingId,
          tool: parsed.tool,
          summary: String(parsed.summary || '请确认是否执行该操作'),
          arguments: parsed.arguments || {},
        };
      }

      if (parsed.type === 'query') {
        const tool = parsed.tool;
        const args = parsed.arguments || {};
        let result: any;
        try {
          result = await this.executeReadTool(tool, args, user);
        } catch (e) {
          result = { error: (e as Error).message };
        }
        const resultText = `工具 ${tool} 执行结果：${JSON.stringify(result)}`;
        // 将工具结果作为 assistant 工具消息回填，继续下一轮
        llmMessages.push({ role: 'assistant', content: `[tool:${tool}]` });
        llmMessages.push({ role: 'user', content: resultText });
        continue;
      }

      // 未知 type，作为文本回复
      return { type: 'reply', content: raw };
    }

    return { type: 'reply', content: '处理步骤过多，请换个方式描述您的需求。' };
  }

  async confirm(user: AuthUser, body: { pending_id: string }) {
    requireTeacher(user);
    const pendingId = (body.pending_id || '').trim();
    const action = this.pending.get(pendingId);
    if (!action) throw new BadRequestException('待确认操作已失效，请重新发起');

    if (action.user.id !== user.id) throw new BadRequestException('无权执行该操作');

    this.pending.delete(pendingId);
    const result = await this.executeWriteTool(action.tool, action.arguments, user);
    return {
      type: 'reply',
      content: this.formatWriteResult(action.tool, action.arguments, result),
    };
  }

  // ---- LLM ----
  private async invoke(
    messages: Array<{ role: string; content: string }>,
    customHeaders: Record<string, string>,
  ): Promise<string> {
    try {
      const res = await this.client.invoke(
        messages as any,
        { temperature: 0.2, thinking: 'disabled' as const },
        undefined,
        customHeaders,
      );
      return res.content || '';
    } catch (e) {
      this.logger.error(`LLM 调用失败: ${(e as Error).message}`);
      throw new BadRequestException('AI 服务暂时不可用，请稍后重试');
    }
  }

  // ---- 工具执行 ----
  private async executeReadTool(tool: string, args: any, user: AuthUser) {
    switch (tool) {
      case 'list_courses':
        return this.listCourses(user);
      case 'list_recent_tasks':
        return this.listTasks(user, args?.course_id);
      case 'list_roster':
        return this.listRoster(user, args?.course_id);
      case 'get_attendance':
        return this.getAttendance(user, args?.task_id);
      case 'get_absentees':
        return this.getAbsentees(user, args?.task_id);
      default:
        throw new Error(`未知工具: ${tool}`);
    }
  }

  private async executeWriteTool(tool: string, args: any, user: AuthUser) {
    switch (tool) {
      case 'create_attendance':
        return this.attendanceService.createTask(user, {
          course_id: args?.course_id,
          duration_minutes: Number(args?.duration_minutes) || 5,
          mode: 'quick',
        });
      case 'makeup_attendance':
        return this.attendanceService.makeup(user, args?.task_id, {
          student_no: args?.student_no,
          reason: args?.reason || '（未填写原因）',
        });
      default:
        throw new Error(`未知操作: ${tool}`);
    }
  }

  private async listCourses(user: AuthUser) {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('courses')
      .select('id, name')
      .eq('teacher_user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  private async listTasks(user: AuthUser, courseId?: string) {
    const tasks = await this.attendanceService.listTasksForTeacher(user);
    if (courseId) return tasks.filter((t: any) => t.course_id === courseId);
    return tasks;
  }

  private async listRoster(user: AuthUser, courseId?: string) {
    if (!courseId) throw new Error('缺少课程 course_id');
    const client = getSupabaseClient();
    const { data: course } = await client
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('teacher_user_id', user.id)
      .maybeSingle();
    if (!course) throw new Error('课程不存在或无权访问');

    const { data, error } = await client
      .from('course_roster')
      .select('student_no, student_name')
      .eq('course_id', courseId)
      .order('student_no', { ascending: true });
    if (error) throw new Error(error.message);
    return data || [];
  }

  private async getAttendance(user: AuthUser, taskId?: string) {
    if (!taskId) throw new Error('缺少任务 task_id');
    return this.attendanceService.getTaskDetail(user, taskId);
  }

  private async getAbsentees(user: AuthUser, taskId?: string) {
    if (!taskId) throw new Error('缺少任务 task_id');
    const detail: any = await this.attendanceService.getTaskDetail(user, taskId);
    const absentees = (detail.participants || [])
      .filter((p: any) => p.status === 'absent')
      .map((p: any) => ({ student_no: p.student_no, student_name: p.student_name }));
    return { absentees, summary: detail.summary };
  }

  // ---- 上下文与提示词 ----
  private async buildContext(user: AuthUser) {
    const courses = await this.listCourses(user);
    const tasks = await this.attendanceService.listTasksForTeacher(user);
    return {
      courses,
      /* @ts-ignore */
      tasks: Array.isArray(tasks) ? tasks.slice(0, 10) : [],
    };
  }

  private buildSystemPrompt(
    user: AuthUser,
    context: { courses: Array<{ id: string; name: string }>; tasks: any[] },
  ): string {
    const coursesBlock =
      context.courses.length === 0
        ? '（暂无课程）'
        : context.courses.map((c) => `- ${c.name}（id=${c.id}）`).join('\n');

    const tasksBlock =
      context.tasks.length === 0
        ? '（暂无任务）'
        : context.tasks
            .map(
              (t: any) =>
                `- 任务 id=${t.id}｜课程「${t.course_name}」｜应到${t.total}｜已签${t.signed_count}｜补签${t.makeup_count}｜${t.status === 'active' ? '进行中' : '已截止'}｜截止${new Date(t.end_at).toLocaleString('zh-CN')}`,
            )
            .join('\n');

    return `你是「AI 智能课堂签到助手」，帮助教师完成课堂签到管理。你只能通过调用工具获取真实数据或执行操作，严禁编造数据。

## 输出协议（必须严格遵守）
每次只输出一个严格的 JSON 对象，不要输出任何其它文字或 Markdown。JSON 必须包含 type 字段：

1. 只读查询（立即执行）：
{"type":"query","tool":"<工具名>","arguments":{...}}
2. 写操作（必须先请老师确认，绝不能自行执行）：
{"type":"confirm","tool":"<工具名>","arguments":{...},"summary":"一句话说明即将执行的操作"}
3. 已获得答案，最终回复老师：
{"type":"reply","content":"给老师看的中文最终回答（简洁准确）"}
4. 信息不足：
{"type":"clarify","question":"需要向老师补充询问的问题"}

## 工具清单
- list_courses：无参数。返回教师课程列表。
- list_recent_tasks：参数 {course_id?}。返回最近签到任务。
- list_roster：参数 {course_id}。返回课程名单。
- get_attendance：参数 {task_id}。返回某次签到的统计与每个学生状态。
- get_absentees：参数 {task_id}。返回缺勤学生名单。
- create_attendance：参数 {course_id, duration_minutes}。发布签到（写，需确认）。
- makeup_attendance：参数 {task_id, student_no, reason}。补签（写，需确认）。

## 规则
- 数据必须来自工具真实返回，禁止编造。
- 发布签到、补签等写操作，必须用 type=confirm 请求老师确认并给出 summary。
- 读操作用 type=query 执行；拿到结果后可继续 query，最后用 type=reply 总结真实数据。
- 课程名与 id 的对照见【当前上下文】，找不到再调用 list_courses / list_recent_tasks。
- 老师说"N分钟"则 duration_minutes 取 N；未明确时默认取 5。
- task_id 是长字符串，必须原样从工具结果或上下文中取用，不要自己生成。

## 当前上下文（教师：${user.name}）
课程：
${coursesBlock}

最近任务：
${tasksBlock}`;
  }

  private formatWriteResult(tool: string, args: any, result: any): string {
    if (tool === 'create_attendance') {
      const total = result?.total ?? 0;
      const endAt = result?.end_at ? new Date(result.end_at).toLocaleTimeString('zh-CN') : '';
      return `已发布签到：共 ${total} 名学生待签到${endAt ? `，截止 ${endAt}` : ''}。`;
    }
    if (tool === 'makeup_attendance') {
      return `已为学号 ${args?.student_no} 完成补签${args?.reason ? `（原因：${args.reason}）` : ''}。`;
    }
    return '操作已完成。';
  }
}
