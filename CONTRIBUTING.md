# Contributing to Twindem

Twindem Community Edition is the open-source core of Twindem, licensed under the
**GNU Affero General Public License v3.0 (AGPL-3.0)**. See `LICENSE`.

## Contribution Agreement

Before a pull request can be merged, contributors must accept the project's
Contributor License Agreement (CLA). By signing it you grant the Twindem
maintainers a broad, irrevocable license to your contribution — broad enough to
**relicense it and offer it under a separate commercial license** alongside the
public AGPL-3.0 release. This is what makes the open-core model work: the public
receives the code under AGPL-3.0, while the maintainers can sell a commercial
license (without copyleft obligations) to organizations that need one. Without a
CLA on every contribution, that dual-licensing right is lost.

The full agreement is in [`CLA.md`](CLA.md). The CLA check will be enforced on GitHub
(CLA bot) before public contribution intake. Do not merge external pull requests until
that check is active.

## Development

```bash
npm install
npm run build
npm run dev
./node_modules/.bin/electron .
```

Main-process changes require a full Electron restart.

## Pull Request Expectations

- Keep changes scoped to one feature or fix.
- Include a short description of the user-visible behavior.
- Run `npm run build` before opening the PR.
- Do not commit local app data, `.twindem/`, agent CLI state, API keys,
  exported release artifacts, or generated databases.

## Security

Do not include secrets in issues or pull requests. Report vulnerabilities
privately using the process in `SECURITY.md`.
