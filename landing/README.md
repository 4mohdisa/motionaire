# Motionaire landing page

A single static page — plain HTML/CSS/JS, no framework, no build step.
It uses the app's own design tokens (see `apps/frontend/src/index.css`)
and the real screenshots from `docs/screenshots/` (copied into `assets/`
so the deployed site is self-contained).

## Deploy to Vercel

1. Import the repo at vercel.com/new.
2. **Root Directory:** `landing`
3. **Framework Preset:** Other (no build command, no output directory).
4. Deploy.

Local preview: any static server, e.g. `python3 -m http.server` in this
directory.

## SEO notes

The page ships with structured data (schema.org SoftwareApplication),
Open Graph + Twitter cards, `robots.txt`, and descriptive meta. Two
things need the final domain once it exists, and are deliberately not
guessed here: a `<link rel="canonical">` tag in `index.html` and a
`sitemap.xml`.
