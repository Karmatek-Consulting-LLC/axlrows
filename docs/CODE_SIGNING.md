# Code Signing — Azure Trusted Signing (Windows) + Apple Developer ID (macOS)

AXLRows installers must be signed before public release. Without signatures:

- Windows: SmartScreen blocks/warns on first download, and the UAC prompt
  shows **"Unknown Publisher"** — a non-starter for UCM admins installing on
  managed enterprise machines.
- macOS: Gatekeeper refuses to open an unsigned, un-notarized `.dmg`
  downloaded from a browser ("cannot be opened because the developer cannot
  be verified"), with only an unobvious right-click override.

History: SignPath Foundation's free OSS signing was applied for and **denied
(2026-08)**. Decision: pay for signing directly —

- **Windows: Azure Trusted Signing** (~$10/mo Basic tier, shared with
  rxrelay-agent, so no new cost). The signing key lives in Microsoft's HSM
  and GitHub Actions authenticates via OIDC — no certificate file or
  long-lived secret to leak.
- **macOS: Apple Developer Program** ($99/yr) — Developer ID Application
  certificate + notarization. There is no cheaper path Gatekeeper accepts.

---

## Windows — Azure Trusted Signing

**Most of the infrastructure already exists** — it was provisioned for
rxrelay-agent on 2026-07-23 (see `rxrelay-agent/docs/CODE_SIGNING.md`) and is
account-level, so AXLRows reuses it:

| Existing (reused) | Value |
|---|---|
| Subscription | `722b946e-dc51-40a3-bc19-36fcd8c9b801` |
| Resource group | `rxrelay-signing` (eastus) |
| Trusted Signing account | `karmatek-signing` · endpoint `https://eus.codesigning.azure.net` · Basic |
| Public Trust identity validation | **Passed 2026-07-23**, ID `acbc2971-631e-43d7-8071-dce351d74d96` (account-level — no re-validation needed) |
| Entra app (CI signer) | `rxrelay-agent-release-signing`, client ID `fe067dd0-a4c2-4e01-bd32-25d9c010d794` |

The cert subject — what UAC shows as publisher — comes from the identity
validation, not the profile name: `CN="Karma-Tek Consulting, LLC", L=Cary,
S=North Carolina, C=US`.

### One-time setup for this repo (Azure side) — done 2026-08-05

1. **Certificate profile: shared with rxrelay-agent.** A separate `axlrows`
   profile was attempted but the **Basic SKU allows only one certificate
   profile** (`ValidationError: Cert Profile creation failed due to the
   SKU - Basic limitation`), and Premium (~10× the cost) or a second account
   (fresh identity validation) isn't worth it. Both products therefore sign
   with the `rxrelay-agent` profile — cosmetic only: the cert subject
   (what users see) is the company name either way. Revocation is coupled
   across both products; revisit if that ever matters.

2. **Federated credential** `axlrows-release` added to the existing CI signer
   app (GitHub OIDC — one app signs for many repos; each credential is
   repo+environment scoped):

   ```bash
   az ad app federated-credential create \
     --id fe067dd0-a4c2-4e01-bd32-25d9c010d794 --parameters '{
       "name": "axlrows-release",
       "issuer": "https://token.actions.githubusercontent.com",
       "subject": "repo:Karmatek-Consulting-LLC/axlrows:environment:release",
       "audiences": ["api://AzureADTokenExchange"]
     }'
   ```

3. **Role**: none needed — the app's "Artifact Signing Certificate Profile
   Signer" assignment is at **account scope** (`karmatek-signing`), which
   covers every profile.

### One-time setup for this repo (GitHub side) — done 2026-08-05

1. **`release` environment** created, restricted to `v*` tags under
   "Deployment branches and tags" — the OIDC subject in step 2 above only
   matches jobs running in this environment, so nothing outside it can sign.

2. **Repository variables** set (identifiers, not secrets — OIDC handles
   auth):

   | Variable | Value |
   |---|---|
   | `AZURE_CLIENT_ID` | `fe067dd0-a4c2-4e01-bd32-25d9c010d794` |
   | `AZURE_TENANT_ID` | `5e0411c6-6b3e-41c7-b69d-3c24adbe97d3` |
   | `AZURE_SUBSCRIPTION_ID` | `722b946e-dc51-40a3-bc19-36fcd8c9b801` |
   | `SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net` |
   | `SIGNING_ACCOUNT_NAME` | `karmatek-signing` |
   | `SIGNING_CERT_PROFILE` | `rxrelay-agent` (shared — see above) |

   (Identical across Karmatek repos — org-level variables would remove the
   duplication if a third signed repo ever appears.)

`AZURE_CLIENT_ID` doubles as the signing gate: while unset, releases build
UNSIGNED with a warning — fine for internal testing, never for distribution.

### How the workflow signs (and why not Tauri's `signCommand`)

Tauri's documented Azure route (`bundle.windows.signCommand` +
`artifact-signing-cli`) only supports **client-secret** auth, which would
reintroduce a stored, rotating secret. To keep pure OIDC,
`.github/workflows/release.yml` instead uses Tauri 2's split build with the
same `azure/trusted-signing-action` already proven on rxrelay-agent:

