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

  @Post(':id/roster/import')
  async importRoster(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.coursesService.importRoster(user, id, body.students || []);
  }

  @Post(':id/roster/import-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importExcel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.coursesService.importRosterExcel(user, id, file);
  }

  @Get(':id/roster')
  async getRoster(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.coursesService.getRoster(user, id);
  }
}