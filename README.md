# X Space Alert — Chrome extension

Email + Chrome notification when anyone you follow on X starts or joins a Space
(same list as the Spaces bar on your x.com home). Runs while Chrome is open.

## Install
1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Be logged in to x.com in the same Chrome.
3. Click the icon → fill EmailJS keys + your email → **Save** → **Send test email**.

## EmailJS template
- To Email: `{{email}}`
- Subject: `{{subject}}`
- Body can use `{{handle}}`, `{{space_title}}`, `{{link}}`, `{{message}}`.

## Notes
- Checks every 5 min by default (min 2). Lower = more risk of X rate-limiting.
- Each Space alerts once. Popup shows last check status + recent alerts.
