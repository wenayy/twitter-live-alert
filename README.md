# X Space Alert — Chrome extension

Email + Chrome notification when anyone you follow on X starts or joins a Space
(same list as the Spaces bar on your x.com home), plus any extra @handles you
add in Settings that you don't follow. Runs while Chrome is open.

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
- Each Space alerts once; failed emails retry on every check (up to 10 tries).
- Scheduled Spaces: reminder ~10 min before start, then a normal alert when it goes live.
- Popup shows emails used this EmailJS month (free plan = 200). Set the reset day in Settings.
