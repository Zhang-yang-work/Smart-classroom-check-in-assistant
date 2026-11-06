import { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { Canvas, Text, View } from '@tarojs/components';
import { getAttendanceQr } from '@/api';
import { Button } from '@/components/ui/button';

const CANVAS_ID = 'attendance-qr';
const SIZE = 224;

function draw(rows: string[]) {
  const context = Taro.createCanvasContext(CANVAS_ID);
  context.setFillStyle('#ffffff');
  context.fillRect(0, 0, SIZE, SIZE);
  if (rows.length) {
    const cell = Math.floor(SIZE / (rows.length + 8));
    const offset = Math.floor((SIZE - cell * rows.length) / 2);
    context.setFillStyle('#000000');
    rows.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) {
        if (line[x] === '1') context.fillRect(offset + x * cell, offset + y * cell, cell, cell);
      }
    });
  }
  context.draw();
}

export function QrDisplay({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState('正在获取二维码…');
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFailed(false);
    setMessage('正在获取二维码…');
    const refresh = async (clear = false) => {
      try {
        if (clear) draw([]);
        const { rows, refresh_in_ms: refreshIn } = await getAttendanceQr(taskId);
        if (stopped) return;
        if (refreshIn > 200) {
          draw(rows);
          setMessage('请用学生微信小程序扫码 · 二维码约每 10 秒更新');
        }
        timer = setTimeout(() => {
          if (stopped) return;
          void refresh(true);
        }, Math.max(200, refreshIn));
      } catch (err) {
        if (stopped) return;
        setMessage(err instanceof Error ? err.message : '无法获取二维码，请重试');
        setFailed(true);
      }
    };
    Taro.nextTick(() => { if (!stopped) void refresh(); });
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [taskId, retry]);

  return (
    <View className="flex flex-col items-center gap-2 py-2">
      <Canvas canvasId={CANVAS_ID} id={CANVAS_ID} style={{ width: SIZE, height: SIZE, display: failed ? 'none' : 'block' }} />
      <Text className="block text-xs text-muted-foreground">{message}</Text>
      {failed && <Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>重新获取</Button>}
    </View>
  );
}