1. `tauri build --no-bundle` — compile `axlrows.exe`
2. sign the exe (so the binary **inside** the installers is signed)
3. `tauri bundle` — produce `.msi` + NSIS `-setup.exe`
4. sign both installers

Signatures are RFC 3161 timestamped by the action, so they outlive cert
rotation. Known tradeoff: the NSIS **uninstaller** embedded in `-setup.exe`
stays unsigned (only `signCommand` can reach it). SmartScreen and UAC judge
the installer and the app exe, both signed; revisit only if an AV vendor
complains.

---

## macOS — Apple Developer ID + notarization

### One-time setup (Apple side)

1. **Enroll** in the Apple Developer Program ($99/yr) at
   [developer.apple.com](https://developer.apple.com/programs/enroll/) as
   Karma-Tek Consulting, LLC (organization enrollment needs a D-U-N-S number;
   individual enrollment works too but the publisher string becomes the
   personal name).
2. **Create a "Developer ID Application" certificate**: Keychain Access →
   Certificate Assistant → *Request a Certificate from a Certificate
   Authority* (save to disk) → upload the CSR at developer.apple.com →
   Certificates → **Developer ID Application** → download the `.cer` and
   double-click to add it to the login keychain.
3. **Export as `.p12`**: Keychain Access → My Certificates → right-click the
   Developer ID Application cert → Export, set an export password. Then
   base64 it for GitHub: `base64 -i axlrows-devid.p12 | pbcopy`.
4. **App-specific password** for notarization: account.apple.com → Sign-In
   and Security → App-Specific Passwords.
5. **Team ID**: developer.apple.com → Membership.

### GitHub secrets

Set as secrets (same page as the variables above; environment secrets on
`release` also work):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` (step 3) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Karma-Tek Consulting, LLC (<TEAMID>)` — exact string from `security find-identity -v -p codesigning` |
| `APPLE_ID` | the Apple account email |
| `APPLE_PASSWORD` | the app-specific password (step 4) |
| `APPLE_TEAM_ID` | the Team ID (step 5) |

`APPLE_CERTIFICATE` doubles as the signing gate — while unset, the `.dmg`
builds unsigned/un-notarized with a warning. Tauri's bundler picks these up
from the environment: it codesigns the `.app`, submits the `.dmg` to Apple's
notary service (`notarytool`, usually a couple of minutes), and staples the
ticket. First notarization may require accepting updated agreements at
developer.apple.com.

---

## Verifying a release

- **Windows** (or via `osslsigncode` on Mac/Linux as done for rxrelay-agent):
  `signtool verify /pa /v AXLRows_<ver>_x64-setup.exe` — publisher must show
  Karma-Tek Consulting, LLC with an RFC 3161 timestamp.
- **macOS**: `spctl -a -vv -t install AXLRows_<ver>_universal.dmg` →
  "accepted, source=Notarized Developer ID", and
  `xcrun stapler validate AXLRows_<ver>_universal.dmg`.

## Checklist

- [x] Azure: subscription, Trusted Signing account, identity validation
      (all reused from rxrelay-agent, provisioned 2026-07-23)
- [x] Azure: certificate profile — **shared `rxrelay-agent` profile** (Basic
      SKU allows only one; see above), 2026-08-05
- [x] Azure: federated credential for
      `repo:Karmatek-Consulting-LLC/axlrows:environment:release`, 2026-08-05
- [x] Azure: signer role — already granted at account scope, covers all profiles
- [x] GitHub: `release` environment created, restricted to `v*` tags, 2026-08-05
- [x] GitHub: the six `AZURE_*`/`SIGNING_*` repository variables set, 2026-08-05
- [ ] Apple: Developer Program enrollment (identity verification can take a
      day or two — start early)
- [ ] Apple: Developer ID Application cert created + exported
- [ ] GitHub: the six `APPLE_*` secrets set
- [ ] Test release: tag `v0.1.0`, verify both platforms per the section above
