# Windows code signing (SignPath)

Unsigned Windows installers trigger SmartScreen ("Windows protected your PC").
The release workflow can sign the NSIS setup and the MSI through
[SignPath](https://signpath.io); for open source projects the
[SignPath Foundation](https://signpath.org) provides the certificate for free.

Signing stays off until it is configured; releases then publish unsigned
Windows installers exactly as before.

## One-time setup

1. **License.** SignPath Foundation only signs projects under an OSI-approved
   license: add a `LICENSE` file to the repository first.
2. **Apply** at <https://signpath.org/apply> with the repository URL
   (`https://github.com/ivangg1/UnderTex`). The Foundation reviews the project.
3. Once approved, in the SignPath web app:
   - connect the GitHub repository as a *trusted build system* (GitHub
     Actions), so signing requests can only come from this repo's workflows;
   - create a project (e.g. slug `undertex`) and a signing policy (e.g.
     `release-signing`);
   - add an artifact configuration with the contents of
     [`.github/signpath/artifact-configuration.xml`](../.github/signpath/artifact-configuration.xml);
   - create an API token for a CI user with submitter rights on the policy.
4. In GitHub → Settings → Secrets and variables → Actions:
   - secret `SIGNPATH_API_TOKEN`: the API token;
   - variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`,
     `SIGNPATH_SIGNING_POLICY_SLUG`.

Setting `SIGNPATH_ORGANIZATION_ID` turns signing on for the next tag.

## What the workflow does

1. All platforms build into a **draft** release.
2. `sign-windows` downloads the Windows installers, sends them to SignPath and
   waits for the signed files.
3. Signing changes the files, so it regenerates their updater signatures
   (`.github/scripts/resign-windows.mjs`) and patches `latest.json`.
4. It replaces the release files, and `publish` makes the release public.
   If signing fails the release stays a draft, so users never get a broken
   update.
