# Security Policy

`pixel-serve-server` handles user-supplied query parameters, fetches arbitrary
network resources (subject to an allowlist), and reads files from disk, so it
sits in a vulnerability class that warrants a clear disclosure channel. This
document describes how to report security issues, which versions are covered,
and what is in and out of scope.

## Supported Versions

Security fixes are backported to the **current** major release line. Older
majors receive fixes only when the underlying change is low-risk and the issue
is rated High or Critical.

| Version | Supported          | Notes                                                    |
| ------- | ------------------ | -------------------------------------------------------- |
| `2.x`   | Yes                | Active development line — all severities patched here    |
| `1.x`   | Security only      | High / Critical only; see `MIGRATION.md` to upgrade      |
| `< 1.0` | No                 | Pre-stable; upgrade to `2.x`                             |

## Reporting a Vulnerability

**Please do not open a public GitHub issue** for security reports. Use one of
the following private channels, in order of preference:

1. **GitHub Security Advisories (preferred).** Open a draft advisory at
   [github.com/Hiprax/pixel-serve-server/security/advisories/new](https://github.com/Hiprax/pixel-serve-server/security/advisories/new).
   This keeps the report private until disclosure and gives maintainers a
   workspace to coordinate a patch and a CVE.
2. **Private email to the maintainer.** If GitHub is unavailable, contact the
   author listed in `package.json#author` via the email address on their
   GitHub profile.

When reporting, please include (as much as you can):

- A description of the vulnerability and the conditions required to reach it.
- The affected version(s) of `pixel-serve-server` (and Node.js, Sharp, axios,
  etc. when relevant).
- A proof-of-concept (request, payload, or reproduction script). Minimal
  reproductions accelerate triage significantly.
- Suggested mitigations or fixes if you have them.

## Response Targets

- **Acknowledgement:** within 5 business days.
- **Initial assessment** (severity, scope, reproducer confirmation): within 10
  business days.
- **Fix or mitigation** for High / Critical issues: within 30 days of
  confirmation when feasible. Lower-severity issues are scheduled into the
  normal release cadence.

## Embargo and Disclosure Policy

`pixel-serve-server` follows a **90-day coordinated disclosure** window by
default:

- The reporter is asked to keep the issue private for up to 90 days from the
  date of acknowledgement so a patched release and security advisory can ship
  together.
- For straightforward issues a patched release is typically published well
  within that window.
- If the maintainers cannot ship a fix within 90 days, the embargo may be
  extended by mutual agreement. We will not unilaterally extend the embargo.
- After the patched release, the GitHub Security Advisory is published and
  credit is given to the reporter unless they request otherwise.

If the vulnerability is being actively exploited in the wild, the embargo can
be shortened — please flag this in the initial report.

## Scope

### In scope

- The `pixel-serve-server` npm package source under `src/` and the published
  `dist/` artifacts.
- The middleware factory `registerServe` and every exported helper
  (`isValidPath`, `isPublicHost`, `isPrivateIp`, `looksLikeSvg`,
  `buildDeterministicEtag`, `buildSourceIdentifier`, `buildFilename`,
  `isInsideRoot`, `stripApiPrefix`, `resolvePinnedAddress`, `buildPinnedAgents`).
- The Zod schemas (`optionsSchema`, `userDataSchema`) that gate user input.

Common vulnerability classes that are explicitly in scope:

- Path traversal / arbitrary file read.
- SSRF (server-side request forgery), including DNS rebinding and redirect
  chain bypasses.
- Decompression bombs or other resource-exhaustion attacks against the Sharp
  pipeline.
- Header injection via `Content-Disposition`, `Cache-Control`, or `ETag`.
- ReDoS in user-controlled regexes (`apiRegex`).
- Schema bypasses that allow unknown options or malformed input to reach the
  pipeline.

### Out of scope

- **Vulnerabilities in development dependencies** (eslint, vitest, tsup,
  supertest, prettier, etc.) that do not surface in the published `dist/`
  bundle. These are tracked via `npm audit` and fixed in the normal release
  cycle, but are not considered package security issues.
- **Vulnerabilities in the `pixel-serve-test` integration app.** That package
  is an internal demo and is not published to npm.
- **Misconfiguration without a code defect.** Examples: an operator setting
  `allowSvgInput: true` and then receiving a hostile SVG, leaving
  `allowedNetworkList` permissively wide, or failing to authenticate calls to
  the middleware. Configuration hardening guidance lives in the README's
  "Security Features" section; surprising defaults are in scope.
- **Self-DoS via legitimate configuration.** Sharp processing is CPU-bound and
  Pixel Serve does not bound concurrency on your behalf. Caps belong at the
  reverse proxy / process manager. The README's "Performance" section
  documents this.
- **Operating system, Node.js runtime, or Sharp/libvips vulnerabilities** that
  do not require a behavioral change in `pixel-serve-server` to mitigate.
  Please report those upstream.

## Hardening Reference

The README documents the security model in detail:

- Path traversal protection (`isValidPath`)
- SSRF redirect protection with DNS pinning
- Decompression-bomb protection (`maxInputPixels`, `failOn: "warning"`)
- SVG input rejection (magic-byte sniffer + Sharp `meta.format`)
- API prefix and ReDoS safety (`apiPrefix` vs `apiRegex`)
- `getUserFolderRootDir` containment for private folder access

Reading these sections before deploying is the fastest way to avoid
configuration-driven exposure.

## Thank You

Responsible disclosure makes the package safer for everyone. Reporters who
follow this policy will be credited in the published advisory.
