import { redirect } from 'next/navigation';
import { auth, signOut } from '../../auth';
import styles from './page.module.css';

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect('/?view=signin');
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1 className={styles.heading}>Welcome, {session.user?.name}</h1>

        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/?view=signin' });
          }}
        >
          <button type="submit" className={styles.button}>
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
