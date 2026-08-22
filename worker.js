// Motimer — Polar checkout success worker
//
// Flow:
// 1. Polar redirects here after checkout with ?checkout_id={CHECKOUT_ID}.
// 2. The Worker reads the checkout server-side and takes customer_id directly.
// 3. If the checkout already has subscription_id, we read that exact
//    subscription for status/current_period_end. Otherwise we fall back to a
//    customer subscription lookup.
// 4. The success page sends ONLY customerId + validUntil to the extension.
//    No Polar license key lookup is used anywhere.
// 5. /subscription-status?customer_id=... is used by the extension for refresh.

const EXTENSION_ID = "menmcfeoaehnhnmklhgnbhglkokknnfh";
const POLAR_ORG_ID = "0e4771fb-1ab4-41d6-a759-4362e4643bc7";

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

    if (url.pathname !== "/success") {
      return htmlResponse(
        renderError("Not found."),
        404
      );
    }

    const checkoutId = String(
      url.searchParams.get("checkout_id") || ""
    ).trim();

    if (
      !checkoutId ||
      checkoutId === "{CHECKOUT_ID}"
    ) {
      return htmlResponse(
        renderError("Missing checkout information."),
        400
      );
    }

    try {
      const checkout = await polarGet(
        env,
        `/v1/checkouts/${encodeURIComponent(checkoutId)}`
      );

      if (!checkout?.customer_id) {
        return htmlResponse(
          renderError(
            "We couldn't find your customer information yet. Please refresh this page in a few seconds."
          ),
          200
        );
      }

      // SOURCE OF TRUTH FOR ACTIVATION.
      // We never search for or require a Polar license key.
      const customerId = String(
        checkout.customer_id
      );

      let subscription = null;
      let lookupError = "";

      // Best path: successful checkout can point directly to subscription.
      if (checkout.subscription_id) {
        try {
          subscription = await polarGet(
            env,
            `/v1/subscriptions/${encodeURIComponent(
              checkout.subscription_id
            )}`
          );
        } catch (err) {
          lookupError = String(
            err?.message ||
            err ||
            "subscription lookup failed"
          );
        }
      }

      // Fallback: find customer's subscription.
      if (!subscription) {
        try {
          subscription = await findSubscription(
            env,
            customerId
          );
        } catch (err) {
          lookupError = String(
            err?.message ||
            err ||
            "subscription lookup failed"
          );
        }
      }

      const validUntil = String(
        subscription?.current_period_end || ""
      );

      const polarStatus = String(
        subscription?.status || ""
      );

      const active =
        isEntitledStatus(polarStatus) &&
        !!validUntil;

      return htmlResponse(
        renderSuccess(
          customerId,
          validUntil,
          polarStatus,
          active,
          lookupError
        ),
        200
      );

    } catch (err) {
      return htmlResponse(
        renderError(
          "Something went wrong looking up your order: " +
          String(
            err?.message || err
          )
        ),
        500
      );
    }
  },
};


// =========================================================
// Subscription status endpoint
// =========================================================

async function handleSubscriptionStatus(
  url,
  env
) {
  const customerId = String(
    url.searchParams.get("customer_id") || ""
  ).trim();

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
    const subscription =
      await findSubscription(
        env,
        customerId
      );

    if (!subscription) {
      return jsonResponse({
        ok: true,
        status: "Not subscribed",
        validUntil: "",
        subscriptionId: "",
        polarStatus: "",
      });
    }

    const polarStatus = String(
      subscription.status || ""
    );

    const validUntil = String(
      subscription.current_period_end || ""
    );

    const active =
      isEntitledStatus(polarStatus) &&
      !!validUntil;

    return jsonResponse({
      ok: true,

      status: active
        ? "Active"
        : "Not subscribed",

      validUntil,

      subscriptionId:
        String(
          subscription.id || ""
        ),

      polarStatus,
    });

  } catch (err) {

    // Do NOT hide Polar errors.
    return jsonResponse(
      {
        ok: false,

        error: String(
          err?.message ||
          err ||
          "subscription lookup failed"
        ),
      },
      500
    );
  }
}


// =========================================================
// Subscription helpers
// =========================================================

function isEntitledStatus(status) {
  return (
    status === "active" ||
    status === "trialing"
  );
}


async function findSubscription(
  env,
  customerId
) {
  const data = await polarGet(
    env,

    `/v1/subscriptions/?organization_id=${encodeURIComponent(
      POLAR_ORG_ID
    )}&customer_id=${encodeURIComponent(
      customerId
    )}&active=true&sorting=-current_period_end&limit=10`
  );

  const items =
    Array.isArray(data?.items)
      ? data.items
      : [];

  return (
    items.find(
      sub =>
        isEntitledStatus(
          String(
            sub?.status || ""
          )
        )
    ) ||

    items[0] ||

    null
  );
}


// =========================================================
// Polar API
// =========================================================

async function polarGet(
  env,
  path
) {
  const token =
    String(
      env?.POLAR_API_TOKEN || ""
    ).trim();

  if (!token) {
    throw new Error(
      "POLAR_API_TOKEN is not configured in Worker secrets"
    );
  }

  const res = await fetch(
    `https://api.polar.sh${path}`,
    {
      headers: {
        Authorization:
          `Bearer ${token}`,

        Accept:
          "application/json",
      },
    }
  );

  const text =
    await res.text();

  if (!res.ok) {

    let detail = text;

    try {
      const parsed =
        JSON.parse(text);

      detail =
        parsed?.detail ||
        parsed?.message ||
        text;

    } catch (_) {}

    throw new Error(
      `Polar API ${path} -> ${res.status}: ${detail}`
    );
  }

  try {

    return JSON.parse(text);

  } catch (_) {

    throw new Error(
      `Polar API ${path} returned invalid JSON`
    );
  }
}


