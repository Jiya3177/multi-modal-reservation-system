# Render Deployment Guide

This project can be deployed from a single GitHub repo to one Render Blueprint that creates:

- `ors-web` for the Node.js + Express app
- `ors-mysql` for the MySQL database

## Before You Start

1. Push the latest code to GitHub.
2. Keep secrets out of Git.
3. Rotate any passwords or API keys that were used during local development.

## One-Time Render Setup

1. Open [Render](https://render.com/) and sign in.
2. Click **New +** -> **Blueprint**.
3. Connect your GitHub account if Render asks.
4. Select this repository.
5. Render will detect [`render.yaml`](/Users/chaudharyjiya/Desktop/coding/New%20project/render.yaml).
6. When prompted, provide the secret values for:
   - `MYSQL_PASSWORD`
   - `MYSQL_ROOT_PASSWORD`
   - `DB_PASSWORD`
   - `SMTP_USER`
   - `SMTP_PASS`
   - `MAIL_FROM`
   - `APP_BASE_URL`
   - `FAST2SMS_API_KEY`

## Important Value Mapping

Use the same value for these:

- `MYSQL_PASSWORD` = `DB_PASSWORD`

Set `APP_BASE_URL` to your Render public app URL after Render shows it, for example:

```text
https://ors-web.onrender.com
```

## What Happens on Startup

The app now automatically:

1. connects to MySQL using `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`
2. applies the base schema from [`sql/schema.sql`](/Users/chaudharyjiya/Desktop/coding/New%20project/sql/schema.sql)
3. runs the existing demo inventory bootstrap
4. starts the web server

This keeps the existing booking, payment, admin, and UI logic unchanged while removing the need to manually import the schema during deployment.

## After the First Deploy

1. Open the Render web service URL.
2. Verify:
   - `/health`
   - register/login
   - dashboard
   - search
   - booking
   - payment
   - forgot password email

## Future Updates

After the first setup, future changes are simple:

1. update code locally
2. commit and push to GitHub
3. Render auto-deploys the latest version

## Important Note About Cost

The web service can use Render's free web plan, but the MySQL private service uses a persistent disk and starter plan. This is the simplest single-platform deployment, but it is not a fully free database setup.
