import * as oidc from 'openid-client';
import type { Config } from '../config/env.js';

/** What the app keeps about the signed-in user. Tokens are not stored. */
export interface SessionUser {
  /** Entra object ID (`oid`), stable per user in the tenant; falls back to `sub` for other IdPs. */
  id: string;
  name: string;
  email: string;
  roles: string[];
}

/** Per-login values that must survive the redirect to the IdP and back (stored in the session). */
export interface AuthRequestChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcClient {
  createAuthRequest(): Promise<AuthRequestChecks & { url: URL }>;
  /** Validates the callback (state, PKCE, nonce, ID token) and returns the user. Throws on failure. */
  completeAuth(callbackUrl: URL, expected: AuthRequestChecks): Promise<SessionUser>;
  /** IdP sign-out URL, if the provider supports it. */
  endSessionUrl(): Promise<URL | undefined>;
}

export const CALLBACK_PATH = '/api/auth/callback';

type OidcConfig = Pick<
  Config,
  'PUBLIC_BASE_URL' | 'OIDC_ISSUER' | 'OIDC_CLIENT_ID' | 'OIDC_CLIENT_SECRET' | 'OIDC_SCOPES'
>;

/**
 * Authorization Code + PKCE against any OIDC provider (Microsoft Entra ID in production).
 * `allowInsecure` permits an http:// issuer and exists only for tests; it is not configurable via env.
 */
export function createOidcClient(config: OidcConfig, { allowInsecure = false } = {}): OidcClient {
  const redirectUri = `${config.PUBLIC_BASE_URL}${CALLBACK_PATH}`;

  // Discovery is lazy so pods start even if the IdP is briefly unreachable. A failed attempt is not
  // cached, so the next login retries. The metadata is identical on every pod.
  let discovered: Promise<oidc.Configuration> | undefined;
  const getConfiguration = () => {
    discovered ??= oidc
      .discovery(
        new URL(config.OIDC_ISSUER),
        config.OIDC_CLIENT_ID,
        undefined,
        oidc.ClientSecretPost(config.OIDC_CLIENT_SECRET),
        allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        discovered = undefined;
        throw err;
      });
    return discovered;
  };

  return {
    async createAuthRequest() {
      const configuration = await getConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: config.OIDC_SCOPES,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        // Default response_mode=query: the callback is a top-level GET, so the SameSite=Lax session
        // cookie is sent. form_post would drop the cookie and break the state check.
      });
      return { url, state, nonce, codeVerifier };
    },

    async completeAuth(callbackUrl, expected) {
      const configuration = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: expected.codeVerifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('ID token missing from token response');
      return toSessionUser(claims);
    },

    async endSessionUrl() {
      const configuration = await getConfiguration();
      if (!configuration.serverMetadata().end_session_endpoint) return undefined;
      return oidc.buildEndSessionUrl(configuration, {
        post_logout_redirect_uri: `${config.PUBLIC_BASE_URL}/`,
        client_id: config.OIDC_CLIENT_ID,
      });
    },
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function toSessionUser(claims: oidc.IDToken): SessionUser {
  return {
    id: str(claims.oid) ?? claims.sub,
    name: str(claims.name) ?? '',
    email: str(claims.email) ?? str(claims.preferred_username) ?? '',
    roles: Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : [],
  };
}
