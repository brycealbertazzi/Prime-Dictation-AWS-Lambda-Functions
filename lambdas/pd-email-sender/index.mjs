// Lambda: pd-email-sender (Node.js 20/22, ESM)
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { verifyFirebase } from "../auth.mjs";

// ---------- CORS ----------
const ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

// ---------- Env / clients ----------
const {
  REGION = "us-west-2",
  FROM_EMAIL,
  BUCKET_NAME,
  RECORDINGS_PREFIX = "recordings/",
  TRANSCRIPTIONS_PREFIX = "transcriptions/",
  DOWNLOAD_URL_TTL_SECONDS = "86400",
  ATTACHMENT_MAX_MB = "9",
} = process.env;

if (!FROM_EMAIL) throw new Error("Missing env FROM_EMAIL");
if (!BUCKET_NAME) throw new Error("Missing env BUCKET_NAME");

const ses = new SESv2Client({ region: REGION });
const s3  = new S3Client({ region: REGION });

const ACCOUNT_ID = process.env.SES_ACCOUNT_ID; // optional
const SENDER_DOMAIN = FROM_EMAIL.split("@")[1] || "example.com";
const FROM_IDENTITY_ARN = ACCOUNT_ID ? `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${SENDER_DOMAIN}` : undefined;

const MB = 1024 * 1024;
const ATTACH_LIMIT_MB = parseFloat(ATTACHMENT_MAX_MB) || 9;
const SES_MAX_BYTES = 10 * MB;
const MIME_OVERHEAD_BYTES = 48 * 1024;

export const handler = async (event) => {
  // Preflight
  if (event.requestContext?.http?.method === "OPTIONS" || event.routeKey === "OPTIONS /") {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  try {
    const user = await verifyFirebase(event);

    const payload = JSON.parse(event.body || "{}");
    const toEmail = (payload.toEmail || "").trim();
    if (!toEmail) return resp(400, { error: "Missing toEmail" });

    const items = [];
    if (payload.recordingKey)     items.push({ key: String(payload.recordingKey), label: "Recording" });
    if (payload.transcriptionKey) items.push({ key: String(payload.transcriptionKey), label: "Transcription" });

    const meta = await Promise.all(items.map(async ({ key, label }) => {
      validateKeyPrefix(key, user.uid);
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      const size = Number(head.ContentLength || 0);
      const contentType = head.ContentType || inferContentType(key);
      return { key, label, size, contentType };
    }));

    const subject = "Prime Dictation";
    const recordingMeta = meta.find(m => m.label === "Recording");
    const transcriptionMeta = meta.find(m => m.label === "Transcription");

    let responseLinks = [];
    let sendCommand;

    const totalBytes = (recordingMeta?.size || 0) + (transcriptionMeta?.size || 0);
    const wantAttachments =
      recordingMeta &&
      totalBytes <= ATTACH_LIMIT_MB * MB &&
      fitsSesLimitWhenBase64(meta);

    if (wantAttachments) {
      const parts = [];
      for (const m of meta) {
        const data = await getObjectBuffer(m.key);
        parts.push({ filename: filenameFromKey(m.key), contentType: m.contentType, data });
      }
      const html = renderEmailHtml({ links: [], hasAttachments: true });
      const text = renderEmailText({ links: [], hasAttachments: true });
      const raw  = buildMimeMixed({ from: FROM_EMAIL, to: toEmail, subject, text, html, attachments: parts });

      sendCommand = new SendEmailCommand({
        FromEmailAddress: FROM_EMAIL,
        ...(FROM_IDENTITY_ARN && { FromEmailAddressIdentityArn: FROM_IDENTITY_ARN }),
        Destination: { ToAddresses: [toEmail] },
        Content: { Raw: { Data: raw } },
        ReplyToAddresses: [`support@${SENDER_DOMAIN}`],
      });

    } else {
      responseLinks = await Promise.all(
        meta.map(async ({ key, label, contentType }) => {
          const filename = filenameFromKey(key);

          const url = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: BUCKET_NAME,
              Key: key,
              // 👇 Force "download" behavior in browsers (esp. Safari)
              ResponseContentDisposition: `attachment; filename="${filename}"`,
              ResponseContentType: 'application/octet-stream',
              // If you prefer to keep the real MIME type instead:
              // ResponseContentType: contentType,
            }),
            { expiresIn: parseInt(DOWNLOAD_URL_TTL_SECONDS, 10) || 86400 }
          );

          return { label, key, url };
        })
      );
      const html = renderEmailHtml({ links: responseLinks, hasAttachments: false });
      const text = renderEmailText({ links: responseLinks, hasAttachments: false });

      sendCommand = new SendEmailCommand({
        FromEmailAddress: FROM_EMAIL,
        ...(FROM_IDENTITY_ARN && { FromEmailAddressIdentityArn: FROM_IDENTITY_ARN }),
        Destination: { ToAddresses: [toEmail] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" },
            },
          },
        },
        ReplyToAddresses: [`support@${SENDER_DOMAIN}`],
      });
    }

    const respSes = await ses.send(sendCommand);
    return resp(200, { messageId: respSes?.MessageId, toEmail, links: responseLinks, uid: user.uid });

  } catch (err) {
    const code = err?.statusCode || 500;
    console.error("email error:", err);
    return resp(code, { error: err?.message || "Internal error" });
  }
};

