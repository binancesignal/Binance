/** Email templates — black header, centered card, green call-to-action. */

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shell({ appName, logoUrl, title, bodyHtml }) {
  // Mail clients cannot show data: URLs — only use the logo when it is a public https URL.
  const logo = logoUrl && /^https:\/\//i.test(logoUrl)
    ? `<img src="${esc(logoUrl)}" alt="${esc(appName)}" height="34" style="display:inline-block;height:34px;max-width:200px;border:0">`
    : `<span style="font-size:26px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;font-family:Arial,Helvetica,sans-serif">${esc(appName)}</span>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fa">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:20px 10px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px 18px 0 0;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827">
<tr><td align="center" style="background:#000000;padding:26px 20px;border-radius:18px 18px 0 0">${logo}</td></tr>
<tr><td style="padding:34px 32px 8px"><h1 style="margin:0;text-align:center;font-size:28px;line-height:1.25;font-weight:800;color:#0b1020">${esc(title)}</h1></td></tr>
<tr><td style="padding:12px 32px 30px;font-size:16px;line-height:1.65;color:#1f2937">${bodyHtml}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td align="center" style="padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9ca3af">© ${new Date().getFullYear()} ${esc(appName)}</td></tr></table>
</td></tr></table></body></html>`;
}

export function verifyEmailTemplate({ appName, logoUrl, link }) {
  const bodyHtml = `
<p style="margin:18px 0 0">Hello,</p>
<p style="margin:18px 0 0">Tap the button below to verify your email address and set up your ${esc(appName)} profile.</p>
<p style="margin:28px 0;text-align:center"><a href="${esc(link)}" style="display:inline-block;background:#0a9b57;color:#ffffff;text-decoration:none;font-weight:700;font-size:18px;padding:16px 34px;border-radius:10px">Verify Email</a></p>
<p style="margin:0;text-align:center;font-size:14px;color:#374151">Once you are logged in feel free to delete this email.</p>
<p style="margin:26px 0 0;font-size:12.5px;line-height:1.5;color:#9ca3af">Button not working? Copy this link into your browser:<br><span style="word-break:break-all">${esc(link)}</span></p>
<p style="margin:26px 0 0;font-weight:700">Kind Regards,<br><span style="font-weight:400">${esc(appName)} Team</span></p>`;
  return {
    subject: `Welcome to ${appName} — verify your email`,
    html: shell({ appName, logoUrl, title: `Welcome to ${appName}`, bodyHtml }),
    text: `Welcome to ${appName}\n\nVerify your email address: ${link}\n\nOnce you are logged in feel free to delete this email.\n\nKind Regards,\n${appName} Team`,
  };
}

export function testEmailTemplate({ appName, logoUrl }) {
  const bodyHtml = `<p style="margin:18px 0 0;text-align:center">Your SMTP settings work. Verification emails will be sent from this address.</p>`;
  return {
    subject: `${appName} — SMTP test`,
    html: shell({ appName, logoUrl, title: 'Email is working ✅', bodyHtml }),
    text: `${appName}: your SMTP settings work.`,
  };
}
