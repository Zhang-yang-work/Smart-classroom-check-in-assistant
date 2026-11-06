import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CoursesService, UploadedFileLike } from './courses.service';
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

  @Post(':id/groups')
  createGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.coursesService.createGroup(user, id, body?.name);
  }

  @Post(':id/groups/:groupId/roster/import')
  async importRoster(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Body() body: any,
  ) {
    return this.coursesService.importRoster(user, id, groupId, body?.students);
  }

  @Post(':id/groups/:groupId/roster/import-excel')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async importExcel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.coursesService.importRosterExcel(user, id, groupId, file);
  }

  @Get(':id/groups/:groupId/roster')
  async getRoster(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('groupId') groupId: string) {
    return this.coursesService.getRoster(user, id, groupId);
  }
}
