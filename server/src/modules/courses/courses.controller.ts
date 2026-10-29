import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { AuthGuard, CurrentUser, AuthUser } from '@/common/auth';

@Controller('courses')
@UseGuards(AuthGuard)
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.coursesService.createCourse(user, body);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return this.coursesService.listCourses(user);
  }

  @Post(':id/roster/import')
  async importRoster(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.coursesService.importRoster(user, id, body.students || []);
  }

  @Get(':id/roster')
  async getRoster(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.coursesService.getRoster(user, id);
  }
}