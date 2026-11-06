import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const coordinates = {
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
};
export const locationProof = z.object({
  ...coordinates,
  accuracy: z.number().positive().max(100),
  captured_at_ms: z.number().int().positive(),
});
export const locationCenter = z.object({ ...coordinates, accuracy: z.number().positive().max(100) });
const presetsSchema = z.array(z.object({
  ...coordinates,
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(128),
})).max(100);

export function locationPresets() {
  const value = process.env.ATTENDANCE_LOCATION_PRESETS;
  if (!value?.trim()) return [];
  try {
    const result = presetsSchema.parse(JSON.parse(value));
    if (new Set(result.map(preset => preset.id)).size !== result.length) throw new Error();
    return result;
  } catch {
    throw new ServiceUnavailableException('预设建筑配置无效，请联系管理员');
  }
}

const QR_INTERVAL_MS = 10_000;
const QR_PATTERN = /^att1\.([A-Za-z0-9_-]{1,36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;

export function requireQrSecret() {
  const secret = process.env.ATTENDANCE_QR_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new ServiceUnavailableException('二维码签到尚未配置');
  }
  return secret;
}

function qrSignature(payload: string) {
  return createHmac('sha256', requireQrSecret()).update(payload).digest('base64url');
}

export function issueQr(taskId: string, taskEndMs: number, now = Date.now()) {
  const expiresAt = Math.min((Math.floor(now / QR_INTERVAL_MS) + 1) * QR_INTERVAL_MS, taskEndMs);
  const payload = `att1.${taskId}.${expiresAt}`;
  return { token: `${payload}.${qrSignature(payload)}`, expiresAt };
}

export function validateQr(taskId: string, token: unknown, now = Date.now()) {
  const parsed = typeof token === 'string' && token.length <= 99 ? QR_PATTERN.exec(token) : null;
  if (!parsed || parsed[1] !== taskId) {
    throw new BadRequestException('二维码无效或不属于本次任务，请重新扫描');
  }
  const signature = qrSignature(`att1.${parsed[1]}.${parsed[2]}`);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(parsed[3]))) {
    throw new BadRequestException('二维码无效，请重新扫描');
  }
  const expiresAt = Number(parsed[2]);
  if (expiresAt <= now) throw new BadRequestException('二维码已过期，请扫描当前二维码');
  return expiresAt;
}
