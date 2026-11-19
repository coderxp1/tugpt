/**
 * Shown by the Dashboard and the Workspace when the person is signed in but has no authorized
 * organization. Sign-in never creates or binds an account, so the only way forward is an admin.
 */
export function AccessRequired() {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1>Workspace access required</h1>
      <p>You are signed in. No authorized organization is available. Ask your administrator to review your existing account and organization access. Sign-in does not create or bind an account.</p>
      <a href="/auth/logout">Sign out</a>
    </main>
  );
}
