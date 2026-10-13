# Approvals platform (Google Apps Script web app)

A web app on top of the live Google Sheet **Golden Collection – Approval Requests**. Requesters submit in a form. Each approver sees a queue of what waits on them and approves, returns or rejects in one click. Emails go to the next approver, and the CEO Executive Assistant is copied at every stage. A daily job chases SLAs. Nothing depends on ERP or WMS.

The Sheet stays the system of record. Its Requests tab formulas still decide band, route and status from the Settings tab, so a change to Settings changes the app's routing straight away.

## What it does

| Who | In the app |
| --- | --- |
| Requester (media buyer, marketing exec, designer, CX / live ops agent) | New request form with a live route preview (band, approval chain, quotes needed, joint payment). Sees their own requests and resubmits returned ones |
| L1 Senior / Lead, L2 Dept Manager | Queue of their department's requests at their step |
| FP&A (second approver) | Queue of every request at the FP&A step, with a dashboard covering pipeline, overdue items and the Band A–B share |
| Strategy Analyst | "Recommend to CEO" on Band D requests for their department |
| CEO | Approves Band D |
| CEO Executive Assistant | Copied on every email. Sees everything and can flag any request for the CEO's attention |
| Accounting | Marks approved requests paid with a payment reference. Above EGP 1.5M it must confirm the CEO co-signed |

Controls built in:
- A requester can never approve their own request.
- A reject or return needs a written reason.
- A returned request restarts at the step that returned it. If the edit moves the request into another band, all approvals are cleared and it restarts at L1.
- An out-of-budget request must name its offset in the business case.
- Every action is written to a **History** tab with a timestamp: submissions, decisions, reminders, comments and payments.
- SLA reminders count working days on a Sunday-to-Thursday week: L1 has 1 day, L2 2, FP&A 1 or 2 by band (from Settings), Strategy 2 and CEO 3. A missed L1 SLA escalates to the L2 Dept Manager.

## Install (about 15 minutes, done once by Ahmed)

1. Open the Sheet and go to **Extensions → Apps Script**.
2. Create three files and paste in the contents from `platform/apps-script/`:
   - `Code.gs`
   - `Logic.gs`
   - `Index.html`: use **+ → HTML** and name it `Index`.
3. Click **Project Settings**, tick **Show "appsscript.json"**, then replace that file's content with `appsscript.json`.
4. In the editor, select the `setup` function and click **Run**, then accept the permissions. This adds two tabs to the Sheet, **People** and **History**, and a daily 09:00 Cairo SLA reminder trigger.
5. Fill in the **People** tab with one row per person: email, name, role and department.
   - Roles: `Requester`, `L1`, `L2`, `FP&A`, `Strategy`, `CEO`, `CEO EA`, `Accounting`, `Admin`.
   - Department: `Marketing`, `CX & Live Ops` or `All`. FP&A, CEO, CEO EA and Accounting use `All`.
   - The Strategy Analysts cover each other: while one is absent, set the other to `All`.
6. Click **Deploy → New deployment → Web app**. Set Execute as **User accessing the web app** and Who has access **Anyone with a Google account**. Copy the URL and share it with the team.
7. Share the Sheet as **Editor** with everyone on the People tab. The app runs as each user, which is how it knows who is signing; it needs this because the team uses personal Gmail accounts.
8. Delete the example row (MKT-001) from the Requests tab before going live.

To update the code later, paste the new files in, then click **Deploy → Manage deployments → Edit → New version**. The URL stays the same.

## Things to know
- **Never sort or delete rows on the Requests tab.** The Request ID formula uses the row number, so either action renumbers IDs and detaches their History. Filter views are safe.
- Editing the Sheet directly still works, but those edits bypass the app's checks (segregation of duties, required reasons) and are not logged in History.
- The Requests tab has no columns for Procurement or HR, so those steps are not enforced by the app yet. Quotes needed are shown on the form, and quote links go in Notes.
- Email volume: Gmail accounts can send about 100 emails a day through Apps Script; Google Workspace accounts get about 1,500.

## Tests
`node --test platform/tests/logic.test.js` checks the routing preview against the 4-band rules, plus working days, SLAs and who can sign.
