// Lambda: pd-email-sender (Node.js 22, ESM)

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Required environment variables:
 * - REGION = us-west-2
 * - FROM_EMAIL = no-reply@primedictation.com
 * - BUCKET_NAME = prime-dictation-audio-and-transcript-files
 * - RECORDINGS_PREFIX = recordings/
 * - TRANSCRIPTIONS_PREFIX = transcriptions/
 * - DOWNLOAD_URL_TTL_SECONDS = 86400
 * Optional:
 * - ATTACHMENT_MAX_MB (defaults to 9)  <-- only attach if the audio is <= this size
 */

const {
  REGION = "us-west-2",
  FROM_EMAIL,
  BUCKET_NAME,
  RECORDINGS_PREFIX = "recordings/",
  TRANSCRIPTIONS_PREFIX = "transcriptions/",
  DOWNLOAD_URL_TTL_SECONDS = "86400",
  ATTACHMENT_MAX_MB = "9"
} = process.env;

if (!FROM_EMAIL) throw new Error("Missing env FROM_EMAIL");
if (!BUCKET_NAME) throw new Error("Missing env BUCKET_NAME");

const ses = new SESv2Client({ region: REGION });
const s3 = new S3Client({ region: REGION });

// Pin SES identity to your DOMAIN so IAM evaluates the correct resource.
const ACCOUNT_ID = "938822376704";
const SENDER_DOMAIN = FROM_EMAIL.split("@")[1] || "primedictation.com";
const FROM_IDENTITY_ARN = `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${SENDER_DOMAIN}`;

// Limits & helpers
const MB = 1024 * 1024;
const ATTACH_LIMIT_MB = parseFloat(ATTACHMENT_MAX_MB) || 9;          // user requirement for audio
const SES_MAX_BYTES = 10 * MB;                                       // SES hard cap ~10MB AFTER base64
const MIME_OVERHEAD_BYTES = 48 * 1024;                               // conservative header/body overhead

/**
 * Event schema:
 * {
 *   "toEmail": "tester@example.com",
 *   "subject": "Your Prime Dictation files",
 *   "recordingKey": "recordings/test-audio.m4a",
 *   "transcriptionKey": "transcriptions/test.txt"
 * }
 */
export const handler = async (event) => {
  try {
    const payload = JSON.parse(event?.body)
    const toEmail = payload?.toEmail
    const subject = "Your Prime Dictation files";

    // Gather candidate assets (keys may be optional)
    const items = [];
    if (payload?.recordingKey)
      items.push({ key: payload.recordingKey, label: "Recording" });
    if (payload?.transcriptionKey)
      items.push({ key: payload.transcriptionKey, label: "Transcription" });

    // Validate keys & check existence/size
    const meta = await Promise.all(items.map(async ({ key, label }) => {
      validateKeyPrefix(key);
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      const size = Number(head.ContentLength || 0);
      const contentType = head.ContentType || inferContentType(key);
      return { key, label, size, contentType };
    }));

    // Decide: attach vs. link
    // Rule of thumb:
    // - Only attach if recording <= ATTACH_LIMIT_MB
    // - Ensure base64-encoded total + overhead < SES 10MB
    const recordingMeta = meta.find(m => m.label === "Recording");
    const transcriptionMeta = meta.find(m => m.label === "Transcription");

    if (!recordingMeta) return

    const sumOfFiles = transcriptionMeta?.size ? recordingMeta.size + transcriptionMeta.size : recordingMeta.size

    const wantAttachments =
      recordingMeta &&
      sumOfFiles <= ATTACH_LIMIT_MB * MB &&
      fitsSesLimitWhenBase64(meta);

    let responseLinks = [];
    let sendCommand;

    if (wantAttachments) {
      // Download bodies and build MIME email (Raw) with attachments
      const parts = [];
      for (const m of meta) {
        const data = await getObjectBuffer(m.key);
        const filename = filenameFromKey(m.key);
        parts.push({
          filename,
          contentType: m.contentType,
          data // Buffer
        });
      }

      const html = renderEmailHtml({ links: [], hasAttachments: true });
      const text = renderEmailText({ links: [], hasAttachments: true });

      const raw = buildMimeMixed({
        from: FROM_EMAIL,
        to: toEmail,
        subject,
        text,
        html,
        attachments: parts
      });

      sendCommand = new SendEmailCommand({
        FromEmailAddress: FROM_EMAIL,
        FromEmailAddressIdentityArn: FROM_IDENTITY_ARN,
        Destination: { ToAddresses: [toEmail] },
        Content: { Raw: { Data: raw } },
        ReplyToAddresses: [`support@${SENDER_DOMAIN}`]
      });

    } else {
      // Presign links and send Simple email
      responseLinks = await Promise.all(
        meta.map(async ({ key, label }) => {
          const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
            { expiresIn: parseInt(DOWNLOAD_URL_TTL_SECONDS, 10) || 86400 }
          );
          return { label, key, url };
        })
      );

      const html = renderEmailHtml({ links: responseLinks, hasAttachments: false });
      const text = renderEmailText({ links: responseLinks, hasAttachments: false });

      sendCommand = new SendEmailCommand({
        FromEmailAddress: FROM_EMAIL,
        FromEmailAddressIdentityArn: FROM_IDENTITY_ARN,
        Destination: { ToAddresses: [toEmail] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" }
            }
          }
        },
        ReplyToAddresses: [`support@${SENDER_DOMAIN}`]
      });
    }

    console.log("SES send preview", {
      from: FROM_EMAIL,
      identityArn: FROM_IDENTITY_ARN,
      to: [toEmail],
      mode: wantAttachments ? "attachments" : "links"
    });

    const resp = await ses.send(sendCommand);
    return ok({ messageId: resp?.MessageId, toEmail, links: responseLinks });

  } catch (err) {
    console.error("Send failed:", err);
    return errorOut(err);
  }
};

