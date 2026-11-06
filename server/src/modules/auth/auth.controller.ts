import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard, CurrentUser, readSessionToken } from '@/common/auth';
import type { AuthUser } from '@/common/auth';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('wechat/login')
  login(@Body() body: unknown) {
    return this.authService.login(body);
  }

  @Post('student/bind')
  bind(@Headers('authorization') authorization: unknown, @Body() body: unknown) {
    return this.authService.bindStudent(readSessionToken(authorization), body);
  }

  @Post('teacher/activate')
  activate(@Headers('authorization') authorization: unknown, @Body() body: unknown) {
    return this.authService.activateTeacher(readSessionToken(authorization), body);
  }

  @Post('logout')
  logout(@Headers('authorization') authorization: unknown) {
    return this.authService.logout(readSessionToken(authorization));
  }

  @UseGuards(AuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
