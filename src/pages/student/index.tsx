import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { LogOut } from 'lucide-react-taro';
import { listStudentTasks, signIn } from '@/api';
import { getUser, clearSession } from '@/utils/storage';
import { formatDateTime, statusText } from '@/utils/format';
import type { Task } from '@/api/types';

function countdownLeft(endAt: string): string {
  const ms = new Date(endAt).getTime() - Date.now();
  if (ms <= 0) return '已截止';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '即将截止';
  return `剩余 ${minutes} 分钟`;
}

export default function StudentPage() {
  const [ongoing, setOngoing] = useState<Task[]>([]);
  const [history, setHistory] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingId, setSigningId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await listStudentTasks();
      setOngoing(res.ongoing || []);
      setHistory(res.history || []);
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

  const doSign = async (taskId: string) => {
    setSigningId(taskId);
    try {
      await signIn(taskId);
      Taro.showToast({ title: '签到成功', icon: 'success' });
      await load();
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setSigningId('');
    }
  };

  const logout = () => {
    clearSession();
    Taro.redirectTo({ url: '/pages/index/index' });
  };

  return (
    <View className="min-h-full flex flex-col px-5 py-6 pb-10">
      <View className="flex items-center justify-between mb-6">
        <View>
          <Text className="block text-xl font-bold text-foreground">
            {user?.name || '同学'}，你好
          </Text>
          <Text className="block text-sm text-muted-foreground mt-1">
            学号 {user?.student_no || '-'}
          </Text>
        </View>
        <View className="flex items-center gap-2">
          <Badge variant="secondary">学生</Badge>
          <Button variant="ghost" size="icon" onClick={logout}>
            <LogOut size={18} color="#000" />
          </Button>
        </View>
      </View>

      {loading ? (
        <View className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </View>
      ) : (
        <>
          <Text className="block text-sm font-semibold text-foreground mb-3">进行中的签到</Text>
          {ongoing.length === 0 ? (
            <Card>
              <CardContent className="p-6">
                <Text className="block text-center text-sm text-muted-foreground">
                  暂无进行中的签到，请留意课堂通知
                </Text>
              </CardContent>
            </Card>
          ) : (
            <View className="flex flex-col gap-3">
              {ongoing.map((t) => (
                <Card key={t.id}>
                  <CardContent className="p-4">
                    <View className="flex items-start justify-between">
                      <View className="flex-1">
                        <Text className="block text-base font-semibold text-foreground">
                          {t.course_name}
                        </Text>
                        <Text className="block text-xs text-muted-foreground mt-1">
                          {formatDateTime(t.start_at)} 发布 · {countdownLeft(t.end_at)}
                        </Text>
                      </View>
                      {t.my_status === 'signed' ? (
                        <Badge>已签到</Badge>
                      ) : (
                        <Button
                          size="sm"
                          disabled={signingId === t.id}
                          onClick={() => doSign(t.id)}
                        >
                          立即签到
                        </Button>
                      )}
                    </View>
                  </CardContent>
                </Card>
              ))}
            </View>
          )}

          <Separator className="my-6" />

          <Text className="block text-sm font-semibold text-foreground mb-3">签到历史</Text>
          {history.length === 0 ? (
            <Card>
              <CardContent className="p-6">
                <Text className="block text-center text-sm text-muted-foreground">
                  暂无历史记录
                </Text>
              </CardContent>
            </Card>
          ) : (
            <View className="flex flex-col gap-3">
              {history.map((t) => (
                <Card key={t.id}>
                  <CardContent className="p-4">
                    <View className="flex items-center justify-between">
                      <View className="flex-1">
                        <Text className="block text-base font-semibold text-foreground">
                          {t.course_name}
                        </Text>
                        <Text className="block text-xs text-muted-foreground mt-1">
                          {formatDateTime(t.start_at)}
                        </Text>
                      </View>
                      <Badge variant={t.my_status === 'unsigned' ? 'destructive' : 'secondary'}>
                        {statusText(t.my_status)}
                      </Badge>
                    </View>
                  </CardContent>
                </Card>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}