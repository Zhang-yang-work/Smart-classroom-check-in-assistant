import { useRef, useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GraduationCap } from 'lucide-react-taro';
import { activateTeacher, ApiError, bindStudent, getMe, wechatLogin } from '@/api';
import type { User } from '@/api/types';
import { clearSession, getToken, setSession } from '@/utils/storage';

export default function IndexPage() {
  const [role, setRole] = useState<'student' | 'teacher'>('student');
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [ticket, setTicket] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;

  function enter(token: string, user: User) {
    setSession(token, user);
    Taro.redirectTo({ url: user.role === 'teacher' ? '/pages/teacher/index' : '/pages/student/index' });
  }

  async function perform(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  const login = () => perform(async () => {
    const current = getToken();
    if (current) {
      try {
        enter(current, await getMe());
        return;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) throw err;
        clearSession();
      }
    }
    const { code } = await Taro.login().catch(() => {
      throw new Error('无法获取微信登录凭证，请重试');
    });
    if (!code) throw new Error('无法获取微信登录凭证，请重试');
    const response = await wechatLogin(code);
    if ('binding_token' in response) setTicket(response.binding_token);
    else enter(response.token, response.user);
  });

  useLoad((options) => {
    if (isWeapp && options.signedOut !== '1') void login();
  });

  const bind = () => perform(async () => {
    const identity = { name: name.trim() };
    if (!number.trim() || !identity.name || (role === 'teacher' && !activationCode.trim())) {
      throw new Error(role === 'teacher' ? '请填写工号、姓名与激活码' : '请填写学号与姓名');
    }
    try {
      const response = role === 'student'
        ? await bindStudent(ticket, { ...identity, student_no: number.trim() })
        : await activateTeacher(ticket, {
            ...identity, employee_no: number.trim(), activation_code: activationCode.trim(),
          });
      setActivationCode('');
      enter(response.token, response.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setTicket('');
      throw err;
    }
  });

  function switchRole(value: string) {
    if (busy.current || (value !== 'student' && value !== 'teacher')) return;
    setRole(value);
    setNumber('');
    setName('');
    setActivationCode('');
    setError('');
  }

  return (
    <View className="min-h-full flex flex-col px-5 py-10">
      <View className="flex flex-col items-center mb-8">
        <View className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mb-4">
          <GraduationCap size={36} color="#ffffff" />
        </View>
        <Text className="block text-2xl font-bold text-foreground">智能课堂签到助手</Text>
        <Text className="block text-sm text-muted-foreground mt-2">AI 驱动的课堂签到与考勤管理</Text>
      </View>

      <Card>
        <CardContent className="p-5">
          {!isWeapp ? (
            <Text className="block text-sm text-muted-foreground">请在微信小程序中登录。当前页面仅用于界面预览。</Text>
          ) : !ticket ? (
            <Button className="w-full" disabled={loading} onClick={login}>
              {loading ? '正在登录…' : '微信登录'}
            </Button>
          ) : (
            <View className="flex flex-col gap-4">
              <Text className="block text-sm font-medium">首次登录，请绑定身份</Text>
              <Tabs value={role} onValueChange={switchRole}>
                <TabsList className="w-full">
                  <TabsTrigger value="student" className="flex-1">我是学生</TabsTrigger>
                  <TabsTrigger value="teacher" className="flex-1">我是教师</TabsTrigger>
                </TabsList>
              </Tabs>
              <Input
                type="text"
                maxlength={64}
                disabled={loading}
                placeholder={role === 'student' ? '请输入学号' : '请输入教师工号'}
                value={number}
                onInput={(event) => setNumber(event.detail.value)}
              />
              <Input
                type="text"
                maxlength={64}
                disabled={loading}
                placeholder="请输入姓名"
                value={name}
                onInput={(event) => setName(event.detail.value)}
              />
              {role === 'teacher' && (
                <Input
                  password
                  maxlength={43}
                  disabled={loading}
                  placeholder="请输入管理员发放的一次性激活码"
                  value={activationCode}
                  onInput={(event) => setActivationCode(event.detail.value)}
                />
              )}
              <Button className="w-full" disabled={loading} onClick={bind}>
                {loading ? '正在确认…' : role === 'student' ? '绑定学生身份' : '激活教师身份'}
              </Button>
            </View>
          )}
          {error && <Text className="block text-sm text-destructive mt-4">{error}</Text>}
        </CardContent>
      </Card>
    </View>
  );
}
