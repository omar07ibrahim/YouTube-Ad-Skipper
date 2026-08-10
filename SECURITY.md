# Security policy

## Supported versions

Security fixes target the latest default branch and the latest published release, when one exists. The version 2 work remains unreleased while live-site acceptance is incomplete.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/omar07ibrahim/YouTube-Ad-Skipper/security/advisories/new). Do not open a public issue for a suspected vulnerability and do not include accounts, cookies, browsing history, extension profiles, private URLs, credentials, or personal data.

Include:

- affected commit and browser version;
- minimal reproduction against a synthetic or locally fulfilled fixture;
- impact and attacker prerequisites;
- suggested remediation, if known.

An acknowledgement should arrive within 72 hours. Triage and remediation timing depend on severity and reproducibility. Coordinated disclosure is preferred.

## Runtime boundary

The extension runs one static content script on `https://www.youtube.com/*`, uses the named `storage` permission, and stores one local versioned count plus at most 256 random action IDs. It includes no analytics, telemetry, remote code, or remotely hosted assets.

The state machine interacts with rendered player controls. It does not block network requests, authenticate YouTube state, prove that a skip completed, guarantee ad-free playback, or create a transaction with the page. YouTube CSS classes are an unstable third-party adapter.

## Evidence boundary

Committed browser evidence uses a fresh unpacked extension in digest-pinned Chromium and locally fulfilled HTTPS fixture documents. Capture runs with a loopback-only namespace and aborts unexpected HTTP(S) requests. The evidence proves the declared offline extension and MV3 lifecycle contracts; it does not prove current live YouTube behavior.

Automated live-site CI is intentionally excluded. YouTube’s [Terms of Service](https://uk.youtube.com/t/terms) restrict automated access without prior written permission and prohibit attempts to interfere with the Service. Do not add a bot-driven live YouTube probe unless the repository owner can document an applicable permission or legal basis. Any manual compatibility test remains the tester’s responsibility and must avoid accounts or personal data in evidence.

Please rotate or revoke any credential accidentally committed to Git history even after the current tree is cleaned.
