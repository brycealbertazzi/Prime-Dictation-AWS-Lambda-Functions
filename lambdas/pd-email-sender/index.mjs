// Lambda: pd-email-sender (Node.js 22, ESM)

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildHtml, buildText } from "../../shared/src/index.js";

/**
 * Required environment variables (configure in Lambda console):
 * - SES_REGION = us-west-2
 * - FROM_EMAIL = no-reply@primedictation.com
 * - BUCKET_NAME = prime-dictation-audio-and-transcript-files
 * - RECORDINGS_PREFIX = recordings/
 * - TRANSCRIPTIONS_PREFIX = transcriptions/
 * - DOWNLOAD_URL_TTL_SECONDS = 86400
 *
 * Optional:
 * - S3_REGION (defaults to SES_REGION)
 */

// --- env & clients ---

const {
  SES_REGION = "us-west-2",
  FROM_EMAIL,
  BUCKET_NAME,
  RECORDINGS_PREFIX = "recordings/",
  TRANSCRIPTIONS_PREFIX = "transcriptions/",
  DOWNLOAD_URL_TTL_SECONDS = "86400",
  S3_REGION
} = process.env;

if (!FROM_EMAIL) throw new Error("Missing env FROM_EMAIL");
if (!BUCKET_NAME) throw new Error("Missing env BUCKET_NAME");

const ses = new SESv2Client({ region: SES_REGION });
const s3 = new S3Client({ region: S3_REGION || SES_REGION });

// Pin the SES identity to your DOMAIN so IAM evaluates the right resource.
// If you ever change account/region/domain, update this builder.
const ACCOUNT_ID = "938822376704";
const SENDER_DOMAIN = FROM_EMAIL.split("@")[1] || "primedictation.com";
const FROM_IDENTITY_ARN = `arn:aws:ses:${SES_REGION}:${ACCOUNT_ID}:identity/${SENDER_DOMAIN}`;

// --- handler ---

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

    // Guard: ensure FROM is your domain (avoids gmail-from accidents)
    if (!FROM_EMAIL.endsWith(`@${SENDER_DOMAIN}`)) {
      throw new Error(`FROM_EMAIL must end with @${SENDER_DOMAIN}`);
    }

    const links = [];
    if (event?.recordingKey) {
      links.push(await presignIfExists(event.recordingKey, "Recording"));
    }
    if (event?.transcriptionKey) {
      links.push(await presignIfExists(event.transcriptionKey, "Transcription"));
    }

    const html = buildHtml(messageText, links);
    const text = buildText(messageText, links);

    const params = {
      FromEmailAddress: FROM_EMAIL,                      // visible From
      FromEmailAddressIdentityArn: FROM_IDENTITY_ARN,    // force SES to use domain identity
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
      // Do NOT set ConfigurationSetName unless you actually use one.
    };

    console.log("SES send preview", {
      from: params.FromEmailAddress,
      identityArn: params.FromEmailAddressIdentityArn,
      to: params.Destination.ToAddresses
    });

    const resp = await ses.send(new SendEmailCommand(params));
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
