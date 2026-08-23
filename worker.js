// Motimer — Polar Webhook Worker
//
// Polar webhooks:
//   order.paid
//   subscription.active
//
// Required Cloudflare secret:
//   POLAR_WEBHOOK_SECRET
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

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // =================================================
    // POLAR WEBHOOK
    // =================================================

    if (
      url.pathname === "/polar-webhook" &&
      request.method === "POST"
    ) {
      return handlePolarWebhook(request, env);
    }

    // =================================================
    // ACTIVATION STATUS
    // =================================================

    if (
      url.pathname === "/activation-status" &&
      request.method === "GET"
    ) {
      return handleActivationStatus(url, env);
    }

    // =================================================
    // CHECKOUT SUCCESS PAGE
    // =================================================

    if (
      url.pathname === "/success" &&
      request.method === "GET"
    ) {
      return handleSuccessPage(url, env);
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
    // IMPORTANT:
    // Must read the exact raw body before JSON.parse().
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

    // Verify Polar / Standard Webhooks signature.
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

    // =================================================
    // ORDER PAID
    // =================================================

    if (eventType === "order.paid") {
      return handleOrderPaid(event, env);
    }

    // =================================================
    // SUBSCRIPTION ACTIVE
    // =================================================

    if (
      eventType === "subscription.active"
    ) {
      return handleSubscriptionActive(
        event,
        env
      );
    }

    // Accept other events.
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

  // ---------------------------------------------------
  // IMPORTANT FOR THE EXTENSION
  //
  // Extension calls:
  //
  // /activation-status?activation_id=<customer_id or email>
  //
  // Therefore we save the activation under BOTH the
  // customer_id and the buyer's checkout email, so the
  // extension can activate automatically using whichever
  // identifier it already has (the Google account email
  // it's connected to needs no manual linking step).
  // ---------------------------------------------------

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

  // Save under customer_id AND email so the extension can find it.
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

  // Primary key used by the extension when it already
  // knows the Polar customer_id (manual/legacy linking):
  //
  // activation:<customer_id>
  //
  if (activation.customerId) {
    await env.MOTIMER_KV.put(
      `activation:${activation.customerId}`,
      value
    );
  }

  // Secondary key used by the extension's automatic path:
  // it queries by the connected Google account's email,
  // with no manual step required from the buyer as long as
  // they check out with the same email.
  //
  // activation:<email, lowercased>
  //
  if (activation.customerEmail) {
    await env.MOTIMER_KV.put(
      `activation:${activation.customerEmail.toLowerCase()}`,
      value
    );
  }

  // Also save by checkout/order/subscription ID
  // when available. This gives us useful fallback
  // records without changing the extension API.

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
    ).trim().toLowerCase();

  if (!activationId) {
    return jsonResponse(
      {
        ok: false,
        error: "Missing activation_id",
      },
      400
    );
  }

  if (!env.MOTIMER_KV) {
    return jsonResponse(
      {
        ok: false,
        error: "MOTIMER_KV is not configured",
      },
      500
    );
  }

  // The extension passes either the Polar customer_id or the
  // connected Google account email here — both are indexed
  // under the same "activation:<key>" namespace by saveActivation().
  //
  // The success page (handleSuccessPage below) passes
  // "checkout:<checkout_id>" instead, right after a purchase,
  // before it knows the real customer_id yet.
  const raw =
    await env.MOTIMER_KV.get(
      `activation:${activationId}`
    );

  if (!raw) {
    return jsonResponse({
      ok: true,
      active: false,
      status: "not_activated",
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
        error: "Invalid activation data",
      },
      500
    );
  }

  const expires =
    new Date(
      activation.expiresAt
    ).getTime();

  const now =
    Date.now();

  const remainingMs =
    expires - now;

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

    // Included so the success page (which only knows the
    // checkout_id) can learn the real customer_id and hand it
    // to the extension. Non-secret: this is the same
    // customer_id Polar already shows the buyer in their own
    // account/receipt.
    customerId:
      activation.customerId || "",

    activatedAt:
      activation.activatedAt,

    expiresAt:
      activation.expiresAt,
  });
}


