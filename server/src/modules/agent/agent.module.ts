import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AttendanceModule } from '@/modules/attendance/attendance.module';

@Module({
  imports: [AttendanceModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}