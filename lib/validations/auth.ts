import { z } from 'zod';

export const signUpSchema = z
  .object({
    name: z.string('Full Name is required').superRefine((value, ctx) => {
      if (!/^[A-Za-z\s]*$/.test(value)) {
        ctx.addIssue({ code: 'custom', message: 'Full Name Must Use Only Letters' });
        return;
      }

      const trimmed = value.trim();
      const firstSpaceIndex = trimmed.indexOf(' ');
      const hasSecondWord = firstSpaceIndex !== -1 && trimmed.slice(firstSpaceIndex + 1).trim().length > 0;

      if (!hasSecondWord) {
        ctx.addIssue({ code: 'custom', message: 'Full Name Must Include At Least 2 Words' });
      }
    }),
    email: z.string('Please enter a valid email').email('Please enter a valid email'),
    password: z
      .string('Password must be at least 8 characters')
      .min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string('Please confirm your password').min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const signInSchema = z.object({
  email: z.string('Please enter a valid email').email('Please enter a valid email'),
  password: z.string('Password is required').min(1, 'Password is required'),
});

export const verifyEmailSchema = z.object({
  email: z.string('Please enter a valid email').email('Please enter a valid email'),
  code: z
    .string('Please enter the 6 digit code')
    .regex(/^\d{6}$/, 'Please enter the 6 digit code'),
});

export const resendVerificationSchema = z.object({
  email: z.string('Please enter a valid email').email('Please enter a valid email'),
});

export const forgotPasswordSchema = z.object({
  email: z.string('Please enter a valid email').email('Please enter a valid email'),
});

export const resetPasswordSchema = z
  .object({
    token: z.string('Reset token is missing').min(1, 'Reset token is missing'),
    password: z
      .string('Password must be at least 8 characters')
      .min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string('Please confirm your password').min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: 'Passwords do not match',
    path: ['confirmPassword'],
  });
