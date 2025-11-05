// auth.mjs (or inline in the same file)
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let inited = false;
function initFirebase() {
  if (!inited) {
    initializeApp(); // ← no credential object
    inited = true;
  }
}

function firstString(v) {
  // Handles strings, arrays, undefined
  if (Array.isArray(v)) return v.find(x => typeof x === "string") || null;
  return typeof v === "string" ? v : null;
}

function extractAuthHeader(event) {
  // 1) Standard headers map (Function URL typically lower-cases keys)
  const h = event?.headers || {};
  // Build a normalized, lowercased map defensively
  const lower = {};
  for (const k in h) {
    if (Object.hasOwn(h, k)) lower[k.toLowerCase()] = h[k];
  }

  // Try common header names
  const candidates = [
    lower["authorization"],
    lower["x-authorization"],
    // API Gateway (or other proxies) may use multiValueHeaders
    firstString(event?.multiValueHeaders?.authorization),
    firstString(event?.multiValueHeaders?.Authorization),
  ].filter(Boolean);

  const raw = firstString(candidates) || null;
  return raw;
}

export async function verifyFirebase(event) {
  initFirebase();

  const raw = extractAuthHeader(event);
  if (!raw) {
    console.warn("Auth: no Authorization header. headers keys:", Object.keys(event?.headers || {}));
    const e = new Error("Missing bearer token"); e.statusCode = 401; throw e;
  }

  // Accept odd spacing/casing, with or without "Bearer"
  const m = /^\s*Bearer\s+(.+)\s*$/i.exec(raw) || /^\s*([A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+)\s*$/.exec(raw);
  const token = m?.[1];
  if (!token) {
    console.warn("Auth: Authorization header present but not a Bearer/JWT:", raw.slice(0, 32) + "…");
    const e = new Error("Malformed Authorization header"); e.statusCode = 401; throw e;
  }

  try {
    // Set to false if you don’t need revocation checking
    return await getAuth().verifyIdToken(token);
  } catch (err) {
    console.warn("Auth: verifyIdToken failed:", err?.message);
    const e = new Error("Invalid or expired token"); e.statusCode = 401; throw e;
  }
}
