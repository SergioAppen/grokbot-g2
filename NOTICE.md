# Third-party notices and credits

This project does not vendor any third-party source code or packages. Dependencies are installed from npm
by `./run.sh setup` and keep their own licenses:

| Package | License | Notes |
|---|---|---|
| `@cursor/bdk` | Proprietary ("Cursor SDK License", © Anysphere Inc., use subject to Cursor's Terms of Service) | **Not redistributed here.** Installed from npm as a dependency of `relay/bdk`. You need your own Cursor account / API key and must accept Cursor's terms. |
| `@evenrealities/even_hub_sdk` | MIT | Glasses/phone bridge used by the app. |
| `@evenrealities/evenhub-cli` | see package | `evenhub pack` (builds the `.ehpk`). |
| `@evenrealities/evenhub-simulator` | MIT | Desktop simulator used for tests and screenshots. |
| `vite`, `typescript`, `qrcode`, `@types/node` | MIT / Apache-2.0 | Build tooling. |

## Code and patterns this project builds on

The app scaffold (WebView host page, viewport/zoom lock, mic → PCM handling, 120 ms render debounce,
double-tap exit wiring) started from Even Realities' official **asr** template, and the conversation-list HUD
follows the image-page input pattern from Even's display documentation.

- **even-realities/evenhub-templates** — https://github.com/even-realities/evenhub-templates (MIT)

The relay design (self-hosted Node relay between the glasses app and an AI backend, speech-to-text on the
relay, tunnel to the phone) was informed by these MIT-licensed projects. No code was copied from them:

- **ukaoma/cos-glasses-server** — https://github.com/ukaoma/cos-glasses-server (MIT, © 2026 COS Contributors)
- **sam-siavoshian/claude-code-g2** — https://github.com/sam-siavoshian/claude-code-g2 (MIT, © 2026 Saam Siavoshian)

### evenhub-templates license

```
MIT License

Copyright (c) 2026 David Yu / Even Realities

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
