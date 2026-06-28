# Hawk — landing site

A single self-contained marketing/landing page for **Hawk**, the ambient AI agent
(iOS frontend + backend agent). No build step, no framework.

## Structure

```
website/
├── index.html          # the entire site (HTML + inline CSS + vanilla JS)
├── assets/             # owl app icon + the Coding-demo screen recording
├── deploy_modal.py     # serve the static site on Modal
└── preview/            # per-section screenshots (PR review aids)
```

## Run locally

```bash
cd website && python3 -m http.server 8011
# open http://localhost:8011
```

## Production routing

- `www.hawky.live` serves this public homepage.
- `hawky.live` redirects to `www.hawky.live`.
- `login.hawky.live` serves the authenticated Hawk app.

## Deploy (Modal)

```bash
cd website && modal deploy deploy_modal.py
# → https://hao-ai-lab--hawk-site-web.modal.run
```

## Notes

- Brand name `Hawk` is kept easy to swap (reserved name, may change).
- Placeholders pending real values: GitHub/citation URL (`github.com/hawk-agent/hawk`)
  and install URL (`hawk.sh`). The public site should point users to the
  `login.hawky.live` request-access flow until the TestFlight public link is
  accepting new testers again.
- Five of the six demo cells are styled placeholders (each has a `data-demo` hook);
  the Coding cell plays a real recording. Drop clips in to light up the rest.
