// Motimer — Polar checkout success worker
//
// What this does:
// 1. Polar redirects the customer here after a successful payment, with
//    ?checkout_id=... in the URL (set that on your Checkout Link's Success URL
//    as: https://motimer.online/success?checkout_id={CHECKOUT_ID}).
// 2. This Worker calls the Polar API (server-side, using your secret
//    Organization Access Token) to get the customer_id from the checkout,
//    plus the customer's active subscription to know the real renewal date.
// 3. It serves a simple HTML page with one button: "Activate Motimer".
//    Clicking it sends the customer_id + renewal date straight into
//    the extension via chrome.runtime.sendMessage.
//    NO license key lookup is required.
// 4. It also exposes GET /subscription-status?customer_id=... — the
//    extension polls this periodically (every ~12h) to refresh "Valid
//    until" without needing the Polar org token itself.
//
// Setup (Cloudflare dashboard, no local tooling required):
// 1. workers.cloudflare.com -> Create a Worker -> paste this file's code.
// 2. Worker -> Settings -> Variables -> add a SECRET named POLAR_API_TOKEN
//    (value = your Polar Organization Access Token).
// 3. Worker -> Settings -> Variables -> add a plain variable
//    POLAR_ORG_ID = 0e4771fb-1ab4-41d6-a759-4362e4643bc7
//    (or, preferably, put it in wrangler.toml under [vars]).
// 4. Worker -> Triggers -> add a custom domain / route covering BOTH paths:
//    motimer.online/success* AND motimer.online/subscription-status*
//    (easiest: one route "motimer.online/*" covering everything).
// 5. In Polar, edit the "Motimer - Main Checkout" link -> Success URL:
//    https://motimer.online/success?checkout_id={CHECKOUT_ID}

// IMPORTANT: this must be the EXACT same ID as MOTIMER_EXTENSION_ID in the
// extension's motimer_config.js.
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
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (url.pathname === "/subscription-status") {
      return handleSubscriptionStatus(url, env);
    }

    // Default: checkout success page.
    const checkoutId = url.searchParams.get("checkout_id");

    if (!checkoutId) {
      return htmlResponse(
        renderError("Missing checkout information."),
        400
      );
    }

    try {
      // Get the checkout directly from Polar.
      const checkout = await polarGet(
        env,
        `/v1/checkouts/${checkoutId}`
      );

      if (!checkout?.customer_id) {
        return htmlResponse(
          renderError(
            "We couldn't find your order yet. Please refresh this page in a few seconds."
          ),
          200
        );
      }

      // IMPORTANT:
      // customer_id from the checkout is now the source of truth.
      // We do NOT search for a license key anymore.
      const customerId = checkout.customer_id;

      // Subscription lookup is only for the renewal / valid-until date.
      const validUntil = await findSubscriptionValidUntil(
        env,
        customerId
      );

      return htmlResponse(
        renderSuccess(customerId, validUntil),
        200
      );
    } catch (err) {
      return htmlResponse(
        renderError(
          "Something went wrong looking up your order: " +
          err.message
        ),
        500
      );
    }
  },
};

// ---- Subscription status endpoint ----
async function handleSubscriptionStatus(url, env) {
  const customerId = url.searchParams.get("customer_id");

  if (!customerId) {
    return jsonResponse(
      {
        ok: false,
        error: "missing customer_id",
      },
      400
    );
  }

  try {
    const validUntil = await findSubscriptionValidUntil(
      env,
      customerId
    );

    const status = validUntil
      ? "Active"
      : "Not configured";

    return jsonResponse({
      ok: true,
      status,
      validUntil,
    });
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: err.message,
      },
      500
    );
  }
}

