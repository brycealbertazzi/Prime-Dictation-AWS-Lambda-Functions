// Lambda: pd-presign (Node.js 20/22, ESM)
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import admin from "firebase-admin";

// ---------- Auth (Firebase ID token) ----------
let adminInited = false;
function initFirebase() {
  if (!adminInited) {
    // No service account required just for verifyIdToken; projectId helps logs
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
    adminInited = true;
  }
}

async function verifyFirebase(event) {
  initFirebase();
  // Accept both header casings
  const h = event.headers || {};
  const authz = h.authorization || h.Authorization || "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) throw Object.assign(new Error("Missing bearer token"), { statusCode: 401 });
  try {
    // checkRevoked=true: stronger semantics
    return await admin.auth().verifyIdToken(m[1], true);
  } catch {
    throw Object.assign(new Error("Invalid or expired token"), { statusCode: 401 });
  }
}

// ---------- CORS ----------
const ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

// ---------- Env / clients ----------
const {
  BUCKET_NAME,
  S3_REGION = process.env.AWS_REGION || "us-west-2",
  ALLOWED_PREFIXES = "recordings/,transcriptions/",
  MAX_BYTES = "15728640", // 15MB
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
  "text/plain",
]);

export const handler = async (event) => {
  // Preflight
  if (event.requestContext?.http?.method === "OPTIONS" || event.routeKey === "OPTIONS /") {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  try {
    const user = await verifyFirebase(event); // has user.uid, exp, etc.

    const body = parseJson(event.body);
    const key = reqString(body.key, "key");                          // e.g. "recordings/foo.m4a"
    const contentType = reqString(body.contentType, "contentType");  // e.g. "audio/mp4"
    const contentLength = Number(body.contentLength || 0);           // bytes from client

    // (Optional, recommended) Tenancy guard: require user-owned prefix
    // Example: users/<uid>/...
    if (process.env.REQUIRE_UID_PREFIX === "1") {
      const expected = `users/${user.uid}/`;
      if (!key.startsWith(expected)) {
        return bad(403, `key must start with '${expected}' for this user`);
      }
    } else {
      // Otherwise enforce your static prefixes
      if (!allowedPrefixes.some(p => key.startsWith(p))) {
        return bad(400, `key must start with one of: ${allowedPrefixes.join(" ")}`);
      }
    }

    if (!allowedContentTypes.has(contentType)) {
      return bad(400, `Unsupported contentType: ${contentType}`);
    }
    if (!contentLength || contentLength > maxBytes) {
      return bad(400, `contentLength missing or exceeds limit (${maxBytes} bytes).`);
    }

    const putCmd = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      // ServerSideEncryption: "AES256", // optional
    });

    const url = await getSignedUrl(s3, putCmd, { expiresIn: 60 });

    return ok({
      url,
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(contentLength),
      },
      key,
      bucket: BUCKET_NAME,
      region: S3_REGION,
      expiresIn: 60,
      uid: user.uid,
    });

  } catch (err) {
    const code = err?.statusCode || 500;
    console.error("presign error:", err);
    return resp(code, { error: err?.message || "Internal error" });
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
function resp(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}
