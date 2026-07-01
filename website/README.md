# Hawk — landing site

A single self-contained marketing/landing page for **Hawk**, the ambient AI agent
(iOS frontend + backend agent). No build step, no framework.

## Structure

```
website/
├── index.html          # the entire site (HTML + inline CSS + vanilla JS)
├── assets/             # app icon, demo posters, and demo recordings
├── deploy_modal.py     # serve the static site on Modal
└── preview/            # per-section screenshots (PR review aids)
```

## Run locally

```bash
cd website && python3 -m http.server 8011
# open http://localhost:8011
```

## Deploy (Modal)

```bash
cd website && modal deploy deploy_modal.py
# → https://hao-ai-lab--hawk-site-web.modal.run
```

## Notes

- Brand name `Hawk` is kept easy to swap (reserved name, may change).
- Public GitHub/citation links should point at `github.com/hao-ai-lab/hawky`.
- The install URL and TestFlight invite can still be swapped at deployment time.
- All six demo cells play real recordings (Cocktail, Safety, Reminder, Silent, Coding,
  Visual Memory — each has a `data-demo` hook and a tap-to-play control).
