# opensourceS2DEMO

Browser-based screen / capture-card recorder with composited webcam PiP, live captions, and voice-driven export (meeting notes + action plan PDF). **100% client-side. No server. No accounts. Fully stateless.**

## Quick start (offline)

1. Clone or download this folder
2. Serve over HTTP (required for ES modules):

```bash
python -m http.server 8080
```

3. Open **http://localhost:8080** in **Chrome** or **Edge**
4. Record → stop → choose exports in the dialog

> Opening `index.html` directly (`file://`) will not work — use any static file server.

## Features

| Feature | Description |
|---------|-------------|
| **Screen / window / tab** | Standard `getDisplayMedia` capture |
| **Capture card / HDMI** | Live gaming feed via `getUserMedia` — commentate with mic + webcam PiP |
| **Webcam PiP** | Composited into the recording (not preview-only) |
| **Background blur** | Portrait-style blur behind your face in the PiP bubble |
| **Custom background image** | Upload a static image for this session only |
| **Auto captions** | Chrome/Edge Web Speech API — burned into video + `.vtt` sidecar |
| **Export dialog** | Video, meeting notes (`.md`), action plan (`.pdf`), captions |
| **Stateless** | All blobs, transcripts, and uploads wiped after export |

## Gaming commentary setup

1. Source → **Capture card** → select your HDMI device
2. Enable **Microphone** for commentary
3. Enable **Webcam** PiP (optional blur or custom background)
4. Record — your voice + face overlay the live feed

## Privacy

- Nothing is uploaded to any server
- No `localStorage` / cookies for recordings
- Background images exist only in RAM until export completes
- PDF generation uses [jsPDF](https://github.com/parallax/jsPDF) from CDN when online; meeting notes `.md` work fully offline

## Browser support

| Feature | Chrome | Edge | Firefox | Safari |
|---------|--------|------|---------|--------|
| Screen capture | ✅ | ✅ | ✅ | ✅ |
| System audio | ✅ | ✅ | ❌ | ❌ |
| Capture card | ✅ | ✅ | ✅ | ⚠️ |
| Captions | ✅ | ✅ | ❌ | ❌ |
| Composited PiP | ✅ | ✅ | ✅ | ✅ |

## Project structure

```
index.html          UI
css/style.css       Styles
js/app.js           Main logic
js/compositor.js    Canvas compositor (screen + PiP + captions)
js/webcam-bg.js     PiP background blur / image
js/plan-export.js   Meeting notes + PDF from transcript
js/session.js       Stateless session wipe
```

## Publish your own fork

This repo is intentionally **offline-only** — no IBM Cloud, Docker, or deployment configs included.

```bash
git init
git add index.html css js LICENSE README.md .gitignore
git commit -m "opensourceS2DEMO — offline browser recorder"
gh repo create opensourceS2DEMO --public --source=. --push
```

## License

MIT — see [LICENSE](LICENSE).
