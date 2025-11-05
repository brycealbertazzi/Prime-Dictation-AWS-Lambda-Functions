// Lightweight Firebase token verification for AWS Lambda (no revocation).
// Requires env: FIREBASE_PROJECT_ID = "<your-firebase-project-id>"

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let inited = false;
function initFirebase() {
  if (!inited) {
    // Important: pass projectId so Admin SDK doesn't try GCP metadata discovery on AWS.
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      // Fail fast with a clear message if not set.
      throw new Error("FIREBASE_PROJECT_ID env var is required");
    }
    initializeApp({ projectId });
    inited = true;
  }
}

function firstString(v) {
  if (Array.isArray(v)) return v.find(x => typeof x === "string") || null;
  return typeof v === "string" ? v : null;
}

function extractAuthHeader(event) {
  const h = event?.headers || {};
  const lower = {};
  for (const k in h) lower[k.toLowerCase()] = h[k];

  const candidates = [
    lower["authorization"],           // most common
    lower["x-authorization"],         // fallback
    firstString(event?.multiValueHeaders?.authorization),
    firstString(event?.multiValueHeaders?.Authorization),
  ].filter(Boolean);

  const raw = firstString(candidates) || "";
  // Accept "Bearer <token>" or bare JWT
  const m =
    /^\s*Bearer\s+(.+)\s*$/i.exec(String(raw)) ||
    /^\s*([A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+)\s*$/.exec(String(raw));
  return m?.[1] || null;
}

export async function verifyFirebase(event) {
  initFirebase();

  const token = extractAuthHeader(event);
  if (!token) {
    const e = new Error("Missing bearer token");
    e.statusCode = 401;
    throw e;
  }

  try {
    // No revocation check (works without Google credentials on AWS).
    return await getAuth().verifyIdToken(token);
  } catch (err) {
    console.warn("Auth: verifyIdToken failed:", err?.message);
    const e = new Error("Invalid or expired token");
    e.statusCode = 401;
    throw e;
  }
}
