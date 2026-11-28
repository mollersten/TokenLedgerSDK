/**
 * TokenLedger TypeScript SDK.
 *
 * Most apps need only these, one call each:
 *
 *   addCredits(tenantId, credits)                     → new balance
 *   charge(tenantId, credits)                         → new balance
 *   getBalance(tenantId)                              → balance
 *   meter(tenantId, maxCredits, work)                 → what `work` returns
 *   chargeOnce(tenantId, itemKey, credits, produce)   → what `produce` returns
 *   importCustomers(customers)                        → { imported, failed, … }
 *
 * Zero runtime dependencies: uses the platform's `fetch`, `AbortController`
 * and `crypto.randomUUID` (Node 20+, Deno, Bun, modern browsers).
 *
 * Every mutating call sends an `Idempotency-Key`. Network failures and 5xx
 * responses are retried with the *same* key, so a retry can never charge a
 * tenant twice: the server replays the original response instead.
 *
 * That covers retries inside one call. To charge for a *thing* once, even
 * when the tenant's code crashes after getting it and asks again from a new
 * process, use `chargeOnce` with an `itemKey`.
 */

export type Metadata = Record<string, unknown>;

export type LedgerEntryType =
  | "GRANT"
  | "RESERVE"
  | "COMMIT"
  | "REFUND_UNUSED"
  | "OVERAGE_DEDUCT"
  | "RELEASE"
  | "EXPIRE"
  /** Credits left in a bucket when it expired (or returned to it after). */
  | "CREDIT_EXPIRE";

export type ReservationStatus = "PENDING" | "COMMITTED" | "RELEASED" | "EXPIRED";

// ---------------------------------------------------------------------------
// Options & params
// ---------------------------------------------------------------------------

/** The hosted TokenLedger API, used when `baseUrl` is not given. */
export const DEFAULT_BASE_URL = "https://tokenledger-api.fly.dev";

/**
 * The feature used when a call doesn't name one. Features label what a charge
 * was for; for `chargeOnce` the feature is also part of the item, so imported
 * purchases and charges that both leave it out match up.
 */
export const DEFAULT_FEATURE = "default";

export interface TokenLedgerClientOptions {
  /**
   * API base URL. Defaults to {@link DEFAULT_BASE_URL}, the hosted API. Set
   * it to reach another server, e.g. `http://127.0.0.1:8080` for a local one.
   */
  baseUrl?: string;
  /** Secret API key (`tl_live_…`). Keep it server-side; never ship it to browsers. */
  apiKey: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Retries for network errors, 5xx responses and `rate_limited` 429s. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries. Default 200 ms. */
  retryDelayMs?: number;
}

export interface RequestOptions {
  /**
   * Supply your own key to make a call idempotent across process restarts.
   * A key replays the first answer it got, including refusals: a reserve
   * that got `insufficient_credits` answers the same with that key even
   * after a top-up. Use a new key for a new attempt. Keys are remembered for
   * 24 hours; `chargeOnce` doesn't rely on them (an owned item stays owned).
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface GrantParams {
  tenantId: string;
  amount: number;
  reason?: string;
  metadata?: Metadata;
  /**
   * Make these credits expire (e.g. the end of the billing period for a
   * monthly allowance). Expiring credits are spent before permanent ones,
   * soonest expiry first; whatever is left at `expiresAt` is removed.
   * Omit for credits that never expire, such as purchased top-ups.
   */
  expiresAt?: Date | string;
}

export interface ReserveParams {
  tenantId: string;
  /** What the hold is for, e.g. `"report"`. Default {@link DEFAULT_FEATURE}. */
  feature?: string;
  estimateCredits: number;
  /** How long the hold lives before the server's reaper returns it. Default 60. */
  ttlSeconds?: number;
  metadata?: Metadata;
}

export interface CommitParams {
  tenantId: string;
  reservationId: string;
  actualCreditsUsed: number;
  metadata?: Metadata;
}

export interface ReleaseParams {
  tenantId: string;
  reservationId: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface GrantResult {
  tenantId: string;
  availableCredits: number;
  reservedCredits: number;
  /** The part of `availableCredits` that will expire. */
  expiringCredits: number;
  grantedCredits: number;
  ledgerEntryId: string;
  updatedAt: string;
  /** Set when the grant had `expiresAt`. */
  bucketId?: string;
  expiresAt?: string;
}

export interface ReserveAllowed {
  allowed: true;
  reservationId: string;
  remainingAvailable: number;
  reservedBalance: number;
  expiresAt: string;
}

export interface ReserveDenied {
  allowed: false;
  error: "insufficient_credits";
  availableCredits: number;
  requestedCredits: number;
}

export type ReserveResult = ReserveAllowed | ReserveDenied;

export interface CommitResult {
  reservationId: string;
  status: "COMMITTED";
  reservedAmount: number;
  committedAmount: number;
  refundedCredits: number;
  overageCredits: number;
  /** Unused credits whose bucket expired while they were held. */
  expiredCredits: number;
  availableCredits: number;
  reservedCredits: number;
  expiringCredits: number;
}

export interface ReleaseResult {
  reservationId: string;
  status: "RELEASED";
  releasedCredits: number;
  /** Released credits whose bucket expired while they were held. */
  expiredCredits: number;
  availableCredits: number;
  reservedCredits: number;
  expiringCredits: number;
}

export interface LedgerEntry {
  id: string;
  tenantId: string;
  reservationId: string | null;
  /** The credit bucket a GRANT created or a CREDIT_EXPIRE emptied. */
  bucketId: string | null;
  entryType: LedgerEntryType;
  deltaAvailable: number;
  deltaReserved: number;
  balanceAvailableAfter: number;
  balanceReservedAfter: number;
  /**
   * What this event recorded beyond the amounts: a grant's reason, a
   * commit's metadata, who expired it. (Entries written before the ledger
   * was normalized may also carry `feature` and `buckets` here.)
   */
  metadata: Metadata;
  /** The feature of the reservation this entry belongs to, if any. */
  feature: string | null;
  /** The expiring-credit buckets the credits moved from or to. */
  buckets: { bucketId: string; amount: number }[];
  createdAt: string;
}

/** Credits from one grant with an expiry. */
export interface CreditBucket {
  id: string;
  granted: number;
  remaining: number;
  expiresAt: string;
  reason: string | null;
  createdAt: string;
}

export interface Wallet {
  tenantId: string;
  /** Everything spendable: permanent + expiring. */
  availableCredits: number;
  reservedCredits: number;
  /** Spendable credits that will expire (sum of `creditBuckets`). */
  expiringCredits: number;
  /** Credits that never expire. */
  permanentCredits: number;
  nextExpiryAt: string | null;
  /** Buckets with credits left, soonest expiry first. */
  creditBuckets: CreditBucket[];
  updatedAt: string;
  recentLedger: LedgerEntry[];
}

// ---------------------------------------------------------------------------
// withCreditHold
// ---------------------------------------------------------------------------

export interface CreditHoldOptions extends ReserveParams {
  /** Base idempotency key; `:reserve` is appended for the reservation call. */
  idempotencyKey?: string;
  /** Reason recorded when the hold is released because the callback threw. */
  releaseReason?: string;
}

export interface CreditHold {
  reservationId: string;
  tenantId: string;
  feature: string;
  estimateCredits: number;
  expiresAt: Date;
  /** Aborted when the hold's TTL elapses; pass it to your upstream calls. */
  signal: AbortSignal;
}

/** Return the credits actually used, or an object carrying a result too. */
export type HoldOutcome<T> = number | { cost: number; result?: T; metadata?: Metadata };

export interface CreditHoldResult<T> {
  result: T | undefined;
  /** What the callback reported using. */
  cost: number;
  /**
   * Usage that could not be charged: the cost went over the hold and the
   * tenant's balance could not cover the difference, so only the hold was
   * charged. 0 normally.
   */
  uncoveredCredits: number;
  reservation: ReserveAllowed;
  commit: CommitResult;
}

// ---------------------------------------------------------------------------
// chargeOnce
// ---------------------------------------------------------------------------

export interface ChargeOnceOptions {
  tenantId: string;
  /**
   * Names exactly one thing the tenant buys, e.g. `email:${personId}`.
   * Together with `feature` it is the item: the same key under another
   * feature is a different item, bought separately. Once paid, the tenant
   * owns it (for good, or for the account's `itemRetentionDays`); it never
   * unlocks anything for another tenant. Make it as narrow as what you
   * deliver (a key per company would sell every person there for the price
   * of one), and add a version if the item can change and should be paid for
   * again (`report:${id}:v2`).
   */
  itemKey: string;
  /** Default {@link DEFAULT_FEATURE}. Part of the item (see `itemKey`). */
  feature?: string;
  /** What the item costs. Charged in full once it is delivered. */
  credits: number;
  /**
   * How long the hold lives while `callback` runs. Default 60. Keep it
   * short: if your process dies mid-callback, the item can't be charged
   * again until the hold runs out.
   */
  ttlSeconds?: number;
  metadata?: Metadata;
  /** How long to wait while another request is charging the same item. Default 10 000 ms. */
  waitMs?: number;
  /** Reason recorded when the hold is released because the callback threw. */
  releaseReason?: string;
}

export interface ChargeOnceItem {
  tenantId: string;
  itemKey: string;
  feature: string;
  /**
   * The tenant has paid for this item before. Deliver it again without
   * charging (from your cache, if you keep one).
   */
  alreadyCharged: boolean;
  /**
   * The new hold, or the earlier reservation that paid for the item (`null`
   * when the purchase was imported from another system).
   */
  reservationId: string | null;
  /** Aborted when the hold's TTL elapses; pass it to your upstream calls. */
  signal: AbortSignal;
}

/** Returned from a `chargeOnce` callback via `noCharge()`: deliver, but don't bill. */
export class NoCharge<T> {
  readonly result: T;

