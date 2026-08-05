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

- **Windows: Azure Trusted Signing** (Basic tier, ~$10/mo). The signing key
  lives in Microsoft's HSM and GitHub Actions authenticates via OIDC — no
  certificate file or long-lived secret to leak, in this repo or anywhere.
- **macOS: Apple Developer Program** ($99/yr) — Developer ID Application
  certificate + notarization. There is no cheaper path Gatekeeper accepts.

AXLRows has its own dedicated signing infrastructure (account, certificate
profile, CI identity) — nothing is shared with any other Karma-Tek project.

---

## Windows — Azure Trusted Signing

Dedicated resources (provisioned 2026-08-05):

| Resource | Value |
|---|---|
| Resource group | `axlrows-signing` (eastus) |
| Trusted Signing account | `axlrows-signing` · endpoint `https://eus.codesigning.azure.net` · Basic |
| Certificate profile | `axlrows` (Public Trust) — pending identity validation |
| Entra app (CI signer) | `axlrows-release-signing`, GitHub-OIDC federated for `repo:Karmatek-Consulting-LLC/axlrows:environment:release`, "Artifact Signing Certificate Profile Signer" role on the account |

Azure resource IDs (tenant, subscription, client ID) are deliberately not
committed — this is a public repo. They live as GitHub repository variables
(Settings → Secrets and variables → Actions); fetch the client ID any time
with:

```bash
az ad app list --display-name axlrows-release-signing --query '[0].appId' -o tsv
```

### Remaining setup (in order)

1. **Identity validation** (portal-only, no CLI): portal.azure.com → Trusted
   Signing account `axlrows-signing` → Identity validation → new **Public
   Trust** validation with Karma-Tek Consulting, LLC's registered details.
   Usually completes same-day for an already-verified entity, but it gates
   everything below. (Known quirk: the verify-email link can intermittently
   return "The request is blocked" — a transient Microsoft WAF issue;
   retrying the link resolves it.)

2. **Certificate profile**, once validation shows Completed:

   ```bash
   az trustedsigning certificate-profile create \
     -g axlrows-signing --account-name axlrows-signing \
     -n axlrows --profile-type PublicTrust \
     --identity-validation-id <id shown on the completed validation>
   ```

3. **Flip signing on** by setting the last repo variable (its absence is the
   self-skip gate — until then releases build UNSIGNED with a warning):

   ```bash
   gh variable set AZURE_CLIENT_ID \
     -b "$(az ad app list --display-name axlrows-release-signing --query '[0].appId' -o tsv)"
   ```

Already in place on the GitHub side: the `release` environment (restricted
to `v*` tags — the OIDC federation subject only matches jobs in this
environment, so nothing outside it can sign) and the `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `SIGNING_ENDPOINT`, `SIGNING_ACCOUNT_NAME`, and
`SIGNING_CERT_PROFILE` variables.

### How the workflow signs (and why not Tauri's `signCommand`)

Tauri's documented Azure route (`bundle.windows.signCommand` +
`artifact-signing-cli`) only supports **client-secret** auth, which would
reintroduce a stored, rotating secret. To keep pure OIDC,
`.github/workflows/release.yml` instead uses Tauri 2's split build with
`azure/trusted-signing-action`:

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

- **Windows** (or via `osslsigncode` on Mac/Linux):
  `signtool verify /pa /v AXLRows_<ver>_x64-setup.exe` — publisher must show
  Karma-Tek Consulting, LLC with an RFC 3161 timestamp.
- **macOS**: `spctl -a -vv -t install AXLRows_<ver>_universal.dmg` →
  "accepted, source=Notarized Developer ID", and
  `xcrun stapler validate AXLRows_<ver>_universal.dmg`.

## Checklist

- [x] Azure: resource group + Trusted Signing account `axlrows-signing`
      (Basic, eastus), 2026-08-05
- [x] Azure: Entra app `axlrows-release-signing` + GitHub OIDC federated
      credential + signer role on the account, 2026-08-05
- [x] GitHub: `release` environment created, restricted to `v*` tags, 2026-08-05
- [x] GitHub: `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SIGNING_*`
      repository variables set, 2026-08-05
- [ ] Azure: **Public Trust identity validation** (portal — the long pole,
      start first)
- [ ] Azure: certificate profile `axlrows` created (needs the validation ID)
- [ ] GitHub: `AZURE_CLIENT_ID` variable set — flips Windows signing on
- [ ] Apple: Developer Program enrollment (identity verification can take a
      day or two — start early)
- [ ] Apple: Developer ID Application cert created + exported
- [ ] GitHub: the six `APPLE_*` secrets set
- [ ] Test release: tag `v0.1.0`, verify both platforms per the section above
