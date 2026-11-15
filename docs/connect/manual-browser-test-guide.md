# Manual browser test guide (TuGPT dashboard)

Everything below is done through the dashboard UI â€” no terminal, curl, Postman, or
database queries. Start at `https://staging.tugpt.pro`, logged in as the staging
test account (owner/admin of the test organization).

## 1. Google Calendar
1. Open **Connect**.
2. Select **Google Workspace** â†’ authorize on Google's official OAuth page.
3. Confirm the connection shows **Connected** in the settings.
4. Open **Chat**, type `@` and select **Google Calendar**.
5. Ask: "When am I free next Tuesday for 60 minutes?"
6. Confirm the answer reflects real calendar busy/free time (cross-check your Google Calendar).

## 2. Microsoft 365
1. Open **Connect** â†’ select **Microsoft 365** â†’ authorize on Microsoft's page.
2. Confirm **Connected** status.
3. In Chat, select **Microsoft 365 Calendar** and ask the same availability question.
4. Confirm the result comes from Microsoft Graph (cross-check your Outlook calendar).

## 3. Customer MCP
1. In the Connect/MCP section, **register** an endpoint (paste an HTTPS MCP URL + name).
2. **Discover** its tools (snapshot).
3. **Review + approve** the tools and assign each a permission (read/write/â€¦).
4. **Activate** the connection â€” it should succeed only after the egress proxy is verified.
5. In Chat, select the approved MCP tool and invoke it; confirm it executes.
6. **Revoke/deactivate** the endpoint, then retry the tool in Chat â€” confirm execution is blocked.

## 4. Image generation
1. Open **Create**.
2. Generate an image (GPU backend).
3. **Refresh the page.**
4. Confirm the image is still listed and can be viewed + downloaded.

## Failure inspection (without exposing secrets/PII)
- In-app error states show a stable reason slug (e.g. `ACTIVATION_DENIED`, `GOOGLE_NOT_CONFIGURED`).
- Server logs are structured and redact tokens, keys, and personal data â€” inspect only
  redacted logs, never raw credentials.
