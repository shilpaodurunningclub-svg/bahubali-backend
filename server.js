require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, 'data', 'registrations.json');

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Razorpay setup ----------
// Get these from https://dashboard.razorpay.com/app/keys (Test mode to start with)
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
} else {
  console.warn('⚠️  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set in .env — payment endpoints will return an error until you add them.');
}

// ---------- Email setup ----------
// Gmail: use an App Password (not your normal Gmail password) — https://myaccount.google.com/apppasswords
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let mailTransporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
} else {
  console.warn('⚠️  EMAIL_USER / EMAIL_PASS not set in .env — confirmation emails will be skipped (logged only) until configured.');
}

function generateBibNumber() {
  const random = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
  return `BAHU-${random}`;
}

function formatAddonsList(addons) {
  if (!addons) return [];
  const labels = {
    pickup: 'Pickup from Vidhana Soudha (3rd evening) — ₹300',
    dinner: 'Dinner — ₹300',
    roomstay: 'Room Stay (Twin-Sharing) — ₹1,200',
    drop: 'Drop to Vidhana Soudha (4th evening) — ₹300'
  };
  return Object.keys(labels).filter(k => addons[k]).map(k => labels[k]);
}

function buildRunnerSummaryText(runner, bibNumber) {
  const addons = formatAddonsList(runner.addons);
  const fullName = `${(runner.firstName || '')} ${(runner.lastName || '')}`.trim();
  const lines = [
    `  Bib Number: ${bibNumber}`,
    `  Name: ${fullName}`,
    `  Race Distance: ${runner.raceDistanceKm ? runner.raceDistanceKm + ' km' : 'Not specified'}`
  ];
  if (addons.length) {
    lines.push(`  Add-ons: ${addons.join(', ')}`);
  } else {
    lines.push(`  Add-ons: None`);
  }
  return lines.join('\n');
}

async function sendConfirmationEmail(record) {
  const toEmail = record.entryType === 'single'
    ? (record.runner && record.runner.email)
    : (record.runners && record.runners[0] && record.runners[0].email);

  if (!toEmail) {
    console.warn(`No email address found on registration ${record.id}; skipping confirmation email.`);
    return;
  }

  const runners = record.entryType === 'single' ? [record.runner] : (record.runners || []);
  const bibNumbers = runners.map(() => generateBibNumber());
  record.bibNumbers = bibNumbers;

  const runnerBlocks = runners.map((r, idx) => buildRunnerSummaryText(r, bibNumbers[idx])).join('\n\n');
  const amountPaid = typeof record.amount === 'number' ? `₹${record.amount.toLocaleString('en-IN')}` : 'N/A';
  const primaryName = runners[0] ? `${runners[0].firstName || ''} ${runners[0].lastName || ''}`.trim() : 'Runner';

  const subject = `You're confirmed for Bahubali! Registration ${record.id}`;
  const text = `Dear ${primaryName || 'Runner'},

Thank you for being part of Bahubali — we're thrilled to have you join us for this event!

Your registration is confirmed. Here are your details:

${runnerBlocks}

Amount Paid: ${amountPaid}
Registration ID: ${record.id}

If you have any questions or need assistance, please reach out to:
  Devi: 9886077317
  Praveen Shetty: 9663503000

See you at the start line!

Warm regards,
Team Bahubali`;

  if (!mailTransporter) {
    console.warn(`EMAIL not configured — would have sent confirmation to ${toEmail} for ${record.id}:\n${text}`);
    return;
  }

  try {
    await mailTransporter.sendMail({
      from: `"Bahubali Registration" <${EMAIL_FROM}>`,
      to: toEmail,
      subject,
      text
    });
    console.log(`Confirmation email sent to ${toEmail} for registration ${record.id}`);
  } catch (err) {
    console.error(`Failed to send confirmation email for ${record.id}:`, err);
  }
}

// ---------- Admin protection ----------
// Set ADMIN_KEY in your environment. Without it, admin endpoints are locked (fail closed).
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY is not set on the server. Admin access is disabled until it is configured.' });
  }
  const provided = req.get('x-admin-key') || req.query.key || '';
  if (provided !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid or missing admin key.' });
  }
  next();
}

// ---------- Simple JSON-file storage ----------
function readRegistrations() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read registrations.json:', e);
    return [];
  }
}

