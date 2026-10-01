// GET /api/whish-success?externalId=...
// Whish's verified server-to-server success callback — also pinged once as a
// fallback by thankyou.html in case Whish's own callback is delayed or dropped.
//
// This is where a Whish order is RECORDED, but only after the payment is
// verified with Whish, and idempotently so duplicate callbacks (or the
// thankyou.html ping) can never double-record or record an unpaid order. The
// order fields were persisted to Redis by api/whish-create.js under
// order:<externalId>; here we verify, claim, write the Google Sheet row, and
// send the confirmation email over Zoho SMTP.
//
// Whish requires an HTTP 200 to acknowledge the callback, so this ALWAYS
// responds 200 — verified or not, already-recorded or errored.
//
// Live: this points at the PRODUCTION Whish host.

var WHISH_BASE = "https://api.whish.money/itel-service/api";
var USER_AGENT =
  "LArtisanAlcoolique/1.0 (https://lartisanalcoolique.com; orders@lartisanalcoolique.com)";

// Same Google Sheet endpoint + secret the COD flow uses (assets/js/checkout.js).
var SHEET_URL = "https://script.google.com/macros/s/AKfycbyJ1Ybnf2ul-Vm9Ywhioa1Gs6Uf8NfXffqi59SO1TJsEINfbCzi3EiU0PL5k2u2J86d/exec";
var SHEET_SECRET = "lartisan2026xyz";

// node-redis (v4) needs an explicit connect/quit per serverless invocation.
var createClient = require("redis").createClient;
async function withRedis(fn) {
  var client = createClient({ url: process.env.KV_REST_API_REDIS_URL });
  client.on("error", function (e) { if (console) console.warn("[redis] client error:", String(e)); });
  await client.connect();
  try { return await fn(client); }
  finally { try { await client.quit(); } catch (e) {} }
}

// Tasteful, email-safe confirmation (inline styles, table layout, light ground).
function orderEmailHtml(order) {
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var row = function (label, value) {
    return '<tr>' +
      '<td style="padding:6px 0;color:#8a7a5c;width:130px;vertical-align:top;">' + label + '</td>' +
      '<td style="padding:6px 0;color:#2b2118;">' + value + '</td></tr>';
  };
  var bundleLine = esc(order.bundle) + (order.designs ? ": " + esc(order.designs) : "");
  var deliverTo = esc(order.address) + (order.city ? ", " + esc(order.city) : "");
  return '' +
    '<div style="margin:0;padding:24px;background:#f4f1ea;font-family:Georgia,\'Times New Roman\',serif;color:#2b2118;">' +
      '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6ddca;border-radius:8px;overflow:hidden;">' +
        '<div style="background:#0E0B08;padding:22px 28px;">' +
          '<div style="font-family:Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;font-size:12px;color:#C9A868;">L\'Artisan Alcoolique</div>' +
          '<div style="font-size:21px;color:#E0C088;margin-top:6px;">Order confirmed</div>' +
        '</div>' +
        '<div style="padding:26px 28px;">' +
          '<p style="margin:0 0 14px;font-size:16px;">Hi ' + esc(order.firstName) + ',</p>' +
          '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">Your order is placed and paid — thank you. Here\'s what\'s on the way:</p>' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:15px;line-height:1.6;border-collapse:collapse;">' +
            row("Order", bundleLine) +
            (order.amount ? row("Total", "$" + esc(order.amount)) : "") +
            row("Payment", "Whish Pay") +
            row("Deliver to", deliverTo) +
            row("Phone", esc(order.phone)) +
          '</table>' +
          '<p style="margin:22px 0 0;font-size:15px;line-height:1.6;">We\'ll confirm delivery timing with you on WhatsApp shortly.</p>' +
          '<p style="margin:20px 0 0;font-size:13px;color:#9a8b6f;">L\'Artisan Alcoolique · Beirut · The Art of Smoke</p>' +
        '</div>' +
      '</div>' +
    '</div>';
}

