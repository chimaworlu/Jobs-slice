import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '../../../../lib/db';
import { generateVerificationCode } from '../../../../lib/tokens';
import { sendEmail } from '../../../../lib/email';
import { signUpLimiter, checkRateLimit } from '../../../../lib/rate-limit';
import { getClientIp } from '../../../../lib/get-client-ip';
import { signUpSchema } from '../../../../lib/validations/auth';

const VERIFICATION_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validation = signUpSchema.safeParse(body);

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

  const { success, retryAfter } = await checkRateLimit(signUpLimiter, ip);

  if (!success) {
    return NextResponse.json(
      { message: `Too many sign-up attempts. Try again in ${retryAfter} seconds.`, retryAfter },
      { status: 429 }
    );
  }

  const name = typeof body?.name === 'string' ? body.name : null;
  const email = typeof body?.email === 'string' ? body.email.toLowerCase().trim() : null;
  const password = typeof body?.password === 'string' ? body.password : null;

  if (!name || !email || !password) {
    return NextResponse.json({ message: 'Name, email and password are required.' }, { status: 400 });
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    return NextResponse.json(
      {
        message:
          'If this email is not registered you will receive a verification code. Please check your inbox.',
      },
      { status: 200 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      emailVerified: false,
    },
  });

  try {
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
      subject: 'Verify your email',
      html: `<p>Your verification code is: <strong>${code}</strong></p>`,
    });

    return NextResponse.json(
      {
        message:
          'If this email is not registered you will receive a verification code. Please check your inbox.',
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[POST /api/auth/signup] Failed to complete sign-up after user creation', {
      userId: user.id,
      email: user.email,
      error,
    });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again later.' },
      { status: 500 }
    );
  }
}
