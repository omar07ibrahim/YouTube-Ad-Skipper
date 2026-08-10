# Contributing

Thank you for helping make the extension behavior smaller, safer, and easier to verify.

## Development setup

Use Node.js 22.19.0 to match hosted CI:

    npm ci --ignore-scripts --no-audit --no-fund
    npm run check
    npm run coverage

The complete offline Chromium evidence gate is:

    npm run visuals:capture
    npm run visuals:verify

Docker is required for browser recapture. The wrapper uses the digest-pinned image and promotes only allowlisted, verified outputs.

## Change expectations

- Preserve one declarative content controller; do not reintroduce duplicate programmatic injection.
- Keep skip-first ordering, conservative acceleration, playback-rate ownership, and BFCache recovery explicit.
- Preserve exact sender validation, acknowledgement shape, bounded retry state, and deduplication semantics.
- Keep the runtime free of third-party dependencies, remote code, analytics, and telemetry.
- Minimize Manifest V3 permissions and explain every new permission.
- Add deterministic tests for state-machine, worker, storage, popup, or renderer changes.
- Use local synthetic fixtures for automated tests. Do not commit accounts, cookies, live browsing data, action UUIDs, extension IDs, timestamps, host paths, credentials, or personal data.
- Do not represent offline fixtures as live YouTube acceptance.
- Do not add automated live-site access without documented permission consistent with YouTube’s terms.
- Keep commits focused, linear, and reviewable.

## Visual evidence

Files under `docs/assets/`, `docs/evidence/`, and the generated `images/icon128.png` are controlled by `scripts/visual-contract.json`.

When a bound input changes:

1. run `npm run visuals:capture`;
2. run `npm run visuals:verify`;
3. review popup pixels, every GIF frame, SVG/text output, receipt, and manifest together;
4. confirm a second capture produces no diff.

Generated files must never be staged mockups. The README labels whether pixels come from the real unpacked extension, a receipt-derived categorical rendering, or deterministic terminal-style output.

## Pull requests

Describe the problem, state-machine or trust-boundary change, exact checks, visual impact, compatibility status, and any remaining live-site uncertainty. By contributing, you agree that your contribution is licensed under MIT.
