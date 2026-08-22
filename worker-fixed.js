// Motimer — Polar checkout success worker
//
// What this does:
// 1. Polar redirects the customer here after a successful payment, with
//    ?checkout_id=... in the URL (set that on your Checkout Link's Success URL
//    as: https://motimer.online/success?checkout_id={CHECKOUT_ID}).
// 2. This Worker calls the Polar API (server-side, using your secret
//    Organization Access Token) to find the license key that was just
//    generated for that checkout, plus the customer's active subscription
//    (to know the real renewal date — license keys themselves have no
//    expiry on a recurring plan).
// 3. It serves a simple HTML page with one button: "Activate Motimer".
//    Clicking it sends the key (+ customer id + renewal date) straight into
//    the extension via chrome.runtime.sendMessage (allowed because of
//    "externally_connectable" in manifest.json) — no copy/paste needed.
// 4. It also exposes GET /subscription-status?customer_id=... — the
//    extension polls this periodically (every ~12h) to refresh "Valid
//    until" without needing the Polar org token itself.
//
// Setup (Cloudflare dashboard, no local tooling required):
// 1. workers.cloudflare.com -> Create a Worker -> paste this file's code.
// 2. Worker -> Settings -> Variables -> add a SECRET named POLAR_API_TOKEN
//    (value = your Polar Organization Access Token, from Polar Dashboard ->
//    Settings -> API Keys / Developers -> Create token, scopes:
//    checkouts:read, license_keys:read, subscriptions:read).
// 3. Worker -> Settings -> Variables -> add a plain variable
//    POLAR_ORG_ID = 0e4771fb-1ab4-41d6-a759-4362e4643bc7
//    (or, preferably, put it in wrangler.toml under [vars] so it survives
//    redeploys from Git — see wrangler.toml in this repo.)
// 4. Worker -> Triggers -> add a custom domain / route covering BOTH paths:
//    motimer.online/success*  AND  motimer.online/subscription-status*
//    (easiest: one route "motimer.online/*" covering everything).
// 5. In Polar, edit the "Motimer - Main Checkout" link -> Success URL:
//    https://motimer.online/success?checkout_id={CHECKOUT_ID}

// IMPORTANT: this must be the EXACT same ID as MOTIMER_EXTENSION_ID in the
// extension's motimer_config.js (it in turn must match what's registered as
// the OAuth client's extension ID in Google Cloud Console — see the comment
// there). It was previously out of sync with the extension
// (aniinmakekcefcjkmlgkhmmfdghfngge vs iciodmffjmfgemjdeaaeppppbohfgdng),
// which silently broke the whole "Activate Motimer" button: the browser had
// no extension listening at that ID, so chrome.runtime.sendMessage always
// failed with "Couldn't reach the extension." If your real installed/published
// extension ID is ever different from the value below, update BOTH this file
// and motimer_config.js to match it — never just one side.
const EXTENSION_ID = "laabndpmcdhpkohikigfabfkekgpndgk";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/subscription-status") {
      return handleSubscriptionStatus(url, env);
    }

    // Default: checkout success page.
    const checkoutId = url.searchParams.get("checkout_id");
    if (!checkoutId) {
      return htmlResponse(renderError("Missing checkout information."), 400);
    }

    try {
      const checkout = await polarGet(env, `/v1/checkouts/${checkoutId}`);
      if (!checkout?.customer_id) {
        return htmlResponse(renderError("We couldn't find your order yet. Please refresh this page in a few seconds."), 200);
      }

      const customerId = checkout.customer_id;
      const [licenseKey, validUntil] = await Promise.all([
        findLicenseKeyForCustomer(env, customerId),
        findSubscriptionValidUntil(env, customerId),
      ]);

      if (!licenseKey) {
        return htmlResponse(renderError("Payment received, but no license key was found yet. Please refresh in a moment or contact support@motimer.online."), 200);
      }

      return htmlResponse(renderSuccess(licenseKey, customerId, validUntil), 200);
    } catch (err) {
      return htmlResponse(renderError("Something went wrong looking up your order: " + err.message), 500);
    }
  },
};