  constructor(result: T) {
    this.result = result;
  }
}

/**
 * Return `noCharge(result)` from a `chargeOnce` callback when there is
 * nothing to bill for, e.g. a lookup that found nothing. The hold is
 * released, nothing is charged, and the item stays unpaid, so it is charged
 * the next time it is actually delivered.
 */
export function noCharge<T>(result: T): NoCharge<T> {
  return new NoCharge(result);
}

export interface ChargeOnceResult<T> {
  result: T;
  /** This call charged the tenant `creditsCharged` credits. */
  charged: boolean;
  /** The tenant had already paid for the item; nothing was charged now. */
  alreadyCharged: boolean;
  creditsCharged: number;
  /** `null` when the item was owned through an imported purchase. */
  reservationId: string | null;
  /** Set when this call charged. */
  commit?: CommitResult;
}

// ---------------------------------------------------------------------------
// importTenants (optional: moving customers over from another system)
// ---------------------------------------------------------------------------

/** Part of a customer's starting balance. */
export interface ImportCredit {
  amount: number;
  /** For credits that lapse (a monthly allowance). Must be in the future. */
  expiresAt?: Date | string;
  reason?: string;
}

/** Something the customer bought in the old system. `chargeOnce` treats it as paid. */
export interface ImportPurchase {
  itemKey: string;
  /**
   * The feature `chargeOnce` will use for this item (default
   * {@link DEFAULT_FEATURE}). It is part of the item: under a different
   * feature the same key is a different item, not covered by this purchase.
   */
  feature?: string;
  /** What they paid for it (at least 1). */
  credits: number;
  purchasedAt?: Date | string;
}

export interface ImportTenant {
  tenantId: string;
  /** Their balance in the old system. A tenant's balance can be imported once. */
  credits?: ImportCredit[];
  /**
   * What they already bought. Leave it out if `chargeOnce` should charge
   * for those items again; it can also be imported later on its own.
   */
  purchases?: ImportPurchase[];
}

export interface ImportOptions {
  /**
   * Names this import, e.g. `"from-stripe-2026-11"`. Run it again with the
   * same id and the same data (after a crash, say) and every customer already
   * imported is skipped. Use a new id for a later, different import.
   */
  importId: string;
  /** Called after each request, e.g. to log progress. */
  onProgress?: (progress: { tenantsDone: number; tenantsTotal: number }) => void;
  signal?: AbortSignal;
}

export interface ImportTenantResult {
  tenantId: string;
  /** `replayed`: imported by an earlier run with the same `importId`. */
  status: "imported" | "replayed" | "failed";
  grantedCredits: number;
  purchasesImported: number;
  /** Items the tenant had already paid for. */
  purchasesSkipped: number;
  skippedItemKeys: string[];
  /** The balance right after the import (a replay shows it as of then). */
  availableCredits?: number;
  /**
   * Set when `status` is `failed`, e.g. `credits_already_imported`,
   * `tenant_limit_reached`, `invalid_import`, or `item_charge_in_progress`
   * (one of its items was being charged; rerun once it settles).
   */
  error?: string;
  message?: string;
}

export interface ImportResult {
  imported: number;
  replayed: number;
  failed: number;
  /** One per tenant, in the order given. */
  tenants: ImportTenantResult[];
}

/** Server limits per import request; `importTenants` splits to stay under them. */
const IMPORT_TENANTS_PER_CALL = 100;
const IMPORT_PURCHASES_PER_CALL = 5_000;

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

export interface AccountSettings {
  /**
   * How many days a tenant owns an item it bought through `chargeOnce` (or
   * that was imported). After that the item is charged again the next time.
   * The record is deleted 7 days later, so a value set by mistake can be
   * raised (or cleared) in that time and the items are owned again.
   * `null`: owned for good (the default).
   */
  itemRetentionDays: number | null;
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Where your account stands against its hourly request limit (free plan:
 * 120/hour). The first time the account goes over it, a one-time 24-hour
 * grace period starts with a higher limit (600/hour) so you have time to
 * upgrade; after that, requests over the limit fail with
 * `hourly_limit_exceeded` until the next hour.
 */
export interface RateLimitInfo {
  /** Requests allowed this hour (the grace limit while the grace period runs). */
  limit: number;
  remaining: number;
  /** When this hour's count resets. */
  resetAt: Date;
  /** Set while the grace period runs: upgrade before then. */
  graceEndsAt?: Date;
}

function parseRateLimit(headers: Headers): RateLimitInfo | undefined {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return undefined;
  const graceEnds = headers.get("x-ratelimit-grace-ends");
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000),
    ...(graceEnds !== null ? { graceEndsAt: new Date(Number(graceEnds) * 1000) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The API answered with an error status. Notable codes: `invalid_api_key`
 * (401), `account_suspended` / `trial_expired` / `tenant_limit_reached` (403),
 * `item_charge_in_progress` / `import_in_progress` (409), `wallet_busy` /
 * `service_busy` (503, retried automatically),
 * `rate_limited` / `hourly_limit_exceeded` / `monthly_quota_exceeded` (429).
 */
export class TokenLedgerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  /** From the `Retry-After` header on 429 responses. */
  readonly retryAfterSeconds: number | undefined;
  /** The account's hourly limit, if it has one. */
  readonly rateLimit: RateLimitInfo | undefined;

  constructor(status: number, body: unknown, retryAfterSeconds?: number, rateLimit?: RateLimitInfo) {
    const record = isRecord(body) ? body : {};
    const code = typeof record.error === "string" ? record.error : `http_${status}`;
    const detail = typeof record.message === "string" ? `: ${record.message}` : "";
    super(`TokenLedger API ${status} ${code}${detail}`);
    this.name = "TokenLedgerApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
    this.rateLimit = rateLimit;
  }
}

/** The tenant cannot cover the requested credits (HTTP 402). */
export class InsufficientCreditsError extends TokenLedgerApiError {
  readonly availableCredits: number;

  constructor(body: unknown) {
    super(402, body);
    this.name = "InsufficientCreditsError";
    const record = isRecord(body) ? body : {};
    this.availableCredits = typeof record.available_credits === "number" ? record.available_credits : 0;
  }
}

/** The request never produced an HTTP response (after all retries). */
export class TokenLedgerNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenLedgerNetworkError";
  }
}

// ---------------------------------------------------------------------------
// The simple functions: options and results
// ---------------------------------------------------------------------------

/** Makes `chargeOnce`'s item (see `ChargeOnceOptions`). */
export type ChargeOnceCallback<T> = (item: ChargeOnceItem) => Promise<T | NoCharge<T>> | T | NoCharge<T>;

export interface AddCreditsOptions {
  /** Make these credits expire then, e.g. at the end of a monthly allowance. */
  expiresAt?: Date | string;
  reason?: string;
  metadata?: Metadata;
  /**
   * Makes the call safe to repeat, even from another process: the same key
   * adds the credits once. Use something that names the top-up, such as an
   * invoice id.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ChargeOptions {
  /** What the charge is for, e.g. `"report"`. Default {@link DEFAULT_FEATURE}. */
  feature?: string;
  metadata?: Metadata;
  /** Makes the call safe to repeat, e.g. an order id: the same key charges once. */
  idempotencyKey?: string;
}

export interface MeterOptions {
  /** What the work is, e.g. `"report"`. Default {@link DEFAULT_FEATURE}. */
  feature?: string;
  /**
   * How long the work may take. Default 60. If it takes longer, nothing is
   * charged and `meter` throws, so set this above your slowest run.
   */
  ttlSeconds?: number;
  metadata?: Metadata;
  idempotencyKey?: string;
}

export interface SimpleChargeOnceOptions {
  /** Default {@link DEFAULT_FEATURE}. Part of the item: see `ChargeOnceOptions.itemKey`. */
  feature?: string;
  /** How long `produce` may take. Default 60. */
  ttlSeconds?: number;
  metadata?: Metadata;
  /** How long to wait while another request charges the same item. Default 10 000 ms. */
  waitMs?: number;
  releaseReason?: string;
}

/** One customer for `importCustomers`. */
export interface ImportCustomer {
  /** Your id for the customer: the `tenantId` you use in every other call. */
  id: string;
  /** Their balance in the old system. Imported once; later runs don't change it. */
  credits?: number;
  /**
   * Items they already bought, so `chargeOnce` won't charge them again. A
   * string is an item key under the default feature; use the object form
   * if you pass a `feature` to `chargeOnce`.
   */
  owns?: (string | { itemKey: string; feature?: string; credits?: number; purchasedAt?: Date | string })[];
}

export interface ImportCustomersOptions {
  /**
   * Leave it out: the default is the same on every run, so running an import
   * again only adds what's new. Set your own only to import different data
   * for customers imported in the last 24 hours.
   */
  importId?: string;
  onProgress?: (progress: { tenantsDone: number; tenantsTotal: number }) => void;
  signal?: AbortSignal;
}

export interface ImportCustomersResult {
  /** Customers imported by this call. */
  imported: number;
  /** Customers an earlier run already imported (nothing changed for them). */
  alreadyImported: number;
  /** Customers with no credits and nothing owned: nothing to send. */
  skipped: number;
  /** Customers that could not be imported, and why. Fix them and run again. */
  failed: { id: string; error: string; message: string }[];
}

/** The `importId` `importCustomers` uses unless given one. */
const DEFAULT_IMPORT_ID = "tokenledger-sdk-import";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface RawResponse {
  status: number;
  body: Json;
}

export class TokenLedgerClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  #rateLimit: RateLimitInfo | undefined;

