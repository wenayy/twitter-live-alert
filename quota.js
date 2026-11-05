// Shared by background.js and popup.js: EmailJS free plan monthly quota.
const EMAIL_QUOTA = 200;

// Start date (YYYY-MM-DD) of the current quota month, given the day it resets.
function quotaPeriod(resetDay, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), resetDay);
  if (now < start) start.setMonth(start.getMonth() - 1);
  return start.toLocaleDateString("en-CA");
}
