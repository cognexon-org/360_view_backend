import crypto from 'node:crypto';
import { config } from '../config.js';

export function hashOtp(phone: string, code: string): string {
  return crypto
    .createHmac('sha256', config.OTP_SECRET)
    .update(`${phone}:${code}`)
    .digest('hex');
}

export function randomOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export function safeObjectName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'asset.bin';
}
