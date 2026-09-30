# Distribution License Verification Checklist

Use this checklist against each actual source archive and packaged desktop build.
Repository contents alone are not sufficient.

## Required top-level files

- [ ] `LICENSE` contains the unmodified Apache License 2.0 text.
- [ ] `NOTICE` contains only applicable informational attribution notices.
- [ ] `THIRD_PARTY_NOTICES.md` reflects the exact contents of this artifact.

## Artifact inspection

- [ ] Record source commit/tag.
- [ ] Record artifact filename and SHA-256.
- [ ] Inspect the unpacked source archive.
- [ ] Inspect the unpacked Electron package/application resources.
- [ ] Confirm all bundled JavaScript dependencies and exact versions.
- [ ] Confirm all bundled Python packages and exact versions.
- [ ] Confirm all native binaries, including FFmpeg or `uv`, if present.
- [ ] Confirm model weights are not unintentionally bundled.
- [ ] Confirm no real-person reference audio or authorization documents are bundled.
- [ ] Confirm fonts, icons, logos, screenshots, and sample media have recorded terms.

## Scope checks

- [ ] First-party source code intended for Apache-2.0 has a verified provenance basis.
- [ ] Any copied or modified third-party source is listed with exact scope and license.
- [ ] Model code and model weights are listed separately.
- [ ] External cloud services are described as services, not redistributed software.
- [ ] Brand and trademark rights are not implied by the Apache-2.0 code license.

## Build verification commands

```bash
bun run lint
bun run test
bun run build
bun run package:dir
```

After packaging, search the output for the required files and prohibited assets.
Adapt paths to the actual packaging output:

```bash
find release dist -type f \
  \( -name LICENSE -o -name NOTICE -o -name 'THIRD_PARTY_NOTICES.md' \) -print

find release dist -type f \
  \( -iname '*.wav' -o -iname '*.mp3' -o -iname '*.flac' \
     -o -iname '*.pt' -o -iname '*.safetensors' -o -iname '*.bin' \) -print
```

## Release sign-off

- Release/version:
- Commit:
- Source archive SHA-256:
- Desktop artifact SHA-256:
- Reviewer:
- Review date:
- Unresolved items:
