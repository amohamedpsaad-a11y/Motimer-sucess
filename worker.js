// Motimer — Polar Webhook Worker
//
// Polar webhooks:
//   order.paid
//   subscription.active
//
// Required Cloudflare secret:
//   POLAR_WEBHOOK_SECRET
//   POLAR_ACCESS_TOKEN
//
// Required KV binding:
//   MOTIMER_KV

const SUBSCRIPTION_DAYS = 30;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, webhook-id, webhook-timestamp, webhook-signature",
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

    if (
      url.pathname === "/polar-webhook" &&
      request.method === "POST"
    ) {
      return handlePolarWebhook(request, env);
    }

    if (
      url.pathname === "/activation-status" &&
      request.method === "GET"
    ) {
      return handleActivationStatus(url, env);
    }

    if (
      url.pathname === "/success" &&
      request.method === "GET"
    ) {
      return handleSuccessPage(url, env);
    }

    if (
      url.pathname === "/customer-portal" &&
      request.method === "GET"
    ) {
      return handleCustomerPortal(url, env);
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
      },
      404
    );
  },
};


// =====================================================
// POLAR WEBHOOK
// =====================================================

async function handlePolarWebhook(request, env) {
  try {
    const body = await request.text();

    const webhookId =
      request.headers.get("webhook-id");

    const webhookTimestamp =
      request.headers.get("webhook-timestamp");

    const webhookSignature =
      request.headers.get("webhook-signature");

    if (
      !webhookId ||
      !webhookTimestamp ||
      !webhookSignature
    ) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing webhook signature headers",
        },
        401
      );
    }

    if (!env.POLAR_WEBHOOK_SECRET) {
      return jsonResponse(
        {
          ok: false,
          error: "POLAR_WEBHOOK_SECRET is not configured",
        },
        500
      );
    }

    const valid =
      await verifyWebhookSignature(
        body,
        webhookId,
        webhookTimestamp,
        webhookSignature,
        env.POLAR_WEBHOOK_SECRET
      );

    if (!valid) {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid webhook signature",
        },
        401
      );
    }

    let event;

    try {
      event = JSON.parse(body);
    } catch (_) {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid JSON",
        },
        400
      );
    }

    const eventType =
      getEventType(request, event);

    if (eventType === "order.paid") {
      return handleOrderPaid(event, env);
    }

    if (
      eventType === "subscription.active"
    ) {
      return handleSubscriptionActive(
        event,
        env
      );
    }

    return jsonResponse({
      ok: true,
      ignored: true,
      event: eventType,
    });

  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: String(
          err?.message || err
        ),
      },
      500
    );
  }
}


// =====================================================
// ORDER PAID
// =====================================================

async function handleOrderPaid(event, env) {
  const data =
    event?.data || event;

  const orderId = String(
    data?.id ||
    data?.order_id ||
    ""
  );

  const customerId =
    getCustomerId(data);

  const customerEmail =
    getCustomerEmail(data);

  const checkoutId = String(
    data?.checkout_id ||
    ""
  );

  const subscriptionId = String(
    data?.subscription_id ||
    ""
  );

  const paidAt =
    data?.paid_at ||
    data?.created_at ||
    new Date().toISOString();

  const activation = {
    ok: true,

    orderId,

    customerId,

    customerEmail,

    checkoutId,

    subscriptionId,

    activatedAt: paidAt,

    expiresAt: addDays(
      paidAt,
      SUBSCRIPTION_DAYS
    ),

    days: SUBSCRIPTION_DAYS,

    status: "active",
  };

  if (env.MOTIMER_KV) {
    await saveActivation(
      activation,
      env
    );
  }

  return jsonResponse({
    ok: true,

    event: "order.paid",

    activated: true,

    customerId,

    customerEmail,

    expiresAt:
      activation.expiresAt,
  });
}


// =====================================================
// SUBSCRIPTION ACTIVE
// =====================================================

async function handleSubscriptionActive(
  event,
  env
) {
  const data =
    event?.data || event;

  const subscriptionId =
    String(
      data?.id ||
      data?.subscription_id ||
      ""
    );

  const customerId =
    getCustomerId(data);

  const customerEmail =
    getCustomerEmail(data);

  const periodStart =
    data?.current_period_start ||
    data?.period_start ||
    data?.started_at ||
    new Date().toISOString();

  const periodEnd =
    data?.current_period_end ||
    data?.period_end ||
    addDays(
      periodStart,
      SUBSCRIPTION_DAYS
    );

  const activation = {
    ok: true,

    subscriptionId,

    customerId,

    customerEmail,

    activatedAt:
      periodStart,

    expiresAt:
      periodEnd,

    status: "active",
  };

  if (env.MOTIMER_KV) {
    await saveActivation(
      activation,
      env
    );
  }

  return jsonResponse({
    ok: true,

    event:
      "subscription.active",

    activated: true,

    customerId,

    customerEmail,

    expiresAt:
      periodEnd,
  });
}


