# Third-Party Notices

> **Status: release-candidate draft.** This file must be verified against the
> exact source archive, desktop package, bundled resources, lockfiles, model
> download configuration, fonts, icons, sample media, and native binaries of
> each release. Do not treat this draft as a complete legal inventory.

## 1. Scope

Unless otherwise stated, eligible first-party source code in this repository is
intended to be licensed under the Apache License, Version 2.0.

Third-party source code, packages, native binaries, model code, model weights,
fonts, icons, audio samples, and cloud services remain subject to their own
licenses and terms. The repository-level Apache-2.0 license does not relicense
those materials.

Only components actually included in a specific source or binary distribution
should appear in the finalized notices delivered with that distribution.

## 2. Direct JavaScript / TypeScript dependency candidates

The following direct dependencies are declared by the project and must be
resolved to their exact packaged versions and upstream license texts before a
release is published.

| Component | Declared version/range | Typical role | Included in release | License / notice status |
|---|---:|---|---|---|
| `@google/genai` | `^2.4.0` | Gemini API client | Verify | Pending exact-version verification |
| `@modelcontextprotocol/sdk` | `^1.31.0` | MCP server SDK | Verify | Pending exact-version verification |
| `@tailwindcss/vite` | `^4.3.3` | Build integration | Verify | Pending exact-version verification |
| `@vitejs/plugin-react` | `^6.1.1` | React build plugin | Verify | Pending exact-version verification |
| `better-sqlite3` | `^13.0.3` | Local SQLite access | Verify | Pending exact-version verification |
| `dotenv` | `^17.2.3` | Environment configuration | Verify | Pending exact-version verification |
| `express` | `^4.21.2` | Local Node HTTP service | Verify | Pending exact-version verification |
| `jszip` | `^3.10.2` | ZIP import/export | Verify | Pending exact-version verification |
| `lucide-react` | `^0.546.0` | UI icons | Verify | Pending exact-version verification |
| `motion` | `^12.23.24` | UI motion | Verify | Pending exact-version verification |
| `multer` | `^2.4.0` | Multipart uploads | Verify | Pending exact-version verification |
| `react` | `^19.0.1` | UI runtime | Verify | Pending exact-version verification |
| `react-dom` | `^19.0.1` | UI runtime | Verify | Pending exact-version verification |
| `undici` | `^8.11.2` | HTTP client | Verify | Pending exact-version verification |
| `vite` | `^8.3.0` | Build/runtime tooling | Verify | Pending exact-version verification |
| `zod` | `^4.6.5` | Runtime validation | Verify | Pending exact-version verification |
| `electron` | `^44.4.5` | Desktop runtime | Verify | Pending exact-version verification |
| `electron-builder` | `^26.15.3` | Desktop packaging | Usually build-only; verify | Pending exact-version verification |
| `esbuild` | `^0.25.0` | Build tooling | Usually build-only; verify | Pending exact-version verification |
| `typescript` | `^7.0.2` | Build tooling | Usually build-only; verify | Pending exact-version verification |
| `vitest` | `^5.0.1` | Test tooling | Usually not distributed; verify | Pending exact-version verification |

This table is an inventory aid, not a substitute for the exact notices and
license texts required by the versions included in a release artifact.

## 3. Python, native, model, and service candidates

| Component / service | Purpose | Distribution mode | License / terms status |
|---|---|---|---|
| Qwen3-TTS CustomVoice | Preset voice synthesis | Downloaded or locally configured; verify | Record exact repository, revision, code license, and weight license |
| Qwen3-TTS VoiceDesign | AI voice design | Downloaded or locally configured; verify | Record exact repository, revision, code license, and weight license |
| Qwen3-TTS Base | Reference-audio voice cloning | Downloaded or locally configured; verify | Record exact repository, revision, code license, and weight license |
| Whisper model | Speech recognition | Downloaded or locally configured; verify | Record exact model ID, revision, code license, and weight license |
| PyTorch and Python packages | Local inference runtime | Installed or managed runtime; verify | Generate inventory from the exact locked environment |
| FFmpeg | Audio conversion | External system tool or bundled binary; verify | If bundled, include exact build/source and applicable notices |
| `uv` | Managed Python runtime setup | May be bundled/downloaded; verify | Record exact binary version, source, license, and checksum |
| Google Gemini API | Optional cloud TTS / reasoning service | External service, not redistributed | Subject to provider service terms, not Apache-2.0 |

Model weights, model files, and cloud services are not licensed under the
repository Apache-2.0 license unless an upstream license expressly says so.
Maintain the definitive model record in `docs/MODEL_AND_LICENSE_MATRIX.md`.

## 4. Source-code provenance and AGPL reference project

The project documentation records architectural and product-capability reference
to `debpalash/VoiceStudio`, whose referenced repository version is licensed
under AGPL-3.0-only.

The current provenance review has not identified that project as a component
included in this distribution. Architectural reference does not itself create a
third-party notice obligation; however, any confirmed source-code inclusion,
modification, or derivative code must be recorded here with its exact scope and
license before release.

Do not list or remove VoiceStudio from the final release notices solely on the
basis of this draft. Use the completed code-provenance review.

## 5. Fonts, icons, brand assets, and media

Before release, inspect all files under `public/`, `build/`, packaging resource
directories, sample-data directories, and generated demo assets.

At minimum, classify:

- Semovix, Xino｜犀诺, 连犀智语, and RhinoLink-Tech names and logos;
- bundled fonts;
- Lucide or other icon assets;
- screenshots and promotional images;
- generated sample audio;
- reference voices and Voice Profiles;
- user-provided audio or authorization documents.

Brand assets, voice references, Voice Profiles, sample media, and user-generated
content are not automatically covered by Apache-2.0. Document them separately in
`TRADEMARKS.md` and `ASSET_LICENSES.md`.

## 6. Release finalization checklist

Before replacing this draft with release-ready notices:

1. Resolve exact versions from `bun.lock`, Python lockfiles, and the packaged app.
2. Inspect the unpacked desktop package and source archive, not only the repository.
3. Identify every bundled native binary and copied source file.
4. Collect upstream copyright and attribution notices that must be retained.
5. Include or reference the applicable license texts in the distribution.
6. Separate model-code licenses from model-weight licenses.
7. Confirm that no unlicensed voice sample, font, logo, or media asset is bundled.
8. Confirm that `LICENSE`, `NOTICE`, and the finalized third-party notices are in
   the top level of each source and binary distribution.
9. Record the release tag/commit and artifact checksum used for the inventory.
10. Have the final file reviewed by the project owner or qualified counsel where
    commercial or regulatory exposure is material.