// ---- Subscription status endpoint (polled periodically by the extension) ----
async function handleSubscriptionStatus(url, env) {
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonResponse({ ok: false, error: "missing customer_id" }, 400);
  }
  try {
    const validUntil = await findSubscriptionValidUntil(env, customerId);
    const status = validUntil ? "Active" : "Not configured";
    return jsonResponse({ ok: true, status, validUntil });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

async function polarGet(env, path) {
  const res = await fetch(`https://api.polar.sh${path}`, {
    headers: { Authorization: `Bearer ${env.POLAR_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Polar API ${path} -> ${res.status}`);
  return res.json();
}

async function findLicenseKeyForCustomer(env, customerId) {
  const data = await polarGet(
    env,
    `/v1/license-keys/?organization_id=${env.POLAR_ORG_ID}&customer_id=${customerId}&sorting=-created_at&limit=1`
  );
  const item = data?.items?.[0];
  return item?.key || null;
}

// Looks up the customer's active subscription and returns its current
// period end (ISO date string) — this is the real "renews on" / "valid
// until" date for a recurring plan, unlike the license key's own
// (non-existent) expiry.
async function findSubscriptionValidUntil(env, customerId) {
  try {
    const data = await polarGet(
      env,
      `/v1/subscriptions/?organization_id=${env.POLAR_ORG_ID}&customer_id=${customerId}&active=true&sorting=-current_period_end&limit=1`
    );
    const sub = data?.items?.[0];
    return sub?.current_period_end || "";
  } catch (_) {
    // Non-fatal: activation should still succeed even if this lookup fails.
    return "";
  }
}

function htmlResponse(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function renderError(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Motimer</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:420px;text-align:center;padding:24px}</style></head>
<body><div class="card"><h2>Motimer</h2><p>${escapeHtml(message)}</p></div></body></html>`;
}

function renderSuccess(licenseKey, customerId, validUntil) {
  const safeKey = escapeHtml(licenseKey);
  const safeCustomerId = escapeHtml(customerId || "");
  const safeValidUntil = escapeHtml(validUntil || "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Thank you — Motimer</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:440px;text-align:center;padding:32px;background:#151515;border-radius:12px}
button{background:#fff;color:#000;border:0;border-radius:8px;padding:12px 22px;font-size:15px;cursor:pointer;margin-top:16px}
button:disabled{opacity:.6;cursor:default}
.status{margin-top:14px;font-size:14px;color:#aaa}
code{display:block;margin-top:14px;font-size:12px;color:#777;word-break:break-all}
</style></head>
<body>
<div class="card">
<h2>Thank you for your purchase! 🎉</h2>
<p>Click below to activate Motimer in this browser.</p>
<button id="activateBtn">Activate Motimer</button>
<div class="status" id="statusMsg"></div>
<code>${safeKey}</code>
</div>
<script>
const EXTENSION_ID = "${EXTENSION_ID}";
const LICENSE_KEY = "${safeKey}";
const CUSTOMER_ID = "${safeCustomerId}";
const VALID_UNTIL = "${safeValidUntil}";
const btn = document.getElementById("activateBtn");
const statusEl = document.getElementById("statusMsg");
btn.addEventListener("click", () => {
  btn.disabled = true;
  statusEl.textContent = "Activating…";
  if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
    statusEl.textContent = "Please open this page in Chrome with Motimer installed.";
    btn.disabled = false;
    return;
  }
  chrome.runtime.sendMessage(EXTENSION_ID, { type: "MOTIMER_ACTIVATE_LICENSE", key: LICENSE_KEY, customerId: CUSTOMER_ID, validUntil: VALID_UNTIL }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Couldn't reach the extension. Is Motimer installed?";
      btn.disabled = false;
      return;
    }
    if (response && response.ok) {
      statusEl.textContent = "Activated! You can close this tab.";
      btn.textContent = "Activated ✓";
    } else {
      statusEl.textContent = (response && response.error) || "Activation failed.";
      btn.disabled = false;
    }
  });
});
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
