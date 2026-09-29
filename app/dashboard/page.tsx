import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signOut } from '../../auth';
import SendEmailView from '../_components/SendEmailView';
import DeadLetterView from '../_components/DeadLetterView';
import styles from './page.module.css';

const NAV_ITEMS = [
  { view: 'send', label: 'Send Email' },
  { view: 'dead', label: 'Dead Letter' },
] as const;

type DashboardView = (typeof NAV_ITEMS)[number]['view'];

function resolveView(value: string | string[] | undefined): DashboardView {
  const view = Array.isArray(value) ? value[0] : value;
  return view === 'dead' ? 'dead' : 'send';
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const session = await auth();

  if (!session) {
    redirect('/?view=signin');
  }

  const view = resolveView((await searchParams).view);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <nav className={styles.nav} aria-label="Dashboard">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.view}
              href={`/dashboard?view=${item.view}`}
              className={styles.navLink}
              aria-current={view === item.view ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className={styles.account}>
          <span className={styles.userName}>{session.user?.name}</span>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/?view=signin' });
            }}
          >
            <button type="submit" className={styles.signOutButton}>
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className={styles.main}>{view === 'dead' ? <DeadLetterView /> : <SendEmailView />}</main>
    </div>
  );
}
