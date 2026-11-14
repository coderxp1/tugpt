 'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
export default function Logout(){const router=useRouter();const [error,setError]=useState('');const [busy,setBusy]=useState(false);return <main className="mx-auto max-w-lg p-8"><h1>Sign out of Dashboard</h1><p>Your TuGPT website session will remain signed in.</p><button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const r=await fetch('/api/auth/logout',{method:'POST',headers:{'x-tugpt-csrf':'1','Content-Type':'application/json'},body:'{}',redirect:'error'});if(!r.ok)throw Error();router.replace('/auth/login?signed_out=1');}catch{setError('Sign-out could not be confirmed. Please try again.');setBusy(false);}}}>Sign out</button><p role="alert">{error}</p></main>;}
