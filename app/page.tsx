'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import SignUpView from './_components/SignUpView';
import SignInView from './_components/SignInView';
import VerifyEmailView from './_components/VerifyEmailView';
import ForgotPasswordView from './_components/ForgotPasswordView';
import ResetPasswordView from './_components/ResetPasswordView';

function AuthRouter() {
  const searchParams = useSearchParams();
  const view = searchParams.get('view') ?? 'signup';

  switch (view) {
    case 'signin':
      return <SignInView />;
    case 'verify-email':
      return <VerifyEmailView />;
    case 'forgot-password':
      return <ForgotPasswordView />;
    case 'reset-password':
      return <ResetPasswordView />;
    case 'signup':
    default:
      return <SignUpView />;
  }
}

export default function AuthPage() {
  return (
    <Suspense fallback={null}>
      <AuthRouter />
    </Suspense>
  );
}
