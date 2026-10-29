import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { getTaskDetail, makeup } from '@/api';
import { formatDateTime } from '@/utils/format';
import type { TaskDetail, Participant } from '@/api/types';

export default function DetailPage() {
  const [taskId, setTaskId] = useState('');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [makeupStudent, setMakeupStudent] = useState<Participant | null>(null);
  const [reason, setReason] = useState('');
  const [makeupLoading, setMakeupLoading] = useState(false);

  const load = async (id: string) => {
    setLoading(true);
    try {
      setDetail(await getTaskDetail(id));
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setLoading(false);
    }
  };

  useLoad((opts) => {
    const id = (opts as any)?.id || '';
    setTaskId(id);
    if (id) load(id);
  });

  const doMakeup = async () => {
    if (!makeupStudent) return;
    if (!reason.trim()) {
      Taro.showToast({ title: '请填写补签原因', icon: 'none' });
      return;
    }
    setMakeupLoading(true);
    try {
      await makeup(taskId, { student_no: makeupStudent.student_no, reason: reason.trim() });
      Taro.showToast({ title: '补签成功', icon: 'success' });
      setMakeupStudent(null);
      setReason('');
      await load(taskId);
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setMakeupLoading(false);
    }
  };

  const summary = detail?.summary;
  const participants = detail?.participants || [];

  return (
    <View className="min-h-full flex flex-col px-5 py-6 pb-10">
      {loading ? (
        <View className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </View>
      ) : !detail ? (
        <Text className="block text-center text-sm text-muted-foreground mt-10">任务不存在</Text>
      ) : (
        <>
          <Card className="mb-4">
            <CardContent className="p-4">
              <View className="flex items-center justify-between">
                <Text className="block text-lg font-bold text-foreground">
                  {detail.task.course_name || '签到详情'}
                </Text>
                <Badge variant={detail.task.status === 'active' ? 'default' : 'secondary'}>
                  {detail.task.status === 'active' ? '进行中' : '已截止'}
                </Badge>
              </View>
              <Text className="block text-xs text-muted-foreground mt-2">
                {formatDateTime(detail.task.start_at)} 发布 · 截止 {formatDateTime(detail.task.end_at)}
              </Text>
            </CardContent>
          </Card>

          <Card className="mb-5">
            <CardContent className="p-4">
              <View className="grid grid-cols-4 gap-2 text-center">
                <View>
                  <Text className="block text-xl font-bold text-foreground">{summary?.total ?? 0}</Text>
                  <Text className="block text-xs text-muted-foreground mt-1">应到</Text>
                </View>
                <View>
                  <Text className="block text-xl font-bold text-green-600">{summary?.signed ?? 0}</Text>
                  <Text className="block text-xs text-muted-foreground mt-1">已签</Text>
                </View>
                <View>
                  <Text className="block text-xl font-bold text-amber-600">{summary?.makeup ?? 0}</Text>
                  <Text className="block text-xs text-muted-foreground mt-1">补签</Text>
                </View>
                <View>
                  <Text className="block text-xl font-bold text-red-500">{summary?.absent ?? 0}</Text>
                  <Text className="block text-xs text-muted-foreground mt-1">缺勤</Text>
                </View>
              </View>
            </CardContent>
          </Card>

          <Text className="block text-sm font-semibold text-foreground mb-3">学生名单</Text>
          <Card>
            <CardContent className="p-2">
              {participants.length === 0 ? (
                <Text className="block text-center text-sm text-muted-foreground py-6">
                  名单为空
                </Text>
              ) : (
                <View className="flex flex-col">
                  {participants.map((p, idx) => (
                    <View key={p.student_no}>
                      {idx > 0 && <Separator className="my-1" />}
                      <View className="flex items-center justify-between py-2 px-2">
                        <View className="flex-1">
                          <Text className="block text-sm text-foreground">
                            {p.student_name}（{p.student_no}）
                          </Text>
                          {p.makeup_reason && (
                            <Text className="block text-xs text-muted-foreground mt-1">
                              原因：{p.makeup_reason}
                            </Text>
                          )}
                        </View>
                        <View className="flex items-center gap-2">
                          <Badge
                            variant={
                              p.status === 'absent'
                                ? 'destructive'
                                : p.status === 'signed'
                                  ? 'secondary'
                                  : 'default'
                            }
                          >
                            {p.status === 'signed' ? '已签到' : p.status === 'makeup' ? '已补签' : '缺勤'}
                          </Badge>
                          {p.status === 'absent' && (
                            <Button size="sm" variant="outline" onClick={() => setMakeupStudent(p)}>
                              补签
                            </Button>
                          )}
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* 补签弹窗 */}
      <Dialog open={!!makeupStudent} onOpenChange={(open) => !open && setMakeupStudent(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              为 {makeupStudent?.student_name}（{makeupStudent?.student_no}）补签
            </DialogTitle>
          </DialogHeader>
          <View className="mt-2">
            <Text className="block text-sm font-medium text-foreground mb-2">补签原因</Text>
            <Textarea
              placeholder="请输入补签原因"
              value={reason}
              onInput={(e) => setReason((e as any).detail.value)}
            />
          </View>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMakeupStudent(null)}>
              取消
            </Button>
            <Button disabled={makeupLoading} onClick={doMakeup}>
              确认补签
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}