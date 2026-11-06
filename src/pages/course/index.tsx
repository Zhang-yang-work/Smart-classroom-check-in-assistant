import { useRef, useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { listCourses, createCourse, createGroup, importRoster, getRoster, importRosterExcel } from '@/api';
import type { Course, RosterItem, TeachingGroup } from '@/api/types';

type GroupTarget = TeachingGroup & { courseId: string };

export default function CoursePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseName, setCourseName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [openCourse, setOpenCourse] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<GroupTarget | null>(null);
  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<GroupTarget | null>(null);
  const isWeb = Taro.getEnv() === Taro.ENV_TYPE.WEB;

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : '操作失败，请重试', icon: 'none' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    setCourses(await listCourses());
  }
  useLoad(() => { void run(refresh); });

  async function refreshRoster(target: GroupTarget) {
    setRoster(await getRoster(target.courseId, target.id));
  }

  function showRoster(course: Course, group: TeachingGroup) {
    void run(async () => {
      const target = { ...group, courseId: course.id };
      const members = await getRoster(target.courseId, target.id);
      setSelectedGroup(target);
      setRoster(members);
    });
  }

  function addCourse() {
    void run(async () => {
      const course = await createCourse(courseName.trim());
      setCourseName('');
      setOpenCourse(course.id);
      setSelectedGroup(null);
      setGroupName('');
      await refresh();
    });
  }

  function addGroup(course: Course) {
    void run(async () => {
      const group = await createGroup(course.id, groupName.trim());
      setGroupName('');
      await refresh();
      setSelectedGroup({ ...group, courseId: course.id });
      setRoster([]);
    });
  }

  async function upload(target: GroupTarget, path: string, fileName?: string) {
    const rows = await importRosterExcel(target.courseId, target.id, path, fileName);
    await refreshRoster(target);
    Taro.showToast({ title: `已导入 ${rows.length} 人`, icon: 'success' });
  }

  function selectExcel(target: GroupTarget) {
    if (isWeb) {
      uploadTarget.current = target;
      fileInput.current?.click();
      return;
    }
    Taro.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'xls'],
      success: ({ tempFiles }) => {
        const path = tempFiles[0]?.path;
        if (path) void run(() => upload(target, path));
      },
    });
  }

  function importPasted() {
    if (!selectedGroup) return;
    const target = selectedGroup;
    void run(async () => {
      const rows = pasteText.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const [student_no, ...name] = line.split(/[,，\t\s]+/);
        return { student_no, student_name: name.join(' ') };
      });
      const added = await importRoster(target.courseId, target.id, rows);
      setPasteOpen(false);
      setPasteText('');
      await refreshRoster(target);
      Taro.showToast({ title: `已导入 ${added.length} 人`, icon: 'success' });
    });
  }

  return (
    <View className="min-h-full flex flex-col gap-4 px-5 py-6 pb-10">
      <Text className="block text-lg font-bold">课程与教学班</Text>
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <Input placeholder="新课程名称" value={courseName} maxlength={128} onInput={e => setCourseName(e.detail.value)} />
          <Button disabled={busy || !courseName.trim()} onClick={addCourse}>创建课程</Button>
        </CardContent>
      </Card>
      {courses.map(course => (
        <Card key={course.id}>
          <CardContent className="flex flex-col gap-3 p-4">
            <Button variant="outline" disabled={busy} onClick={() => {
              setOpenCourse(openCourse === course.id ? '' : course.id);
              setSelectedGroup(null);
              setGroupName('');
            }}
            >{course.name} · {course.groups?.length ?? 0} 个教学班</Button>
            {openCourse === course.id && (
              <>
                <Input placeholder="新教学班名称" value={groupName} maxlength={128} onInput={e => setGroupName(e.detail.value)} />
                <Button disabled={busy || !groupName.trim()} onClick={() => addGroup(course)}>创建教学班</Button>
                <View className="flex flex-wrap gap-2">
                  {course.groups?.map(group => (
                    <Button key={group.id} size="sm" disabled={busy}
                      variant={selectedGroup?.id === group.id ? 'default' : 'outline'}
                      onClick={() => showRoster(course, group)}
                    >{group.name}</Button>
                  ))}
                </View>
                {selectedGroup?.courseId === course.id && (
                  <>
                    <Text className="block text-sm font-semibold">{selectedGroup.name} · 学生名单</Text>
                    <View className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => selectExcel(selectedGroup)}>Excel 导入</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setPasteText(''); setPasteOpen(true); }}>粘贴导入</Button>
                    </View>
                    {roster.length === 0 && <Text className="block text-sm text-muted-foreground">名单为空</Text>}
                    {roster.map(row => (
                      <Text key={row.id} className="block text-sm">{row.student_name}（{row.student_no}）</Text>
                    ))}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ))}
      <Dialog open={pasteOpen} onOpenChange={open => !busy && setPasteOpen(open)}>
        <DialogContent>
          <DialogHeader><DialogTitle>导入 {selectedGroup?.name} 名单</DialogTitle></DialogHeader>
          <Textarea placeholder="每行一条，格式：学号,姓名" value={pasteText} onInput={e => setPasteText(e.detail.value)} />
          <DialogFooter><Button disabled={busy || !pasteText.trim()} onClick={importPasted}>确认导入</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {isWeb && (
        <input ref={fileInput} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            const target = uploadTarget.current;
            event.currentTarget.value = '';
            if (!file || !target) return;
            void run(async () => {
              const url = URL.createObjectURL(file);
              // A Blob URL preserves the bytes, but Taro needs the original name for multipart.
              try { await upload(target, url, file.name); } finally { URL.revokeObjectURL(url); }
            });
          }}
        />
      )}
    </View>
  );
}