// ---- Polar API helper ----
async function polarGet(env, path) {
  const res = await fetch(
    `https://api.polar.sh${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.POLAR_API_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(
      `Polar API ${path} -> ${res.status}`
    );
  }

  return res.json();
}

// ---- Subscription lookup only ----
// No license-key lookup exists anymore.
async function findSubscriptionValidUntil(env, customerId) {
  try {
    const data = await polarGet(
      env,
      `/v1/subscriptions/?organization_id=${env.POLAR_ORG_ID}&customer_id=${customerId}&active=true&sorting=-current_period_end&limit=1`
    );

    const sub = data?.items?.[0];

    return sub?.current_period_end || "";
  } catch (_) {
    // Non-fatal: activation should still succeed.
    return "";
  }
}

function htmlResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function jsonResponse(obj, status) {
  return new Response(
    JSON.stringify(obj),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...CORS_HEADERS,
      },
    }
  );
}

function renderError(message) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Motimer</title>
<style>
body{
  font-family:system-ui,Arial,sans-serif;
  background:#0a0a0a;
  color:#eee;
  display:flex;
  align-items:center;
  justify-content:center;
  height:100vh;
  margin:0
}
.card{
  max-width:420px;
  text-align:center;
  padding:24px
}
</style>
</head>
<body>
<div class="card">
  <h2>Motimer</h2>
  <p>${escapeHtml(message)}</p>
</div>
</body>
</html>`;
}

function renderSuccess(customerId, validUntil) {
  const safeCustomerId = escapeHtml(
    customerId || ""
  );

  const safeValidUntil = escapeHtml(
    validUntil || ""
  );

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Thank you — Motimer</title>
<style>
body{
  font-family:system-ui,Arial,sans-serif;
  background:#0a0a0a;
  color:#eee;
  display:flex;
  align-items:center;
  justify-content:center;
  height:100vh;
  margin:0
}
.card{
  max-width:440px;
  text-align:center;
  padding:32px;
  background:#151515;
  border-radius:12px
}
button{
  background:#fff;
  color:#000;
  border:0;
  border-radius:8px;
  padding:12px 22px;
  font-size:15px;
  cursor:pointer;
  margin-top:16px
}
button:disabled{
  opacity:.6;
  cursor:default
}
.status{
  margin-top:14px;
  font-size:14px;
  color:#aaa
}
code{
  display:block;
  margin-top:14px;
  font-size:12px;
  color:#777;
  word-break:break-all
}
</style>
</head>

<body>
<div class="card">
  <h2>Thank you for your purchase! 🎉</h2>

  <p>
    Click below to activate Motimer in this browser.
  </p>

  <button id="activateBtn">
    Activate Motimer
  </button>

  <div
    class="status"
    id="statusMsg"
  ></div>

  <code>
    Customer ID: ${safeCustomerId}
  </code>
</div>

<script>
const EXTENSION_ID = "${EXTENSION_ID}";
const CUSTOMER_ID = "${safeCustomerId}";
const VALID_UNTIL = "${safeValidUntil}";

const btn =
  document.getElementById("activateBtn");

const statusEl =
  document.getElementById("statusMsg");

btn.addEventListener("click", () => {
  btn.disabled = true;
  statusEl.textContent = "Activating…";

  if (
    !window.chrome ||
    !chrome.runtime ||
    !chrome.runtime.sendMessage
  ) {
    statusEl.textContent =
      "Please open this page in Chrome with Motimer installed.";

    btn.disabled = false;
    return;
  }

  // IMPORTANT:
  // Send customerId directly from the checkout.
  // No license key is sent or required.
  chrome.runtime.sendMessage(
    EXTENSION_ID,
    {
      type: "MOTIMER_ACTIVATE_LICENSE",
      customerId: CUSTOMER_ID,
      validUntil: VALID_UNTIL
    },
    (response) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent =
          "Couldn't reach the extension. Is Motimer installed?";

        btn.disabled = false;
        return;
      }

      if (response && response.ok) {
        statusEl.textContent =
          "Activated! You can close this tab.";

        btn.textContent =
          "Activated ✓";
      } else {
        statusEl.textContent =
          (response && response.error) ||
          "Activation failed.";

        btn.disabled = false;
      }
    }
  );
});
</script>

</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c])
  );
}