function writeRegistrations(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---------- Public config (safe to expose) ----------
app.get('/api/config', (req, res) => {
  res.json({ razorpayKeyId: RAZORPAY_KEY_ID || null });
});

// ---------- Save a registration ----------
// Called from the form ("Next Step") before going to the payment page.
app.post('/api/register', (req, res) => {
  const payload = req.body || {};

  if (!payload.entryType || typeof payload.amount !== 'number') {
    return res.status(400).json({ error: 'Missing required fields (entryType, amount).' });
  }

  const registrations = readRegistrations();
  const id = 'REG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();

  const record = {
    id,
    createdAt: new Date().toISOString(),
    status: 'pending_payment',
    ...payload
  };

  registrations.push(record);
  writeRegistrations(registrations);

  res.json({ ok: true, registrationId: id, record });
});

// ---------- List all registrations (admin only) ----------
app.get('/api/registrations', requireAdmin, (req, res) => {
  res.json(readRegistrations());
});

// ---------- Get one registration (admin only) ----------
app.get('/api/registrations/:id', requireAdmin, (req, res) => {
  const list = readRegistrations();
  const record = list.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

// ---------- Status summary counts (admin only) ----------
app.get('/api/registrations-summary', requireAdmin, (req, res) => {
  const list = readRegistrations();
  const summary = { total: list.length, paid: 0, pending_payment: 0, payment_verification_failed: 0 };
  list.forEach(r => {
    if (summary[r.status] !== undefined) summary[r.status]++;
  });
  res.json(summary);
});

// ---------- Delete one registration (admin only) ----------
app.delete('/api/registrations/:id', requireAdmin, (req, res) => {
  const list = readRegistrations();
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [removed] = list.splice(idx, 1);
  writeRegistrations(list);
  res.json({ ok: true, deleted: removed.id });
});

// ---------- Bulk delete registrations (admin only) ----------
app.post('/api/registrations/bulk-delete', requireAdmin, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids must be a non-empty array.' });
  }

  const list = readRegistrations();
  const idSet = new Set(ids);
  const remaining = list.filter(r => !idSet.has(r.id));
  const deletedCount = list.length - remaining.length;

  writeRegistrations(remaining);
  res.json({ ok: true, deletedCount });
});

// ---------- Create a Razorpay order ----------
// amountInRupees comes from the form's already-computed Grand Total.
app.post('/api/create-order', async (req, res) => {
  if (!razorpay) {
    return res.status(500).json({ error: 'Razorpay is not configured on the server. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.' });
  }

  const { registrationId, amountInRupees } = req.body || {};
  if (!registrationId || !amountInRupees) {
    return res.status(400).json({ error: 'registrationId and amountInRupees are required.' });
  }

  const amountInPaise = Math.round(amountInRupees * 100);
  if (amountInPaise < 100) {
    return res.status(400).json({ error: 'Amount must be at least ₹1 (100 paise).' });
  }

  const registrations = readRegistrations();
  const record = registrations.find(r => r.id === registrationId);
  if (!record) return res.status(404).json({ error: 'Registration not found.' });

  try {
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { registrationId }
    });

    record.razorpayOrderId = order.id;
    writeRegistrations(registrations);

    res.json({ ok: true, order, keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    const statusCode = err && (err.statusCode === 401 || (err.error && err.error.code === 'BAD_REQUEST_ERROR' && /key/i.test(err.error.description || '')))
      ? 401
      : 500;
    const message = statusCode === 401
      ? 'Razorpay authentication failed. Check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.'
      : 'Failed to create Razorpay order.';
    res.status(statusCode).json({ error: message });
  }
});

// ---------- Verify payment signature after Razorpay Checkout success ----------
app.post('/api/verify-payment', async (req, res) => {
  const { registrationId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  if (!registrationId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required fields (registrationId, razorpay_order_id, razorpay_payment_id, razorpay_signature).' });
  }
  if (!RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Server missing RAZORPAY_KEY_SECRET.' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  const isValid = expectedSignature === razorpay_signature;

  const registrations = readRegistrations();
  const record = registrations.find(r => r.id === registrationId);

  if (record) {
    record.status = isValid ? 'paid' : 'payment_verification_failed';
    record.razorpayPaymentId = razorpay_payment_id;
    record.razorpaySignature = razorpay_signature;
    record.paidAt = isValid ? new Date().toISOString() : null;
    writeRegistrations(registrations);
  }

  if (!isValid) {
    return res.status(400).json({ ok: false, error: 'Signature verification failed.' });
  }

  if (record) {
    await sendConfirmationEmail(record);
    writeRegistrations(registrations); // persist bib numbers added inside sendConfirmationEmail
  }

  res.json({ ok: true, status: 'paid' });
});

app.listen(PORT, () => {
  console.log(`Bahubali Registration backend running on http://localhost:${PORT}`);
  console.log(`Registration data is stored in: ${DATA_FILE}`);
});
