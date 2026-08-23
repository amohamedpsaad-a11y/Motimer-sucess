// Motimer — Polar Webhook Worker
//
// Events:
//   order.paid
//   subscription.active
//
// Subscription duration:
//   30 days
//
// IMPORTANT:
// Add this Cloudflare Worker secret:
//
//   POLAR_WEBHOOK_SECRET
//
// KV binding:
//
//   MOTIMER_KV

const SUBSCRIPTION_DAYS = 30;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, webhook-id, webhook-timestamp, webhook-signature, Polar-Webhook-Signature, X-Polar-Signature",
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

    // Polar webhook
    if (
      url.pathname === "/polar-webhook" &&
      request.method === "POST"
    ) {
      return handlePolarWebhook(request, env);
    }

    // Extension activation check
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
    // Read the raw body before doing JSON.parse().
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
          error:
            "Missing Polar webhook signature headers",
        },
        401
      );
    }

    if (!env.POLAR_WEBHOOK_SECRET) {
      return jsonResponse(
        {
          ok: false,
          error:
            "POLAR_WEBHOOK_SECRET is not configured",
        },
        500
      );
    }

    const valid =
      await verifyWebhookSignature(
        body,
        request.headers,
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

    // order.paid
    if (eventType === "order.paid") {
      return await handleOrderPaid(
        event,
        env
      );
    }

    // subscription.active
    if (
      eventType ===
      "subscription.active"
    ) {
      return await handleSubscriptionActive(
        event,
        env
      );
    }

    // Other events are accepted but ignored.
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

async function handleOrderPaid(
  event,
  env
) {
  const data =
    event?.data || event;

  const orderId = String(
    data?.id ||
    data?.order_id ||
    ""
  );

  const customerId = String(
    data?.customer_id ||
    ""
  );

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
    const key =
      makeActivationKey(
        activation
      );

    await env.MOTIMER_KV.put(
      key,
      JSON.stringify(
        activation
      )
    );
  }

  return jsonResponse({
    ok: true,

    event: "order.paid",

    activated: true,

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
    String(
      data?.customer_id ||
      ""
    );

  const periodStart =
    data?.current_period_start ||
    data?.period_start ||
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

    activatedAt:
      periodStart,

    expiresAt:
      periodEnd,

    status: "active",
  };

  if (env.MOTIMER_KV) {
    const key =
      makeActivationKey(
        activation
      );

    await env.MOTIMER_KV.put(
      key,
      JSON.stringify(
        activation
      )
    );
  }

  return jsonResponse({
    ok: true,

    event:
      "subscription.active",

    activated: true,

    expiresAt:
      periodEnd,
  });
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
    ).trim();

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

  const now = Date.now();

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

    status: active
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
// WEBHOOK SIGNATURE
// =====================================================
//
// Polar webhook headers:
//
//   webhook-id
//   webhook-timestamp
//   webhook-signature
//
// Signed payload:
//
//   webhook-id + "." +
//   webhook-timestamp + "." +
//   rawBody
//
// This validator supports both the literal secret
// and the Standard Webhooks derived secret format.
//

const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS =
  5 * 60;


async function verifyWebhookSignature(
  payload,
  headers,
  secret
) {
  try {
    const webhookId =
      String(
        headers.get(
          "webhook-id"
        ) || ""
      ).trim();

    const timestamp =
      String(
        headers.get(
          "webhook-timestamp"
        ) || ""
      ).trim();

    const signatureHeader =
      String(
        headers.get(
          "webhook-signature"
        ) || ""
      ).trim();

    if (
      !webhookId ||
      !timestamp ||
      !signatureHeader ||
      !secret
    ) {
      return false;
    }

    // Prevent replay attacks.
    const timestampNumber =
      Number(timestamp);

    if (
      !Number.isFinite(
        timestampNumber
      )
    ) {
      return false;
    }

    const age =
      Math.abs(
        Math.floor(
          Date.now() / 1000
        ) - timestampNumber
      );

    if (
      age >
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      return false;
    }

    const signedPayload =
      `${webhookId}.${timestamp}.${payload}`;

    const signatures =
      parseWebhookSignatures(
        signatureHeader
      );

    if (
      signatures.length === 0
    ) {
      return false;
    }

    // Try literal secret.
    const literalKey =
      await importHmacKey(
        new TextEncoder().encode(
          secret
        )
      );

    const literalValid =
      await verifyAnySignature(
        literalKey,
        signedPayload,
        signatures
      );

    if (literalValid) {
      return true;
    }

    // Try Standard Webhooks secret.
    const standardKeyBytes =
      decodeStandardWebhookSecret(
        secret
      );

    if (!standardKeyBytes) {
      return false;
    }

    const standardKey =
      await importHmacKey(
        standardKeyBytes
      );

    return await verifyAnySignature(
      standardKey,
      signedPayload,
      signatures
    );

  } catch (_) {
    return false;
  }
}


async function importHmacKey(
  keyBytes
) {
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );
}


function parseWebhookSignatures(
  header
) {
  const result = [];

  // Example:
  //
  // v1,xxxxx v1,yyyyy

  for (
    const item of
    String(header)
      .trim()
      .split(/\s+/)
  ) {
    if (!item) {
      continue;
    }

    const comma =
      item.indexOf(",");

    if (comma === -1) {
      continue;
    }

    const version =
      item
        .slice(0, comma)
        .trim();

    const value =
      item
        .slice(comma + 1)
        .trim();

    if (
      version === "v1" &&
      value
    ) {
      result.push(value);
    }
  }

  return result;
}


async function verifyAnySignature(
  key,
  signedPayload,
  signatures
) {
  const payloadBytes =
    new TextEncoder().encode(
      signedPayload
    );

  for (
    const encodedSignature
    of signatures
  ) {
    const signatureBytes =
      base64ToBytes(
        encodedSignature
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
}


function decodeStandardWebhookSecret(
  secret
) {
  try {
    let value =
      String(secret).trim();

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


function base64ToBytes(
  value
) {
  try {
    const text =
      String(value).trim();

    if (!text) {
      return null;
    }

    const binary =
      atob(text);

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
// HELPERS
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


function makeActivationKey(
  activation
) {
  const id =
    activation.checkoutId ||
    activation.orderId ||
    activation.subscriptionId;

  return `activation:${String(
    id || ""
  )}`;
}


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
