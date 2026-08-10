# Changelog

All notable changes are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Planned for 2.0.0

#### Added

- one owned ad-episode controller with deterministic lifecycle handling;
- exact action acknowledgements, bounded retry outbox, and a 256-ID replay window;
- serialized storage updates, badge reconciliation, and legacy count migration;
- privacy-explicit local popup with no remote or personal widgets;
- 76-test offline suite with line, branch, and function coverage evidence;
- 15 reproducible architecture, setup, policy, popup, lifecycle, GIF, receipt, and manifest outputs;
- real unpacked-extension offline Chromium replay across SPA, ad-pod, two-tab, worker-stop, and message-wake boundaries;
- minimal runtime-only extension artifact with SHA-256 inventory.

#### Changed

- acceleration waits six seconds, never exceeds an extension-added 2× rate, and stops for the final eight seconds;
- skip controls are attempted before acceleration;
- content injection is declarative and limited to one controller;
- permissions are reduced to `storage`, with local storage restricted to trusted extension contexts.

#### Security

- trusted sender validation and exact response validation;
- bounded inputs, pending reports, retries, action IDs, and decoder work;
- digest-pinned read-only CI and loopback-only browser evidence capture;
- no analytics, telemetry, remote code, or remotely hosted assets.

### Not yet established

- current live YouTube selector compatibility;
- real short/long ad, ad-pod, consent, regional, SPA, multi-tab, and natural worker-restart acceptance;
- crash atomicity or a guarantee that a DOM click completed a skip.

[Unreleased]: https://github.com/omar07ibrahim/YouTube-Ad-Skipper/compare/main...feat/ad-state-machine
