import Taro from '@tarojs/taro';
import { logoutSession } from '@/api';
import { clearSession } from '@/utils/storage';

export async function logout() {
  let revoked = false;
  try {
    await logoutSession();
    revoked = true;
  } catch {
    // An offline device can clear local storage even when remote revocation is unconfirmed.
  }
  clearSession();
  await Taro.reLaunch({ url: '/pages/index/index?signedOut=1' });
  if (!revoked) Taro.showToast({ title: '已退出本机，服务端撤销未确认', icon: 'none' });
}
