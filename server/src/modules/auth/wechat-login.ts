import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class WechatLogin {
  async exchange(code: string): Promise<{ appId: string; openId: string }> {
    const appId = process.env.WX_APP_ID?.trim();
    const secret = process.env.WX_APP_SECRET?.trim();
    if (!appId || appId.length > 64 || !secret) {
      throw new ServiceUnavailableException('微信登录尚未配置');
    }

    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: appId, secret, js_code: code, grant_type: 'authorization_code',
    }).toString();

    let result: { openid?: unknown; errcode?: unknown } | null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error();
      result = await response.json();
    } catch {
      // The URL contains the AppSecret. Never log the request or upstream error.
      throw new ServiceUnavailableException('微信登录暂不可用，请重新获取登录凭证');
    }
    if (!result || (result.errcode !== undefined && result.errcode !== 0)
      || typeof result.openid !== 'string' || !result.openid.trim() || result.openid.length > 128) {
      throw new UnauthorizedException('微信登录凭证无效，请重新登录');
    }
    return { appId, openId: result.openid };
  }
}
