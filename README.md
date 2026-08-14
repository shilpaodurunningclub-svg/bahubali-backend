# Bahubali Registration — Backend

This is a small Node/Express backend for the registration form. It does two things:

1. **Saves every registration** (single or multiple entry, with all runner details and the calculated price) to `data/registrations.json`.
2. **Handles real Razorpay payments** — creates a Razorpay Order, opens the real Razorpay Checkout popup in the browser, and verifies the payment signature on success.

## 1. Install

```bash
npm install
```

## 2. Add your Razorpay keys

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Then open `.env` and fill in your **Key ID** and **Key Secret** from
https://dashboard.razorpay.com/app/keys

Start with the **Test mode** keys (they look like `rzp_test_xxxxxxxxxxxx`) so you can test the whole
flow with Razorpay's test cards/UPI before switching to live keys.

```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
PORT=4000
```

Without these two values, registrations will still save fine, but clicking **Pay Now** will show
an error instead of opening the payment popup.

## 3. Run it

```bash
npm start
```

Then open **http://localhost:4000** in your browser — the form is served directly from this backend
(`public/index.html`), so everything talks to the same server with no extra config.

## How it works

- **"Next Step"** on the form → `POST /api/register` → saves the registration (status: `pending_payment`)
  and returns a `registrationId`.
- **"Pay Now"** on the payment page → `POST /api/create-order` → creates a real Razorpay Order → opens
  the Razorpay Checkout popup with your test/live key.
- After payment, Razorpay calls back into the page, which sends the payment details to
  `POST /api/verify-payment`. The server re-computes the signature using your `RAZORPAY_KEY_SECRET`
  and only marks the registration `paid` if it matches — this is what stops someone from faking a
  successful payment from the browser console.

## Viewing registrations

- All of them: `GET /api/registrations`
- One by ID: `GET /api/registrations/:id`
- Or just open `data/registrations.json` directly — it's a plain JSON file.

This is intentionally simple (no database, no auth) so it's easy to read and adapt. For anything
beyond local testing / a small event, you'll want to:
- Put this behind HTTPS (Razorpay Checkout requires it in production).
- Swap the JSON file for a real database (Postgres, MongoDB, etc.) once you have more than a
  handful of registrations, or if two people might register at the exact same time.
- Add authentication in front of `/api/registrations` so entry lists aren't publicly readable.
- Set up a Razorpay webhook (in addition to the client-side verification here) so payments are
  captured even if someone closes the browser tab right after paying.

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Set the same two environment variables
(`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) in your host's dashboard instead of a local `.env` file,
and make sure the site is served over HTTPS.
