# ST3 C2 WhatsApp Monitor

Updated Oracle alert worker with a local dashboard. The WhatsApp message layout and source fields match the uploaded script. No Oracle tables are created or modified. Production records come from Oracle; sent/pending history is durably stored locally in data/notifications.jsonl. This is a single-machine monitor, not a shared Oracle audit table.

## Install on your existing Windows bot PC

1. Stop the old bot with Ctrl+C and close its bot Chrome window. Stop any other task that starts the old bot. Do not run both versions.
2. Back up your old folder. Extract this package to a permanent folder, for example C:\C2-WhatsApp-Monitor.
3. Copy your existing `.env`, `.sent_keys.json`, and entire `.wwebjs_auth` folder into the new folder. Enable hidden files in Explorer if needed. These preserve credentials, prior sent keys, and the WhatsApp login. The new script still uses client ID `quality-bot`. Do not delete those files. Old keys have no send timestamps; the dashboard labels them as legacy.
4. Open a terminal in the new folder and run `npm install`. Keep the generated package-lock.json. Use an actively supported Node LTS release. If your existing Oracle connection requires Instant Client, set ORACLE_CLIENT_LIB_DIR to its directory.
5. Keep your existing DB_USER, DB_PASSWORD, DB_CONNECT_STRING and WHATSAPP_GROUP_ID values. Optional settings are in .env.example. Default dashboard address is http://localhost:8080. Change DASHBOARD_PORT if another application uses 8080.
6. For a background trial run, execute `powershell -NoProfile -ExecutionPolicy Bypass -File .\Run-Monitor.ps1`. Node logs go to files; there is no terminal input handler. Open http://localhost:8080. Scan the dashboard QR if the copied session needs relinking. This QR is available only on the monitor; no notification is sent to a new recipient.
7. For automatic startup after reboot, close the trial supervisor, stop its child node.exe in Task Manager, then open PowerShell as Administrator in this folder and run `powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-Autostart.ps1`. Supply the Windows password for the account that owns the session (not your Windows PIN). Windows Task Scheduler stores the credential. The installer starts the task immediately, including when nobody is logged in. Account policy must allow batch logon. If the password changes, update the scheduled task's credentials.
8. Leave the PC powered on, connected to Oracle and the internet, and prevent sleep while plugged in. A sleeping or powered-off PC cannot monitor. Locking the screen is fine. No repeated Enter presses are required.

This environment cannot connect to your Oracle server, Windows session, or WhatsApp account, so live deployment and delivery must be verified on your PC.

## What changed

- Oracle discovery runs independently of WhatsApp connectivity. It polls every 10 seconds plus query/send processing time: near-real-time polling, not instantaneous Oracle push events.
- Reads records from Oracle midnight minus LOOKBACK_DAYS (default 2), including today. On the first run, all C2 records in this window without saved keys are queued. To retain the original today-only scope, use LOOKBACK_DAYS=0. Increase the window after a long outage if you need to recover older, never-discovered records.
- Ten messages maximum per cycle, with a three-second gap; the next cycle starts after completion. A large backlog takes time to drain. The loop never overlaps.
- Each pending/send result is appended and flushed to disk individually. Restart retains deduplication history; no 5,000-key eviction. Back up the data folder, legacy keys, and session folder. Do not edit the journal while running. History grows over time; monitor disk space.
- Disconnect recovery and a watchdog work with the Windows supervisor. Crashes restart after 15 seconds. A hung send terminates the worker before reconnecting, so an old send promise cannot overlap a replacement session.
- The dashboard automatically refreshes every three seconds with pending/sending, sent, needs-verification, Oracle status, WhatsApp status, last query, heartbeat, search and status filters. Tables display up to 500 matching rows; totals include all retained records.

## Send outcomes and duplicate protection

Sent means WhatsApp returned a message ID, or history reconciliation found the exact message. It does not guarantee delivery or reading. Receipt information is shown separately, where available; WhatsApp group receipt behavior depends on WhatsApp. Original legacy keys only prove the old script recorded success.

An interrupted, failed or timed-out send is marked Needs verification. The monitor checks the last 200 outgoing group messages every minute while connected and matches message body and attempt time. Confirmed matches become Sent automatically. If chat-history APIs fail or the message is outside the history window, the record remains Needs verification. It is not automatically resent: WhatsApp Web provides no transactional idempotency guarantee, so blindly retrying can send duplicates. This exceptional condition requires checking the group; normal notifications are fully automatic.

To explicitly requeue a record after confirming it did not arrive: stop the scheduled task and its Node child, run `node requeue.js "EXACT_BARCODE"`, then start the scheduled task. The helper only requeues uncertain records, preserves an audit entry, and refuses to proceed if the dashboard port is occupied. Do not use it while another bot instance is sending.

Legacy timezone compatibility: Oracle created dates are now returned as database wall-clock strings (YYYY-MM-DD HH24:MI:SS), matching the old formatter when the previous Node host used the same timezone as Oracle. If the old host formatted dates in another timezone, compare a saved legacy key before first sending to prevent unintended resend.

## Access from another PC

Set DASHBOARD_HOST=0.0.0.0 and a strong DASHBOARD_PASSWORD, restart the task, then use http://YOUR-SERVER-IP:8080. Username: admin. Allow only trusted internal machines through Windows Firewall. HTTP Basic authentication is not encrypted; use an HTTPS reverse proxy or VPN for network access. Oracle credentials stay on the server. Default loopback access is limited to the host PC. The API and QR require the same login.

## Diagnosis

- Pending plus WhatsApp offline: view status and QR, check the linked account and group membership. Sessions revoked in WhatsApp require relinking.
- Oracle query failed: check DB credentials, connectivity, permissions for ifsapp.c_tire_manuf_proc_ovw and the existing C_Defect_API functions. Query failures stay visible; they are not reported as an empty successful query.
- Process exits: inspect logs/stderr.log. Corrupt complete journal records stop startup rather than silently forgetting sent history. Restore a known good backup after investigation.
- Port busy: another dashboard or bot is running. Stop it or choose an unused port. Always use one deployment folder and one worker; the Windows supervisor mutex prevents duplicate supervised launches. Different manually configured ports/folders are not a distributed lock.
- For an interactive Command Prompt, disable Properties → Options → QuickEdit Mode. A paused console is consistent with the reported Enter-to-resume behavior. Background execution with redirected logs avoids dependency on console input/selection. Sleep, a blocked database, or a stuck browser can cause similar symptoms.

References: https://learn.microsoft.com/en-us/windows/console/high-level-console-modes ; https://docs.wwebjs.dev/Client.html ; https://node-oracledb.readthedocs.io/en/stable/api_manual/pool.html



# cd E:\Applications\ProgramMonitor
# node .\index.js