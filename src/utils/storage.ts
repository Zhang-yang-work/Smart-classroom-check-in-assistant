import Taro from '@tarojs/taro';

const TOKEN_KEY = 'attendance_token';
const USER_KEY = 'attendance_user';

export function getToken(): string {
  return Taro.getStorageSync(TOKEN_KEY) || '';
}

export function setSession(token: string, user: Record<string, any>): void {
  Taro.setStorageSync(TOKEN_KEY, token);
  Taro.setStorageSync(USER_KEY, user);
}

export function getUser(): Record<string, any> | null {
  return Taro.getStorageSync(USER_KEY) || null;
}

export function clearSession(): void {
  Taro.removeStorageSync(TOKEN_KEY);
  Taro.removeStorageSync(USER_KEY);
}