import { Module } from '@nestjs/common';
import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { CoursesModule } from '@/modules/courses/courses.module';
import { AttendanceModule } from '@/modules/attendance/attendance.module';
import { AgentModule } from '@/modules/agent/agent.module';
import { SeedService } from '@/seed/seed.service';

@Module({
  imports: [AuthModule, CoursesModule, AttendanceModule, AgentModule],
  controllers: [AppController],
  providers: [AppService, SeedService],
})
export class AppModule {}