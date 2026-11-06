import { useState } from 'react';
import Taro, { useDidHide, useDidShow, useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { adjustAttendance, endTask, getTaskDetail } from '@/api';
import { formatDateTime, modeText, statusText } from '@/utils/format';
import type { AttendanceSummary, FinalAttendanceStatus, TaskDetail, Participant } from '@/api/types';
import { QrDisplay } from './qr-display';

const FINAL_STATUSES: FinalAttendanceStatus[] = ['present', 'late', 'excused', 'absent'];

function Summary({ name, stats, active }: { name: string; stats: AttendanceSummary; active: boolean }) {
  return (
    <View className="flex flex-col gap-1">
      <Text className="block text-sm font-semibold">{name} · 应到 {stats.total} 人</Text>
      <View className="flex flex-wrap gap-2">
        {FINAL_STATUSES.map(status => (
          <Badge key={status} variant="outline">{statusText(status)} {stats[status]}</Badge>
        ))}
        {active && <Badge variant="secondary">未签到 {stats.unsigned}</Badge>}
      </View>
    </View>
  );
}

export default function DetailPage() {
  const [taskId, setTaskId] = useState('');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Participant | null>(null);
  const [nextStatus, setNextStatus] = useState<FinalAttendanceStatus>('present');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [visible, setVisible] = useState(true);
  useDidShow(() => setVisible(true));
  useDidHide(() => setVisible(false));

  async function load(id: string) {
    if (!id) { setLoading(false); return; }
    setLoading(true);
    try {
      setDetail(await getTaskDetail(id));
    } catch (err) {
      Taro.showToast({ title: (err as Error).message, icon: 'none' });
    } finally {
      setLoading(false);
    }
  }

  useLoad(options => {
    const id = options.id ?? '';
    setTaskId(id);
    void load(id);
  });

  async function save() {
    if (!selected || !reason.trim()) return;
    setSaving(true);
    try {
      await adjustAttendance(taskId, { student_no: selected.student_no, status: nextStatus, reason: reason.trim() });
      setSelected(null);
      await load(taskId);
    } catch (err) {
      Taro.showToast({ title: (err as Error).message, icon: 'none' });
    } finally {
      setSaving(false);
    }
  }

  async function end() {
    setSaving(true);
    try {
      await endTask(taskId);
      setConfirmEnd(false);
      await load(taskId);
    } catch (err) {
      Taro.showToast({ title: (err as Error).message, icon: 'none' });
    } finally {
      setSaving(false);
    }
  }

  const active = detail?.task.status === 'active';
  const task = detail?.task;
  return (
    <View className="min-h-full flex flex-col gap-4 px-5 py-6 pb-10">
      {loading ? <Skeleton className="h-28 w-full rounded-lg" /> : !task ? (
        <Text className="block text-sm text-muted-foreground">任务不可用</Text>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-2 p-4">
              <View className="flex items-center justify-between gap-2">
                <Text className="block text-lg font-bold">{task.course_name || '签到详情'}</Text>
                <Badge variant={active ? 'default' : 'secondary'}>{active ? '进行中' : '已结束'}</Badge>
              </View>
              <Text className="block text-xs text-muted-foreground">
                {modeText(task.mode)}{task.location_name ? ` · ${task.location_name} · ${task.location_radius_m} 米` : ''}
              </Text>
              <Text className="block text-xs text-muted-foreground">
                正常截止 {formatDateTime(task.normal_end_at || task.end_at)}
                {task.normal_end_at && task.normal_end_at !== task.end_at ? ` · 迟到截止 ${formatDateTime(task.end_at)}` : ''}
              </Text>
              {task.ended_at && <Text className="block text-xs text-muted-foreground">提前结束于 {formatDateTime(task.ended_at)}</Text>}
              {visible && active && !confirmEnd && !selected && detail?.summary && task.mode === 'qr' && <QrDisplay taskId={task.id} />}
              <View className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => load(taskId)}>刷新统计</Button>
                {active && detail?.summary && <Button size="sm" variant="destructive" onClick={() => setConfirmEnd(true)}>提前结束</Button>}
              </View>
            </CardContent>
          </Card>

          {detail?.summary && (
            <Card><CardContent className="flex flex-col gap-4 p-4">
              <Summary name="整体统计" stats={detail.summary} active={active} />
              {detail.groups?.map(group => (
                <Summary key={group.id ?? 'historical'} name={group.name} stats={group.summary} active={active} />
              ))}
            </CardContent></Card>
          )}

          <Card><CardContent className="flex flex-col gap-3 p-4">
            <Text className="block text-sm font-semibold">签到名单</Text>
            {!detail?.participants?.length && <Text className="block text-sm text-muted-foreground">暂无名单</Text>}
            {detail?.participants?.map(person => (
              <View key={person.student_no} className="flex items-center justify-between gap-2 border-b border-border pb-2">
                <View className="flex-1">
                  <Text className="block text-sm">{person.student_name}（{person.student_no}）</Text>
                  <Text className="block text-xs text-muted-foreground">
                    {person.group_name || '历史名单'} · {statusText(person.status)}
                  </Text>
                  {person.makeup_reason && <Text className="block text-xs text-muted-foreground">调整原因：{person.makeup_reason}</Text>}
                </View>
                <Button size="sm" variant="outline" onClick={() => {
                  setSelected(person);
                  setNextStatus(person.status === 'unsigned' ? 'present' : person.status);
                  setReason('');
                }}
                >调整</Button>
              </View>
            ))}
          </CardContent></Card>
        </>
      )}

      <Dialog open={!!selected} onOpenChange={open => { if (!open && !saving) setSelected(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>调整 {selected?.student_name} 的考勤</DialogTitle></DialogHeader>
          <View className="flex flex-wrap gap-2">
            {FINAL_STATUSES.map(status => (
              <Button key={status} size="sm" variant={nextStatus === status ? 'default' : 'outline'}
                onClick={() => setNextStatus(status)}
              >{statusText(status)}</Button>
            ))}
          </View>
          <Textarea placeholder="填写调整原因" maxlength={256} value={reason} onInput={event => setReason(event.detail.value)} />
          <DialogFooter><Button disabled={saving || !reason.trim()} onClick={save}>保存调整</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmEnd} onOpenChange={open => !saving && setConfirmEnd(open)}>
        <DialogContent>
          <DialogHeader><DialogTitle>提前结束签到</DialogTitle></DialogHeader>
          <Text className="block text-sm">结束后学生将无法继续签到，已保存的签到结果和参与名单会保留。</Text>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setConfirmEnd(false)}>取消</Button>
            <Button variant="destructive" disabled={saving} onClick={end}>确认结束</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
