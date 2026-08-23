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

    activatedAt:
      activation.activatedAt,

    expiresAt:
      activation.expiresAt,
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

function decodeWebhookSecret(
  secret
) {
  try {
    let value =
      String(secret)
        .trim();

    // Standard Webhooks secrets normally
    // start with whsec_.
    if (
      value.startsWith(
        "whsec_"
      )
    ) {
      value =
        value.slice(
          "whsec_".length
        );
    }

    if (!value) {
      return null;
    }

    return base64ToBytes(
      value
    );

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
