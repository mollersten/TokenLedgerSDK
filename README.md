# TokenLedger TypeScript SDK

The TypeScript client for TokenLedger: usage metering, credit wallets and
entitlements for your customers. Give each customer
credits, put a hold on credits before metered work, charge what the work actually
used, and charge for an item only once, even when a request is retried or a
process crashes.

- One file, no dependencies. Uses the platform's `fetch`.
- Runs on Node 20+, Deno and Bun.
- **Server-side only.** The API key is a secret: never ship it to a browser or
  a mobile app.
- Safe to retry. Every charge carries an idempotency key, so a retried request
  can never charge a customer twice.
- Not using JavaScript? Call the [HTTP API](#http-api-any-language) directly
  from Python, Go, Ruby, PHP, Java, .NET or any other backend.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The six functions](#the-six-functions)
  - [`addCredits`](#addcredits): give a customer credits
  - [`charge`](#charge): take credits
  - [`getBalance`](#getbalance): see what a customer has
  - [`meter`](#meter): charge what some work used
  - [`chargeOnce`](#chargeonce): charge for an item only the first time
  - [`importCustomers`](#importcustomers): move customers from another system
- [More control](#more-control)
- [Concepts](#concepts)
- [Give credits](#give-credits)
- [Meter work: hold, then charge](#meter-work-hold-then-charge)
- [Charge once per item](#charge-once-per-item)
- [Check a balance](#check-a-balance)
- [Move customers from another system](#move-customers-from-another-system)
- [Account settings](#account-settings)
- [Errors](#errors)
- [Retries, timeouts and idempotency](#retries-timeouts-and-idempotency)
- [Rate limits](#rate-limits)
- [Client options](#client-options)
- [Upgrading from `VaultClient`](#upgrading-from-vaultclient)
- [HTTP API (any language)](#http-api-any-language)
- [Development](#development)

## Install

```bash
npm install tokenledger-sdk
```

The package is ESM with TypeScript types included. With pnpm, Yarn or Bun, use
`pnpm add`, `yarn add` or `bun add`. In Deno, import `npm:tokenledger-sdk`.

## Quick start

```ts
import { TokenLedgerClient } from "tokenledger-sdk";

const ledger = new TokenLedgerClient({ apiKey: process.env.TOKENLEDGER_API_KEY! });

await ledger.addCredits("cus_123", 1000); // → 1000
await ledger.charge("cus_123", 5);        // → 995
await ledger.getBalance("cus_123");       // → 995
```

That's it. `"cus_123"` is your own id for the customer: any string, such as a
user id. The customer's wallet is created the first time you give them credits.

The client talks to the hosted API at `https://tokenledger-api.fly.dev` unless
you pass a `baseUrl` (see [Client options](#client-options)).

## The six functions

Most apps need only these. Call the function, pass the arguments, and get back
the value shown.

| Call | Returns |
| --- | --- |
| `addCredits(customerId, credits)` | The new balance |
| `charge(customerId, credits)` | The new balance |
| `getBalance(customerId)` | The balance |
| `meter(customerId, maxCredits, work)` | What `work` returns |
| `chargeOnce(customerId, itemKey, credits, produce)` | What `produce` returns |
| `importCustomers(customers)` | `{ imported, alreadyImported, skipped, failed }` |

Each function also takes an optional last argument with extra settings,
described under each one. When a customer doesn't have enough credits,
`charge`, `meter` and `chargeOnce` throw `InsufficientCreditsError` and charge
nothing:

```ts
import { InsufficientCreditsError } from "tokenledger-sdk";

try {
  await ledger.charge("cus_123", 5);
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    // error.availableCredits: show a "top up" prompt
  } else {
    throw error;
  }
}
```

### `addCredits`

Give a customer credits, such as after they pay or when their monthly
allowance renews.

```ts
const balance = await ledger.addCredits("cus_123", 1000); // → 1000
```

| Argument | |
| --- | --- |
| `customerId` | Your id for the customer |
| `credits` | How many to add: a whole number, at least 1 |

**Returns** the customer's new balance.

**Optional settings:**
- `expiresAt`: make the credits expire then, such as at the end of the month.
  Expiring credits are spent first.
- `idempotencyKey`: a name for this top-up, such as an invoice id. Calling
  again with the same key adds nothing, so a retry after a crash can't give
  credits twice.
- `reason`, `metadata`: stored on the ledger entry.

```ts
await ledger.addCredits("cus_123", 500, {
  expiresAt: new Date("2026-12-31T23:59:59Z"),
  idempotencyKey: `invoice:${invoiceId}`,
});
```

### `charge`

Take credits from a customer, for something with a fixed price.

```ts
const balance = await ledger.charge("cus_123", 5); // → 995
```

| Argument | |
| --- | --- |
| `customerId` | Your id for the customer |
| `credits` | How many to take: a whole number, at least 1 |

**Returns** the customer's new balance.

**Throws** `InsufficientCreditsError` when the balance is too low. Nothing is
charged.

**Optional settings:**
- `feature`: what the charge is for, such as `"report"`. It's shown in the
  customer's ledger.
- `idempotencyKey`: a name for this charge, such as an order id. Calling again
  with the same key charges nothing more.
- `metadata`: stored on the ledger entry.

### `getBalance`

```ts
const balance = await ledger.getBalance("cus_123"); // → 995
```

**Returns** the credits the customer can spend: 0 for a customer you've never
given credits. For expiring credits and the ledger history, use
[`getWallet`](#check-a-balance).

### `meter`

For work whose cost you only know afterwards, such as tokens used or pages
processed. `meter` sets aside `maxCredits` while the work runs, so the customer
can't spend them twice, then charges what the work reports.

```ts
const report = await ledger.meter("cus_123", 50, async (use) => {
  const r = await generateReport();
  use(r.creditsUsed); // report what it cost
  return r;
});
```

| Argument | |
| --- | --- |
| `customerId` | Your id for the customer |
| `maxCredits` | The most the work may cost. This much is set aside while it runs. |
| `work` | Your function. It gets `use(credits)`, which you call to report usage; several calls add up. |

**Returns** whatever `work` returns.

**What gets charged:**
- What you passed to `use`.
- The full `maxCredits` if you never call `use`.
- Nothing if `work` throws; the error is rethrown.
- Usage above `maxCredits` is taken from the balance when it can cover it.

**Throws** `InsufficientCreditsError` when the customer can't cover
`maxCredits`. In that case `work` doesn't run.

**Optional settings:**
- `ttlSeconds`: how long the work may take; the default is 60. If it takes
  longer, nothing is charged and `meter` throws, so set this above your
  slowest run.
- `feature`, `metadata`, `idempotencyKey`.

### `chargeOnce`

For something a customer should pay for once, such as looking up a person's
email address. The first time, they pay. After that it's free for them,
even if their code crashed and asks again.

```ts
const email = await ledger.chargeOnce("cus_123", `email:${personId}`, 1, () => lookUpEmail(personId));
```

| Argument | |
| --- | --- |
| `customerId` | Your id for the customer |
| `itemKey` | Names exactly one thing they buy, such as `email:${personId}` |
| `credits` | What it costs |
| `produce` | Your function that makes the item |

**Returns** whatever `produce` returns. The customer is charged only once
`produce` succeeds. If it throws, nothing is charged and the error is
rethrown.

**Nothing to deliver:** if the lookup found nothing, return `noCharge(value)`
from `produce`. The customer isn't charged, and the next request charges
again:

```ts
import { noCharge } from "tokenledger-sdk";

const email = await ledger.chargeOnce<string | null>("cus_123", `email:${personId}`, 1, async () => {
  const found = await lookUpEmail(personId);
  return found ?? noCharge(null);
});
```

**Throws** `InsufficientCreditsError` when the customer can't pay. In that
case `produce` doesn't run.

**Optional settings:**
- `feature`: put items in groups. The same `itemKey` under another feature is a
  different item.
- `ttlSeconds`: how long `produce` may take; the default is 60.
- `waitMs`, `metadata`.

See [Charge once per item](#charge-once-per-item) for how racing requests are
handled and how to choose an `itemKey`.

### `importCustomers`

Optional. If your customers already have credits or purchases in another
system, this moves them over:

```ts
const { imported, failed } = await ledger.importCustomers([
  { id: "cus_123", credits: 520, owns: ["email:p_981", "email:p_982"] },
  { id: "cus_456", credits: 100 },
]);
// imported → 2, failed → []
```

**Each customer has:**
- `id`: your id for the customer.
- `credits`: their balance in the old system.
- `owns`: item keys they already bought, so `chargeOnce` won't charge them
  again. If you pass a `feature` to `chargeOnce`, use
  `{ itemKey, feature }` here.

**Returns**:
- `imported`: customers imported now.
- `alreadyImported`: customers an earlier run imported.
- `skipped`: customers with nothing to import.
- `failed`: a list of `{ id, error, message }`.

**How it behaves:**
- **Any number of customers:** the SDK sends them in batches of 100.
- **Safe to run again:** customers already imported are never added twice,
  and new ones in the list are imported. That makes it safe to rerun after
  a crash, or as new customers move over.
- **Balances are imported once:** later runs don't change a balance. To add
  credits after that, use `addCredits`.
- **Failures:** a customer whose balance changed within 24 hours of the last
  run fails with `idempotency_key_mismatch`.

Switch a customer to TokenLedger only after they're imported, and stop
spending in the old system first.

## More control

The six functions cover most apps. The sections below show the full API
behind them:

- [expiring credits per grant](#give-credits);
- [holds you commit or release yourself](#reserve-commit-and-release);
- [detailed results from `chargeOnce`](#charge-once-per-item);
- [imports with expiring balances and purchase prices](#move-customers-from-another-system);
- [settings](#account-settings), [errors](#errors) and
  [retries](#retries-timeouts-and-idempotency).

In the full API, the customer id is called `tenantId`.

## Concepts

| Term | Meaning |
| --- | --- |
| **Tenant** | One of your customers. `tenantId` is your own id for them, such as a user or organisation id. Their wallet is created by the first grant. |
| **Credits** | Whole numbers. A wallet's `availableCredits` are spendable; `reservedCredits` are on hold. |
| **Feature** | A label for what you meter, such as `"report"` or `"email_lookup"`. It's recorded with each charge. Optional everywhere: when left out, `"default"` is used (exported as `DEFAULT_FEATURE`). |
| **Hold** (reservation) | Credits set aside before the work starts. Commit it with what was used, or release it. A hold that's never settled is returned automatically when its TTL runs out. |
| **Item** | One thing a tenant buys, named by `feature` plus `itemKey`. Used by [`chargeOnce`](#charge-once-per-item). |
| **Ledger** | Every change to a wallet is recorded as an entry, with the balance after it. |

## Give credits

```ts
// Credits that never expire, such as a purchased top-up.
await ledger.grant({ tenantId: "cus_123", amount: 5_000, reason: "top-up" });

// Credits that expire, such as a monthly allowance.
await ledger.grant({
  tenantId: "cus_123",
  amount: 500,
  reason: "monthly allowance",
  expiresAt: new Date("2026-12-31T23:59:59Z"),
});
```

Expiring credits are spent before permanent ones, soonest expiry first. What's
left at `expiresAt` is removed.

## Meter work: hold, then charge

Metered work goes through a hold, so a customer can't spend more than they have
while the work runs:

1. Reserve an estimate.
2. Do the work.
3. Commit what it actually used. Any unused part of the hold goes back to the
   customer.

### `withCreditHold` (recommended)

`withCreditHold` does all three steps around your callback:

```ts
const { result, cost, uncoveredCredits } = await ledger.withCreditHold(
  { tenantId: "cus_123", feature: "transcription", estimateCredits: 30, ttlSeconds: 120 },
  async (hold) => {
    const transcript = await transcribe(file, { signal: hold.signal });
    return { cost: transcript.minutes, result: transcript };
  },
);
```

- **Return value:** the callback returns the credits used: either a number, or
  `{ cost, result?, metadata? }`.
- **Balance too low:** if the customer can't cover `estimateCredits`, it throws
  `InsufficientCreditsError` before your callback runs.
- **Callback throws:** the hold is released, nothing is charged, and your
  error is rethrown.
- **Work costs more than the hold:** the difference is taken from the
  balance. If the balance can't cover it, the hold itself is charged and the
  shortfall is reported in `uncoveredCredits`.
- **Process crash:** the server returns the hold when `ttlSeconds` runs out
  (default 60).
- **Work outlives the hold:** `hold.signal` aborts when the TTL runs out, so
  pass it on to your upstream calls. If the work still finishes after that, the
  commit throws `reservation_not_pending`. Nothing was charged, so don't
  deliver the result.

### `reserve`, `commit` and `release`

For full control, call the three steps yourself:

```ts
const hold = await ledger.reserve({ tenantId: "cus_123", feature: "transcription", estimateCredits: 30 });
if (!hold.allowed) {
  // hold.availableCredits < hold.requestedCredits: ask the customer to top up.
  throw new Error("not enough credits");
}

try {
  const transcript = await transcribe(file);
  await ledger.commit({ tenantId: "cus_123", reservationId: hold.reservationId, actualCreditsUsed: transcript.minutes });
} catch (error) {
  await ledger.release({ tenantId: "cus_123", reservationId: hold.reservationId, reason: "transcription_failed" });
  throw error;
}
```

When the balance is too low, `reserve` resolves with `{ allowed: false }`
instead of throwing. `commit` throws `InsufficientCreditsError` if the work used
more than the hold and the balance can't cover the difference.

## Charge once per item

Some things should be paid for once. Say a customer pays to look up someone's
email address. If their code crashes after the lookup and asks again, they
shouldn't pay twice. `chargeOnce` charges a tenant for an item the first time
it's delivered. After that, the same item is free for that tenant.

The [short form](#chargeonce), `chargeOnce(customerId, itemKey, credits,
produce)`, returns just your value. The form below takes an options object
and returns the details as well (`charged`, `alreadyCharged`,
`creditsCharged`, `commit`):

```ts
import { noCharge } from "tokenledger-sdk";

const { result: email, charged } = await ledger.chargeOnce<string | null>(
  { tenantId: "cus_123", feature: "email_lookup", itemKey: `email:${personId}`, credits: 1 },
  async (item) => {
    // item.alreadyCharged: this tenant has paid for it before, so this call is free.
    const email = await lookUpEmail(personId, { signal: item.signal });
    if (email === null) return noCharge(null); // nothing found: deliver, but don't bill
    return email;
  },
);
```

**What counts as paid:**

- An item counts as paid only once the commit succeeds. If your callback
  throws, returns `noCharge(...)`, or outlives the hold's TTL, nothing is paid
  and the next request charges again.
- Requests racing for the same item can't all get it free, and they can't all
  pay. One of them charges while the others wait (up to `waitMs`, default 10
  seconds). Then the others get the item as already paid. If the charging
  attempt failed, the next one charges instead. After `waitMs`, a waiting
  request throws `TokenLedgerApiError` with code `item_charge_in_progress`.
- Items are owned per tenant. One tenant's purchase never unlocks anything for
  another.
- Deliver the result only after `chargeOnce` resolves, not from inside the
  callback. If the commit fails, `chargeOnce` throws and nothing was paid.

**Choosing an `itemKey`:**

- Make the key as narrow as what you deliver. A key per company would sell
  every person at that company for the price of one.
- The feature is part of the item: the same key under another feature is a
  different item, bought separately.
- Add a version when an item changes and should be paid for again, such as
  `report:${id}:v2`.

By default, an owned item stays owned forever. To charge again after some time,
for data that goes stale, set
[`itemRetentionDays`](#account-settings).

Items your customers bought before they moved to TokenLedger are charged again,
unless you [import those purchases](#move-customers-from-another-system).

## Check a balance

```ts
const wallet = await ledger.getWallet("cus_123");

wallet.availableCredits;  // spendable: permanent + expiring
wallet.reservedCredits;   // on hold
wallet.expiringCredits;   // the part of availableCredits that will expire
wallet.nextExpiryAt;      // when the next credits expire, or null
wallet.creditBuckets;     // expiring credits per grant, soonest first
wallet.recentLedger;      // the 20 most recent ledger entries
```

## Move customers from another system

This step is optional. For most imports, [`importCustomers`](#importcustomers)
is enough. Use `importTenants` when you need more control:

- balances made of several parts, some of them expiring;
- the price each purchase was bought for, and when;
- your own `importId` for each run;
- the full result for every customer.

Nothing else needs an import: `chargeOnce` works the same with or without
one.

```ts
const report = await ledger.importTenants(
  [
    {
      tenantId: "cus_123",
      // Their balance in the old system. A tenant's balance can be imported once.
      credits: [
        { amount: 420 },
        { amount: 100, expiresAt: "2026-12-31T23:59:59Z", reason: "december allowance" },
      ],
      // What they already bought: chargeOnce treats these items as paid.
      purchases: [{ itemKey: "email:p_981", feature: "email_lookup", credits: 1, purchasedAt: "2026-10-02" }],
    },
    // ...any number of customers
  ],
  {
    importId: "from-stripe-2026-11",
    onProgress: ({ tenantsDone, tenantsTotal }) => console.log(`${tenantsDone}/${tenantsTotal}`),
  },
);

for (const tenant of report.tenants) {
  if (tenant.status === "failed") console.warn(tenant.tenantId, tenant.error, tenant.message);
}
```

- **Any number of customers:** the SDK sends them 100 per request, and at most
  5,000 purchases per request. A customer with more purchases is spread over
  follow-up requests.
- **Safe to rerun:** run it again with the same `importId` and the same data,
  after a crash for example, and customers already imported come back as
  `replayed`. A customer whose data changed since is refused
  (`idempotency_key_mismatch`) rather than imported twice. Use a new `importId`
  for a later, different import.
- **Failures don't stop the run:** customers that fail are reported in
  `report.tenants`, not thrown. Fix them and rerun with the same `importId`.
  Common errors:
  - `credits_already_imported`;
  - `tenant_limit_reached`;
  - `invalid_import`;
  - `item_charge_in_progress`: one of the customer's items was being charged.
    Rerun once it settles.
- **Request limits:** imports don't count toward the account's request
  limits.
- **Daily cap:** each account can import up to 1,000,000 customers and
  50,000,000 purchases per UTC day. Past that, customers are reported as failed
  with `import_limit_reached`. Rerun the same import after midnight UTC to
  carry on.
- **Switching over:** switch a customer to TokenLedger only after they're
  imported, and stop spending in the old system first. Otherwise their credits
  could be spent in both places.

## Account settings

```ts
// Owned items expire 90 days after purchase; after that, chargeOnce charges again.
await ledger.updateSettings({ itemRetentionDays: 90 });

// Owned for good (the default).
await ledger.updateSettings({ itemRetentionDays: null });

const { itemRetentionDays } = await ledger.getSettings();
```

A change takes effect at once for every tenant on the account. Expired
ownership records are deleted 7 days after they expire. If you set a value by
mistake, raise it or clear it within that week, and the items are owned
again.

## Errors

| Class | Thrown when | Useful fields |
| --- | --- | --- |
| `InsufficientCreditsError` | The tenant can't cover the credits (HTTP 402). Extends `TokenLedgerApiError`. | `availableCredits` |
| `TokenLedgerApiError` | The API answered with an error status. | `status`, `code`, `body`, `retryAfterSeconds`, `rateLimit` |
| `TokenLedgerNetworkError` | No HTTP response arrived, after all retries. | `cause` |

`reserve` is the exception: it resolves with `{ allowed: false }` instead of
throwing `InsufficientCreditsError`.

```ts
import { InsufficientCreditsError, TokenLedgerApiError } from "tokenledger-sdk";

try {
  await ledger.withCreditHold({ tenantId, feature: "report", estimateCredits: 50 }, runReport);
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    // Show a top-up prompt: error.availableCredits
  } else if (error instanceof TokenLedgerApiError && error.code === "hourly_limit_exceeded") {
    // Try again after error.retryAfterSeconds
  } else {
    throw error;
  }
}
```

Common codes on `TokenLedgerApiError`:

| Status | Codes |
| --- | --- |
| 400 | A request the server refuses before acting: `invalid_request` (unknown field or wrong type), `invalid_json`, `missing_idempotency_key`, or `invalid_<field>` such as `invalid_amount` |
| 401 | `missing_api_key`, `invalid_api_key` |
| 403 | `account_suspended`, `trial_expired`, `tenant_limit_reached` |
| 404 | `wallet_not_found` (the tenant has never been granted credits), `reservation_not_found` |
| 409 | `item_charge_in_progress`, `import_in_progress`, `reservation_not_pending` |
| 422 | `idempotency_key_mismatch`, `idempotency_key_reused`, `invalid_expires_at`, `balance_overflow` |
| 429 | `rate_limited` (retried automatically), `hourly_limit_exceeded`, `monthly_quota_exceeded`, `import_limit_reached` |
| 503 | `wallet_busy`, `service_busy` (retried automatically) |

## Retries, timeouts and idempotency

- **Safe retries:** every grant, reserve, commit, release and import sends an
  `Idempotency-Key`. The client
  retries on network errors, 5xx responses and per-second rate limits
  (`rate_limited`), with the same key and exponential backoff. The server
  answers a repeated key with the original response, so a retry never charges
  twice. Hourly and monthly limits aren't retried.
- **Your own keys:** pass `{ idempotencyKey }` as the last argument to make
  a call idempotent across process restarts as well:

  ```ts
  await ledger.grant({ tenantId: "cus_123", amount: 500 }, { idempotencyKey: `invoice:${invoiceId}` });
  ```

  A key replays the first answer it got, including refusals: a `reserve` that
  was refused with that key is still refused after a top-up. Use a new key for
  a new attempt. Keys are remembered for 24 hours.
- **Timeouts:** `timeoutMs` (default 10 seconds) limits each attempt,
  including reading the response. Import requests get up to 5 minutes.
- **Cancelling:** pass `{ signal }` to cancel a call with an
  `AbortController`.

## Rate limits

Limits depend on your plan. On the free plan, an account can make 120 requests
per hour. The first time it goes over, a one-time 24-hour grace period starts
with a higher limit (600 per hour), so you have time to upgrade. After that,
requests over the limit fail with `hourly_limit_exceeded` until the next hour.

`ledger.rateLimit` shows where the account stands, as of the last response:

```ts
const limit = ledger.rateLimit; // undefined if the account has no hourly limit
if (limit?.graceEndsAt) console.warn(`grace period ends ${limit.graceEndsAt.toISOString()}: upgrade before then`);
if (limit && limit.remaining < 10) console.warn(`${limit.remaining} requests left until ${limit.resetAt.toISOString()}`);
```

## Client options

```ts
import { TokenLedgerClient } from "tokenledger-sdk";

const ledger = new TokenLedgerClient({
  apiKey: process.env.TOKENLEDGER_API_KEY!, // required
  baseUrl: "http://127.0.0.1:8080",         // default: the hosted API
  timeoutMs: 10_000,
  maxRetries: 2,
  retryDelayMs: 200,
});
```

| Option | Default | |
| --- | --- | --- |
| `apiKey` | (required) | Your secret API key (`tl_live_…`). |
| `baseUrl` | `https://tokenledger-api.fly.dev` | Another server, such as a self-hosted or local one. Exported as `DEFAULT_BASE_URL`. An empty string throws, so a blank environment variable can't silently send traffic to the hosted API. |
| `timeoutMs` | `10000` | Timeout for each attempt, in milliseconds. |
| `maxRetries` | `2` | Retries for network errors, 5xx responses and `rate_limited`. |
| `retryDelayMs` | `200` | Base delay for exponential backoff, in milliseconds. |
| `headers` | none | Extra headers sent with every request. |
| `fetch` | `globalThis.fetch` | A custom `fetch` implementation. |

## Upgrading from `VaultClient`

The classes were renamed. The old names still work but are deprecated:

| Old | New |
| --- | --- |
| `VaultClient` | `TokenLedgerClient` |
| `VaultClientOptions` | `TokenLedgerClientOptions` |
| `VaultApiError` | `TokenLedgerApiError` |
| `VaultNetworkError` | `TokenLedgerNetworkError` |

## HTTP API (any language)

The SDK is a thin layer over a JSON HTTP API. You can call the API directly
from any language that can send HTTPS requests.

> **Call it from your backend, never from a frontend.** Your API key can spend
> and grant credits for every one of your customers. Keep it on your server.
> Your web or mobile frontend talks to your own backend, and your backend talks
> to TokenLedger.

### Basics

| | |
| --- | --- |
| Base URL | `https://tokenledger-api.fly.dev` |
| Authentication | `Authorization: Bearer tl_live_…` on every `/v1` request |
| Body | JSON with `Content-Type: application/json`. Field names are `snake_case`. |
| Unknown fields | Refused with 400 `invalid_request`, so a typo like `expiresAt` can't be silently ignored |
| Credits | Whole numbers, up to 9,007,199,254,740,991 (2^53 − 1) |
| Times | RFC 3339 in UTC, such as `2026-12-31T23:59:59Z` |
| `tenant_id`, `feature`, `item_key` | 1–255 characters, no control characters |
| `metadata` | Any JSON object, up to 16 KB. Stored with the grant, hold or commit. |
| `reason` | Free text, up to 1,024 characters |

| Method | Path | Does |
| --- | --- | --- |
| `POST` | [`/v1/credits/grant`](#post-v1creditsgrant) | Add credits to a tenant's wallet |
| `POST` | [`/v1/credits/reserve`](#post-v1creditsreserve) | Put a hold on credits |
| `POST` | [`/v1/credits/commit`](#post-v1creditscommit) | Charge a hold with what was used |
| `POST` | [`/v1/credits/release`](#post-v1creditsrelease) | Cancel a hold |
| `GET` | [`/v1/tenants/{tenant_id}/wallet`](#get-v1tenantstenant_idwallet) | Balances and recent ledger entries |
| `POST` | [`/v1/import`](#post-v1import) | Move customers from another system |
| `GET`, `PATCH` | [`/v1/settings`](#get-and-patch-v1settings) | Account settings |
| `GET` | [`/livez`, `/healthz`](#get-livez-and-healthz) | Health checks, no key needed |

### Idempotency keys

Every `POST` needs an `Idempotency-Key` header, so that retrying can never
charge twice:

- **Format:** 1–255 visible ASCII characters. A UUID works, but a key that
  names the action is better, such as `invoice:in_8812` for a top-up or
  `<reservation_id>:commit` for a commit.
- **Same request again:** send the same key, endpoint and body within 24 hours,
  and the server doesn't act again. It answers with the first response (same
  status, same body) and adds the header `Idempotent-Replayed: true`. That's
  how you retry safely after a timeout.
- **New action:** use a new key. A key answers with its first response, even
  a refusal. A reserve refused with 402 stays refused under that key after a
  top-up.
- **Conflicts:**
  - the same key with a different body gives 422 `idempotency_key_mismatch`;
  - the same key on another endpoint gives 422 `idempotency_key_reused`;
  - a missing key gives 400 `missing_idempotency_key`.
- **Validation errors (400) aren't stored:** fix the request and send it again.
- **Scope:** keys are kept per tenant, so two tenants can't collide.

### Errors and retries

Errors come back as JSON with a code and a message. Some include more
fields, such as `available_credits` on a 402:

```json
{ "error": "insufficient_credits", "allowed": false, "available_credits": 1458, "requested_credits": 1000000 }
```

The codes are listed under [Errors](#errors). Validation errors (400) name the
field, such as `invalid_amount`, `invalid_ttl_seconds` or `invalid_item_key`.

**When to retry:**

- **Network error or timeout:** retry with the same `Idempotency-Key`.
- **`5xx`, including 503 `wallet_busy` and `service_busy`:** retry with the
  same key, after `Retry-After` seconds or an exponential backoff.
- **429 `rate_limited`:** this is the per-second limit, and it clears quickly.
  Wait `Retry-After` seconds (usually 1), then retry with the same key.
- **429 `hourly_limit_exceeded` and `monthly_quota_exceeded`:** don't retry
  in a loop. `Retry-After` says how many seconds until the limit resets.
- **409 `item_charge_in_progress`:** see
  [Charge once per item over HTTP](#charge-once-per-item-over-http).

### Rate-limit headers

Accounts with an hourly limit get these headers on every counted response:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Requests allowed this hour |
| `X-RateLimit-Remaining` | Requests left this hour |
| `X-RateLimit-Reset` | When the count resets, as Unix time in seconds |
| `X-RateLimit-Grace-Ends` | Only while the one-time grace period runs: when it ends, as Unix time in seconds |

### `POST /v1/credits/grant`

Adds credits to a tenant's wallet. The first grant creates the wallet.

```bash
curl https://tokenledger-api.fly.dev/v1/credits/grant \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY" \
  -H "Idempotency-Key: signup:cus_123" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id": "cus_123", "amount": 500, "reason": "monthly allowance", "expires_at": "2026-12-31T23:59:59Z"}'
```

| Field | | |
| --- | --- | --- |
| `tenant_id` | required | Your id for the customer |
| `amount` | required | Credits to add, at least 1 |
| `expires_at` | optional | Must be in the future. Without it, the credits never expire. |
| `reason` | optional | Shown on the ledger entry and the credit bucket |
| `metadata` | optional | Stored on the ledger entry |

```json
{
  "tenant_id": "cus_123",
  "available_credits": 1500,
  "reserved_credits": 0,
  "expiring_credits": 500,
  "granted_credits": 500,
  "ledger_entry_id": "b5a889c7-1329-427e-b846-7db0e967a39b",
  "updated_at": "2026-11-27T14:11:41.876258Z",
  "bucket_id": "170d2cc5-573b-4e96-87b9-8ef3b7658ec5",
  "expires_at": "2026-12-31T23:59:59Z"
}
```

`bucket_id` and `expires_at` only appear for expiring credits.

**Errors:**
- 403 `tenant_limit_reached`: a new tenant would go over your plan's tenant
  limit.
- 422 `invalid_expires_at`: the expiry isn't in the future.
- 422 `balance_overflow`: the balance would exceed the maximum.

### `POST /v1/credits/reserve`

Puts a hold on credits before metered work starts. The hold is returned
automatically if it's neither committed nor released within `ttl_seconds`.

```bash
curl https://tokenledger-api.fly.dev/v1/credits/reserve \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY" \
  -H "Idempotency-Key: 5f0c9c1e-3a8b-4a4f-9a51-2f9e2c1d7b10" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id": "cus_123", "feature": "report", "estimate_credits": 50, "ttl_seconds": 120}'
```

| Field | | |
| --- | --- | --- |
| `tenant_id` | required | |
| `feature` | required | What you meter, such as `"report"` |
| `estimate_credits` | required | Credits to hold, at least 1 |
| `ttl_seconds` | optional | How long the hold lives: 1–86,400, default 60 |
| `item_key` | optional | Charge this item only once. See [below](#charge-once-per-item-over-http). |
| `metadata` | optional | Stored with the hold |

Allowed (200):

```json
{
  "allowed": true,
  "reservation_id": "4d8a9515-00cc-4421-8753-c3996a5d3cda",
  "remaining_available": 1450,
  "reserved_balance": 50,
  "expires_at": "2026-11-27T14:13:41.987822Z"
}
```

Not enough credits (402). A tenant that has never been granted credits gets the
same answer, with `available_credits` 0:

```json
{ "allowed": false, "error": "insufficient_credits", "available_credits": 1458, "requested_credits": 1000000 }
```

### `POST /v1/credits/commit`

Charges a hold with what the work actually used. If it used less than the
hold, the rest goes back to the tenant. If it used more, the difference is
taken from the balance.

```bash
curl https://tokenledger-api.fly.dev/v1/credits/commit \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY" \
  -H "Idempotency-Key: 4d8a9515-00cc-4421-8753-c3996a5d3cda:commit" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id": "cus_123", "reservation_id": "4d8a9515-00cc-4421-8753-c3996a5d3cda", "actual_credits_used": 42}'
```

| Field | | |
| --- | --- | --- |
| `tenant_id` | required | |
| `reservation_id` | required | From the reserve |
| `actual_credits_used` | required | 0 or more. At least 1 for an item hold (release it to charge nothing). |
| `metadata` | optional | Stored on the ledger entry |

```json
{
  "reservation_id": "4d8a9515-00cc-4421-8753-c3996a5d3cda",
  "status": "COMMITTED",
  "reserved_amount": 50,
  "committed_amount": 42,
  "refunded_credits": 8,
  "overage_credits": 0,
  "expired_credits": 0,
  "available_credits": 1458,
  "reserved_credits": 0,
  "expiring_credits": 458
}
```

`expired_credits` counts refunded credits whose expiry date passed while they
were on hold: they expire instead of going back to the balance.

**Errors:**
- 402 `insufficient_credits` (with `overage_credits`): the work used more than
  the hold, and the balance can't cover the difference. The hold stays
  pending: commit at most the held amount, or release it.
- 404 `reservation_not_found`.
- 409 `reservation_not_pending`: the hold was already committed, released or
  expired. If it expired because the TTL passed, nothing was charged, so
  don't deliver the result.

### `POST /v1/credits/release`

Cancels a hold and returns all of it to the tenant.

```bash
curl https://tokenledger-api.fly.dev/v1/credits/release \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY" \
  -H "Idempotency-Key: fe15aef3-ea17-47b0-a9e6-1e94f20b588b:release" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id": "cus_123", "reservation_id": "fe15aef3-ea17-47b0-a9e6-1e94f20b588b", "reason": "report_failed"}'
```

```json
{
  "reservation_id": "fe15aef3-ea17-47b0-a9e6-1e94f20b588b",
  "status": "RELEASED",
  "released_credits": 30,
  "expired_credits": 0,
  "available_credits": 1458,
  "reserved_credits": 0,
  "expiring_credits": 458
}
```

The errors are the same as for commit.

### Charge once per item over HTTP

This is what [`chargeOnce`](#charge-once-per-item) does, step by step:

1. **New key:** create a new `Idempotency-Key` for this attempt, such as a
   UUID. Keep it for the retries in step 3.
2. **Reserve:** call `POST /v1/credits/reserve` with `item_key` and
   `estimate_credits` set to the item's price.
3. **Act on the answer:**
   - **`"already_charged": true`:** the tenant owns the item. Deliver it for
     free. There's no new hold, so don't commit anything. `reservation_id` is
     the reservation that paid, or `null` if the purchase was
     [imported](#post-v1import).

     ```json
     { "allowed": true, "already_charged": true, "item_key": "email:p_981", "feature": "email_lookup",
       "reservation_id": "e3c11d6f-0ecb-44f1-8e46-0dcd6aad54b9", "charged_credits": 1,
       "charged_at": "2026-11-27T14:11:42.252693Z", "remaining_available": 1457, "reserved_balance": 0 }
     ```

   - **`"already_charged": false`:** a hold was made. Produce the item, then
     commit `actual_credits_used` = the price with the key
     `<reservation_id>:commit`. Deliver only after the commit succeeds. If
     there's nothing to deliver, release the hold instead, and nothing is
     charged.

     ```json
     { "allowed": true, "already_charged": false, "item_key": "email:p_981",
       "reservation_id": "e3c11d6f-0ecb-44f1-8e46-0dcd6aad54b9", "remaining_available": 1457,
       "reserved_balance": 1, "expires_at": "2026-11-27T14:12:42.201199Z" }
     ```

   - **409 `item_charge_in_progress`:** another request is charging the same
     item right now. Wait (start at 250 ms and double, up to 2 s), then send
     the **same request with the same key**, for up to about 10 seconds. You'll
     then get `already_charged: true` or a hold of your own. `Retry-After` is
     the longest the other hold can last.
   - **402 `insufficient_credits`:** the tenant can't pay for it.
4. **Crashes:** if your service dies between the reserve and the commit, the
   hold expires after `ttl_seconds`, nothing is charged, and the next attempt
   charges again. Keep `ttl_seconds` short for this reason.

An item is the pair (`feature`, `item_key`), per tenant. See
[Choosing an `itemKey`](#charge-once-per-item) for how narrow to make keys.

### `GET /v1/tenants/{tenant_id}/wallet`

Balances, expiring credits, and the 20 most recent ledger entries, newest first.
URL-encode `tenant_id` if it contains special characters.

```bash
curl https://tokenledger-api.fly.dev/v1/tenants/cus_123/wallet \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY"
```

```json
{
  "tenant_id": "cus_123",
  "available_credits": 1457,
  "reserved_credits": 0,
  "expiring_credits": 457,
  "permanent_credits": 1000,
  "next_expiry_at": "2026-12-31T23:59:59Z",
  "credit_buckets": [
    {
      "id": "170d2cc5-573b-4e96-87b9-8ef3b7658ec5",
      "granted": 500,
      "remaining": 457,
      "expires_at": "2026-12-31T23:59:59Z",
      "reason": "monthly allowance",
      "created_at": "2026-11-27T14:11:41.876258Z"
    }
  ],
  "updated_at": "2026-11-27T14:11:42.411360Z",
  "recent_ledger": [
    {
      "id": "e8b20fe8-fddf-4578-9789-d396f6b1aa4e",
      "tenant_id": "cus_123",
      "entry_type": "COMMIT",
      "reservation_id": "4d8a9515-00cc-4421-8753-c3996a5d3cda",
      "feature": "report",
      "bucket_id": null,
      "delta_available": 0,
      "delta_reserved": -42,
      "balance_available_after": 1450,
      "balance_reserved_after": 8,
      "buckets": [{ "bucket_id": "170d2cc5-573b-4e96-87b9-8ef3b7658ec5", "amount": 42 }],
      "metadata": {},
      "created_at": "2026-11-27T14:11:42.042317Z"
    }
  ]
}
```

**Ledger entry types:**
- `GRANT`: credits added.
- `RESERVE`: a hold was placed.
- `COMMIT`: a hold was charged.
- `REFUND_UNUSED`: the unused part of a hold went back.
- `OVERAGE_DEDUCT`: usage above the hold was taken from the balance.
- `RELEASE`: a hold was cancelled.
- `EXPIRE`: a hold ran out its TTL.
- `CREDIT_EXPIRE`: expiring credits reached their date.

`buckets` shows which expiring-credit grants the credits moved from or to.

**Errors:** 404 `wallet_not_found` if the tenant has never been granted
credits.

### `POST /v1/import`

Moves customers from another billing system: their balances, what they
already bought, or both. See
[Move customers from another system](#move-customers-from-another-system) for
when and why.

```bash
curl https://tokenledger-api.fly.dev/v1/import \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY" \
  -H "Idempotency-Key: from-stripe-2026-11" \
  -H "Content-Type: application/json" \
  -d '{
    "tenants": [
      {
        "tenant_id": "cus_456",
        "credits": [
          { "amount": 420 },
          { "amount": 100, "expires_at": "2026-12-31T23:59:59Z", "reason": "december allowance" }
        ],
        "purchases": [
          { "item_key": "email:p_981", "feature": "email_lookup", "credits": 1, "purchased_at": "2026-10-02T00:00:00Z" }
        ]
      }
    ]
  }'
```

**Limits per request:**
- 1–100 tenants;
- at most 5,000 purchases in total;
- at most 50 credit entries per tenant;
- a body of at most 16 MB.

A tenant needs `credits`, `purchases` or both. A purchase's `credits` (at
least 1) is what the customer paid for it.

**The `Idempotency-Key` names the import:**
- Each tenant is stored under it, so rerunning the same request (after a crash,
  say) answers `replayed` for every tenant already imported.
- A tenant with more than 5,000 purchases goes in follow-up requests under
  their own keys. The SDK uses `<key>:part2`, `<key>:part3` and so on.
- A tenant's balance can be imported only once. Importing it again under a new
  key fails with `credits_already_imported`.

The answer is always 200, with one result per tenant. Failed tenants are
listed with their own error and don't stop the rest:

```json
{
  "imported": 1,
  "replayed": 0,
  "failed": 0,
  "results": [
    {
      "tenant_id": "cus_456",
      "status": "imported",
      "granted_credits": 520,
      "purchases_imported": 1,
      "purchases_skipped": 0,
      "skipped_item_keys": [],
      "available_credits": 520,
      "expiring_credits": 100
    }
  ]
}
```

`status` is `imported`, `replayed` or `failed`. A failed tenant also has
`error` and `message`.

**Limits and errors:**
- Imports don't count toward your request limits.
- At most 2 imports can run at once per account. A third gets 409
  `import_in_progress`.
- Each account can import up to 1,000,000 customers and 50,000,000 purchases
  per UTC day. A tenant that doesn't fit in what's left fails with
  `import_limit_reached`. Once both caps are used up, the whole request gets 429
  `import_limit_reached`. Rerun the same import after midnight UTC.

### `GET` and `PATCH /v1/settings`

`item_retention_days` sets how many days a tenant owns an item it bought (1 to
36,500). `null` means for good, which is the default. `PATCH` needs no
`Idempotency-Key`, since setting the same value twice is harmless.

```bash
curl -X PATCH https://tokenledger-api.fly.dev/v1/settings \
  -H "Authorization: Bearer $TOKENLEDGER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"item_retention_days": 90}'
```

```json
{ "item_retention_days": 90 }
```

`GET /v1/settings` answers the same shape.

### `GET /livez` and `/healthz`

These need no API key and both answer `{"status": "ok"}`. `/livez` means the
server is up. `/healthz` also checks that the server can reach its database.

## Development

Install the dev dependency (TypeScript), then typecheck. CI runs the typecheck
on Node 20 and the latest Node:

```bash
npm install
```

```bash
npm run typecheck
```

`npm run build` writes `dist/`. `npm publish` typechecks and builds first.

The end-to-end checks in [`test/`](test) need a TokenLedger server running
locally and an API key in a file. Each file's header says how to run it. They
refuse to run against anything but a local server.

## License

[MIT](LICENSE)
