import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db';
import { resendLimiter, checkRateLimit } from '../../../../lib/rate-limit';
import { getClientIp } from '../../../../lib/get-client-ip';
import { verifyEmailSchema } from '../../../../lib/validations/auth';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validation = verifyEmailSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        message: validation.error.issues[0]?.message ?? 'Invalid request.',
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 }
    );
  }

  const ip = getClientIp(request);

  const { success, retryAfter } = await checkRateLimit(resendLimiter, ip);

  if (!success) {
    return NextResponse.json(
      { message: `Too many attempts. Try again in ${retryAfter} seconds.`, retryAfter },
      { status: 429 }
    );
  }

  const email = typeof body?.email === 'string' ? body.email.toLowerCase().trim() : null;
  const code = typeof body?.code === 'string' ? body.code : null;

  if (!email || !code) {
    return NextResponse.json({ message: 'email and code are required.' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    return NextResponse.json({ message: 'Invalid verification code' }, { status: 400 });
  }

  const userId = user.id;

  const verificationCode = await prisma.verificationCode.findFirst({
    where: { userId, code },
  });

  if (!verificationCode) {
    return NextResponse.json({ message: 'Invalid verification code' }, { status: 400 });
  }

  if (verificationCode.expiresAt < new Date()) {
    return NextResponse.json({ message: 'Verification code has expired' }, { status: 400 });
  }

  if (verificationCode.used) {
    return NextResponse.json(
      { message: 'Verification code has already been used' },
      { status: 400 }
    );
  }

  await prisma.$transaction([
    prisma.verificationCode.update({
      where: { id: verificationCode.id },
      data: { used: true },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true },
    }),
  ]);

  return NextResponse.json({ message: 'Email verified successfully' }, { status: 200 });
}