// ---------- helpers ----------

function validateKeyPrefix(key) {
  if (!key.startsWith(RECORDINGS_PREFIX) && !key.startsWith(TRANSCRIPTIONS_PREFIX)) {
    throw new Error(
      `Object key must start with '${RECORDINGS_PREFIX}' or '${TRANSCRIPTIONS_PREFIX}': ${key}`
    );
  }
}

function filenameFromKey(key) {
  const i = key.lastIndexOf("/");
  return i >= 0 ? key.slice(i + 1) : key;
}

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
  // Node 18+ SDK: Body has transformToByteArray()
  const bytes = await out.Body.transformToByteArray();
  return Buffer.from(bytes);
}

// Does the base64-encoded total likely fit under SES 10MB?
function fitsSesLimitWhenBase64(metaList) {
  // Base text/html inlined is small; attachments dominate. Add some overhead.
  let totalBase64Bytes = 0;
  for (const m of metaList) {
    // base64 expands by ~4/3
    const b64 = Math.ceil(m.size / 3) * 4;
    totalBase64Bytes += b64;
  }
  const projected = totalBase64Bytes + MIME_OVERHEAD_BYTES;
  return projected < SES_MAX_BYTES;
}

// ---------- Email rendering ----------

function renderEmailHtml({ links, hasAttachments }) {
  const linkBlocks = (links || []).map(l => {
    const name = escapeHtml(l.label || "Download");
    const url = escapeHtml(l.url);
    const file = escapeHtml(filenameFromKey(l.key));
    return `
      <tr>
        <td style="padding:8px 0;">
          <div style="font-size:14px;color:#444;margin-bottom:6px;"><strong>${name}</strong> — ${file}</div>
          <a href="${url}" style="
            display:inline-block;padding:10px 14px;text-decoration:none;
            background:#2563eb;color:#fff;border-radius:8px;font-size:14px;
          " target="_blank" rel="noopener">Download</a>
        </td>
      </tr>`;
  }).join("");

  const footer = hasAttachments
    ? `<p style="margin:10px 0 0 0;font-size:14px;color:#6b7280;">Files are attached to this email.</p>`
    : `<p style="margin:10px 0 0 0;font-size:12px;color:#6b7280;">If a link expires, resend from the app to generate a fresh one.</p>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prime Dictation</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fc;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:24px;">
        <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;padding:24px;border:1px solid #e5e7eb;">
          <tr><td>
            <h1 style="margin:0 0 10px 0;font-size:20px;line-height:1.3;color:#111827;">Your Prime Dictation files</h1>

            ${links?.length ? `
              <table role="presentation" width="100%" style="margin-top:8px;">
                ${linkBlocks}
              </table>` : ``}

            ${footer}
          </td></tr>
        </table>
        <div style="margin-top:12px;font-size:11px;color:#9ca3af;">© ${new Date().getFullYear()} Prime Dictation</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderEmailText({ links, hasAttachments }) {
  const lines = [""];
  if (links?.length) {
    lines.push("Downloads:");
    for (const l of links) lines.push(`- ${l.label}: ${l.url}`);
    lines.push(""); // spacing
    lines.push("If a link expires, resend from the app to generate a fresh one.");
  } else if (hasAttachments) {
    lines.push("Files are attached to this email.");
  }
  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------- MIME builder (for attachments) ----------

function buildMimeMixed({ from, to, subject, text, html, attachments }) {
  const boundaryMixed = "mixed_" + randomId();
  const boundaryAlt = "alt_" + randomId();

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`
  ];

  const altSection =
    `--${boundaryMixed}\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n\r\n` +
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
  return new TextEncoder().encode(raw); // Uint8Array for SES v2 Raw
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function chunk76(str) {
  // Base64 lines <= 76 chars per RFC compliance
  const out = [];
  for (let i = 0; i < str.length; i += 76) out.push(str.slice(i, i + 76));
  return out.join("\r\n");
}

// ---------- HTTP helpers ----------

function ok(body) {
  return { statusCode: 200, body: JSON.stringify(body) };
}

function errorOut(err) {
  const body = { error: err?.name || "Error", message: err?.message || String(err) };
  return { statusCode: 500, body: JSON.stringify(body) };
}