// =========================================================
// Responses
// =========================================================

function htmlResponse(
  body,
  status
) {
  return new Response(
    body,
    {
      status,

      headers: {
        "content-type":
          "text/html; charset=utf-8",
      },
    }
  );
}


function jsonResponse(
  obj,
  status = 200
) {
  return new Response(
    JSON.stringify(obj),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        ...CORS_HEADERS,
      },
    }
  );
}


// =========================================================
// Error page
// =========================================================

function renderError(
  message
) {
  return `<!doctype html>
<html>

<head>
<meta charset="utf-8">
<title>Motimer</title>

<style>

body{
  font-family:
    system-ui,
    Arial,
    sans-serif;

  background:#0a0a0a;
  color:#eee;

  display:flex;
  align-items:center;
  justify-content:center;

  height:100vh;
  margin:0;
}

.card{
  max-width:440px;
  text-align:center;
  padding:32px;

  background:#151515;
  border-radius:12px;
}

</style>
</head>

<body>

<div class="card">

<h2>Motimer</h2>

<p>
${escapeHtml(message)}
</p>

</div>

</body>
</html>`;
}


// =========================================================
// Success page
// =========================================================

function renderSuccess(
  customerId,
  validUntil,
  polarStatus,
  active,
  lookupError
) {

  const safeCustomerId =
    escapeHtml(
      customerId || ""
    );

  const safeValidUntil =
    escapeHtml(
      validUntil || ""
    );

  const safePolarStatus =
    escapeHtml(
      polarStatus || ""
    );

  const safeLookupError =
    escapeHtml(
      lookupError || ""
    );

  return `<!doctype html>

<html>

<head>

<meta charset="utf-8">

<title>
Thank you — Motimer
</title>

<style>

body{
  font-family:
    system-ui,
    Arial,
    sans-serif;

  background:#0a0a0a;
  color:#eee;

  display:flex;
  align-items:center;
  justify-content:center;

  height:100vh;
  margin:0;
}

.card{
  max-width:460px;
  text-align:center;

  padding:32px;

  background:#151515;

  border-radius:12px;
}

button{
  background:#fff;
  color:#000;

  border:0;

  border-radius:8px;

  padding:12px 22px;

  font-size:15px;

  cursor:pointer;

  margin-top:16px;
}

button:disabled{
  opacity:.6;
  cursor:default;
}

.status{
  margin-top:14px;
  font-size:14px;
  color:#aaa;
}

code{
  display:block;

  margin-top:14px;

  font-size:12px;

  color:#777;

  word-break:break-all;
}

.debug{
  display:none;
}

</style>

</head>

<body>

<div class="card">

<h2>
Thank you for your purchase! 🎉
</h2>

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
Customer ID:
${safeCustomerId}
</code>

<div
  class="debug"
  id="debug"
  data-status="${safePolarStatus}"
  data-active="${active ? "1" : "0"}"
  data-error="${safeLookupError}"
></div>

</div>


<script>

const EXTENSION_ID =
  "${EXTENSION_ID}";

const CUSTOMER_ID =
  ${JSON.stringify(
    customerId || ""
  )};

const VALID_UNTIL =
  ${JSON.stringify(
    validUntil || ""
  )};

const INITIAL_ACTIVE =
  ${active ? "true" : "false"};


const btn =
  document.getElementById(
    "activateBtn"
  );

const statusEl =
  document.getElementById(
    "statusMsg"
  );


btn.addEventListener(
  "click",
  () => {

    btn.disabled = true;

    statusEl.textContent =
      "Activating…";


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


    chrome.runtime.sendMessage(
      EXTENSION_ID,

      {
        type:
          "MOTIMER_ACTIVATE_LICENSE",

        customerId:
          CUSTOMER_ID,

        validUntil:
          VALID_UNTIL
      },

      (response) => {

        if (
          chrome.runtime.lastError
        ) {

          statusEl.textContent =
            "Couldn't reach the extension. Is Motimer installed?";

          btn.disabled = false;

          return;
        }


        if (
          response &&
          response.ok
        ) {

          if (
            response.status ===
            "active"
          ) {

            statusEl.textContent =
              "Activated! You can close this tab.";

            btn.textContent =
              "Activated ✓";

          } else {

            statusEl.textContent =
              "Payment received. Waiting for Polar to finish the subscription…";

            btn.textContent =
              "Waiting for subscription…";

            btn.disabled = true;
          }

        } else {

          statusEl.textContent =
            (
              response &&
              response.error
            ) ||
            "Activation failed.";

          btn.disabled = false;
        }
      }
    );
  }
);

</script>

</body>

</html>`;
}


// =========================================================
// Escape HTML
// =========================================================

function escapeHtml(s) {

  return String(s).replace(
    /[&<>"']/g,

    (c) => ({
      "&":
        "&amp;",

      "<":
        "&lt;",

      ">":
        "&gt;",

      '"':
        "&quot;",

      "'":
        "&#39;",
    }[c])
  );
}
