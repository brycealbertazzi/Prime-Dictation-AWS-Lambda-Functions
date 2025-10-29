import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// CORS you actually want — restrict to your app’s scheme/host in prod
const ALLOW_ORIGIN = "*";

const {
  BUCKET_NAME,
  S3_REGION = process.env.AWS_REGION || "us-west-2",
  ALLOWED_PREFIXES = "recordings/,transcriptions/",
  MAX_BYTES = "15728640" // 15MB
} = process.env;

if (!BUCKET_NAME) throw new Error("Missing BUCKET_NAME");

const s3 = new S3Client({ region: S3_REGION });
const allowedPrefixes = ALLOWED_PREFIXES.split(",").map(s => s.trim()).filter(Boolean);
const maxBytes = parseInt(MAX_BYTES, 10) || 15 * 1024 * 1024;

// Simple content-type allowlist (adjust as needed)
const allowedContentTypes = new Set([
  "audio/mp4",        // .m4a
  "audio/mpeg",       // .mp3
  "audio/wav",
  "text/plain"
]);

export const handler = async (event) => {
  try {
    // Function URL sends raw body; API GW proxy also works. Support both.
    const body = parseJson(event.body);

    const key = reqString(body.key, "key");                       // e.g. "recordings/abc.m4a"
    const contentType = reqString(body.contentType, "contentType"); // e.g. "audio/mp4"
    const contentLength = Number(body.contentLength || 0);        // bytes (from Swift file size)

    // Security validations
    if (!allowedPrefixes.some(p => key.startsWith(p))) {
      return bad(400, `key must start with one of: ${allowedPrefixes.join(" ")}`);
    }
    if (!allowedContentTypes.has(contentType)) {
      return bad(400, `Unsupported contentType: ${contentType}`);
    }
    if (!contentLength || contentLength > maxBytes) {
      return bad(400, `contentLength missing or exceeds limit (${maxBytes} bytes).`);
    }

    // Create a signed URL for a PUT with content-type & content-length
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength
      // Optional: ServerSideEncryption: "AES256"
    });

    const url = await getSignedUrl(s3, putCmd, { expiresIn: 60 }); // 60s is plenty for the request

    // Return the PUT URL + headers the client must include
    return ok({
      url,
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(contentLength)
      },
      key,
      bucket: BUCKET_NAME,
      region: S3_REGION,
      expiresIn: 60
    });

  } catch (err) {
    console.error(err);
    return bad(500, err?.message || "Internal error");
  }
};

// ---------- helpers ----------
function parseJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
function reqString(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing or invalid ${name}`);
  return v.trim();
}
function ok(data) { return resp(200, data); }
function bad(code, message) { return resp(code, { error: message }); }
function resp(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(data)
  };
}
