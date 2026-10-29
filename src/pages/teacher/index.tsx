import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { LogOut, BookOpen, Sparkles, Plus, Clock } from 'lucide-react-taro';
import { listCourses, listTeacherTasks, createTask } from '@/api';
import { getUser, clearSession } from '@/utils/storage';
import { formatDateTime } from '@/utils/format';
import type { Course, Task } from '@/api/types';

const DURATIONS = [5, 10, 15];

export default function TeacherPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState('');
  const [duration, setDuration] = useState(5);
  const [customDuration, setCustomDuration] = useState('');
  const [publishing, setPublishing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [cs, ts] = await Promise.all([listCourses(), listTeacherTasks()]);
      setCourses(cs || []);
      setTasks(ts || []);
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setLoading(false);
    }
  };

  useLoad(() => {
    load();
  });

  const user = getUser();

  const logout = () => {
    clearSession();
    Taro.redirectTo({ url: '/pages/index/index' });
  };

  const openPublish = () => {
    setSelectedCourse('');
    setDuration(5);
    setCustomDuration('');
    setPublishOpen(true);
  };

  const doPublish = async () => {
    if (!selectedCourse) {
      Taro.showToast({ title: '请选择课程', icon: 'none' });
      return;
    }
    const minutes = Number(duration || customDuration);
    if (!minutes || minutes <= 0) {
      Taro.showToast({ title: '请设置签到时长', icon: 'none' });
      return;
    }
    setPublishing(true);
    try {
      await createTask({ course_id: selectedCourse, duration_minutes: minutes });
      Taro.showToast({ title: '签到已发布', icon: 'success' });
      setPublishOpen(false);
      await load();
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setPublishing(false);
    }
  };

  const goDetail = (taskId: string) => {
    Taro.navigateTo({ url: `/pages/detail/index?id=${taskId}` });
  };

  return (
    <View className="min-h-full flex flex-col px-5 py-6 pb-10">
      <View className="flex items-center justify-between mb-6">
        <View>
          <Text className="block text-xl font-bold text-foreground">
            {user?.name || '老师'} 的工作台
          </Text>
          <Text className="block text-sm text-muted-foreground mt-1">课堂签到管理</Text>
        </View>
        <View className="flex items-center gap-2">
          <Badge variant="secondary">教师</Badge>
          <Button variant="ghost" size="icon" onClick={logout}>
            <LogOut size={18} color="#000" />
          </Button>
        </View>
      </View>

      <View className="grid grid-cols-2 gap-3 mb-4">
        <Button
          variant="outline"
          className="h-auto flex-col py-3"
          onClick={() => Taro.navigateTo({ url: '/pages/course/index' })}
        >
          <BookOpen size={24} color="#16a34a" />
          <Text className="block text-sm mt-1">课程与名单</Text>
        </Button>
        <Button
          variant="outline"
          className="h-auto flex-col py-3"
          onClick={() => Taro.navigateTo({ url: '/pages/ai/index' })}
        >
          <Sparkles size={24} color="#16a34a" />
          <Text className="block text-sm mt-1">AI 智能助手</Text>
        </Button>
      </View>

      <Button className="w-full mb-6" onClick={openPublish}>
        <Plus size={18} color="#fff" />
        <Text className="text-white">发布签到</Text>
      </Button>

      <View className="flex items-center gap-2 mb-3">
        <Clock size={16} color="#6b7280" />
        <Text className="block text-sm font-semibold text-foreground">最近签到任务</Text>
      </View>

      {loading ? (
        <View className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </View>
      ) : tasks.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <Text className="block text-center text-sm text-muted-foreground">
              暂无签到任务，点击「发布签到」开始
            </Text>
          </CardContent>
        </Card>
      ) : (
        <View className="flex flex-col gap-3">
          {tasks.map((t) => (
            <Card key={t.id} className="active:opacity-80" onClick={() => goDetail(t.id)}>
              <CardContent className="p-4">
                <View className="flex items-center justify-between">
                  <Text className="block text-base font-semibold text-foreground">
                    {t.course_name}
                  </Text>
                  <Badge variant={t.status === 'active' ? 'default' : 'secondary'}>
                    {t.status === 'active' ? '进行中' : '已截止'}
                  </Badge>
                </View>
                <Text className="block text-xs text-muted-foreground mt-2">
                  {formatDateTime(t.start_at)} · 应到 {t.total ?? 0} 人
                </Text>
                <View className="flex items-center gap-3 mt-2">
                  <Text className="block text-xs">
                    <Text className="text-green-600">已签 {t.signed_count ?? 0}</Text>
                    {'  '}
                    <Text className="text-amber-600">补签 {t.makeup_count ?? 0}</Text>
                  </Text>
                </View>
              </CardContent>
            </Card>
          ))}
        </View>
      )}

      {/* 发布签到弹窗 */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发布签到</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col gap-4 mt-2">
            <View>
              <Text className="block text-sm font-medium text-foreground mb-2">选择课程</Text>
              {courses.length === 0 ? (
                <Text className="block text-sm text-muted-foreground">
                  暂无课程，请先到「课程与名单」创建
                </Text>
              ) : (
                <View className="flex flex-col gap-2">
                  {courses.map((c) => (
                    <Button
                      key={c.id}
                      variant={selectedCourse === c.id ? 'default' : 'outline'}
                      onClick={() => setSelectedCourse(c.id)}
                    >
                      {c.name}
                    </Button>
                  ))}
                </View>
              )}
            </View>
            <View>
              <Text className="block text-sm font-medium text-foreground mb-2">签到时长（分钟）</Text>
              <View className="flex items-center gap-2 mb-2">
                {DURATIONS.map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={duration === d && !customDuration ? 'default' : 'outline'}
                    onClick={() => {
                      setDuration(d);
                      setCustomDuration('');
                    }}
                  >
                    {d} 分钟
                  </Button>
                ))}
              </View>
              <Input
                type="number"
                placeholder="自定义时长（分钟）"
                value={customDuration}
                onInput={(e) => setCustomDuration((e as any).detail.value)}
              />
            </View>
          </View>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              取消
            </Button>
            <Button disabled={publishing} onClick={doPublish}>
              确认发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}