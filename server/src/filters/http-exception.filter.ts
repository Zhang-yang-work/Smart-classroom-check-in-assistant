import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

/**
 * 统一错误响应信封：{ code: <httpStatus>, msg, data: null }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<any>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let msg: unknown = '服务器内部错误';
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        msg = res;
      } else if (res && typeof res === 'object') {
        const m = (res as any).message;
        msg = Array.isArray(m) ? m[0] : m || exception.message;
      }
    } else if (exception instanceof Error) {
      msg = exception.message;
    }

    response.status(status).json({ code: status, msg, data: null });
  }
}