// POST /api/preorder
// Records a PRE-ORDER (reservation, no payment). Out-of-stock products let a
// customer leave their contact details so we can reach them on WhatsApp when
// stock lands. This is fully separate from the Whish/COD order flow — it never
// touches payments, Redis or the Whish API.
//
// On a valid POST it:
//   1) appends a row to the SAME Google Sheet the order flow uses, reusing the
//      exact same Apps Script endpoint + secret and the same column shape as
//      api/whish-success.js (Timestamp, First/Last name, Phone, City, Address,
//      Email, Bundle, Notes). City/Address are left blank; the Bundle column
//      carries a " — PRE-ORDER" suffix and Notes is tagged "PRE-ORDER".
//   2) emails a notification to orders@lartisanalcoolique.com over the same
//      Zoho SMTP transport (ZOHO_USER / ZOHO_PASS) used by the order flow.
//
// Resilience: the Sheet row is the lead. Email is best-effort (capped + errors
// swallowed) so slow/broken SMTP never loses a pre-order. As long as the Sheet
// write OR the email succeeds we return success; only if BOTH fail do we report
// failure so the form can ask the customer to try again or WhatsApp us.

// Same Google Sheet endpoint + secret the order flow uses (api/whish-success.js).
var SHEET_URL = "https://script.google.com/macros/s/AKfycbyJ1Ybnf2ul-Vm9Ywhioa1Gs6Uf8NfXffqi59SO1TJsEINfbCzi3EiU0PL5k2u2J86d/exec";
var SHEET_SECRET = "lartisan2026xyz";

// Where the internal pre-order alert is sent.
var NOTIFY_TO = "orders@lartisanalcoolique.com";

// Read + JSON-parse the request body across the shapes Vercel may hand us
// (already-parsed object, raw string, or an unread stream).
function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    if (typeof req.body === "string") {
      try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); }
    }
    var data = "";
    try {
      req.on("data", function (c) { data += c; });
      req.on("end", function () { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
      req.on("error", function () { resolve({}); });
    } catch (e) { resolve({}); }
  });
}

function clean(v) { return String(v == null ? "" : v).trim().slice(0, 200); }

// Internal, email-safe notification (inline styles, table layout) — same visual
// language as the order confirmation, but this one goes to the shop, not the
// customer.
function preorderEmailHtml(o) {
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var row = function (label, value) {
    return '<tr>' +
      '<td style="padding:6px 0;color:#8a7a5c;width:120px;vertical-align:top;">' + label + '</td>' +
      '<td style="padding:6px 0;color:#2b2118;">' + value + '</td></tr>';
  };
  return '' +
    '<div style="margin:0;padding:24px;background:#f4f1ea;font-family:Georgia,\'Times New Roman\',serif;color:#2b2118;">' +
      '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6ddca;border-radius:8px;overflow:hidden;">' +
        '<div style="background:#0E0B08;padding:22px 28px;">' +
          '<div style="font-family:Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:#C9A868;">L\'Artisan Alcoolique</div>' +
          '<div style="font-size:21px;color:#E0C088;margin-top:6px;">New pre-order</div>' +
        '</div>' +
        '<div style="padding:26px 28px;">' +
          '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">A customer reserved an out-of-stock product. Contact them on WhatsApp when it\'s ready:</p>' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:15px;line-height:1.6;border-collapse:collapse;">' +
            row("Product", esc(o.product)) +
            row("Name", esc(o.firstName) + " " + esc(o.lastName)) +
            row("Phone", esc(o.phone)) +
            row("Email", o.email ? esc(o.email) : "—") +
          '</table>' +
          '<p style="margin:22px 0 0;font-size:13px;color:#9a8b6f;">Pre-order · no payment taken · recorded to the orders sheet</p>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function preorderEmailText(o) {
  return "New pre-order (no payment taken)\n\n" +
    "Product: " + o.product + "\n" +
    "Name: " + o.firstName + " " + o.lastName + "\n" +
    "Phone: " + o.phone + "\n" +
    "Email: " + (o.email || "—") + "\n\n" +
    "Contact them on WhatsApp when the product is ready.";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  var body = await readBody(req);
  var firstName = clean(body.firstName);
  var lastName = clean(body.lastName);
  var phone = clean(body.phone);
  var email = clean(body.email);
  // The product + option the customer picked, e.g. "1 Signature Kit ($55)".
  var product = clean(body.product) || "Pre-Order";

  // First name, last name and phone are required; email is optional.
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ ok: false, error: "First name, last name and phone are required." });
  }

  var order = { firstName: firstName, lastName: lastName, phone: phone, email: email, product: product };

  // Bundle column mirrors the order flow's format, tagged as a pre-order.
  var bundleLabel = /—\s*PRE-ORDER\s*$/i.test(product) ? product : (product + " — PRE-ORDER");

  // 1) Google Sheet row — same endpoint/secret/column shape as whish-success.js.
  var sheetOk = false;
  try {
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        secret: SHEET_SECRET,
        type: "Pre-Order",
        firstName: firstName, lastName: lastName, phone: phone,
        city: "", address: "", email: email,
        bundle: bundleLabel,
        notes: "PRE-ORDER",
        paymentMethod: "Pre-Order"
      })
    });
    sheetOk = true;
  } catch (err) {
    console.error("[preorder] sheet write failed", { error: String(err) });
  }

  // 2) Notification email — same Zoho SMTP transport as whish-success.js.
  //    Best-effort: capped at 8s and any error swallowed so a flaky mailer can
  //    never lose a lead that's already (or about to be) in the Sheet.
  var emailOk = false;
  try {
    var nodemailer = require("nodemailer");
    var transporter = nodemailer.createTransport({
      host: "smtp.zoho.com", port: 465, secure: true,
      auth: { user: process.env.ZOHO_USER, pass: process.env.ZOHO_PASS }
    });
    var sendEmail = transporter.sendMail({
      from: '"L\'Artisan Alcoolique" <' + process.env.ZOHO_USER + '>',
      to: NOTIFY_TO,
      replyTo: email || undefined,
      subject: "New Pre-Order — " + product,
      text: preorderEmailText(order),
      html: preorderEmailHtml(order)
    });
    await Promise.race([
      sendEmail,
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error("email timeout")); }, 8000); })
    ]);
    emailOk = true;
  } catch (e) {
    console.warn("[preorder] email failed:", String(e));
  }

  // As long as the lead was captured somewhere (Sheet or email), it's a success.
  if (sheetOk || emailOk) {
    return res.status(200).json({ ok: true, sheet: sheetOk, email: emailOk });
  }
  console.error("[preorder] both sheet and email failed — lead not recorded");
  return res.status(502).json({
    ok: false,
    error: "We couldn't record your pre-order just now. Please try again, or message us on WhatsApp."
  });
};
