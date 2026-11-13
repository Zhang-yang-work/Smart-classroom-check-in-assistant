import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AuthUser, requireTeacher } from '@/common/auth';
import { AttendanceService } from '@/modules/attendance/attendance.service';
import { locationPresets, locationProof, requireQrSecret } from '@/modules/attendance/attendance-proof';

const ATTENDANCE_MODES = { normal: '普通签到', location: '位置签到', qr: '二维码签到' };
const attendanceArguments = z.object({
  course_id: z.string().trim().min(1).max(36),
  mode: z.enum(['normal', 'location', 'qr']),
  duration_minutes: z.coerce.number().int().min(1).max(1440).default(5),
  late_minutes: z.number().int().min(0).max(1440).default(0),
  all_groups: z.boolean().default(false),
  group_ids: z.array(z.string().trim().min(1).max(36)).min(1).max(100).optional(),
  location_preset_id: z.string().trim().min(1).max(64).optional(),
  radius_m: z.union([z.literal(50), z.literal(100), z.literal(200)]).default(100),
});

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

  async chat(user: AuthUser, headers: Record<string, any>, body: {
    messages?: ChatMessage[]; location?: unknown; location_supported?: boolean; location_preset_id?: string;
  }) {
    requireTeacher(user);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) throw new BadRequestException('消息不能为空');

    const customHeaders = HeaderUtils.extractForwardHeaders(headers || {});
    const context = await this.buildContext(user);
    const reply = (content: string) => ({ type: 'reply', content:
      body.location_supported !== true && content.includes('附带当前位置')
        ? '当前 WebView/H5 页面无法获取教师定位，请在本页选择已配置的预设建筑再发送；也可在原生微信小程序中定位。'
        : content,
    });

    const system = this.buildSystemPrompt(user, context, body.location !== undefined,
      body.location_supported === true, body.location_preset_id);
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
        return reply(raw);
      }

      if (parsed.type === 'reply') {
        return reply(String(parsed.content || ''));
      }

      if (parsed.type === 'clarify') {
        return reply(String(parsed.question || '请补充更多信息'));
      }

      if (parsed.type === 'confirm') {
        let args = parsed.arguments || {};
        let summary = String(parsed.summary || '请确认是否执行该操作');
        if (parsed.tool === 'create_attendance') {
          try {
            args = this.prepareAttendance({ ...args,
              location_preset_id: body.location_preset_id ?? args.location_preset_id,
            }, body.location);
            const course = context.courses.find(course => course.id === args.course_id);
            if (!course) throw new BadRequestException('请选择你负责的课程后再发布签到');
            const groups = course.groups ?? [];
            const selectedGroups = groups.filter(group => args.group_ids?.includes(group.id));
            if (!args.all_groups && selectedGroups.length !== args.group_ids.length) {
              throw new BadRequestException('教学班不存在或不属于所选课程，请核对课程和教学班后重试');
            }
            const scope = args.all_groups ? '全部教学班' : selectedGroups.map(group => `「${group.name}」`).join('、');
            const late = args.late_minutes === 0 ? '关闭迟到窗口' : `迟到窗口 ${args.late_minutes} 分钟`;
            summary = `发布${ATTENDANCE_MODES[args.mode]}，课程「${course.name}」的${scope}，正常签到 ${args.duration_minutes} 分钟，${late}，共 ${args.duration_minutes + args.late_minutes} 分钟后截止`;
            if (args.mode === 'location') {
              const preset = args.location_preset_id === undefined ? undefined
                : locationPresets().find(item => item.id === args.location_preset_id);
              const center = preset ? preset.name : `本次获取的教师定位（${args.location.latitude}, ${args.location.longitude}）`;
              summary += `，中心为${center}，半径 ${args.radius_m} 米`;
            }
          } catch (error) {
            if (error instanceof HttpException) return reply(error.message);
            throw error;
          }
        }
        const pendingId = randomUUID();
        this.pending.set(pendingId, {
          tool: parsed.tool,
          arguments: args,
          user,
        });
        return {
          type: 'confirm',
          pending_id: pendingId,
          tool: parsed.tool,
          summary,
          arguments: args,
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
      return reply(raw);
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
    } catch {
      this.logger.error('LLM 调用失败');
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
        return this.attendanceService.createTask(user, this.prepareAttendance(args, args?.location), args?.all_groups === true);
      case 'makeup_attendance':
        return this.attendanceService.makeup(user, args?.task_id, {
          student_no: args?.student_no,
          reason: args?.reason,
        });
      default:
        throw new Error(`未知操作: ${tool}`);
    }
  }

  private prepareAttendance(args: unknown, teacherLocation?: unknown) {
    const input = attendanceArguments.safeParse(args);
    if (!input.success) {
      throw new BadRequestException('请明确签到类型（普通、位置或二维码）、课程和教学班，并提供有效时长和半径（50、100 或 200 米）');
    }
    const parameters = input.data;
    if (parameters.all_groups ? parameters.group_ids !== undefined : !parameters.group_ids?.length) {
      throw new BadRequestException('请明确选择一个或多个教学班，或明确要求课程全部教学班');
    }
    if (parameters.group_ids && new Set(parameters.group_ids).size !== parameters.group_ids.length) {
      throw new BadRequestException('教学班选择有重复，请核对后重试');
    }
    if (parameters.mode === 'qr') requireQrSecret();
    if (parameters.mode !== 'location') return parameters;
    if (parameters.location_preset_id !== undefined) {
      if (!locationPresets().some(item => item.id === parameters.location_preset_id)) {
        throw new BadRequestException('预设建筑不可用，请在本页选择可用预设建筑后重新发送');
      }
      return parameters;
    }
    // Coordinates come from the explicit client attachment, never from model arguments.
    const location = locationProof.safeParse(teacherLocation);
    const now = Date.now();
    if (!location.success || location.data.accuracy > parameters.radius_m
      || location.data.captured_at_ms < now - 60_000 || location.data.captured_at_ms > now + 15_000) {
      throw new BadRequestException('位置签到需要有效位置。请在本页选择预设建筑；原生微信小程序中可重新定位后再发送');
    }
    return { ...parameters, location: location.data };
  }

  private async listCourses(user: AuthUser) {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('courses')
      .select('id, name, groups:teaching_groups(id,name)')
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
    const taskStatus = detail.task.status;
    const absentees: Array<{ student_no: string; student_name: string }> = [];
    const unsigned: typeof absentees = [];
    for (const { status, student_no, student_name } of detail.participants ?? []) {
      if (status === 'absent') absentees.push({ student_no, student_name });
      if (taskStatus === 'active' && status === 'unsigned') unsigned.push({ student_no, student_name });
    }
    return { task_status: taskStatus, unsigned, absentees, summary: detail.summary };
  }

  // ---- 上下文与提示词 ----
  private async buildContext(user: AuthUser) {
    const courses = await this.listCourses(user);
    const tasks = await this.attendanceService.listTasksForTeacher(user);
    let presets: Array<{ id: string; name: string }> = [];
    try {
      presets = this.attendanceService.listLocationPresets(user);
    } catch {
      // Other Agent queries remain usable; publishing rechecks the preset configuration.
    }
    return {
      courses,
      /* @ts-ignore */
      tasks: Array.isArray(tasks) ? tasks.slice(0, 10) : [],
      location_presets: presets,
    };
  }

  private buildSystemPrompt(
    user: AuthUser,
    context: { courses: Array<{ id: string; name: string; groups?: Array<{ id: string; name: string }> }>; tasks: any[]; location_presets: Array<{ id: string; name: string }> },
    hasTeacherLocation: boolean,
    locationSupported: boolean,
    selectedPreset?: string,
  ): string {
    const coursesBlock =
      context.courses.length === 0
        ? '（暂无课程）'
        : context.courses.map((c) => `- ${c.name}（id=${c.id}），教学班：${(c.groups ?? []).map(group => `${group.name}（id=${group.id}）`).join('、') || '暂无'}`).join('\n');

    const tasksBlock =
      context.tasks.length === 0
        ? '（暂无任务）'
        : context.tasks
            .map(
              (t: any) =>
                `- 任务 id=${t.id}｜课程「${t.course_name}」｜${t.status === 'active' ? '进行中' : '已截止'}｜截止${new Date(t.ended_at || t.end_at).toLocaleString('zh-CN')}`,
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
- get_absentees：参数 {task_id}。返回任务状态、尚未签到名单（unsigned）和缺勤名单（absentees）。
- create_attendance：参数 {course_id, mode, duration_minutes, late_minutes?, group_ids?, all_groups?, location_preset_id?, radius_m?}。mode 必填，仅允许 normal（普通签到）、location（位置签到）、qr（动态二维码签到）（写，需确认）。正常时长默认 5 分钟。教师没有明确要求迟到窗口时 late_minutes 必须为 0，正常时段结束后完全截止；例如「发布5分钟签到」只开放5分钟。明确要求迟到时才设置所要求的分钟数，时长不明确先询问。
- 教师指定一个或多个教学班时，将上下文中的真实 ID 放入 group_ids，all_groups=false；只有明确要求课程全部教学班时 all_groups=true 且省略 group_ids。不得把指定教学班扩大为全部教学班。课程或教学班名称有歧义、未指定范围、名称或 ID 不匹配时用 clarify 询问，不得猜测或选取相近名称。
- location 模式必须有本轮附带的教师定位，或当前上下文中真实存在且由教师选定的建筑 location_preset_id。radius_m 可选 50、100、200 米，默认 100 米。不得生成或猜测坐标，不得把文本描述当作有效定位。缺少位置条件时用 clarify 询问预设建筑。只有下方声明定位入口可用时，才能引导点击「附带当前位置」。WebView/H5 未接入定位时应说明限制并引导在本页选择预设建筑。
- normal 和 qr 模式不需要位置。qr 签发任务共用的动态二维码。
- makeup_attendance：参数 {task_id, student_no, reason?}。补签（写，需确认），原因选填，不得编造理由。

## 规则
- 数据必须来自工具真实返回，禁止编造。
- 签到进行中，unsigned 表述为「尚未签到」，absentees 表述为「教师已标记缺勤」，两份名单分开说明。任务已结束时，absentees 表述为「最终缺勤」。对 get_attendance 的同类状态也使用这些表述。
- 发布签到、补签等写操作，必须用 type=confirm 请求老师确认并给出 summary。
- 按教师要求识别三种签到方式并原样传递 mode。指定类型无法发布时明确说明原因，禁止改成其他类型。发布确认须说明实际签到类型、课程、所选教学班、正常/迟到时长和总截止时间；位置签到还须说明位置来源和半径。
- 「普通签到」对应 normal，「定位/位置签到」对应 location，「扫码/二维码签到」对应 qr。教师未指定方式时使用 normal；已指定方式时必须保留。
- 读操作用 type=query 执行；拿到结果后可继续 query，最后用 type=reply 总结真实数据。
- 课程名与 id 的对照见【当前上下文】，找不到再调用 list_courses / list_recent_tasks。
- 老师说"N分钟"则 duration_minutes 取 N；未明确时默认取 5。
- task_id 是长字符串，必须原样从工具结果或上下文中取用，不要自己生成。

## 当前上下文（教师：${user.name}）
本轮教师定位附件：${hasTeacherLocation ? '已附带，发布前由服务端校验' : '未附带'}。
当前页面定位入口：${locationSupported ? '原生微信小程序，可点击「附带当前位置」' : '不可用，WebView/H5 请在本页选择预设建筑，不能引导点击定位按钮'}。
本轮教师选择的预设建筑 ID：${selectedPreset ?? '未选择'}。
可用预设建筑：${context.location_presets.map(item => `${item.name}（id=${item.id}）`).join('、') || '暂无；当前环境无法定位时请联系管理员配置预设建筑'}。

课程：
${coursesBlock}

最近任务：
${tasksBlock}`;
  }

  private formatWriteResult(tool: string, args: any, result: any): string {
    if (tool === 'create_attendance') {
      const total = result?.total ?? 0;
      const endAt = result?.end_at ? new Date(result.end_at).toLocaleTimeString('zh-CN') : '';
      return `已发布${ATTENDANCE_MODES[result.mode]}：共 ${total} 名学生待签到${endAt ? `，截止 ${endAt}` : ''}。`;
    }
    if (tool === 'makeup_attendance') {
      return `已为学号 ${args?.student_no} 完成补签${args?.reason ? `（原因：${args.reason}）` : ''}。`;
    }
    return '操作已完成。';
  }
}
