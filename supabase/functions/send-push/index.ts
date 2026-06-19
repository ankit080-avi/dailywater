// ─────────────────────────────────────────────────────────────────────
// send-push — Supabase Edge Function
//
// Triggered by a Database Webhook on INSERT into `notifications`.
// Looks up FCM tokens for the recipient (`userId`) in `device_tokens`,
// then POSTs to FCM HTTP v1 API. Cleans up dead tokens.
//
// Environment secrets required (set in Supabase Dashboard →
//   Project Settings → Edge Functions → Secrets):
//
//   FIREBASE_SERVICE_ACCOUNT — full JSON of the Firebase Admin SDK
//                              service account (single-line or pretty,
//                              JSON.parse handles both).
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
// Supabase platform — no need to set them manually.
// ─────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FIREBASE_SERVICE_ACCOUNT = Deno.env.get('FIREBASE_SERVICE_ACCOUNT');

// Parse service account at module load. Wrap in try/catch so a malformed secret
// doesn't crash the whole worker — handler returns a useful error message instead.
let sa: any = null;
let saError: string | null = null;
if (!FIREBASE_SERVICE_ACCOUNT) {
  saError = 'FIREBASE_SERVICE_ACCOUNT secret is not set';
  console.error(saError);
} else {
  try {
    sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    saError = 'JSON.parse(FIREBASE_SERVICE_ACCOUNT) failed: ' + (e as Error).message
      + ' — first 80 chars: ' + FIREBASE_SERVICE_ACCOUNT.slice(0, 80);
    console.error(saError);
  }
}
const FCM_URL = sa ? `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send` : '';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Cache the OAuth access token for ~50 min (it's valid for 1 h)
let cachedToken: { token: string; exp: number } | null = null;

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;

  // Import the PEM-formatted PKCS#8 private key
  const pem = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)),
  );
  const jwt = `${signingInput}.${b64url(sigBytes)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth token fetch failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return cachedToken.token;
}

async function sendToToken(token: string, title: string, body: string, data: Record<string, string>) {
  const accessToken = await getAccessToken();
  const message = {
    message: {
      token,
      notification: { title, body },
      data,
      android: { priority: 'HIGH', notification: { sound: 'default', channel_id: 'milkmate_default' } },
      webpush: {
        fcm_options: { link: 'https://ankit080-avi.github.io/MilkMate/' },
        notification: { icon: 'https://ankit080-avi.github.io/MilkMate/icon-192.png' },
      },
    },
  };
  const res = await fetch(FCM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  return { status: res.status, body: await res.text() };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!sa) {
    return new Response(JSON.stringify({ ok: false, error: saError || 'FIREBASE_SERVICE_ACCOUNT not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload: any = null;
  try {
    payload = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Supabase Database Webhook payload shape: { type, table, record, schema, ... }
  const notif = payload?.record;
  if (!notif || !notif.userId) {
    return new Response(JSON.stringify({ ok: false, error: 'no record/userId in payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Pull recipient device tokens
  const { data: tokens, error } = await supabase
    .from('device_tokens')
    .select('id, token, platform')
    .eq('userId', notif.userId);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!tokens || tokens.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, reason: 'no tokens for user' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data: Record<string, string> = {
    type: notif.type ?? '',
    notifId: String(notif.id ?? ''),
    userId: String(notif.userId ?? ''),
  };

  const results = await Promise.all(
    tokens.map(async (t: any) => {
      try {
        const r = await sendToToken(t.token, notif.title || 'MilkMate', notif.body || '', data);
        // Drop dead tokens — FCM returns 404/UNREGISTERED for revoked/uninstalled clients
        const isDead = r.status === 404 || r.status === 410 || /UNREGISTERED|INVALID_ARGUMENT/i.test(r.body);
        if (isDead) {
          await supabase.from('device_tokens').delete().eq('id', t.id);
        }
        return { id: t.id, status: r.status, dropped: isDead };
      } catch (e) {
        return { id: t.id, error: String(e) };
      }
    }),
  );

  return new Response(JSON.stringify({ ok: true, sent: results.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