// =====================================================
// SAVE ACTIVATION
// =====================================================

async function saveActivation(
  activation,
  env
) {
  const value =
    JSON.stringify(
      activation
    );

  if (activation.customerId) {
    await env.MOTIMER_KV.put(
      `activation:${activation.customerId}`,
      value
    );
  }

  if (activation.customerEmail) {
    await env.MOTIMER_KV.put(
      `activation:${activation.customerEmail.toLowerCase()}`,
      value
    );
  }

  if (activation.checkoutId) {
    await env.MOTIMER_KV.put(
      `activation:checkout:${activation.checkoutId}`,
      value
    );
  }

  if (activation.orderId) {
    await env.MOTIMER_KV.put(
      `activation:order:${activation.orderId}`,
      value
    );
  }

  if (activation.subscriptionId) {
    await env.MOTIMER_KV.put(
      `activation:subscription:${activation.subscriptionId}`,
      value
    );
  }
}


// =====================================================
// GET CUSTOMER ID
// =====================================================

function getCustomerId(data) {
  return String(
    data?.customer_id ||
    data?.customer?.id ||
    data?.customer?.customer_id ||
    ""
  ).trim();
}


// =====================================================
// GET CUSTOMER EMAIL
// =====================================================

function getCustomerEmail(data) {
  return String(
    data?.customer_email ||
    data?.customer?.email ||
    data?.customer?.email_address ||
    ""
  ).trim().toLowerCase();
}


// =====================================================
// LIVE POLAR CUSTOMER STATE
// =====================================================

