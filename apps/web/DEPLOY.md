# Web App Deployment

The web app (`apps/web`) deploys automatically on every successful push to `main`, with the build executed in GitHub Actions and deployed to Vercel as a prebuilt artifact.

**Live URL:** [https://hivemoot-web.vercel.app/](https://hivemoot-web.vercel.app/)
Custom domain connection is pending.

## Setup

1. Add repository secrets:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
2. Configure production runtime env vars in Vercel (see `.env.example`).
3. Merge or push changes that touch `apps/web/**` into `main`.

## Flow

- `Web` workflow runs typecheck/lint/test/build.
- If `Web` passes on a `main` push, `Web Deploy` runs:
  - `vercel pull`
  - `vercel build --prod`
  - `vercel deploy --prebuilt --prod`

You can also trigger deployment manually from the Actions tab via `Web Deploy`.
