import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { GraduationCap } from 'lucide-react-taro';
import { bindStudent, studentLogin, teacherLogin, getMe } from '@/api';
import { setSession, getToken } from '@/utils/storage';

export default function IndexPage() {
  const [role, setRole] = useState<'student' | 'teacher'>('student');
  const [studentNo, setStudentNo] = useState('');
  const [studentName, setStudentName] = useState('');
  const [bindingCode, setBindingCode] = useState('');
  const [teacherName, setTeacherName] = useState('');
  const [teacherCode, setTeacherCode] = useState('');
  const [loading, setLoading] = useState(false);

  const redirectByRole = (r: string) => {
    Taro.redirectTo({
      url: r === 'teacher' ? '/pages/teacher/index' : '/pages/student/index',
    });
  };

  useLoad(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const me = await getMe();
      redirectByRole(me.role);
    } catch {
      // 未登录或登录失效，停留在入口页
    }
  });

  const showErr = (e: unknown) => {
    Taro.showToast({ title: (e as Error).message || '操作失败', icon: 'none' });
  };

  const handleStudentSubmit = async () => {
    if (!studentNo.trim() || !studentName.trim()) {
      Taro.showToast({ title: '请填写学号与姓名', icon: 'none' });
      return;
    }
    const isFirstBind = bindingCode.trim().length > 0;
    setLoading(true);
    try {
      const res = isFirstBind
        ? await bindStudent({
            student_no: studentNo.trim(),
            name: studentName.trim(),
            binding_code: bindingCode.trim(),
          })
        : await studentLogin({
            student_no: studentNo.trim(),
            name: studentName.trim(),
          });
      setSession(res.token, res.user);
      Taro.showToast({ title: isFirstBind ? '绑定成功' : '登录成功', icon: 'success' });
      redirectByRole('student');
    } catch (e) {
      showErr(e);
    } finally {
      setLoading(false);
    }
  };

  const handleTeacherSubmit = async () => {
    if (!teacherName.trim() || !teacherCode.trim()) {
      Taro.showToast({ title: '请填写姓名与教师口令', icon: 'none' });
      return;
    }
    setLoading(true);
    try {
      const res = await teacherLogin({ name: teacherName.trim(), teacher_code: teacherCode.trim() });
      setSession(res.token, res.user);
      Taro.showToast({ title: '登录成功', icon: 'success' });
      redirectByRole('teacher');
    } catch (e) {
      showErr(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className="min-h-full flex flex-col px-5 py-10">
      <View className="flex flex-col items-center mb-8">
        <View className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mb-4">
          <GraduationCap size={36} color="#ffffff" />
        </View>
        <Text className="block text-2xl font-bold text-foreground">智能课堂签到助手</Text>
        <Text className="block text-sm text-muted-foreground mt-2">
          AI 驱动的课堂签到与考勤管理
        </Text>
      </View>

      <Card>
        <CardContent className="p-5">
          <Tabs value={role} onValueChange={(v) => setRole(v as 'student' | 'teacher')}>
            <TabsList className="w-full">
              <TabsTrigger value="student" className="flex-1">我是学生</TabsTrigger>
              <TabsTrigger value="teacher" className="flex-1">我是教师</TabsTrigger>
            </TabsList>

            <TabsContent value="student" className="mt-5 flex flex-col gap-4">
              <View>
                <Text className="block text-sm font-medium text-foreground mb-2">学号</Text>
                <Input
                  type="text"
                  placeholder="请输入学号，如 20260001"
                  value={studentNo}
                  onInput={(e) => setStudentNo((e as any).detail.value)}
                />
              </View>
              <View>
                <Text className="block text-sm font-medium text-foreground mb-2">姓名</Text>
                <Input
                  type="text"
                  placeholder="请输入姓名"
                  value={studentName}
                  onInput={(e) => setStudentName((e as any).detail.value)}
                />
              </View>
              <View>
                <Text className="block text-sm font-medium text-foreground mb-2">
                  绑定码（首次绑定必填）
                </Text>
                <Input
                  type="text"
                  placeholder="已绑定的同学可留空直接登录"
                  value={bindingCode}
                  onInput={(e) => setBindingCode((e as any).detail.value)}
                />
              </View>
              <Button className="w-full" disabled={loading} onClick={handleStudentSubmit}>
                进入
              </Button>
            </TabsContent>

            <TabsContent value="teacher" className="mt-5 flex flex-col gap-4">
              <View>
                <Text className="block text-sm font-medium text-foreground mb-2">姓名</Text>
                <Input
                  type="text"
                  placeholder="请输入教师姓名"
                  value={teacherName}
                  onInput={(e) => setTeacherName((e as any).detail.value)}
                />
              </View>
              <View>
                <Text className="block text-sm font-medium text-foreground mb-2">教师口令</Text>
                <Input
                  type="text"
                  placeholder="请输入管理员分发的教师口令"
                  value={teacherCode}
                  onInput={(e) => setTeacherCode((e as any).detail.value)}
                />
              </View>
              <Button className="w-full" disabled={loading} onClick={handleTeacherSubmit}>
                教师登录
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Text className="block text-center text-xs text-muted-foreground mt-8">
        学生首次凭绑定码绑定，之后凭学号+姓名登录；教师凭管理员口令登录
      </Text>
    </View>
  );
}