// ---------- validation / s3 helpers ----------
function validateKeyPrefix(key, uid) {
  if (process.env.REQUIRE_UID_PREFIX === "1") {
    const expected = `users/${uid}/`;
    if (!key.startsWith(expected)) {
      const e = new Error(`Object key must start with '${expected}'`); e.statusCode = 403; throw e;
    }
    return;
  }
  if (!key.startsWith(RECORDINGS_PREFIX) && !key.startsWith(TRANSCRIPTIONS_PREFIX)) {
    const e = new Error(`Object key must start with '${RECORDINGS_PREFIX}' or '${TRANSCRIPTIONS_PREFIX}': ${key}`);
    e.statusCode = 400; throw e;
  }
}

function filenameFromKey(key) { const i = key.lastIndexOf("/"); return i >= 0 ? key.slice(i + 1) : key; }
function inferContentType(key) {
  const lower = key.toLowerCase();
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".txt")) return "text/plain; charset=UTF-8";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
async function getObjectBuffer(key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const bytes = await out.Body.transformToByteArray();
  return Buffer.from(bytes);
}
function fitsSesLimitWhenBase64(metaList) {
  let total = 0;
  for (const m of metaList) total += Math.ceil(m.size / 3) * 4; // 4/3 expansion
  return (total + MIME_OVERHEAD_BYTES) < SES_MAX_BYTES;
}

// ---------- renderers / MIME builder ----------
function renderEmailHtml({ links, hasAttachments }) {
  const linkBlocks = (links || []).map(l => {
    const name = escapeHtml(l.label || "Download");
    const url  = escapeHtml(l.url);
    const file = escapeHtml(filenameFromKey(l.key));
    return `
      <tr>
        <td style="padding:8px 0;">
          <div style="font-size:14px;color:#444;margin-bottom:6px;"><strong>${name}</strong> — ${file}</div>
          <a href="${url}" style="display:inline-block;padding:10px 14px;text-decoration:none;background:#2563eb;color:#fff;border-radius:8px;font-size:14px;" target="_blank" rel="noopener">Download</a>
        </td>
      </tr>`;
  }).join("");

  const footer = hasAttachments
    ? `<p style="margin:10px 0 0 0;font-size:14px;color:#6b7280;">Files are attached to this email.</p>`
    : `<p style="margin:10px 0 0 0;font-size:12px;color:#6b7280;">If a link expires, resend from the app to generate a fresh one.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prime Dictation</title></head>
<body style="margin:0;padding:0;background:#f6f8fc;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr><td align="center" style="padding:24px;">
      <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;padding:24px;border:1px solid #e5e7eb;">
        <tr><td>
          <h1 style="margin:0 0 10px 0;font-size:20px;line-height:1.3;color:#111827;">Your Prime Dictation files are ready</h1>
          ${links?.length ? `<table role="presentation" width="100%" style="margin-top:8px;">${linkBlocks}</table>` : ``}
          ${footer}
        </td></tr>
      </table>
      <div style="margin-top:12px;font-size:11px;color:#9ca3af;">© ${new Date().getFullYear()} Prime Dictation</div>
    </td></tr>
  </table>
</body></html>`;
}
function renderEmailText({ links, hasAttachments }) {
  const lines = [""];
  if (links?.length) {
    lines.push("Downloads:");
    for (const l of links) lines.push(`- ${l.label}: ${l.url}`);
    lines.push("");
    lines.push("If a link expires, resend from the app to generate a fresh one.");
  } else if (hasAttachments) {
    lines.push("Files are attached to this email.");
  }
  return lines.join("\n");
}
function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }

function buildMimeMixed({ from, to, subject, text, html, attachments }) {
  const boundaryMixed = "mixed_" + randomId();
  const boundaryAlt   = "alt_" + randomId();

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
  ];

  const altSection =
    `--${boundaryMixed}\r\nContent-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n\r\n` +
    `--${boundaryAlt}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${text}\r\n` +
    `--${boundaryAlt}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${html}\r\n` +
    `--${boundaryAlt}--\r\n`;

  const parts = attachments.map(att => {
    const b64 = att.data.toString("base64");
    const safeName = att.filename.replace(/"/g, "'");
    return (
      `--${boundaryMixed}\r\n` +
      `Content-Type: ${att.contentType}; name="${safeName}"\r\n` +
      `Content-Disposition: attachment; filename="${safeName}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      chunk76(b64) + `\r\n`
    );
  }).join("");

  const closing = `--${boundaryMixed}--`;
  const raw = headers.join("\r\n") + "\r\n\r\n" + altSection + parts + closing;
  return new TextEncoder().encode(raw);
}

function randomId() { return Math.random().toString(36).slice(2, 10); }
function chunk76(str) { const out = []; for (let i = 0; i < str.length; i += 76) out.push(str.slice(i, i + 76)); return out.join("\r\n"); }

// ---------- HTTP ----------
function resp(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(body) };
}
