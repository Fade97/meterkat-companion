# Security policy

Please report vulnerabilities in the companion, the protocol or the release/update chain **privately** through GitHub's [private vulnerability reporting](https://github.com/Fade97/meterkat-companion/security/advisories/new), not in public issues.

Include what you found, how to reproduce it and the affected version (`meterkat version`). Fixes ship as a signed release that installed companions pick up automatically within a day.

In scope:

- this repository: collectors, local state, pairing, relay client, autostart, self-update and packaging;
- protocol v2 ([protocol/v2.md](protocol/v2.md)) and its use by the hosted relay `meterkat-relay.fabian-duerkop.de`;
- the signed releases in [Fade97/meterkat-releases](https://github.com/Fade97/meterkat-releases).

Out of scope: denial of service through volume against the hosted relay, and findings in the provider CLIs themselves (report those to Anthropic, OpenAI or Google).
