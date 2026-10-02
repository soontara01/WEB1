# Deploying to AKS behind Application Gateway (AGIC)

Target setup: Azure Application Gateway v2 (TLS termination, optional WAF) → AGIC → pods serving plain HTTP on port 3000 → MongoDB Atlas on Azure. Users sign in with Microsoft Entra ID (OpenID Connect).

The app is stateless. MongoDB holds **only sessions** (including the CSRF token and the signed-in user's name, email and object ID). The app stores no users, passwords or tokens. Pods can be scaled freely and **no cookie affinity is needed**.

## 1. Build the image

The Angular apps are baked into the image. Before `docker build`, CI must copy each Angular build output into `apps/<name>/browser`:

```bash
# in each Angular repo (baseHref must match the name in SPA_APPS, and inlineCritical must be false; see CLAUDE.md)
ng build --base-href /inventory/     # -> dist/inventory/browser

# in this repo
mkdir -p apps/inventory apps/sale
cp -r ../inventory/dist/inventory/browser apps/inventory/browser
cp -r ../sale/dist/sale/browser       apps/sale/browser
docker build -t <acr>.azurecr.io/web1-appserver:<git-sha> .
```

The image runs as UID 1000 and does not write to its filesystem.

## 2. Configuration

Every variable is validated at startup, and the pod exits with a clear message if one is invalid. See `.env.example` for all options.

**ConfigMap**

| Variable | Value on AKS | Why |
|---|---|---|
| `NODE_ENV` | `production` | Enables Secure cookies, HSTS and hides error details |
| `PORT` | `3000` | |
| `TRUST_PROXY` | App Gateway **subnet CIDR**, e.g. `10.225.0.0/24` | Trust `X-Forwarded-For`/`-Proto` only from the gateway. Without it, session cookies are not sent (the pod sees HTTP) and logs show the gateway IP instead of the client |
| `SHUTDOWN_DELAY_MS` | `30000` | Pod keeps serving while AGIC removes it from the backend pool |
| `MONGO_DB` | e.g. `app` | |
| `SESSION_TTL_SECONDS` | `28800` (8 h) | Sessions are not re-checked against Entra: a user disabled there keeps access until the session expires |
| `PUBLIC_BASE_URL` | `https://app.example.com` | Public origin; the OIDC redirect URI is `PUBLIC_BASE_URL/api/auth/callback` |
| `OIDC_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Use the tenant **ID (GUID)**, not a domain name, or issuer validation fails |
| `OIDC_CLIENT_ID` | Application (client) ID | |
| `MONGO_MAX_POOL_SIZE` | e.g. `20` | See [Atlas](#5-mongodb-atlas) |
| `SPA_APPS` | `inventory:/app/apps/inventory/browser,sale:/app/apps/sale/browser` | Must match the folders baked into the image |
| `LOG_LEVEL` | `info` | JSON logs go to stdout (Container Insights) |

**Secret** (preferably synced from Key Vault via the Secrets Store CSI driver)

| Variable | Notes |
|---|---|
| `MONGO_URI` | `mongodb+srv://...` Atlas connection string |
| `SESSION_SECRETS` | Comma-separated, each ≥ 32 chars. To rotate, **prepend** a new secret and keep the old one until sessions expire (`SESSION_TTL_SECONDS`) |
| `OIDC_CLIENT_SECRET` | Client secret from the app registration. It **expires** (max 24 months), so track the date and rotate before then or every sign-in fails |

## 2a. Entra ID app registration

Create once per environment in *Microsoft Entra ID → App registrations → New registration*:

1. **Supported account types:** *Accounts in this organizational directory only* (single tenant). Everyone in the tenant can sign in.
2. **Redirect URI:** platform **Web**, `https://app.example.com/api/auth/callback`. Add `http://localhost:3000/api/auth/callback` on a separate dev registration for local development.
3. **Certificates & secrets → New client secret** → store it in Key Vault as `OIDC_CLIENT_SECRET`.
4. **Front-channel logout URL** (optional): `https://app.example.com/`.
5. No API permissions are needed beyond the default `User.Read` delegated permission; the app only reads the ID token (`oid`, `name`, `preferred_username`/`email`, `roles`).

**Egress:** pods must reach `https://login.microsoftonline.com` (discovery, token endpoint, signing keys). If cluster egress goes through Azure Firewall or a proxy, allow this FQDN.

## 3. Pod spec requirements

```yaml
spec:
  terminationGracePeriodSeconds: 60        # must exceed SHUTDOWN_DELAY_MS/1000 + 10
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: app
      image: <acr>.azurecr.io/web1-appserver:<git-sha>
      ports: [{ containerPort: 3000 }]
      envFrom:
        - configMapRef: { name: web1-appserver }
        - secretRef: { name: web1-appserver }
      readinessProbe:                        # AGIC also uses this as the App Gateway health probe
        httpGet: { path: /readyz, port: 3000 }
        periodSeconds: 5
        failureThreshold: 2
      livenessProbe:                         # process only; does not check MongoDB
        httpGet: { path: /healthz, port: 3000 }
        periodSeconds: 10
        failureThreshold: 3
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      resources:
        requests: { cpu: 250m, memory: 256Mi }
        limits: { memory: 512Mi }
```

Notes:
- **`/readyz` checks MongoDB.** If Atlas is unreachable, every pod goes unready and the gateway returns 502 for all paths, including static files. This is intentional: without the database no API call can succeed.
- **Shutdown sequence.** On SIGTERM, `/readyz` returns 503 immediately and the pod keeps serving for `SHUTDOWN_DELAY_MS`. It then stops accepting connections, finishes in-flight requests (up to 10s) and exits 0. Do not add a `preStop` sleep on top of this; the delay is already in the app.
- **Scaling.** Node.js runs on one CPU core per process, so scale by adding replicas (HPA on CPU, around 70%) rather than raising CPU limits. Add a PodDisruptionBudget (`minAvailable: 1` or more) and spread pods across zones.

## 4. Ingress (AGIC)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web1-appserver
  annotations:
    appgw.ingress.kubernetes.io/backend-protocol: "http"
    appgw.ingress.kubernetes.io/ssl-redirect: "true"
    appgw.ingress.kubernetes.io/appgw-ssl-certificate: "<cert-name-in-appgw>"
    appgw.ingress.kubernetes.io/cookie-based-affinity: "false"   # not needed; sessions are in MongoDB
    appgw.ingress.kubernetes.io/connection-draining: "true"
    appgw.ingress.kubernetes.io/connection-draining-timeout: "30"
    appgw.ingress.kubernetes.io/request-timeout: "30"
spec:
  ingressClassName: azure-application-gateway
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: web1-appserver, port: { number: 80 } } }
```

Route **everything** (`/`) to the service and do not rewrite paths. The app handles `/api/*`, `/inventory/*`, `/sale/*` and `/` itself.

## 5. MongoDB Atlas

- **Network:** use a Private Endpoint (Azure Private Link) from the AKS VNet, or add the cluster's egress IP (NAT gateway or load balancer outbound IP) to the Atlas IP access list.
- **Connections:** each pod opens up to `MONGO_MAX_POOL_SIZE` connections. Keep `HPA maxReplicas × MONGO_MAX_POOL_SIZE` (plus headroom for deploys, which briefly run old and new pods together) below your tier's limit (for example M10 allows 1,500).
- **Indexes:** the app creates its indexes on startup (TTL index on `sessions`; that is the only collection). The database user needs `readWrite` on `MONGO_DB` (which includes `createIndex`).

## 6. Rate limiting (required at the gateway)

**The app has no rate limiting of its own.** If the gateway does not enforce it, there is none. This requires the **WAF_v2** SKU; Standard_v2 has no custom rate-limit rules.

Add WAF policy custom rules of type `RateLimitRule`, grouped by `ClientAddr` (the gateway sees the real client IP):

| Priority | Match (RequestUri) | Suggested threshold | Purpose |
|---|---|---|---|
| 10 | begins with `/api/auth/` | ~20 requests / 1 min per IP | Sign-in flow abuse (passwords are checked by Entra, which has its own lockout) |
| 20 | begins with `/api/` | ~300 requests / 1 min per IP | General API abuse |

Action `Block` (the client gets 403 from the gateway). Tune the thresholds to real traffic. Clients behind a shared NAT (corporate networks) count as one IP. Static files (`/`, `/inventory/`, `/sale/`) normally need no limit.

## 7. Application Gateway and WAF

- **Client IP:** App Gateway appends the client port to `X-Forwarded-For` (`203.0.113.7:51234`). The app strips it (`src/middleware/clientIp.ts`), so no rewrite rule is required.
- **WAF body size:** the app limits JSON bodies to `BODY_LIMIT` (100kb by default). The WAF's own request body limit must be at least that.
- **Headers:** the WAF and rewrite rules must pass the `X-CSRF-Token` header and the session cookie (`SESSION_NAME`, default `sid`) through unchanged.
- **HSTS:** the app already sends HSTS in production. Don't add a second, conflicting header at the gateway.

## 8. Checklist after first deploy

```bash
curl -sI https://app.example.com/ | grep -i -E "strict-transport|content-security"   # security headers present
curl -s  https://app.example.com/readyz                                              # {"status":"ready"}
curl -s -c jar https://app.example.com/api/auth/csrf && grep sid jar                 # cookie issued (TRUST_PROXY ok)
curl -sI https://app.example.com/api/auth/login | grep -i location                  # redirects to login.microsoftonline.com (OIDC config + egress ok)
kubectl logs deploy/web1-appserver | grep clientIp | head                            # real client IPs, no ports
kubectl rollout restart deploy/web1-appserver   # while running a load test: no 502s expected
```
