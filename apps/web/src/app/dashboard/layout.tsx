import {getSessionContext} from '@/lib/tenant/server';
import {redirect} from 'next/navigation';
export default async function DashboardLayout({children}:{children:React.ReactNode}){
 const s=await getSessionContext();if(!s)redirect('/auth/login');
 if(!s.tenant)return <main className="mx-auto max-w-lg p-8"><h1>Workspace access required</h1><p>You are signed in. No authorized organization is available. Ask your administrator to review your existing account and organization access. Sign-in does not create or bind an account.</p><a href="/auth/logout">Sign out of Dashboard</a></main>;
 return children;
}
