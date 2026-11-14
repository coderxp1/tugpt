import Link from 'next/link';
export default function WebsiteSignInError() {
  return <main className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-bold">We could not open your Dashboard</h1><p className="my-4">Sign-in may have expired or been cancelled, or your account may not have an active organization membership. Your existing account and permissions have not been changed.</p><p className="my-4">Return to the website to try again. If the problem continues, contact your organization administrator.</p><a href="https://tugpt.pro/login.html">Return to TuGPT sign-in</a><p className="my-4"><Link href="/auth/logout" prefetch={false}>Sign out of this Dashboard session</Link></p></main>;
}
