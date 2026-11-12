import { useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Bot, Send } from 'lucide-react-taro';
import { agentChat, agentConfirm, listLocationPresets } from '@/api';
import type { AttendanceLocation } from '@/api/types';
import { currentLocation } from '@/utils/attendance-proof';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  pendingId?: string;
  isConfirm?: boolean;
}

interface Pending {
  id: string;
  summary: string;
}

const WELCOME: ChatMsg = {
  role: 'assistant',
  content:
    '你好，我是你的 AI 签到助手。你可以让我：\n· 发布签到：「给数据库系统概论发一个 5 分钟签到」\n· 查看考勤：「统计刚才那次签到谁没来」\n· 补签：「给张三补签，原因生病请假」',
};

export default function AiPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [location, setLocation] = useState<AttendanceLocation>();
  const [locating, setLocating] = useState(false);
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([]);
  const [presetId, setPresetId] = useState('');
  const [presetError, setPresetError] = useState('');
  // The H5 fallback only supports WGS84; this project has no configured GCJ-02 JS-SDK bridge.
  const canLocate = Taro.getEnv() === Taro.ENV_TYPE.WEAPP && typeof Taro.getLocation === 'function';

  useDidShow(() => {
    void listLocationPresets().then(items => {
      setPresets(items);
      setPresetError('');
      setPresetId('');
    }).catch(() => {
      setPresets([]);
      setPresetId('');
      setPresetError('预设建筑加载失败，请稍后重新进入页面重试');
    });
  });

  const append = (msg: ChatMsg) => setMessages((prev) => [...prev, msg]);

  const attachLocation = async () => {
    if (!canLocate || sending || locating) return;
    setLocating(true);
    setLocation(undefined);
    setPresetId('');
    try {
      setLocation(await currentLocation());
    } catch (error) {
      append({ role: 'assistant', content: (error as Error).message });
    } finally {
      setLocating(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending || locating) return;
    const userMsg: ChatMsg = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setSending(true);
    setPending(null);
    setLocation(undefined);
    try {
      const res = await agentChat(history.map((m) => ({ role: m.role, content: m.content })), location, {
        location_supported: canLocate, location_preset_id: presetId || undefined,
      });
      if (res.type === 'reply') {
        append({ role: 'assistant', content: res.content || '（无响应）' });
      } else if (res.type === 'confirm') {
        const pendingId = res.pending_id || '';
        append({
          role: 'assistant',
          content: res.summary || '请确认操作',
          pendingId,
          isConfirm: true,
        });
        setPending({ id: pendingId, summary: res.summary || '' });
      }
    } catch (e) {
      const msg = (e as Error).message || '调用失败';
      append({ role: 'assistant', content: `⚠️ AI 服务调用失败：${msg}` });
    } finally {
      setSending(false);
    }
  };

  const confirmAction = async (approve: boolean) => {
    if (!pending || sending || locating) return;
    const { id } = pending;
    if (!approve) {
      setPending(null);
      append({ role: 'assistant', content: '已取消该操作。' });
      return;
    }
    setSending(true);
    try {
      const res = await agentConfirm(id);
      setPending(null);
      append({ role: 'assistant', content: res.content || '操作已完成。' });
    } catch (e) {
      append({ role: 'assistant', content: `⚠️ 操作失败：${(e as Error).message}` });
    } finally {
      setSending(false);
    }
  };

  return (
    <View className="h-full flex flex-col">
      <View className="flex items-center gap-2 px-5 py-4 border-b border-border">
        <View className="w-9 h-9 rounded-full bg-primary flex items-center justify-center">
          <Bot size={20} color="#ffffff" />
        </View>
        <View>
          <Text className="block text-base font-semibold text-foreground">AI 签到助手</Text>
          <Text className="block text-xs text-muted-foreground">真实工具调用 · 写入需你确认</Text>
        </View>
      </View>

      <ScrollArea className="flex-1" orientation="vertical">
        <View className="flex flex-col gap-3 px-5 py-4">
          {messages.map((m, idx) => {
            const isUser = m.role === 'user';
            const showPending = m.isConfirm && m.pendingId === pending?.id;
            return (
              <View key={idx} className={isUser ? 'flex justify-end' : 'flex justify-start'}>
                <View className={isUser ? 'max-w-[85%]' : 'max-w-[85%]'}>
                  <Card className={isUser ? 'bg-primary border-0' : ''}>
                    <CardContent className="p-3">
                      <Text
                        className={`block text-sm whitespace-pre-wrap ${
                          isUser ? 'text-primary-foreground' : 'text-foreground'
                        }`}
                      >
                        {m.content}
                      </Text>
                    </CardContent>
                  </Card>
                  {showPending && (
                    <View style={{ display: 'flex', flexDirection: 'row', gap: '8px', marginTop: '8px' }}>
                      <View style={{ flex: 1 }}>
                        <Button variant="outline" size="sm" onClick={() => confirmAction(false)}>
                          取消
                        </Button>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button size="sm" onClick={() => confirmAction(true)}>
                          确认执行
                        </Button>
                      </View>
                    </View>
                  )}
                </View>
              </View>
            );
          })}
          {sending && (
            <View className="flex justify-start">
              <Card>
                <CardContent className="p-3">
                  <Text className="block text-sm text-muted-foreground">思考中…</Text>
                </CardContent>
              </Card>
            </View>
          )}
        </View>
      </ScrollArea>

      <View className="px-5 py-2 flex flex-col gap-2">
        {canLocate ? (
          <Button variant="outline" size="sm" disabled={sending || locating} onClick={attachLocation}>
            {locating ? '正在定位…' : location ? '重新定位' : '附带当前位置'}
          </Button>
        ) : (
          <Text className="block text-xs text-muted-foreground">当前 WebView/H5 预览未接入可用定位，请选择预设建筑，或在原生微信小程序中定位。</Text>
        )}
        {location && <Text className="block text-xs text-muted-foreground">定位成功，精度约 {Math.round(location.accuracy)} 米，将随下一条消息发送</Text>}
        {presets.length > 0 ? (
          <Select value={presetId} onValueChange={id => { setPresetId(id); setLocation(undefined); }}>
            <SelectTrigger><SelectValue placeholder="位置签到可选择预设建筑" /></SelectTrigger>
            <SelectContent>
              {presets.map(preset => <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <Text className="block text-xs text-muted-foreground">{presetError || '暂无预设建筑；无法定位时请联系管理员配置建筑地点。'}</Text>
        )}
        {presetId && <Text className="block text-xs text-muted-foreground">已选择预设建筑，将随下一条消息发送</Text>}
      </View>

      <View
        style={{
          display: 'flex',
          flexDirection: 'row',
          gap: '8px',
          padding: '12px',
          borderTop: '1px solid #e5e5e5',
          backgroundColor: '#fff',
        }}
      >
        <View style={{ flex: 1 }}>
          <Textarea
            className="h-24"
            placeholder="输入你的需求，如：给数据库系统概论发一个 5 分钟签到"
            value={input}
            onInput={(e) => setInput((e as any).detail.value)}
          />
        </View>
        <View style={{ flexShrink: 0, alignSelf: 'flex-end' }}>
          <Button size="icon" disabled={sending || locating} onClick={send}>
            <Send size={18} color="#fff" />
          </Button>
        </View>
      </View>
    </View>
  );
}