// =====================================================
// CHECKOUT SUCCESS PAGE
// =====================================================
//
// Polar's Checkout Link "Success URL" should point here:
//
//   https://motimer-sucess.amohamedpsaad.workers.dev/success?checkout_id={CHECKOUT_ID}
//
// Polar substitutes {CHECKOUT_ID} automatically at redirect
// time. This page polls our own /activation-status using
// "checkout:<checkout_id>" (saved by saveActivation() as soon
// as the order.paid webhook lands) until it finds the real
// customer_id, then hands that customer_id to the extension
// via chrome.runtime.sendMessage — matching manifest.json's
// externally_connectable, which already allows this exact
// Worker origin to message the extension.
// =====================================================

function handleSuccessPage(url, env) {
  const checkoutId = String(
    url.searchParams.get("checkout_id") || ""
  ).trim();

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Motimer — تم الدفع</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#0b0f14;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:420px;text-align:center}
  h1{font-size:20px;margin-bottom:12px}
  p{color:#9aa7b2;line-height:1.6}
  .spinner{width:36px;height:36px;border:3px solid #263140;border-top-color:#4f9dff;border-radius:50%;margin:0 auto 20px;animation:spin 0.8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .ok{color:#3fd07a}
  .err{color:#ff6b6b}
</style>
</head>
<body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <h1 id="title">جاري تفعيل اشتراكك…</h1>
  <p id="msg">من فضلك متقفلش الصفحة دي.</p>
</div>
<script>
(function(){
  const EXTENSION_ID = "hkogoheijgpicaokfbdpehgppdgppijl";
  const checkoutId = ${JSON.stringify(checkoutId)};
  const titleEl = document.getElementById("title");
  const msgEl = document.getElementById("msg");
  const spinnerEl = document.getElementById("spinner");

  function done(ok, title, msg) {
    spinnerEl.style.display = "none";
    titleEl.textContent = title;
    titleEl.className = ok ? "ok" : "err";
    msgEl.textContent = msg;
  }

  function sendToExtension(customerId) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      done(false, "افتح الصفحة دي من نفس المتصفح اللي فيه Motimer", "الإكستنشن مش متاح من المتصفح ده.");
      return;
    }
    chrome.runtime.sendMessage(
      EXTENSION_ID,
      { type: "MOTIMER_ACTIVATE_LICENSE", customerId: customerId },
      function (response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
          done(false, "الدفع نجح، بس التفعيل التلقائي مايتحصلش", "افتح إعدادات Motimer ودوس Activate يدويًا.");
          return;
        }
        done(true, "تم تفعيل اشتراكك بنجاح", "تقدر تقفل الصفحة دي دلوقتي وترجع لـ Motimer.");
      }
    );
  }

  async function pollForCustomerId(attempt) {
    attempt = attempt || 0;
    if (!checkoutId) {
      done(false, "لينك مش صحيح", "الصفحة دي محتاجة تتفتح من رابط الدفع بتاع Polar.");
      return;
    }
    try {
      const res = await fetch("/activation-status?activation_id=" + encodeURIComponent("checkout:" + checkoutId), { cache: "no-store" });
      const json = await res.json().catch(function(){ return {}; });
      if (json && json.ok && json.customerId) {
        sendToExtension(json.customerId);
        return;
      }
    } catch (e) {}
    if (attempt < 8) {
      setTimeout(function () { pollForCustomerId(attempt + 1); }, 2000);
    } else {
      done(false, "لسه الدفع بيتأكد", "استنى شوية وافتح إعدادات Motimer، أو افتح الصفحة دي تاني.");
    }
  }

  pollForCustomerId(0);
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}


// =====================================================
// POLAR WEBHOOK SIGNATURE
// =====================================================
//
// Headers:
//
//   webhook-id
//   webhook-timestamp
//   webhook-signature
//
// Signed content:
//
//   webhook-id + "." +
//   webhook-timestamp + "." +
//   rawBody
//
// Secret normally looks like:
//
//   whsec_xxxxxxxxx
//
// Signature normally looks like:
//
//   v1,xxxxxxxx
//
// NOTE (Polar-specific quirk):
// Polar's own docs warn that rolling your own verification
// needs the secret "base64 encoded" before generating the
// signature — unlike the generic Standard Webhooks spec,
// where the whsec_-prefixed secret is ALREADY base64 and
// gets base64-DECODED to obtain the raw HMAC key bytes.
// For Polar, the safe approach is to use the secret's raw
// UTF-8 bytes directly as the HMAC key (see
// decodeWebhookSecret below) instead of base64-decoding it.
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

    // Protect against replayed webhooks.
    const now =
      Math.floor(
        Date.now() / 1000
      );

    const age =
      Math.abs(
        now - timestampNumber
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

    // Polar / Standard Webhooks secret.
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
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["verify"]
      );

    const payloadBytes =
      new TextEncoder().encode(
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

      if (!signatureBytes) {
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
// DEBUG SIGNATURE (temporary — remove once fixed)
// =====================================================

async function computeSignatureVariant(signedPayload, keyBytes) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedPayload)
    );
    return bytesToBase64(new Uint8Array(sigBuf));
  } catch (e) {
    return "error: " + String(e?.message || e);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function debugSignature(
  body,
  webhookId,
  timestamp,
  signatureHeader,
  secret
) {
  const signedPayload = `${webhookId}.${timestamp}.${body}`;
  const raw = String(secret).trim();
  const stripped = raw.startsWith("whsec_")
    ? raw.slice("whsec_".length)
    : raw;

  const variants = {};

  // Variant A: strip prefix, base64-decode (original spec-style)
  const bytesA = base64ToBytes(stripped);
  variants.a_stripped_base64decoded = bytesA
    ? await computeSignatureVariant(signedPayload, bytesA)
    : "invalid base64";

  // Variant B: strip prefix, raw UTF-8 bytes
  const bytesB = new TextEncoder().encode(stripped);
  variants.b_stripped_rawbytes = await computeSignatureVariant(
    signedPayload,
    bytesB
  );

  // Variant C: full secret incl. whsec_, raw UTF-8 bytes
  const bytesC = new TextEncoder().encode(raw);
  variants.c_full_rawbytes = await computeSignatureVariant(
    signedPayload,
    bytesC
  );

  // Variant D: full secret incl. whsec_, base64-decoded
  const bytesD = base64ToBytes(raw);
  variants.d_full_base64decoded = bytesD
    ? await computeSignatureVariant(signedPayload, bytesD)
    : "invalid base64";

  return {
    receivedSignatureHeader: signatureHeader,
    parsedReceivedSignatures: parseSignatures(signatureHeader),
    secretLength: raw.length,
    strippedSecretLength: stripped.length,
    bodyLength: body.length,
    signedPayloadPreview:
      signedPayload.length > 120
        ? signedPayload.slice(0, 120) + "…"
        : signedPayload,
    computed: variants,
  };
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

    if (comma === -1) {
      continue;
    }

    const version =
      part
        .slice(0, comma)
        .trim();

    const signature =
      part
        .slice(comma + 1)
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
//
// FIXED: Polar's docs explicitly warn that custom signature
// verification needs the secret "base64 encoded" before
// generating the signature — the opposite of the generic
// Standard Webhooks spec (which base64-DECODES the secret to
// get the raw HMAC key). In practice this means Polar expects
// the raw UTF-8 bytes of the secret string as the HMAC key,
// NOT a base64-decoded version of it.
//
// If this still fails, try the alternate variant below that
// keeps the "whsec_" prefix as part of the key bytes.
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

    // Polar signs webhooks using the RAW UTF-8 bytes of the
    // full secret string, "whsec_" prefix included — NOT
    // base64-decoded. Confirmed against live Polar deliveries.
    return new TextEncoder().encode(value);

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
