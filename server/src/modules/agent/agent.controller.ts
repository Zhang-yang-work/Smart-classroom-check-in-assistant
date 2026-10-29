import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AuthGuard, CurrentUser, AuthUser } from '@/common/auth';

@Controller('agent')
@UseGuards(AuthGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('chat')
  async chat(
    @CurrentUser() user: AuthUser,
    @Req() req: any,
    @Body() body: any,
  ) {
    return this.agentService.chat(user, req.headers || {}, body);
  }

  @Post('confirm')
  async confirm(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.agentService.confirm(user, body);
  }
}