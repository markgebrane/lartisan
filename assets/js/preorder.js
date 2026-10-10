/* ===== L'Artisan — Pre-order (out-of-stock reservations) =====
   Powers the "Pre-order" modal on the out-of-stock store pages (kit, mountain
   glasses, wood chips). A pre-order is a reservation only — NO payment and no
   checkout redirect. On submit it POSTs the contact details + chosen option to
   /api/preorder, which records the lead to the orders sheet and emails the shop.

   This is intentionally separate from the order flow (checkout.js / store.js):
   the pre-order buttons are plain <button>s with no data-buynow and no checkout
   href, so there is no path from here into Whish/COD checkout. */
(function () {
  "use strict";

  var modal = document.getElementById("preorderModal");
  var form = document.getElementById("preorderForm");
  if (!modal || !form) return;

  var openBtns = document.querySelectorAll("[data-preorder-open]");
  var summaryEl = modal.querySelector("[data-preorder-option]");
  var okEl = modal.querySelector("[data-preorder-ok]");
  var errEl = modal.querySelector("[data-preorder-error]");
  var btn = document.getElementById("poSubmit");
  var btnLabel = btn ? btn.textContent : "Reserve";

  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }

  // The product + chosen option for the current selection. Each bundle card can
  // declare a clean label via data-preorder-label (e.g. "1 Signature Smoker Kit
  // ($55)"); otherwise we fall back to the card's sub + price text.
  function selectedLabel() {
    var grid = document.querySelector(".bundle-grid");
    if (!grid) return "";
    var card = grid.querySelector(".bundle-card.selected") || grid.querySelector(".bundle-card");
    if (!card) return "";
    if (card.dataset.preorderLabel) return card.dataset.preorderLabel.trim();
    var subEl = card.querySelector(".bundle-sub");
    var priceEl = card.querySelector(".bundle-price");
    var sub = subEl ? subEl.textContent.trim() : "";
    var price = priceEl ? priceEl.textContent.trim() : "";
    return price ? (sub + " (" + price + ")") : sub;
  }

  function setError(msg) {
    if (!errEl) return;
    errEl.textContent = msg || "";
    errEl.style.display = msg ? "block" : "none";
  }

  function resetForm() {
    if (okEl) okEl.hidden = true;
    form.hidden = false;
    setError("");
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); btn.textContent = btnLabel; }
  }

  // ---- modal open / close (mirrors the Oak Club modal) ----
  var lastFocus = null;
  function openModal() {
    lastFocus = document.activeElement;
    resetForm();
    if (summaryEl) summaryEl.textContent = selectedLabel() || "Your selection";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    var first = document.getElementById("poFirst");
    if (first) setTimeout(function () { first.focus(); }, 40);
  }
  function closeModal() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (lastFocus) { try { lastFocus.focus(); } catch (e) {} }
  }
  for (var i = 0; i < openBtns.length; i++) openBtns[i].addEventListener("click", openModal);
  modal.querySelectorAll("[data-close]").forEach(function (el) { el.addEventListener("click", closeModal); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
  });

  function showSuccess() {
    form.hidden = true;
    if (okEl) okEl.hidden = false;
  }
  function fail(msg) {
    setError(msg);
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); btn.textContent = btnLabel; }
  }

  // ---- submit -> /api/preorder (no payment, no redirect) ----
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;            // native required / email checks

    var payload = {
      firstName: val("poFirst"),
      lastName: val("poLast"),
      phone: val("poPhone"),
      email: val("poEmail"),
      product: selectedLabel() || "Pre-order"
    };

    setError("");
    if (btn) { btn.disabled = true; btn.classList.add("is-loading"); btn.textContent = "Reserving…"; }

    fetch("/api/preorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; });
      })
      .then(function (res) {
        if (res.ok && res.body && res.body.ok) { showSuccess(); }
        else { fail((res.body && res.body.error) || "Something went wrong. Please try again, or message us on WhatsApp."); }
      })
      .catch(function () {
        fail("Network error — please try again, or message us on WhatsApp.");
      });
  });
})();
