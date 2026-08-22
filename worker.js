// Motimer — Polar Webhook Worker
//
// Events:
//   order.paid
//   subscription.active
//
// Subscription duration:
//   30 days
//
// This Worker:
// - Receives Polar webhooks
// - Verifies the webhook signature
// - Records successful payments
// - Creates a 30-day activation
// - Lets the extension check activation status
//
// IMPORTANT:
// Add these Cloudflare Worker secrets:
//   POLAR_WEBHOOK_SECRET
//
// Optional:
//   MOTIMER_EXTENSION_ID
//
// Do NOT put your Polar API token in the extension.

const SUBSCRIPTION_DAYS = 30;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Polar-Webhook-Signature",
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

    // -------------------------------------------------
    // Polar webhook
    // -------------------------------------------------

    if (
      url.pathname === "/polar-webhook" &&
      request.method === "POST"
    ) {
      return handlePolarWebhook(request, env);
    }

    // -------------------------------------------------
    // Extension activation check
    // -------------------------------------------------

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

async function handlePolarWebhook(
  request,
  env
) {
  try {
    const body =
      await request.text();

    const signature =
      request.headers.get(
        "Polar-Webhook-Signature"
      ) ||
      request.headers.get(
        "X-Polar-Signature"
      );

    if (!signature) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Missing webhook signature",
        },
        401
      );
    }

    if (
      !env.POLAR_WEBHOOK_SECRET
    ) {
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
        signature,
        env.POLAR_WEBHOOK_SECRET
      );

    if (!valid) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid webhook signature",
        },
        401
      );
    }

    let event;

    try {
      event =
        JSON.parse(body);
    } catch (_) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid JSON",
        },
        400
      );
    }

    const eventType =
      getEventType(
        request,
        event
      );

    // -------------------------------------------------
    // Successful order
    // -------------------------------------------------

    if (
      eventType ===
      "order.paid"
    ) {
      return await handleOrderPaid(
        event,
        env
      );
    }

    // -------------------------------------------------
    // Active subscription
    // -------------------------------------------------

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
          err?.message ||
          err
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
    event?.data ||
    event;

  const orderId =
    String(
      data?.id ||
      data?.order_id ||
      ""
    );

  const customerId =
    String(
      data?.customer_id ||
      ""
    );

  const checkoutId =
    String(
      data?.checkout_id ||
      ""
    );

  const subscriptionId =
    String(
      data?.subscription_id ||
      ""
    );

  const paidAt =
    data?.paid_at ||
    data?.created_at ||
    new Date().toISOString();

  // We deliberately do NOT use customer_id
  // as the extension identity.
  //
  // It is only stored as payment information.

  const activation = {
    ok: true,

    orderId,

    customerId,

    checkoutId,

    subscriptionId,

    activatedAt:
      paidAt,

    expiresAt:
      addDays(
        paidAt,
        SUBSCRIPTION_DAYS
      ),

    days:
      SUBSCRIPTION_DAYS,

    status:
      "active",
  };

  /*
   * If KV is configured, save the activation.
   *
   * Create a KV binding named:
   *
   * MOTIMER_KV
   */

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
      "order.paid",

    activated:
      true,

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
    event?.data ||
    event;

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

    status:
      "active",
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

    activated:
      true,

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
      ) ||
      ""
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

      active:
        false,

      status:
        "not_activated",

      daysRemaining:
        0,

      expiresAt:
        "",
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
// WEBHOOK SIGNATURE
// =====================================================

async function verifyWebhookSignature(
  payload,
  signatureHeader,
  secret
) {
  try {
    const signature =
      extractSignature(
        signatureHeader
      );

    if (!signature) {
      return false;
    }

    const key =
      await crypto.subtle.importKey(
        "raw",

        new TextEncoder().encode(
          secret
        ),

        {
          name:
            "HMAC",

          hash:
            "SHA-256",
        },

        false,

        [
          "verify",
        ]
      );

    const signatureBytes =
      hexToBytes(
        signature
      );

    if (
      !signatureBytes
    ) {
      return false;
    }

    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(
        payload
      )
    );

  } catch (_) {
    return false;
  }
}


function extractSignature(
  value
) {
  if (!value) {
    return "";
  }

  const text =
    String(value).trim();

  // Supports:
  // sha256=<hex>
  // v1=<hex>
  // <hex>

  if (
    text.startsWith(
      "sha256="
    )
  ) {
    return text.slice(7);
  }

  if (
    text.startsWith(
      "v1="
    )
  ) {
    return text.slice(3);
  }

  return text;
}


function hexToBytes(
  hex
) {
  if (
    !hex ||
    hex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(
      hex
    )
  ) {
    return null;
  }

  const bytes =
    new Uint8Array(
      hex.length / 2
    );

  for (
    let i = 0;
    i < hex.length;
    i += 2
  ) {
    bytes[i / 2] =
      parseInt(
        hex.slice(
          i,
          i + 2
        ),
        16
      );
  }

  return bytes;
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
      "X-Polar-Event"
    ) ||
    ""
  );
}


function makeActivationKey(
  activation
) {
  /*
   * TEMPORARY IDENTITY:
   *
   * This uses the Polar checkout/order/subscription
   * identifier as the server-side activation record.
   *
   * The extension should NOT use customer_id.
   */

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
    JSON.stringify(
      data
    ),
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