async function getLiveCustomerState(
  customerId,
  env
) {
  try {
    const res = await fetch(
      `https://api.polar.sh/v1/customers/${encodeURIComponent(customerId)}/state`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${env.POLAR_ACCESS_TOKEN}`,
          "Content-Type":
            "application/json",
        },
      }
    );

    const data =
      await res.json().catch(
        () => ({})
      );

    if (res.status === 404) {
      return {
        ok: false,
        customerNotFound: true,
      };
    }

    if (
      !res.ok ||
      !data?.id
    ) {
      return {
        ok: false,
        reason:
          "polar_customer_state_failed",
      };
    }

    const activeSubscriptions =
      Array.isArray(
        data.active_subscriptions
      )
        ? data.active_subscriptions
        : [];

    const subscription =
      activeSubscriptions
        .filter(
          (x) =>
            x &&
            (
              x.status === "active" ||
              x.status === "trialing"
            )
        )
        .sort(
          (a, b) =>
            String(
              b?.current_period_end || ""
            ).localeCompare(
              String(
                a?.current_period_end || ""
              )
            )
        )[0];

    if (
      !subscription?.current_period_end
    ) {
      return {
        ok: true,

        payload: {
          ok: true,
          active: false,
          status: "not_subscribed",
          customerId,
          daysRemaining: 0,
          expiresAt: "",
        },
      };
    }

    const expiresAt =
      String(
        subscription.current_period_end
      );

    const remainingMs =
      new Date(
        expiresAt
      ).getTime() -
      Date.now();

    const active =
      remainingMs > 0;

    const activation = {
      ok: true,

      customerId,

      customerEmail:
        String(
          data.email || ""
        )
          .trim()
          .toLowerCase(),

      subscriptionId:
        String(
          subscription.id || ""
        ),

      activatedAt:
        subscription.current_period_start ||
        subscription.started_at ||
        new Date().toISOString(),

      expiresAt,

      status:
        active
          ? "active"
          : "expired",
    };

    if (env.MOTIMER_KV) {
      await saveActivation(
        activation,
        env
      );
    }

    return {
      ok: true,

      payload: {
        ok: true,

        active,

        status:
          active
            ? "active"
            : "expired",

        daysRemaining:
          Math.max(
            0,
            Math.ceil(
              remainingMs /
              (1000 * 60 * 60 * 24)
            )
          ),

        customerId,

        activatedAt:
          activation.activatedAt,

        expiresAt,
      },
    };

  } catch (_) {
    return {
      ok: false,
      reason: "network",
    };
  }
}


// =====================================================
// ACTIVATION STATUS
// =====================================================

async function handleActivationStatus(
  url,
  env
) {
  const activationId =
    String(
      url.searchParams.get(
        "activation_id"
      ) || ""
    )
      .trim()
      .toLowerCase();

  if (!activationId) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Missing activation_id",
      },
      400
    );
  }

  if (!env.MOTIMER_KV) {
    return jsonResponse(
      {
        ok: false,
        error:
          "MOTIMER_KV is not configured",
      },
      500
    );
  }

  // =================================================
  // REAL POLAR CUSTOMER ID
  // =================================================

  if (
    isUuid(activationId) &&
    env.POLAR_ACCESS_TOKEN
  ) {
    const live =
      await getLiveCustomerState(
        activationId,
        env
      );

    if (
      live?.customerNotFound
    ) {
      return jsonResponse({
        ok: true,

        active: false,

        status:
          "customer_not_found",

        customerId:
          activationId,

        customerNotFound:
          true,

        daysRemaining: 0,

        expiresAt: "",
      });
    }

    if (live?.ok) {
      return jsonResponse(
        live.payload
      );
    }

    // Temporary Polar/API failure:
    // use KV only as fallback.
  }


  // =================================================
  // CHECKOUT RESOLUTION
  // =================================================

  if (
    activationId.startsWith(
      "checkout:"
    ) &&
    env.POLAR_ACCESS_TOKEN
  ) {
    const checkoutId =
      activationId
        .slice(
          "checkout:".length
        )
        .trim();

    if (checkoutId) {
      try {
        const res =
          await fetch(
            `https://api.polar.sh/v1/orders?checkout_id=${encodeURIComponent(checkoutId)}&limit=1`,
            {
              method: "GET",

              headers: {
                Authorization:
                  `Bearer ${env.POLAR_ACCESS_TOKEN}`,

                "Content-Type":
                  "application/json",
              },
            }
          );

        const data =
          await res.json()
            .catch(
              () => ({})
            );

        const order =
          Array.isArray(
            data?.items
          )
            ? data.items[0]
            : null;

        const customerId =
          String(
            order?.customer_id ||
            order?.customer?.id ||
            ""
          ).trim();

        if (
          res.ok &&
          customerId &&
          isUuid(customerId)
        ) {
          const live =
            await getLiveCustomerState(
              customerId,
              env
            );

          if (live?.ok) {
            return jsonResponse(
              live.payload
            );
          }
        }

      } catch (_) {}
    }
  }


  // =================================================
  // KV FALLBACK
  // =================================================

  const raw =
    await env.MOTIMER_KV.get(
      `activation:${activationId}`
    );

  if (!raw) {
    return jsonResponse({
      ok: true,

      active: false,

      status:
        "not_activated",

      daysRemaining: 0,

      expiresAt: "",
    });
  }

  let activation;

  try {
    activation =
      JSON.parse(raw);
  } catch (_) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Invalid activation data",
      },
      500
    );
  }

  const expires =
    new Date(
      activation.expiresAt
    ).getTime();

  const remainingMs =
    expires -
    Date.now();

  const daysRemaining =
    Math.max(
      0,
      Math.ceil(
        remainingMs /
        (1000 * 60 * 60 * 24)
      )
    );

  const active =
    remainingMs > 0;

  return jsonResponse({
    ok: true,

    active,

    status:
      active
        ? "active"
        : "expired",

    daysRemaining,

    customerId:
      activation.customerId ||
      "",

    activatedAt:
      activation.activatedAt,

    expiresAt:
      activation.expiresAt,
  });
}


function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}


// =====================================================
// CUSTOMER PORTAL
// =====================================================

