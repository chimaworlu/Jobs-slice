import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '../../../../lib/db';
import { resetPasswordSchema } from '../../../../lib/validations/auth';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validation = resetPasswordSchema.safeParse(body);

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

  const token = typeof body?.token === 'string' ? body.token : null;
  const password = typeof body?.password === 'string' ? body.password : null;

  if (!token || !password) {
    return NextResponse.json({ message: 'token and password are required.' }, { status: 400 });
  }

  let resetToken;

  try {
    resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });
  } catch (error) {
    console.error('[POST /api/auth/reset-password] Failed to look up reset token', {
      userId: undefined,
      token,
      error,
    });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }

  if (!resetToken) {
    return NextResponse.json({ message: 'Invalid reset token' }, { status: 400 });
  }

  if (resetToken.expiresAt < new Date()) {
    return NextResponse.json({ message: 'Reset token has expired' }, { status: 400 });
  }

  if (resetToken.used) {
    return NextResponse.json({ message: 'Reset token has already been used' }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    await prisma.$transaction([
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true },
      }),
      prisma.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      }),
    ]);
  } catch (error) {
    console.error('[POST /api/auth/reset-password] Failed to update password and mark token used', {
      userId: resetToken.userId,
      token,
      error,
    });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ message: 'Password reset successfully' }, { status: 200 });
}
