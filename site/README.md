# Vajaha & Co. site

The multi-page site that's live at https://vajaha.vercel.app (Vercel project `vajaha`).

- `build.mjs` builds every page into `dist/`. It has no dependencies.
- Pages and content are data at the top of `build.mjs`: `SERVICES`, `INDUSTRIES`, `WORK` and `FAQS`. To change the copy, edit those, then redeploy.
- For AI search, the build also writes:
  - JSON-LD on every page (Organization, ProfessionalService, Person, Service, FAQPage, Article, BreadcrumbList)
  - `robots.txt`, which allows search and AI crawlers
  - `sitemap.xml`
  - `llms.txt`
- The build downloads the headshot from halfpan.app (`/photos/sai-head-900.jpg`).
- The site's own address comes from Vercel's production URL. Once vajaha.ai or another domain is attached, canonical URLs, the sitemap and `llms.txt` switch to it on the next deploy. To force a domain, set `SITE_HOST` in the project's environment variables.
- **Booking:** set a `BOOKING_URL` environment variable (a Calendly or Google appointment link) and redeploy. The `/book/` page then embeds it. Until then, it offers email and phone.
- **Vercel settings:**
  - framework: Other
  - build command: `npm run build`
  - output directory: `dist`
  - no install step
  - `vercel.json` adds trailing slashes
  - Deployment Protection: Standard (the production URL is public)

Build locally with the photo already on disk:

```bash
PHOTO_PATH=/path/to/sai-head-900.jpg SITE_HOST=vajaha.vercel.app node build.mjs
```

Redeploy from this folder on the Mac:

```bash
npx vercel --prod
```
