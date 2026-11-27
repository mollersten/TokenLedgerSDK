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

## Contents

- [Install](#install)
- [Quick start](#quick-start)
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
- [Development](#development)

## Install

The SDK isn't on npm yet. It's a single TypeScript file with no
dependencies, so you can use it in either of two ways:

**Copy the file (TypeScript projects).** Copy [`index.ts`](index.ts) into your
project, for example as `src/tokenledger.ts`, and import from that path instead
of `@tokenledger/sdk`.

**Build it and install it from a folder.**

```bash
git clone https://github.com/mollersten/TokenLedgerSDK.git
```

```bash
cd TokenLedgerSDK && npx --package typescript -- tsc -p tsconfig.json
```

```bash
npm install ../TokenLedgerSDK
```

Run the last command from your own project. It installs the package as
`@tokenledger/sdk`, with JavaScript in `dist/index.js` and types in
`dist/index.d.ts`.

## Quick start

```ts
import { TokenLedgerClient } from "@tokenledger/sdk";

const ledger = new TokenLedgerClient({ apiKey: process.env.TOKENLEDGER_API_KEY! });

// Give a customer 1,000 credits.
await ledger.grant({ tenantId: "cus_123", amount: 1_000, reason: "signup bonus" });

// Hold up to 50 credits, do the work, and charge what it actually used.
const { result: report, cost } = await ledger.withCreditHold(
  { tenantId: "cus_123", feature: "report", estimateCredits: 50 },
  async (hold) => {
    const generated = await generateReport({ signal: hold.signal });
    return { cost: generated.creditsUsed, result: generated };
  },
);

console.log(`charged ${cost} credits`, report);
```

The client talks to the hosted API at `https://tokenledger-api.fly.dev` unless
you pass a `baseUrl` (see [Client options](#client-options)).

## Concepts

| Term | Meaning |
| --- | --- |
| **Tenant** | One of your customers. `tenantId` is your own id for them, such as a user or organisation id. Their wallet is created by the first grant. |
| **Credits** | Whole numbers. A wallet's `availableCredits` are spendable; `reservedCredits` are on hold. |
| **Feature** | A label for what you meter, such as `"report"` or `"email_lookup"`. It's recorded with each charge. |
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
it's delivered. After that, the same item is free for that tenant:

```ts
import { noCharge } from "@tokenledger/sdk";

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

This step is optional. If your customers already have credits or purchases in
another billing system, `importTenants` moves them over. Nothing else needs it:
`chargeOnce` works the same with or without an import.

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
import { InsufficientCreditsError, TokenLedgerApiError } from "@tokenledger/sdk";

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
| 401 | `missing_api_key`, `invalid_api_key` |
| 403 | `account_suspended`, `trial_expired`, `tenant_limit_reached` |
| 404 | `wallet_not_found` (the tenant has never been granted credits), `reservation_not_found` |
| 409 | `item_charge_in_progress`, `import_in_progress`, `reservation_not_pending` |
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
import { TokenLedgerClient } from "@tokenledger/sdk";

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

## Development

Typecheck (CI runs this on Node 20 and the latest Node):

```bash
npx --package typescript -- tsc -p tsconfig.json --noEmit
```

The end-to-end checks in [`test/`](test) need a TokenLedger server running
locally and an API key in a file. Each file's header says how to run it. They
refuse to run against anything but a local server.
