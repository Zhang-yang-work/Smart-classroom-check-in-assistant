import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Plus, Users } from 'lucide-react-taro';
import { listCourses, createCourse, importRoster, getRoster } from '@/api';
import type { Course, RosterItem } from '@/api/types';

function parseRoster(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,，\t\s]+/);
      return { student_no: parts[0] || '', student_name: parts.slice(1).join('') };
    })
    .filter((s) => s.student_no && s.student_name);
}

export default function CoursePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState('');
  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCourseId, setImportCourseId] = useState('');
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setCourses((await listCourses()) || []);
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setLoading(false);
    }
  };

  useLoad(() => {
    load();
  });

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      Taro.showToast({ title: '请输入课程名称', icon: 'none' });
      return;
    }
    try {
      await createCourse(name);
      Taro.showToast({ title: '课程已创建', icon: 'success' });
      setNewName('');
      await load();
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    }
  };

  const toggleCourse = async (courseId: string) => {
    if (expandedId === courseId) {
      setExpandedId('');
      return;
    }
    setExpandedId(courseId);
    setRosterLoading(true);
    try {
      setRoster((await getRoster(courseId)) || []);
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setRosterLoading(false);
    }
  };

  const openImport = (courseId: string) => {
    setImportCourseId(courseId);
    setImportText('');
    setImportOpen(true);
  };

  const handleImport = async () => {
    const students = parseRoster(importText);
    if (students.length === 0) {
      Taro.showToast({ title: '请按「学号,姓名」每行一条粘贴名单', icon: 'none' });
      return;
    }
    setImporting(true);
    try {
      await importRoster(importCourseId, students);
      Taro.showToast({ title: `已导入 ${students.length} 人`, icon: 'success' });
      setImportOpen(false);
      if (expandedId === importCourseId) {
        setRoster((await getRoster(importCourseId)) || []);
      }
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <View className="min-h-full flex flex-col px-5 py-6 pb-10">
      <View className="flex items-center gap-2 mb-4">
        <Users size={18} color="#16a34a" />
        <Text className="block text-lg font-bold text-foreground">课程与名单管理</Text>
      </View>

      <Card className="mb-5">
        <CardContent className="p-4">
          <Text className="block text-sm font-medium text-foreground mb-2">创建新课程</Text>
          <View style={{ display: 'flex', flexDirection: 'row', gap: '8px' }}>
            <View style={{ flex: 1 }}>
              <Input
                type="text"
                placeholder="请输入课程名称"
                value={newName}
                onInput={(e) => setNewName((e as any).detail.value)}
              />
            </View>
            <View style={{ flexShrink: 0 }}>
              <Button onClick={handleCreate}>
                <Plus size={18} color="#fff" />
              </Button>
            </View>
          </View>
        </CardContent>
      </Card>

      {loading ? (
        <View className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </View>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <Text className="block text-center text-sm text-muted-foreground">
              暂无课程，请先创建课程
            </Text>
          </CardContent>
        </Card>
      ) : (
        <View className="flex flex-col gap-3">
          {courses.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-4">
                <View className="flex items-center justify-between">
                  <Text className="block text-base font-semibold text-foreground">{c.name}</Text>
                  <View className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => openImport(c.id)}>
                      导入名单
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleCourse(c.id)}>
                      {expandedId === c.id ? '收起' : '查看名单'}
                    </Button>
                  </View>
                </View>

                {expandedId === c.id && (
                  <View className="mt-4">
                    <Separator className="mb-3" />
                    {rosterLoading ? (
                      <Skeleton className="h-16 w-full rounded-lg" />
                    ) : roster.length === 0 ? (
                      <Text className="block text-sm text-muted-foreground py-2">
                        名单为空，请先导入学生
                      </Text>
                    ) : (
                      <View className="flex flex-col gap-2">
                        {roster.map((item) => (
                          <View
                            key={item.id}
                            className="flex items-center justify-between py-2 border-b border-border last:border-0"
                          >
                            <View>
                              <Text className="block text-sm text-foreground">
                                {item.student_name}（{item.student_no}）
                              </Text>
                              <Text className="block text-xs text-muted-foreground mt-1">
                                绑定码 {item.binding_code}
                              </Text>
                            </View>
                            <Badge variant={item.linked_user_id ? 'secondary' : 'outline'}>
                              {item.linked_user_id ? '已绑定' : '未绑定'}
                            </Badge>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}
              </CardContent>
            </Card>
          ))}
        </View>
      )}

      {/* 导入名单弹窗 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入学生名单</DialogTitle>
          </DialogHeader>
          <View className="mt-2">
            <Text className="block text-xs text-muted-foreground mb-2">
              每行一条，格式：学号,姓名（逗号/空格分隔均可）
            </Text>
            <Textarea
              placeholder={'20260004,赵六\n20260005,孙七'}
              value={importText}
              onInput={(e) => setImportText((e as any).detail.value)}
              className="h-40"
            />
          </View>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button disabled={importing} onClick={handleImport}>
              确认导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}