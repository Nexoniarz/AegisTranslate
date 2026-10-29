# Security policy

## Supported versions

Only the latest release receives fixes while AegisTranslate is in alpha.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting
instead: **Security → Report a vulnerability** on
https://github.com/Nexoniarz/AegisTranslate/security/advisories/new.

Include what you found, how to reproduce it, and what an attacker could do with it. You can
expect a reply within a week.

## In scope

- Any way a web page can read, alter or detect the extension's UI or results.
- Any network request the extension makes that isn't described in [PRIVACY.md](PRIVACY.md).
- Prompt injection that makes the extension do anything other than output a (wrong) translation.
- Code loaded from anywhere other than the extension package.

## Design notes

- Page content reaches the model only as delimited data. The model has no tools or network
  access, and its output is inserted with `textContent`, never as HTML.
- All UI lives in a closed shadow root, and the extension exposes no web-accessible resources.
- The ONNX runtime and all scripts are bundled. Nothing is fetched from a CDN.
