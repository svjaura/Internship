# Cahaba Labs site

The one-page site live at https://cahabalabs.vercel.app (Vercel project `cahabalabs`).

- `index.html` is the whole page. Edit it and redeploy.
- The build copies the headshot from halfpan.app (`/photos/sai-head-900.jpg`) into `dist/`. If that photo moves on Half Pan, update the URL in `package.json`.
- Vercel settings: framework Other, build `npm run build`, output `dist`, no install step.
- Deployment protection is Standard: the production URL is public, previews need a Vercel login.

Redeploy from this folder on the Mac:

```bash
npx vercel --prod
```