  constructor(options: TokenLedgerClientOptions) {
    // An empty string is a mistake (say, an unset env var), not a request for
    // the default: refuse it rather than quietly reach the hosted API.
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    if (!baseUrl) throw new TypeError("TokenLedgerClient: baseUrl is empty; omit it to use the hosted API");
    if (!options.apiKey) throw new TypeError("TokenLedgerClient: apiKey is required");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("TokenLedgerClient: no fetch implementation available; pass options.fetch");
    }
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#headers = { ...options.headers, authorization: `Bearer ${options.apiKey}` };
    this.#fetch = fetchImpl;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.#retryDelayMs = options.retryDelayMs ?? 200;
  }

  // -------------------------------------------------------------------------
  // The simple functions: one call each, and you get back what you need.
  // Everything below them is the full API, for more control.
  // -------------------------------------------------------------------------

  /**
   * Give a customer credits. Returns their new balance.
   *
   * @example
   * await ledger.addCredits("cus_123", 1000); // → 1000
   */
  async addCredits(tenantId: string, credits: number, options: AddCreditsOptions = {}): Promise<number> {
    if (!Number.isSafeInteger(credits) || credits <= 0) {
      throw new TypeError(`addCredits: credits must be a positive whole number, got ${String(credits)}`);
    }
    const { idempotencyKey, signal, ...grant } = options;
    const result = await this.grant({ tenantId, amount: credits, ...grant }, { idempotencyKey, signal });
    return result.availableCredits;
  }

  /**
   * Take credits from a customer's balance. Returns their new balance.
   *
   * @example
   * await ledger.charge("cus_123", 5); // → 995
   * @throws InsufficientCreditsError when the balance is too low; nothing is charged.
   */
  async charge(tenantId: string, credits: number, options: ChargeOptions = {}): Promise<number> {
    if (!Number.isSafeInteger(credits) || credits <= 0) {
      throw new TypeError(`charge: credits must be a positive whole number, got ${String(credits)}`);
    }
    const { feature, metadata, idempotencyKey } = options;
    const hold = await this.reserve(
      { tenantId, feature, estimateCredits: credits },
      { idempotencyKey: idempotencyKey === undefined ? undefined : `${idempotencyKey}:reserve` },
    );
    if (!hold.allowed) throw insufficientCredits(hold);
    const commit = await this.commit(
      { tenantId, reservationId: hold.reservationId, actualCreditsUsed: credits, metadata },
      { idempotencyKey: `${hold.reservationId}:commit` },
    );
    return commit.availableCredits;
  }

  /**
   * A customer's spendable credits: 0 for a customer who has never been given
   * any.
   *
   * @example
   * await ledger.getBalance("cus_123"); // → 995
   */
  async getBalance(tenantId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<number> {
    try {
      return (await this.getWallet(tenantId, options)).availableCredits;
    } catch (error) {
      if (error instanceof TokenLedgerApiError && error.code === "wallet_not_found") return 0;
      throw error;
    }
  }

  /**
   * Run work whose cost you only know afterwards, and charge what it used.
   * `maxCredits` is held while it runs, so the customer can't overspend.
   * Report usage with `use(credits)`; calls add up. If `work` never calls
   * `use`, the full `maxCredits` is charged. If `work` throws, nothing is
   * charged and the error is rethrown. Returns what `work` returns.
   *
   * Usage above `maxCredits` is taken from the balance when it can cover it.
   *
   * @example
   * const report = await ledger.meter("cus_123", 50, async (use) => {
   *   const r = await generateReport();
   *   use(r.creditsUsed);
   *   return r;
   * });
   * @throws InsufficientCreditsError when the customer can't cover `maxCredits`; `work` doesn't run.
   */
  async meter<T>(
    tenantId: string,
    maxCredits: number,
    work: (use: (credits: number) => void, hold: CreditHold) => Promise<T> | T,
    options: MeterOptions = {},
  ): Promise<T> {
    if (!Number.isSafeInteger(maxCredits) || maxCredits <= 0) {
      throw new TypeError(`meter: maxCredits must be a positive whole number, got ${String(maxCredits)}`);
    }
    let used: number | undefined;
    const use = (credits: number): void => {
      if (!Number.isSafeInteger(credits) || credits < 0) {
        throw new TypeError(`meter: use() takes a whole number of credits, 0 or more, got ${String(credits)}`);
      }
      used = (used ?? 0) + credits;
    };
    const { feature, ttlSeconds, metadata, idempotencyKey } = options;
    const { result } = await this.withCreditHold<T>(
      { tenantId, feature, estimateCredits: maxCredits, ttlSeconds, metadata, idempotencyKey },
      async (hold) => {
        const result = await work(use, hold);
        return { cost: used ?? maxCredits, result };
      },
    );
    return result as T;
  }

  /**
   * Move customers over from another billing system: their balance, and what
   * they already bought so `chargeOnce` doesn't charge for it again.
   * Optional: nothing else needs it. Pass any number of customers. It's safe
   * to run again: customers already imported are never added twice.
   *
   * @example
   * const { imported, failed } = await ledger.importCustomers([
   *   { id: "cus_123", credits: 520, owns: ["email:p_981"] },
   *   { id: "cus_456", credits: 100 },
   * ]);
   */
  async importCustomers(
    customers: ImportCustomer[],
    options: ImportCustomersOptions = {},
  ): Promise<ImportCustomersResult> {
    const tenants: ImportTenant[] = [];
    for (const customer of customers) {
      const { id, credits } = customer;
      if (credits !== undefined && (!Number.isSafeInteger(credits) || credits < 0)) {
        throw new TypeError(`importCustomers: customer ${id} has credits that are not a whole number, 0 or more`);
      }
      const purchases: ImportPurchase[] = (customer.owns ?? []).map((item) =>
        typeof item === "string"
          ? { itemKey: item, credits: 1 }
          : { itemKey: item.itemKey, feature: item.feature, credits: item.credits ?? 1, purchasedAt: item.purchasedAt },
      );
      if (!credits && purchases.length === 0) continue; // nothing to import
      tenants.push({
        tenantId: id,
        ...(credits ? { credits: [{ amount: credits }] } : {}),
        ...(purchases.length ? { purchases } : {}),
      });
    }
    const skipped = customers.length - tenants.length;
    if (tenants.length === 0) return { imported: 0, alreadyImported: 0, skipped, failed: [] };

    const report = await this.importTenants(tenants, {
      importId: options.importId ?? DEFAULT_IMPORT_ID,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      imported: report.imported,
      alreadyImported: report.replayed,
      skipped,
      failed: report.tenants
        .filter((t) => t.status === "failed")
        .map((t) => ({ id: t.tenantId, error: t.error ?? "unknown_error", message: t.message ?? "" })),
    };
  }

  // -------------------------------------------------------------------------
  // The full API
  // -------------------------------------------------------------------------

  /**
   * Add credits to a tenant's wallet (creates the wallet if needed). Pass
   * `expiresAt` for credits that lapse, such as a monthly allowance.
   */
  async grant(params: GrantParams, options: RequestOptions = {}): Promise<GrantResult> {
    const { body } = await this.#post(
      "/v1/credits/grant",
      {
        tenant_id: params.tenantId,
        amount: params.amount,
        reason: params.reason,
        metadata: params.metadata,
        expires_at: params.expiresAt instanceof Date ? params.expiresAt.toISOString() : params.expiresAt,
      },
      options,
    );
    return {
      tenantId: str(body.tenant_id),
      availableCredits: num(body.available_credits),
      reservedCredits: num(body.reserved_credits),
      expiringCredits: num(body.expiring_credits),
      grantedCredits: num(body.granted_credits),
      ledgerEntryId: str(body.ledger_entry_id),
      updatedAt: str(body.updated_at),
      ...(typeof body.bucket_id === "string" ? { bucketId: body.bucket_id, expiresAt: str(body.expires_at) } : {}),
    };
  }

  /**
   * Place a hold on credits before doing metered work. Resolves with
   * `{ allowed: false }` (instead of throwing) when the balance is too low.
   */
  async reserve(params: ReserveParams, options: RequestOptions = {}): Promise<ReserveResult> {
    const { status, body } = await this.#post(
      "/v1/credits/reserve",
      {
        tenant_id: params.tenantId,
        feature: params.feature ?? DEFAULT_FEATURE,
        estimate_credits: params.estimateCredits,
        ttl_seconds: params.ttlSeconds,
        metadata: params.metadata ?? {},
      },
      options,
      [402],
    );
    if (status === 402) {
      return {
        allowed: false,
        error: "insufficient_credits",
        availableCredits: num(body.available_credits),
        requestedCredits: num(body.requested_credits),
      };
    }
    return {
      allowed: true,
      reservationId: str(body.reservation_id),
      remainingAvailable: num(body.remaining_available),
      reservedBalance: num(body.reserved_balance),
      expiresAt: str(body.expires_at),
    };
  }

  /**
   * Settle a reservation with the credits actually used. Unused credits are
   * refunded; usage above the hold is deducted from the available balance
   * (throws `InsufficientCreditsError` if that is not possible).
   */
  async commit(params: CommitParams, options: RequestOptions = {}): Promise<CommitResult> {
    const { body } = await this.#post(
      "/v1/credits/commit",
      {
        tenant_id: params.tenantId,
        reservation_id: params.reservationId,
        actual_credits_used: params.actualCreditsUsed,
        metadata: params.metadata ?? {},
      },
      options,
    );
    return {
      reservationId: str(body.reservation_id),
      status: "COMMITTED",
      reservedAmount: num(body.reserved_amount),
      committedAmount: num(body.committed_amount),
      refundedCredits: num(body.refunded_credits),
      overageCredits: num(body.overage_credits),
      expiredCredits: num(body.expired_credits ?? 0),
      availableCredits: num(body.available_credits),
      reservedCredits: num(body.reserved_credits),
      expiringCredits: num(body.expiring_credits ?? 0),
    };
  }

  /** Cancel a reservation and return the whole hold to the available balance. */
  async release(params: ReleaseParams, options: RequestOptions = {}): Promise<ReleaseResult> {
    const { body } = await this.#post(
      "/v1/credits/release",
      { tenant_id: params.tenantId, reservation_id: params.reservationId, reason: params.reason },
      options,
    );
    return {
      reservationId: str(body.reservation_id),
      status: "RELEASED",
      releasedCredits: num(body.released_credits),
      expiredCredits: num(body.expired_credits ?? 0),
      availableCredits: num(body.available_credits),
      reservedCredits: num(body.reserved_credits),
      expiringCredits: num(body.expiring_credits ?? 0),
    };
  }

  /** Current balances plus the 20 most recent ledger entries. */
  async getWallet(tenantId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<Wallet> {
    const { body } = await this.#request(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenantId)}/wallet`,
      undefined,
      undefined,
      options.signal,
      [],
    );
    const ledger = Array.isArray(body.recent_ledger) ? body.recent_ledger : [];
    const buckets = Array.isArray(body.credit_buckets) ? body.credit_buckets : [];
    return {
      tenantId: str(body.tenant_id),
      availableCredits: num(body.available_credits),
      reservedCredits: num(body.reserved_credits),
      expiringCredits: num(body.expiring_credits ?? 0),
      permanentCredits: num(body.permanent_credits ?? body.available_credits),
      nextExpiryAt: typeof body.next_expiry_at === "string" ? body.next_expiry_at : null,
      creditBuckets: buckets.filter(isRecord).map(toCreditBucket),
      updatedAt: str(body.updated_at),
      recentLedger: ledger.filter(isRecord).map(toLedgerEntry),
    };
  }

  /**
   * Reserve credits, run `callback`, then commit what it reports using. If the
   * callback throws, the hold is released and the original error is rethrown.
   *
   * If the process dies mid-callback, the server's TTL reaper returns the hold
   * after `ttlSeconds`, so credits are never stranded.
   *
   * If the cost goes over the hold and the balance cannot cover the rest, the
   * hold itself is charged and the shortfall is in `uncoveredCredits`. If the
   * callback outlives `ttlSeconds`, the hold is gone and the commit throws
   * (`reservation_not_pending`): nothing was charged, so don't deliver.
   *
   * @throws InsufficientCreditsError when the reservation is denied.
   */
  async withCreditHold<T = undefined>(
    options: CreditHoldOptions,
    callback: (hold: CreditHold) => Promise<HoldOutcome<T>> | HoldOutcome<T>,
  ): Promise<CreditHoldResult<T>> {
    const { idempotencyKey, releaseReason, ...reserveParams } = options;
    const reservation = await this.reserve(reserveParams, {
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:reserve` : undefined,
    });
    if (!reservation.allowed) throw insufficientCredits(reservation);

    const { reservationId } = reservation;
    const expiresAt = new Date(reservation.expiresAt);
    const expiry = holdExpiry(reservationId, expiresAt);

    let outcome: HoldOutcome<T>;
    try {
      outcome = await callback({
        reservationId,
        tenantId: options.tenantId,
        feature: options.feature ?? DEFAULT_FEATURE,
        estimateCredits: options.estimateCredits,
        expiresAt,
        signal: expiry.signal,
      });
    } catch (error) {
      expiry.clear();
      await this.#releaseQuietly(options.tenantId, reservationId, releaseReason ?? errorReason(error));
      throw error;
    }
    expiry.clear();

    const normalized = typeof outcome === "number" ? { cost: outcome } : outcome;
    const cost = normalized?.cost;
    if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0) {
      await this.#releaseQuietly(options.tenantId, reservationId, "invalid_cost_reported");
      throw new TypeError(
        `withCreditHold: callback must return a non-negative integer cost, got ${String(cost)}`,
      );
    }

    const metadata = typeof outcome === "number" ? undefined : outcome.metadata;
    let commit: CommitResult;
    let uncoveredCredits = 0;
    try {
      commit = await this.commit(
        { tenantId: options.tenantId, reservationId, actualCreditsUsed: cost, metadata },
        { idempotencyKey: `${reservationId}:commit` },
      );
    } catch (error) {
      // The work is done but the balance cannot cover what it used beyond
      // the hold. Charging nothing would hand it out free, so charge the
      // hold (always covered) and report the rest.
      if (!(error instanceof InsufficientCreditsError) || cost <= options.estimateCredits) throw error;
      commit = await this.commit(
        { tenantId: options.tenantId, reservationId, actualCreditsUsed: options.estimateCredits, metadata },
        { idempotencyKey: `${reservationId}:commit-held` },
      );
      uncoveredCredits = cost - options.estimateCredits;
    }
    return {
      result: typeof outcome === "number" ? undefined : outcome.result,
      cost,
      uncoveredCredits,
      reservation,
      commit,
    };
  }

  /**
   * Charge a tenant for one item once, however many times it is asked for:
   * reserve `credits`, run `callback` to produce the item, then commit. If
   * the tenant has paid for `itemKey` before, `callback` runs with
   * `alreadyCharged: true` and nothing is charged, so a customer whose own
   * code crashed after getting the item can fetch it again for free.
   *
   * None of this lets an end user get an item without paying:
   * - It counts as paid only once the commit succeeds. If `callback` throws,
   *   returns `noCharge(...)`, or outlives the hold's TTL, nothing is paid and
   *   the next request charges again.
   * - Requests racing for the same item cannot all get it free or all pay:
   *   one holds the charge and the others wait for it (up to `waitMs`), then
   *   get the item as already paid, or charge it themselves if that attempt
   *   failed. After `waitMs` this throws `TokenLedgerApiError` with code
   *   `item_charge_in_progress`.
   * - Owned items are per tenant. An item is (feature, itemKey): the same key
   *   under another feature is a different item and is charged separately.
   *
   * Owned items last forever unless the account sets `itemRetentionDays`
   * (see `updateSettings`); after that many days the item is charged again.
   *
   * Hand the result to your user only after this resolves, not from inside
   * `callback`: if the commit fails, this throws and nothing was paid.
   *
   * Items bought before you moved to TokenLedger are charged again, unless
   * you import them with `importTenants` (optional).
   *
   * @throws InsufficientCreditsError when the tenant cannot cover `credits`.
   */
  chargeOnce<T>(options: ChargeOnceOptions, callback: ChargeOnceCallback<T>): Promise<ChargeOnceResult<T>>;
  /**
   * Charge a tenant `credits` for an item the first time they get it; every
   * time after that it's free. `produce` makes the item; you get back what it
   * returns. Return `noCharge(value)` from it to deliver without billing.
   *
   * @example
   * const email = await ledger.chargeOnce("cus_123", `email:${personId}`, 1, () => lookUpEmail(personId));
   * @throws InsufficientCreditsError when the tenant cannot pay for it.
   */
  chargeOnce<T>(
    tenantId: string,
    itemKey: string,
    credits: number,
    produce: ChargeOnceCallback<T>,
    options?: SimpleChargeOnceOptions,
  ): Promise<T>;
  async chargeOnce<T>(
    first: string | ChargeOnceOptions,
    second: string | ChargeOnceCallback<T>,
    credits?: number,
    produce?: ChargeOnceCallback<T>,
    options: SimpleChargeOnceOptions = {},
  ): Promise<T | ChargeOnceResult<T>> {
    if (typeof first === "string") {
      if (typeof second !== "string" || typeof credits !== "number" || typeof produce !== "function") {
        throw new TypeError("chargeOnce: call it as chargeOnce(tenantId, itemKey, credits, produce)");
      }
      const { result } = await this.#chargeOnce({ ...options, tenantId: first, itemKey: second, credits }, produce);
      return result;
    }
    if (typeof second !== "function") throw new TypeError("chargeOnce: the second argument must be a function");
    return this.#chargeOnce(first, second);
  }

  async #chargeOnce<T>(options: ChargeOnceOptions, callback: ChargeOnceCallback<T>): Promise<ChargeOnceResult<T>> {
    const { tenantId, itemKey, credits } = options;
    const feature = options.feature ?? DEFAULT_FEATURE;
    if (!Number.isSafeInteger(credits) || credits <= 0) {
      throw new TypeError(`chargeOnce: credits must be a positive integer, got ${String(credits)}`);
    }
    const reservation = await this.#reserveItem({ ...options, feature });
    const { reservationId } = reservation;

    if (reservation.alreadyCharged) {
      const outcome = await callback({
        tenantId,
        itemKey,
        feature,
        alreadyCharged: true,
        reservationId,
        signal: new AbortController().signal,
      });
      return {
        result: outcome instanceof NoCharge ? outcome.result : outcome,
        charged: false,
        alreadyCharged: true,
        creditsCharged: 0,
        reservationId,
      };
    }

    if (reservationId === null) throw new TokenLedgerApiError(200, { error: "unexpected_response", message: "no reservation id for a new hold" });
    const expiry = holdExpiry(reservationId, new Date(reservation.expiresAt));
    let outcome: T | NoCharge<T>;
    try {
      outcome = await callback({ tenantId, itemKey, feature, alreadyCharged: false, reservationId, signal: expiry.signal });
    } catch (error) {
      expiry.clear();
      await this.#releaseQuietly(tenantId, reservationId, options.releaseReason ?? errorReason(error));
      throw error;
    }
    expiry.clear();

    if (outcome instanceof NoCharge) {
      await this.#releaseQuietly(tenantId, reservationId, "not_charged");
      return { result: outcome.result, charged: false, alreadyCharged: false, creditsCharged: 0, reservationId };
    }
    const commit = await this.commit(
      { tenantId, reservationId, actualCreditsUsed: credits },
      { idempotencyKey: `${reservationId}:commit` },
    );
    return { result: outcome, charged: true, alreadyCharged: false, creditsCharged: credits, reservationId, commit };
  }

  /**
   * Optional: move customers over from another billing system. Nothing else
   * in the SDK needs it; `chargeOnce` works the same with or without an
   * import. Per customer, import their balance, what they already bought, or
   * both.
   *
   * Any number of customers can be passed. They are sent 100 per request
   * (and at most 5 000 purchases per request; a customer with more is spread
   * over follow-up requests). Imports do not count toward the account's
   * request limits.
   *
   * Safe to rerun, at any time: with the same `importId` and data, customers
   * already imported are skipped (`replayed`), so a crash halfway costs
   * nothing.
   * A customer whose data changed since is refused (`idempotency_key_mismatch`)
   * rather than imported twice. Customers that fail are reported, not thrown,
   * and do not stop the rest; fix them and rerun with the same `importId`.
   *
   * Switch a customer over only after they are imported, and stop spending in
   * the old system first, or their credits could be spent in both.
   */
  async importTenants(tenants: ImportTenant[], options: ImportOptions): Promise<ImportResult> {
    const { importId } = options;
    if (!importId || !/^[\x21-\x7e]{1,200}$/.test(importId)) {
      throw new TypeError("importTenants: importId must be 1-200 visible ASCII characters");
    }
    const seen = new Set<string>();
    for (const t of tenants) {
      if (!t.tenantId) throw new TypeError("importTenants: every tenant needs a tenantId");
      if (seen.has(t.tenantId)) throw new TypeError(`importTenants: tenant ${t.tenantId} appears twice`);
      seen.add(t.tenantId);
      if (!t.credits?.length && !t.purchases?.length) {
        throw new TypeError(`importTenants: tenant ${t.tenantId} has neither credits nor purchases`);
      }
      // Checked up front so a bad row fails before anything is sent, not halfway.
      for (const c of t.credits ?? []) {
        if (!Number.isSafeInteger(c.amount) || c.amount <= 0) {
          throw new TypeError(`importTenants: tenant ${t.tenantId} has a credit amount that is not a positive integer`);
        }
      }
      const items = new Set<string>();
      for (const p of t.purchases ?? []) {
        if (!p.itemKey || p.feature === "" || !Number.isSafeInteger(p.credits) || p.credits <= 0) {
          throw new TypeError(`importTenants: tenant ${t.tenantId} has a purchase without itemKey or positive credits, or with an empty feature`);
        }
        const feature = p.feature ?? DEFAULT_FEATURE;
        const item = JSON.stringify([feature, p.itemKey]);
        if (items.has(item)) throw new TypeError(`importTenants: tenant ${t.tenantId} has item ${p.itemKey} (${feature}) twice`);
        items.add(item);
      }
    }

    // Each tenant becomes one or more parts: part 0 carries its credits and
    // first purchases, further parts the rest. Parts depend only on the
    // tenant's own data, and part n is always sent under the same key, so a
    // rerun with the same input replays instead of importing again.
    const parts: Json[][] = [];
    tenants.forEach((t) => {
      const purchases = (t.purchases ?? []).map((p) => ({
        item_key: p.itemKey,
        feature: p.feature ?? DEFAULT_FEATURE,
        credits: p.credits,
        purchased_at: toIso(p.purchasedAt),
      }));
      const chunks: (typeof purchases)[] = [];
      for (let i = 0; i < purchases.length; i += IMPORT_PURCHASES_PER_CALL) {
        chunks.push(purchases.slice(i, i + IMPORT_PURCHASES_PER_CALL));
      }
      const credits = (t.credits ?? []).map((c) => ({ amount: c.amount, expires_at: toIso(c.expiresAt), reason: c.reason }));
      const count = Math.max(1, chunks.length);
      for (let n = 0; n < count; n++) {
        const entry: Json = { tenant_id: t.tenantId };
        if (n === 0 && credits.length) entry.credits = credits.map(stripUndefined);
        if (chunks[n]?.length) entry.purchases = chunks[n]!.map(stripUndefined);
        (parts[n] ??= []).push(entry);
      }
    });

    const results = new Map<string, ImportTenantResult>();
    let done = 0;
    for (const [n, entries] of parts.entries()) {
      const key = n === 0 ? importId : `${importId}:part${n + 1}`;
      // A tenant whose earlier part failed is not continued.
      const pending = entries.filter((e) => results.get(str(e.tenant_id))?.status !== "failed");
      for (const batch of batches(pending)) {
        let list: Json[];
        try {
          const { body } = await this.#request("POST", "/v1/import", { tenants: batch }, key, options.signal, [], 300_000);
          list = Array.isArray(body.results) ? body.results.filter(isRecord) : [];
        } catch (error) {
          if (options.signal?.aborted) throw error;
          // Retries are already spent. Report this request's tenants as
          // failed and carry on; a rerun with the same importId replays what
          // went through and retries the rest.
          const code = error instanceof TokenLedgerApiError ? error.code : "network_error";
          const message = error instanceof Error ? error.message : String(error);
          list = batch.map((e) => ({ tenant_id: e.tenant_id, status: "failed", error: code, message }));
        }
        for (const raw of list) mergeImportResult(results, raw);
        if (n === 0) {
          done += batch.length;
          options.onProgress?.({ tenantsDone: done, tenantsTotal: tenants.length });
        }
      }
    }

    const ordered = tenants.map(
      (t) =>
        results.get(t.tenantId) ?? {
          tenantId: t.tenantId,
          status: "failed" as const,
          grantedCredits: 0,
          purchasesImported: 0,
          purchasesSkipped: 0,
          skippedItemKeys: [],
          error: "no_result",
          message: "the server returned no result for this tenant",
        },
    );
    return {
      imported: ordered.filter((r) => r.status === "imported").length,
      replayed: ordered.filter((r) => r.status === "replayed").length,
      failed: ordered.filter((r) => r.status === "failed").length,
      tenants: ordered,
    };
  }

  /** The account's settings (see `updateSettings`). */
  async getSettings(options: Pick<RequestOptions, "signal"> = {}): Promise<AccountSettings> {
    const { body } = await this.#request("GET", "/v1/settings", undefined, undefined, options.signal, []);
    return toSettings(body);
  }

  /**
   * Change the account's settings. `{ itemRetentionDays: 90 }` makes owned
   * items expire 90 days after they were bought, so a tenant pays again for
   * an item after that (for data that goes stale, say); `null` keeps them
   * owned for good. Takes effect at once for every tenant of the account.
   */
  async updateSettings(settings: AccountSettings, options: Pick<RequestOptions, "signal"> = {}): Promise<AccountSettings> {
    const days = settings.itemRetentionDays;
    if (days !== null && (!Number.isSafeInteger(days) || days < 1)) {
      throw new TypeError("updateSettings: itemRetentionDays must be a positive whole number of days, or null");
    }
    const { body } = await this.#request(
      "PATCH",
      "/v1/settings",
      { item_retention_days: days },
      undefined,
      options.signal,
      [],
    );
    return toSettings(body);
  }

  /**
   * The hourly limit as of the most recent response, or `undefined` if the
   * account has no hourly limit (or no request has completed yet). Check
   * `graceEndsAt` to warn before the grace period runs out.
   */
  get rateLimit(): RateLimitInfo | undefined {
    return this.#rateLimit;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #releaseQuietly(tenantId: string, reservationId: string, reason: string): Promise<void> {
    try {
      await this.release(
        { tenantId, reservationId, reason },
        { idempotencyKey: `${reservationId}:release` },
      );
    } catch {
      // Best effort: the caller's original error matters more, and the
      // server's TTL reaper returns the hold if this release never lands.
    }
  }

  /**
   * Reserve for an item, waiting while another request is charging it. One
   * idempotency key covers every attempt: `item_charge_in_progress` is not
   * stored for replay, so each retry is decided afresh, and if a response is
   * lost after the server made the hold, the retry gets that same hold back.
   */
  async #reserveItem(
    options: ChargeOnceOptions,
  ): Promise<{ alreadyCharged: boolean; reservationId: string | null; expiresAt: string }> {
    const idempotencyKey = globalThis.crypto.randomUUID();
    const deadline = Date.now() + (options.waitMs ?? 10_000);
    const payload = {
      tenant_id: options.tenantId,
      feature: options.feature ?? DEFAULT_FEATURE,
      estimate_credits: options.credits,
      ttl_seconds: options.ttlSeconds,
      metadata: options.metadata ?? {},
      item_key: options.itemKey,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const { status, body } = await this.#post("/v1/credits/reserve", payload, { idempotencyKey }, [402]);
        if (status === 402) throw new InsufficientCreditsError(body);
        // A server without item charges would ignore item_key and charge
        // every time; refuse rather than double-charge silently.
        if (body.item_key !== options.itemKey || typeof body.already_charged !== "boolean") {
          throw new TokenLedgerApiError(status, {
            error: "item_charges_unsupported",
            message: "the server did not confirm the item charge; it may predate chargeOnce",
          });
        }
        return {
          alreadyCharged: body.already_charged,
          reservationId: typeof body.reservation_id === "string" ? body.reservation_id : null,
          expiresAt: str(body.expires_at),
        };
      } catch (error) {
        if (!(error instanceof TokenLedgerApiError) || error.code !== "item_charge_in_progress") throw error;
        const wait = Math.min(250 * 2 ** attempt, 2_000, deadline - Date.now());
        if (wait <= 0) throw error;
        await this.#sleep(wait, undefined);
      }
    }
  }

  #post(path: string, payload: Json, options: RequestOptions, accept: number[] = []): Promise<RawResponse> {
    const key = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    return this.#request("POST", path, stripUndefined(payload), key, options.signal, accept);
  }

  async #request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload: Json | undefined,
    idempotencyKey: string | undefined,
    signal: AbortSignal | undefined,
    accept: number[],
    timeoutMs: number = this.#timeoutMs,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { accept: "application/json", ...this.#headers };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error("request timed out")), Math.max(timeoutMs, this.#timeoutMs));
      const onAbort = () => timeout.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      // The timeout covers the whole exchange, reading the body included: a
      // server that sends headers and then stalls must not hang the caller.
      let response: Response;
      let text: string;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: timeout.signal,
        });
        if (response.status >= 500 && attempt < this.#maxRetries) {
          await response.body?.cancel();
          await this.#backoff(attempt, signal);
          continue;
        }
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        // Safe to retry even if the server acted on it: the same
        // Idempotency-Key replays the stored answer.
        if (attempt < this.#maxRetries) {
          await this.#backoff(attempt, signal);
          continue;
        }
        throw new TokenLedgerNetworkError(`TokenLedger request failed: ${method} ${path}`, { cause: error });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      const rateLimit = parseRateLimit(response.headers);
      this.#rateLimit = rateLimit;
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: `http_${response.status}`, message: text.slice(0, 200) };
        }
      }
      const json: Json = isRecord(parsed) ? parsed : {};
      if (response.ok || accept.includes(response.status)) {
        return { status: response.status, body: json };
      }
      const retryAfter = Number(response.headers.get("retry-after")) || undefined;
      // Per-second rate limits clear quickly; hourly and monthly limits do not.
      if (response.status === 429 && json.error === "rate_limited" && attempt < this.#maxRetries) {
        await this.#sleep(Math.min((retryAfter ?? 1) * 1000, 30_000), signal);
        continue;
      }
      if (response.status === 402) throw new InsufficientCreditsError(json);
      throw new TokenLedgerApiError(response.status, json, retryAfter, rateLimit);
    }
  }

  #backoff(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    return this.#sleep(this.#retryDelayMs * 2 ** attempt * (0.5 + Math.random()), signal);
  }

  #sleep(delay: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insufficientCredits(denied: ReserveDenied): InsufficientCreditsError {
  return new InsufficientCreditsError({
    error: denied.error,
    message: `tenant has ${denied.availableCredits} credits, ${denied.requestedCredits} requested`,
    available_credits: denied.availableCredits,
    requested_credits: denied.requestedCredits,
  });
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined(payload: Json): Json {
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toSettings(body: Json): AccountSettings {
  return { itemRetentionDays: typeof body.item_retention_days === "number" ? body.item_retention_days : null };
}

function toIso(value: Date | string | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

/** Pack import entries into requests of at most 100 tenants and 5 000 purchases. */
function batches(entries: Json[]): Json[][] {
  const out: Json[][] = [];
  let current: Json[] = [];
  let purchases = 0;
  for (const entry of entries) {
    const n = Array.isArray(entry.purchases) ? entry.purchases.length : 0;
    if (current.length && (current.length >= IMPORT_TENANTS_PER_CALL || purchases + n > IMPORT_PURCHASES_PER_CALL)) {
      out.push(current);
      current = [];
      purchases = 0;
    }
    current.push(entry);
    purchases += n;
  }
  if (current.length) out.push(current);
  return out;
}

/** Fold one part's server result into the tenant's overall result. */
function mergeImportResult(results: Map<string, ImportTenantResult>, raw: Json): void {
  const tenantId = str(raw.tenant_id);
  const status = raw.status === "failed" ? "failed" : raw.status === "replayed" ? "replayed" : "imported";
  const prev = results.get(tenantId);
  const skipped = Array.isArray(raw.skipped_item_keys) ? raw.skipped_item_keys.map(str) : [];
  const merged: ImportTenantResult = {
    tenantId,
    // Failed beats imported beats replayed: "replayed" only if every part was.
    status:
      prev?.status === "failed" || status === "failed"
        ? "failed"
        : prev?.status === "imported" || status === "imported"
          ? "imported"
          : "replayed",
    grantedCredits: (prev?.grantedCredits ?? 0) + num(raw.granted_credits ?? 0),
    purchasesImported: (prev?.purchasesImported ?? 0) + num(raw.purchases_imported ?? 0),
    purchasesSkipped: (prev?.purchasesSkipped ?? 0) + num(raw.purchases_skipped ?? 0),
    skippedItemKeys: [...(prev?.skippedItemKeys ?? []), ...skipped],
  };
  const available = typeof raw.available_credits === "number" ? raw.available_credits : prev?.availableCredits;
  if (available !== undefined) merged.availableCredits = available;
  const error = typeof raw.error === "string" ? raw.error : prev?.error;
  if (error !== undefined) merged.error = error;
  const message = typeof raw.message === "string" ? raw.message : prev?.message;
  if (message !== undefined) merged.message = message;
  results.set(tenantId, merged);
}

/** An AbortSignal that fires when a hold's TTL elapses. */
function holdExpiry(reservationId: string, expiresAt: Date): { signal: AbortSignal; clear: () => void } {
  const expiry = new AbortController();
  // Not unref'd on purpose: it only lives while the callback runs, and a
  // callback that is just waiting on the signal must still see the abort.
  const timer = setTimeout(
    () => expiry.abort(new Error(`credit hold ${reservationId} expired`)),
    Math.max(0, expiresAt.getTime() - Date.now()),
  );
  return { signal: expiry.signal, clear: () => clearTimeout(timer) };
}

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `callback_failed: ${message}`.slice(0, 1_000);
}

function toLedgerEntry(raw: Json): LedgerEntry {
  return {
    id: str(raw.id),
    tenantId: str(raw.tenant_id),
    reservationId: typeof raw.reservation_id === "string" ? raw.reservation_id : null,
    bucketId: typeof raw.bucket_id === "string" ? raw.bucket_id : null,
    entryType: str(raw.entry_type) as LedgerEntryType,
    deltaAvailable: num(raw.delta_available),
    deltaReserved: num(raw.delta_reserved),
    balanceAvailableAfter: num(raw.balance_available_after),
    balanceReservedAfter: num(raw.balance_reserved_after),
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    feature: typeof raw.feature === "string" ? raw.feature : null,
    buckets: (Array.isArray(raw.buckets) ? raw.buckets : [])
      .filter(isRecord)
      .map((b) => ({ bucketId: str(b.bucket_id), amount: num(b.amount) })),
    createdAt: str(raw.created_at),
  };
}

function toCreditBucket(raw: Json): CreditBucket {
  return {
    id: str(raw.id),
    granted: num(raw.granted),
    remaining: num(raw.remaining),
    expiresAt: str(raw.expires_at),
    reason: typeof raw.reason === "string" ? raw.reason : null,
    createdAt: str(raw.created_at),
  };
}

// ---------------------------------------------------------------------------
// Old names, kept so existing code keeps working
// ---------------------------------------------------------------------------

/** @deprecated Renamed to `TokenLedgerClient`. */
export const VaultClient = TokenLedgerClient;
/** @deprecated Renamed to `TokenLedgerClient`. */
export type VaultClient = TokenLedgerClient;
/** @deprecated Renamed to `TokenLedgerClientOptions`. */
export type VaultClientOptions = TokenLedgerClientOptions;
/** @deprecated Renamed to `TokenLedgerApiError`. */
export const VaultApiError = TokenLedgerApiError;
/** @deprecated Renamed to `TokenLedgerApiError`. */
export type VaultApiError = TokenLedgerApiError;
/** @deprecated Renamed to `TokenLedgerNetworkError`. */
export const VaultNetworkError = TokenLedgerNetworkError;
/** @deprecated Renamed to `TokenLedgerNetworkError`. */
export type VaultNetworkError = TokenLedgerNetworkError;