module.exports = async function handler(req, res) {
  var externalId = (req.query && req.query.externalId) || "";

  // 1) Verify the payment with Whish (same status call the file always made).
  var collectStatus;
  try {
    var resp = await fetch(WHISH_BASE + "/payment/collect/status", {
      method: "POST",
      headers: {
        channel: process.env.WHISH_CHANNEL,
        secret: process.env.WHISH_SECRET,
        websiteUrl: process.env.WHISH_WEBSITE_URL,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({ currency: "USD", externalId: externalId })
    });
    var data = await resp.json();
    collectStatus = data && data.data && data.data.collectStatus;
  } catch (err) {
    console.error("[whish-success] status check failed", { externalId: externalId, error: String(err) });
    return res.status(200).json({ ok: true });
  }

  // 2) Record nothing unless the payment is verified successful.
  if (collectStatus !== "success") {
    console.log("[whish-success] non-success collectStatus; recording nothing", {
      externalId: externalId, collectStatus: collectStatus
    });
    return res.status(200).json({ ok: true });
  }

  // 3) Claim + read + Sheet write, all inside one Redis connection; then email.
  try {
    var order = await withRedis(async function (r) {
      // Claim atomically so duplicate callbacks (and the thankyou.html ping)
      // can't double-record. SET NX returns null if the key already exists.
      var claimed = await r.set("recorded:" + externalId, "1", { NX: true, EX: 172800 });
      if (!claimed) { return { already: true }; }

      var raw = await r.get("order:" + externalId);
      if (!raw) {
        console.warn("[whish-success] no order in redis", externalId);
        return { noOrder: true };
      }
      var ord = JSON.parse(raw);

      // Google Sheet row — same columns/format as the COD flow; PaymentMethod "Whish".
      try {
        await fetch(SHEET_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({
            secret: SHEET_SECRET,
            type: ord.type || "Kit Order",
            firstName: ord.firstName, lastName: ord.lastName, phone: ord.phone,
            city: ord.city, address: ord.address, email: ord.email,
            bundle: ord.bundle + (ord.amount ? " ($" + ord.amount + ")" : "") + (ord.designs ? ": " + ord.designs : ""),
            notes: ord.notes,
            paymentMethod: "Whish"
          })
        });
      } catch (err) {
        // Release the claim so a later retry/callback can re-record this order.
        try { await r.del("recorded:" + externalId); } catch (e) {}
        throw err;
      }

      return ord;
    });

    // Send the confirmation email only for a freshly-recorded, real order.
    if (order && !order.already && !order.noOrder) {
      var nodemailer = require("nodemailer");
      var transporter = nodemailer.createTransport({
        host: "smtp.zoho.com", port: 465, secure: true,
        auth: { user: process.env.ZOHO_USER, pass: process.env.ZOHO_PASS }
      });
      var sendEmail = transporter.sendMail({
        from: '"L\'Artisan Alcoolique" <' + process.env.ZOHO_USER + '>',
        to: order.email,
        bcc: "orders@lartisanalcoolique.com",
        subject: "Your L'Artisan Alcoolique order is confirmed",
        html: orderEmailHtml(order)
      });
      // The order is already saved to the Sheet, so never let slow/failed SMTP
      // hang or fail the callback — cap it at 8s and swallow any error.
      try {
        await Promise.race([
          sendEmail,
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error("email timeout")); }, 8000); })
        ]);
      } catch (e) {
        if (console) console.warn("[whish-success] email failed:", String(e));
      }
    }
  } catch (err) {
    // The Sheet write threw (claim was rolled back) or another unexpected error.
    console.error("[whish-success] recordError", { externalId: externalId, error: String(err) });
  }

  // 4) Always acknowledge — Whish must get a 200 regardless of the outcome.
  return res.status(200).json({ ok: true });
};
