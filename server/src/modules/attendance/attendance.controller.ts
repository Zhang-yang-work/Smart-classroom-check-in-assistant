import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AuthGuard, CurrentUser, AuthUser } from '@/common/auth';

@Controller('attendance')
@UseGuards(AuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // 教师：创建签到任务
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.attendanceService.createTask(user, body);
  }

  // 教师：我的签到任务列表
  @Get('teacher')
  async listForTeacher(@CurrentUser() user: AuthUser) {
    return this.attendanceService.listTasksForTeacher(user);
  }

  // 学生：进行中 + 历史
  @Get('student')
  async listForStudent(@CurrentUser() user: AuthUser) {
    return this.attendanceService.listTasksForStudent(user);
  }

  @Get('location-presets')
  locationPresets(@CurrentUser() user: AuthUser) {
    return this.attendanceService.listLocationPresets(user);
  }

  @Get(':id/qr')
  @Header('Cache-Control', 'no-store')
  qr(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attendanceService.getQr(user, id);
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attendanceService.getTaskDetail(user, id);
  }

  // 学生：签到
  @Post(':id/sign')
  async signIn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body?: any) {
    return this.attendanceService.signIn(user, id, body);
  }

  @Post(':id/end')
  end(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attendanceService.end(user, id);
  }

  @Post(':id/adjust')
  adjust(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.attendanceService.adjust(user, id, body);
  }

  // 教师：补签
  @Post(':id/makeup')
  async makeup(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.attendanceService.makeup(user, id, body);
  }
}
