import { useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { LogOut, BookOpen, Sparkles, Plus, Clock } from 'lucide-react-taro';
import { listCourses, listTeacherTasks, createTask } from '@/api';
import { getUser } from '@/utils/storage';
import { logout } from '@/utils/logout';
import { formatDateTime } from '@/utils/format';
import type { Course, Task } from '@/api/types';

const DURATIONS = [5, 10, 15];

export default function TeacherPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [lateEnabled, setLateEnabled] = useState(true);
  const [lateMinutes, setLateMinutes] = useState('5');
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

  useDidShow(() => {
    load();
  });

  const user = getUser();

  const openPublish = () => {
    setSelectedCourse('');
    setGroupIds([]);
    setLateEnabled(true);
    setLateMinutes('5');
    setDuration(5);
    setCustomDuration('');
    setPublishOpen(true);
  };

  const doPublish = async () => {
    if (!selectedCourse || !groupIds.length) {
      Taro.showToast({ title: '请选择课程和教学班', icon: 'none' });
      return;
    }
    const minutes = customDuration.trim() ? Number(customDuration) : duration;
    const late = lateEnabled ? Number(lateMinutes) : 0;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440
      || !Number.isInteger(late) || late > 1440 || (lateEnabled && late < 1)) {
      Taro.showToast({ title: '请输入 1 至 1440 分钟的整数时长', icon: 'none' });
      return;
    }
    setPublishing(true);
    try {
      await createTask({ course_id: selectedCourse, group_ids: groupIds, duration_minutes: minutes, late_minutes: late });
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
                  {formatDateTime(t.start_at)} 发布 · {formatDateTime(t.ended_at || t.end_at)} 截止
                </Text>
              </CardContent>
            </Card>
          ))}
        </View>
      )}

      {/* 发布签到弹窗 */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发布普通签到</DialogTitle>
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
                      onClick={() => { setSelectedCourse(c.id); setGroupIds([]); }}
                    >
                      {c.name}
                    </Button>
                  ))}
                </View>
              )}
            </View>
            {selectedCourse && (
              <View className="flex flex-col gap-2">
                <Text className="block text-sm font-medium">教学班（可多选）</Text>
                <View className="flex flex-wrap gap-2">
                  {courses.find(course => course.id === selectedCourse)?.groups?.map(group => (
                    <Button key={group.id} size="sm" variant={groupIds.includes(group.id) ? 'default' : 'outline'}
                      onClick={() => setGroupIds(ids => ids.includes(group.id) ? ids.filter(id => id !== group.id) : [...ids, group.id])}
                    >
                      {group.name}
                    </Button>
                  ))}
                </View>
                {!courses.find(course => course.id === selectedCourse)?.groups?.length && (
                  <Text className="block text-sm text-muted-foreground">请先创建教学班并导入名单</Text>
                )}
              </View>
            )}
            <View>
              <Text className="block text-sm font-medium text-foreground mb-2">正常签到时长（分钟）</Text>
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
            <View className="flex flex-col gap-2">
              <Button size="sm" variant="outline" onClick={() => setLateEnabled(value => !value)}>
                迟到窗口：{lateEnabled ? '开启' : '关闭'}
              </Button>
              {lateEnabled && (
                <Input type="number" placeholder="迟到窗口时长（分钟）" value={lateMinutes}
                  onInput={event => setLateMinutes(event.detail.value)}
                />
              )}
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
