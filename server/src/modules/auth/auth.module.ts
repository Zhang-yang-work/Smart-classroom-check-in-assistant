import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WechatLogin } from './wechat-login';

@Module({
  controllers: [AuthController],
  providers: [AuthService, WechatLogin],
})
export class AuthModule {}
