// Lambda: pd-email-sender (Node.js 22, ESM)

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildHtml, buildText } from "pd-shared";

/**
 * Required environment variables (configure in Lambda console):
 * - SES_REGION = us-west-2
 * - FROM_EMAIL = no-reply@primedictation.com
 * - BUCKET_NAME = prime-dictation-audio-and-transcript-files
 * - RECORDINGS_PREFIX = recordings/
 * - TRANSCRIPTIONS_PREFIX = transcriptions/
 * - DOWNLOAD_URL_TTL_SECONDS = 86400
 */

const {
  SES_REGION = "us-west-2",
  FROM_EMAIL,
  BUCKET_NAME,
  RECORDINGS_PREFIX = "recordings/",
  TRANSCRIPTIONS_PREFIX = "transcriptions/",
  DOWNLOAD_URL_TTL_SECONDS = "86400"
} = process.env;

const ses = new SESv2Client({ region: SES_REGION });
const s3 = new S3Client({});

/**
 * Event schema (example):
 * {
 *   "toEmail": "tester@example.com",
 *   "subject": "Your Prime Dictation files",
 *   "messageText": "Here are your files.",
 *   "recordingKey": "recordings/test-audio.m4a",
 *   "transcriptionKey": "transcriptions/test.txt"
 * }
 */
export const handler = async (event) => {
  try {
    const toEmail = reqString(event?.toEmail, "toEmail");
    const subject = event?.subject ?? "Your Prime Dictation files";
    const messageText = event?.messageText ?? "Your files are ready.";

    const links = [];
    if (event?.recordingKey) {
      links.push(await presignIfExists(event.recordingKey, "Recording"));
    }
    if (event?.transcriptionKey) {
      links.push(await presignIfExists(event.transcriptionKey, "Transcription"));
    }

    const html = buildHtml(messageText, links);
    const text = buildText(messageText, links);

    const cmd = new SendEmailCommand({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [toEmail] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" }
          }
        }
      }
    });

    const resp = await ses.send(cmd);
    return ok({ messageId: resp?.MessageId, toEmail, links });

  } catch (err) {
    console.error("Send failed:", err);
    return errorOut(err);
  }
};

// --- helpers ---

function reqString(val, field) {
  if (typeof val !== "string" || !val.trim()) {
    throw new Error(`Missing or invalid field: ${field}`);
  }
  return val.trim();
}

async function presignIfExists(key, label) {
  if (!key.startsWith(RECORDINGS_PREFIX) && !key.startsWith(TRANSCRIPTIONS_PREFIX)) {
    throw new Error(
      `Object key must start with '${RECORDINGS_PREFIX}' or '${TRANSCRIPTIONS_PREFIX}': ${key}`
    );
  }

  // Ensure object exists (fast failure if not)
  await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
    { expiresIn: parseInt(DOWNLOAD_URL_TTL_SECONDS, 10) || 86400 }
  );

  return { label, key, url };
}

function ok(body) {
  return { statusCode: 200, body: JSON.stringify(body) };
}

function errorOut(err) {
  const body = {
    error: err?.name || "Error",
    message: err?.message || String(err),
  };
  return { statusCode: 500, body: JSON.stringify(body) };
}
