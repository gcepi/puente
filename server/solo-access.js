import crypto from 'node:crypto';

const lifetime = 30 * 24 * 60 * 60; // seconds
const cookieName = 'puente_solo';

// Bind this host-only permission to the deployment and current host passcode.
// It survives server restarts and rotating either credential revokes existing grants.
export function createSoloAccess({ openaiKey, hostPasscode }) {
  const available = Boolean(openaiKey && hostPasscode);
  const key = crypto.createHmac('sha256', openaiKey).update('puente/solo/v1\0' + hostPasscode).digest();
  const sign = (value) => crypto.createHmac('sha256', key).update(value).digest('base64url');
  return {
    available,
    grant(secure) {
      const expiry = Math.floor(Date.now() / 1000) + lifetime;
      const grant = expiry + '.' + crypto.randomBytes(12).toString('hex');
      return `${cookieName}=${grant}.${sign(grant)}; Path=/; Max-Age=${lifetime}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
    },
    authorized(cookies = '') {
      if (!available) return false;
      const match = cookies.match(/(?:^|;\s*)puente_solo=(\d{1,12})\.([a-f0-9]{24})\.([\w-]{43})(?:;|$)/);
      if (!match || Number(match[1]) <= Date.now() / 1000) return false;
      return crypto.timingSafeEqual(Buffer.from(match[3]), Buffer.from(sign(match[1] + '.' + match[2])));
    },
  };
}
