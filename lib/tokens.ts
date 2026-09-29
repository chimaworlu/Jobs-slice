import { randomBytes } from 'crypto';

function generateRandomHexToken(byteLength: number): string {
  return randomBytes(byteLength).toString('hex');
}

export function generatePasswordResetToken(): string {
  return generateRandomHexToken(32);
}

export function generateVerificationCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1000000;
  return value.toString().padStart(6, '0');
}
