import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db';
import { generateVerificationCode } from '../../../../lib/tokens';
import { sendEmail } from '../../../../lib/email';
import { resendLimiter, checkRateLimit } from '../../../../lib/rate-limit';
import { getClientIp } from '../../../../lib/get-client-ip';
import { resendVerificationSchema } from '../../../../lib/validations/auth';

const VERIFICATION_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validation = resendVerificationSchema.safeParse(body);

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

  if (!email) {
    return NextResponse.json({ message: 'Email is required.' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    return NextResponse.json(
      { message: 'If this email is registered you will receive a verification code.' },
      { status: 200 }
    );
  }

  if (user.emailVerified) {
    return NextResponse.json({ message: 'Email is already verified' }, { status: 400 });
  }

  const code = generateVerificationCode();

  await prisma.verificationCode.create({
    data: {
      userId: user.id,
      code,
      expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      used: false,
    },
  });

  await sendEmail({
    to: user.email,
    subject: 'Your verification code',
    html: `<p>Your verification code is: <strong>${code}</strong></p>`,
  });

  return NextResponse.json({ message: 'Verification code sent' }, { status: 200 });
}
