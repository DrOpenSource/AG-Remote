import crypto from 'crypto';

/** What the phone's PushManager hands out (PushSubscription.toJSON()). */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** This PC's VAPID key pair. The push services check pushes are signed by the key the phone subscribed with. */
export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateJwk: JsonWebKey;
}

// Push services the phone browsers use. The endpoint comes from a paired phone, but the PC should
// still never POST to an arbitrary URL on its behalf.
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.push\.apple\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/];

const b64u = (buf: Buffer) => buf.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)])), privateJwk: jwk };
}

/** Checks a subscription from the phone before storing it. Returns it trimmed to the fields we use. */
export function validSubscription(sub: any): PushSub | null {
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
    const { p256dh, auth } = sub.keys || {};
    if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return null;
    return { endpoint: url.href, keys: { p256dh, auth } };
  } catch (_) {
    return null;
  }
}

/** RFC 8291 (aes128gcm): only the phone can read the payload, not Google or Apple. */
export function encryptPayload(sub: PushSub, plaintext: Buffer): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // A single record, so the 0x02 "last record" delimiter and no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 VAPID header: a short-lived ES256 JWT scoped to the push service's origin. */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string): string {
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  })}`;
  const key = crypto.createPrivateKey({ key: vapid.privateJwk as crypto.JsonWebKey, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Sends one notification. 'gone' means the phone dropped the subscription and it should be forgotten. */
export async function sendPush(sub: PushSub, payload: object, vapid: VapidKeys, subject: string, ttlSeconds = 3600): Promise<PushResult> {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttlSeconds),
        Urgency: 'high',
        Authorization: vapidAuthorization(sub.endpoint, vapid, subject)
      },
      body: encryptPayload(sub, Buffer.from(JSON.stringify(payload)))
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch (_) {
    return 'failed';
  }
}
