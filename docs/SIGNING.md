# Windows code signing (SignPath Foundation)

AXLRows' Windows installers are signed for free through
[SignPath Foundation](https://signpath.org), which sponsors code signing for
open source projects. The `.github/workflows/windows-release.yml` workflow
builds the NSIS (`.exe`) and MSI installers and submits them to SignPath;
until the SignPath secrets are configured it simply skips signing and
produces unsigned installers.

## One-time setup

### 1. Apply to SignPath Foundation

Apply at <https://signpath.org> ("Get free code signing"). Their
[conditions](https://signpath.org/terms.html) that apply to this repo:

- OSI-approved license, no commercial dual-licensing — MIT, see
  [LICENSE.md](../LICENSE.md).
- Actively maintained, with released and documented functionality (the
  README and GitHub Releases cover this — cut at least one release first).
- Every account with write access to this repo has **MFA enabled on GitHub**.
- Defined roles: at least one *author*, *reviewer*, and *approver*. For a
  solo project one person can hold all three, but say so in the application.

Approval typically takes a few days to a couple of weeks.

### 2. Connect GitHub to SignPath

- Install the [SignPath GitHub App](https://docs.signpath.io/trusted-build-systems/github)
  on the `Karmatek-Consulting-LLC/axlrows` repository.
- In the SignPath organization, link the predefined trusted build system
  **GitHub.com** to the project.

### 3. Create the SignPath project

- Project slug: `axlrows` (the workflow hardcodes this).
- Signing policies: `test-signing` (manual/dispatch builds) and
  `release-signing` (tag builds). The workflow picks the policy based on
  whether it was triggered by a `v*` tag. Release signing with the
  Foundation certificate normally requires a manual approval per request —
  that's the approver role.
- Artifact configuration: `actions/upload-artifact` wraps the staged
  installers in a ZIP, so the root element must be `zip-file`:

  ```xml
  <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
    <zip-file>
      <pe-file path="*-setup.exe">
        <authenticode-sign/>
      </pe-file>
      <msi-file path="*.msi">
        <authenticode-sign/>
      </msi-file>
    </zip-file>
  </artifact-configuration>
  ```

  Check the exact syntax against the
  [artifact configuration docs](https://docs.signpath.io/documentation/artifact-configuration/)
  when setting this up — installer file names include the version number,
  hence the wildcards.

### 4. Configure the repository

In GitHub repo settings:

- **Secret** `SIGNPATH_API_TOKEN` — an API token for a SignPath CI user.
- **Variable** `SIGNPATH_ORGANIZATION_ID` — the SignPath organization ID
  (a UUID, visible in the SignPath portal URL).

Once both exist, the next workflow run signs automatically.

## Cutting a signed release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow builds, signs with `release-signing` (approve the request in
the SignPath portal when the email arrives), and attaches the signed
installers to a **draft** GitHub release for review.

`workflow_dispatch` runs use `test-signing` and only upload workflow
artifacts — test-signed binaries are not for distribution.

## Known limitations

- **Publisher name**: SignPath Foundation certificates show
  **"SignPath Foundation"** as the publisher in UAC prompts, not Karmatek.
  That's the trade-off for free signing. Moving to Azure Artifact Signing
  (~$120/yr) or a Certum open-source certificate would put our own name on
  the dialog.
- **SmartScreen reputation** still builds per-certificate/per-file over
  time; early downloads of a new release may warn until enough installs
  accumulate. Signing removes the "unknown publisher" block, not day-one
  friction.
- **The app binary inside the installers is not signed** — only the
  installers themselves. Deep-signing `axlrows.exe` would need a two-pass
  workflow (`tauri build --no-bundle` → sign the exe → `tauri bundle` →
  sign the installers), i.e. two signing requests per release. Worth doing
  once the basic flow is proven; some AV heuristics look at the inner
  binary.
- **macOS is out of scope**: SignPath is Windows/Authenticode only. Mac
  distribution needs the Apple Developer Program ($99/yr) for Developer ID
  signing + notarization.
