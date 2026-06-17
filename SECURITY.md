# Security Policy

## Supported Versions

Twindem is pre-1.0. Security fixes are made on the main development line.

## Reporting a Vulnerability

Please do not file public issues for vulnerabilities or leaked secrets.

For now, report security issues privately to the project maintainers. Before
the repository is made public, configure GitHub private vulnerability reporting
or publish a dedicated security contact here.

Include:

- affected version or commit,
- reproduction steps,
- expected impact,
- any relevant logs with secrets removed.

## Secret Handling

Twindem stores API keys and board tokens through Electron `safeStorage` in the
local OS keychain-backed userData directory. Config files store secret
references only, not plaintext token values.
