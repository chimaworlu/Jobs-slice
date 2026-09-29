import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import { prisma } from './lib/db';
import { signInLimiter, checkRateLimit } from './lib/rate-limit';
import { getClientIp } from './lib/get-client-ip';

class RateLimitedSignInError extends CredentialsSignin {
  constructor(retryAfter: number) {
    super(`Too many sign in attempts. Try again in ${retryAfter} seconds`);
    this.code = `rate-limited:${retryAfter}`;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    jwt: ({ token, user }) => {
      if (user?.id) {
        token.id = user.id;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (typeof token.id === 'string') {
        session.user.id = token.id;
      }
      return session;
    },
  },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials, request) => {
        const ip = getClientIp(request);
        const { success, retryAfter } = await checkRateLimit(signInLimiter, ip);

        if (!success) {
          throw new RateLimitedSignInError(retryAfter);
        }

        const email = credentials?.email;
        const password = credentials?.password;

        if (typeof email !== 'string' || typeof password !== 'string') {
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });

        if (!user || !user.passwordHash) {
          return null;
        }

        const isValidPassword = await bcrypt.compare(password, user.passwordHash);

        if (!isValidPassword) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
});
