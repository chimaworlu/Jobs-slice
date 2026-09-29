import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db';
import { generatePasswordResetToken } from '../../../../lib/tokens';
import { sendEmail } from '../../../../lib/email';
import { passwordResetLimiter, checkRateLimit } from '../../../../lib/rate-limit';
import { getClientIp } from '../../../../lib/get-client-ip';
import { forgotPasswordSchema } from '../../../../lib/validations/auth';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const GENERIC_MESSAGE = 'If this email is registered you will receive a reset link';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validation = forgotPasswordSchema.safeParse(body);

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

  const { success, retryAfter } = await checkRateLimit(passwordResetLimiter, ip);

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
    return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 200 });
  }

  const token = generatePasswordResetToken();

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      used: false,
    },
  });

  const resetUrl = `${process.env.NEXTAUTH_URL}/?view=reset-password&token=${token}`;

  await sendEmail({
    to: user.email,
    subject: 'Reset your password',
    html: `<p>Click the link below to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  });

  return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 200 });
}
