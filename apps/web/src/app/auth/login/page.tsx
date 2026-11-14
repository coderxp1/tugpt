import {redirect} from 'next/navigation';
export default async function Login({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){
 const p=await searchParams;
 if(p.signed_out==='1')return <main className="mx-auto max-w-lg p-8"><h1>Signed out of Dashboard</h1><p>Your website session is unchanged.</p><a href="https://tugpt.pro/login.html?dashboard=1">Return through TuGPT</a></main>;
 redirect('https://tugpt.pro/login.html?dashboard=1');
}
