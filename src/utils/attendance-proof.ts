import Taro from '@tarojs/taro';

export async function currentLocation() {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) throw new Error('请在微信小程序中获取定位');
  let position: Awaited<ReturnType<typeof Taro.getLocation>>;
  try {
    position = await Taro.getLocation({
      type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 4000,
    });
  } catch (err) {
    const settings = await Taro.getSetting().catch(() => null);
    const detail = (err as { errMsg?: string } | undefined)?.errMsg ?? '';
    if (settings?.authSetting['scope.userLocation'] === false || /auth deny|auth denied|permission denied/i.test(detail)) {
      throw new Error('定位权限未开启，请在微信小程序设置和系统设置中允许定位后重试');
    }
    throw new Error('无法获取当前位置，请开启手机定位服务后重试');
  }
  const { latitude, longitude, accuracy } = position;
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 100) {
    throw new Error('定位精度不足，请到开阔处重试');
  }
  return { latitude, longitude, accuracy, captured_at_ms: Date.now() };
}

export async function scanAttendanceQr(expectedTaskId?: string) {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) throw new Error('请在微信小程序中扫码签到');
  let token: string;
  try {
    const scanned = await Taro.scanCode({ onlyFromCamera: true, scanType: ['qrCode'] });
    token = scanned.result;
  } catch (err) {
    const detail = (err as { errMsg?: string } | undefined)?.errMsg ?? '';
    if (/cancel/i.test(detail)) return null;
    throw new Error('无法扫码，请检查相机权限后重试');
  }
  const taskId = /^att1\.([A-Za-z0-9_-]{1,36})\./.exec(token)?.[1];
  if (!taskId || (expectedTaskId && taskId !== expectedTaskId)) {
    throw new Error('请扫描对应任务的签到二维码');
  }
  return { taskId, token };
}
