import { getSessionContext } from '@/lib/tenant/server';
import { redirect } from 'next/navigation';
import { AccessRequired } from '@/components/shell/AccessRequired';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const s = await getSessionContext();
  if (!s) redirect('/auth/login');
  if (!s.tenant) return <AccessRequired />;
  return children;
}
