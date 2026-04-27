/**
 * Tiny JWT payload decoder. We never validate signatures here — that's the
 * server's job. Client-side decode is purely to read claims like the user
 * id (`sub`) for local identity-linking after sign-in.
 *
 * No external dependency: jose / jwt-decode would each pull in 10-20 KB
 * for what's a one-screen function.
 */

export interface JwtClaims {
  sub?: string;
  email?: string;
  name?: string;
  unique_name?: string;
  display_name?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

export function decodeJwt(token: string): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // base64url -> base64 + padding
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}