async function handleCustomerPortal(
  url,
  env
) {
  const customerId =
    String(
      url.searchParams.get(
        "customer_id"
      ) || ""
    ).trim();

  if (!customerId) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Missing customer_id",
      },
      400
    );
  }

  if (!env.POLAR_ACCESS_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error:
          "POLAR_ACCESS_TOKEN is not configured",
      },
      500
    );
  }

  try {
    const res =
      await fetch(
        "https://api.polar.sh/v1/customer-sessions/",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${env.POLAR_ACCESS_TOKEN}`,

            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              customer_id:
                customerId,
            }),
        }
      );

    const data =
      await res.json()
        .catch(
          () => ({})
        );

    if (
      !res.ok ||
      !data?.customer_portal_url
    ) {
      return jsonResponse(
        {
          ok: false,

          error:
            data?.detail ||
            "Polar API error",
        },

        res.status ||
          502
      );
    }

    return jsonResponse({
      ok: true,

      url:
        data.customer_portal_url,
    });

  } catch (err) {
    return jsonResponse(
      {
        ok: false,

        error:
          String(
            err?.message ||
            err
          ),
      },
      500
    );
  }
}


// =====================================================
// CHECKOUT SUCCESS PAGE
// =====================================================

function handleSuccessPage(
  url,
  env
) {
  const checkoutId =
    String(
      url.searchParams.get(
        "checkout_id"
      ) || ""
    ).trim();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<title>Motimer — Payment confirmed</title>

<style>
  :root{
    --ink:#0f1a13;
    --muted:#5b6b60;
    --paper:#fafaf7;
    --card:#ffffff;
    --line:#e7ede8;
    --green:#178a4c;
    --green-deep:#0f6b3a;
    --green-soft:#e6f6ec;
  }

  *{
    box-sizing:border-box
  }

  body{
    margin:0;
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:24px;
    background:var(--paper);
    color:var(--ink);
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Inter,
      Roboto,
      Arial,
      sans-serif;
  }

  .card{
    width:100%;
    max-width:380px;
    background:var(--card);
    border:1px solid var(--line);
    border-radius:16px;
    padding:36px 32px 28px;
    text-align:center;
    box-shadow:
      0 1px 2px
      rgba(15,26,19,0.04),
      0 12px 28px -16px
      rgba(15,26,19,0.12);
  }

  .check{
    width:52px;
    height:52px;
    margin:0 auto 20px;
    border-radius:50%;
    background:var(--green-soft);
    display:flex;
    align-items:center;
    justify-content:center;
  }

  .check svg{
    width:24px;
    height:24px;
  }

  h1{
    font-size:19px;
    font-weight:650;
    letter-spacing:-0.01em;
    margin:0 0 8px;
  }

  p{
    margin:0;
    color:var(--muted);
    font-size:14.5px;
    line-height:1.55;
  }

  .cta{
    margin-top:24px;
    width:100%;
    padding:12px 20px;
    background:var(--green);
    color:#fff;
    border:none;
    border-radius:10px;
    font-size:14.5px;
    font-weight:600;
    cursor:pointer;
    display:inline-flex;
    align-items:center;
    justify-content:center;
    gap:6px;
    transition:background .15s ease;
    text-decoration:none;
  }

  .cta:hover{
    background:var(--green-deep);
  }

  .brand{
    margin-top:24px;
    padding-top:18px;
    border-top:1px solid var(--line);
    font-size:12px;
    color:#9aa79f;
  }

  .brand b{
    color:var(--muted);
    font-weight:600;
  }
</style>

</head>

<body>

<div class="card">

  <div class="check">

    <svg
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M4 12.5L9.5 18L20 6"
        stroke="#178a4c"
        stroke-width="2.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>

  </div>

  <h1>
    Payment confirmed
  </h1>

  <p>
    Your Motimer subscription is active.
  </p>

  <button
    class="cta"
    id="ctaBtn"
    type="button"
  >
    Go to dashboard →
  </button>

  <div class="brand">
    <b>Motimer</b>
    · secure checkout via Polar
  </div>

</div>

<script>
(function(){

  const EXTENSION_ID =
    "aniinmakekcefcjkmlgkhmmfdghfngge";

  const checkoutId =
    ${JSON.stringify(checkoutId)};


  function openDashboard() {

    window.open(
      "chrome-extension://" +
      EXTENSION_ID +
      "/db.html",
      "_blank"
    );

  }


  document
    .getElementById("ctaBtn")
    .addEventListener(
      "click",
      openDashboard
    );


  function sendToExtension(
    customerId
  ) {

    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.sendMessage
    ) {
      return;
    }

    chrome.runtime.sendMessage(
      EXTENSION_ID,
      {
        type:
          "MOTIMER_ACTIVATE_LICENSE",

        customerId:
          customerId
      }
    );

  }


  async function tryActivate(
    attempt
  ) {

    if (
      !checkoutId ||
      attempt >= 30
    ) {
      return;
    }

    try {

      const res =
        await fetch(
          "/activation-status?activation_id=" +
          encodeURIComponent(
            "checkout:" +
            checkoutId
          ),
          {
            cache:
              "no-store"
          }
        );

      const json =
        await res
          .json()
          .catch(
            function(){
              return {};
            }
          );

      if (
        json &&
        json.ok &&
        json.customerId
      ) {

        sendToExtension(
          json.customerId
        );

        return;
      }

    } catch (e) {}

    setTimeout(
      function(){
        tryActivate(
          attempt + 1
        );
      },
      1000
    );

  }


  tryActivate(0);

})();
</script>

</body>
</html>`;

  return new Response(
    html,
    {
      status:200,

      headers:{
        "Content-Type":
          "text/html; charset=utf-8",

        ...CORS_HEADERS,
      },
    }
  );
}


// =====================================================
// POLAR WEBHOOK SIGNATURE
// =====================================================

const WEBHOOK_TIMESTAMP_TOLERANCE =
  5 * 60;


async function verifyWebhookSignature(
  payload,
  webhookId,
  timestamp,
  signatureHeader,
  secret
) {

  try {

    const timestampNumber =
      Number(timestamp);

    if (
      !Number.isFinite(
        timestampNumber
      )
    ) {
      return false;
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const age =
      Math.abs(
        now -
        timestampNumber
      );

    if (
      age >
      WEBHOOK_TIMESTAMP_TOLERANCE
    ) {
      return false;
    }

    const signedPayload =
      `${webhookId}.${timestamp}.${payload}`;

    const signatures =
      parseSignatures(
        signatureHeader
      );

    if (
      signatures.length === 0
    ) {
      return false;
    }

    const keyBytes =
      decodeWebhookSecret(
        secret
      );

    if (!keyBytes) {
      return false;
    }

    const key =
      await crypto.subtle.importKey(
        "raw",
        keyBytes,
        {
          name:"HMAC",
          hash:"SHA-256",
        },
        false,
        ["verify"]
      );

    const payloadBytes =
      new TextEncoder()
        .encode(
          signedPayload
        );

    for (
      const signature
      of signatures
    ) {

      const signatureBytes =
        base64ToBytes(
          signature
        );

      if (
        !signatureBytes
      ) {
        continue;
      }

      const valid =
        await crypto.subtle.verify(
          "HMAC",
          key,
          signatureBytes,
          payloadBytes
        );

      if (valid) {
        return true;
      }

    }

    return false;

  } catch (_) {

    return false;

  }
}


// =====================================================
// PARSE SIGNATURES
// =====================================================

function parseSignatures(
  header
) {

  const result = [];

  const parts =
    String(header)
      .trim()
      .split(/\s+/);

  for (
    const part
    of parts
  ) {

    const comma =
      part.indexOf(",");

    if (
      comma === -1
    ) {
      continue;
    }

    const version =
      part
        .slice(
          0,
          comma
        )
        .trim();

    const signature =
      part
        .slice(
          comma + 1
        )
        .trim();

    if (
      version === "v1" &&
      signature
    ) {
      result.push(
        signature
      );
    }

  }

  return result;
}


// =====================================================
// DECODE WEBHOOK SECRET
// =====================================================

function decodeWebhookSecret(
  secret
) {

  try {

    const value =
      String(secret)
        .trim();

    if (!value) {
      return null;
    }

    return new TextEncoder()
      .encode(value);

  } catch (_) {

    return null;

  }
}


// =====================================================
// BASE64
// =====================================================

function base64ToBytes(
  value
) {

  try {

    const binary =
      atob(
        String(value)
          .trim()
      );

    const bytes =
      new Uint8Array(
        binary.length
      );

    for (
      let i = 0;
      i < binary.length;
      i++
    ) {

      bytes[i] =
        binary.charCodeAt(i);

    }

    return bytes;

  } catch (_) {

    return null;

  }
}


// =====================================================
// EVENT TYPE
// =====================================================

function getEventType(
  request,
  event
) {

  return String(
    event?.type ||
    event?.event ||
    request.headers.get(
      "webhook-event"
    ) ||
    request.headers.get(
      "X-Polar-Event"
    ) ||
    ""
  );

}


// =====================================================
// DATE
// =====================================================

function addDays(
  isoDate,
  days
) {

  const date =
    new Date(
      isoDate
    );

  date.setTime(
    date.getTime() +
    days *
    24 *
    60 *
    60 *
    1000
  );

  return date.toISOString();
}


// =====================================================
// JSON RESPONSE
// =====================================================

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        ...CORS_HEADERS,
      },
    }
  );

}
