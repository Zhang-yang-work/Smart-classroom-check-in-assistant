import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard, CurrentUser, AuthUser } from '@/common/auth';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('bind')
  async bind(@Body() body: any) {
    return this.authService.bindStudent(body);
  }

  @Post('student-login')
  async studentLogin(@Body() body: any) {
    return this.authService.studentLogin(body);
  }

  @Post('teacher-login')
  async teacherLogin(@Body() body: any) {
    return this.authService.teacherLogin(body);
  }

  @UseGuards(AuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return user;
  }
}