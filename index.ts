/**
 * TokenLedger TypeScript SDK.
 *
 * Zero runtime dependencies: uses the platform's `fetch`, `AbortController`
 * and `crypto.randomUUID` (Node 19+, Deno, Bun, modern browsers).
 *
 * Every mutating call sends an `Idempotency-Key`. Network failures and 5xx
 * responses are retried with the *same* key, so a retry can never charge a
 * tenant twice: the server replays the original response instead.
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

export interface VaultClientOptions {
  /** API base URL, e.g. `https://api.tokenledger.example`. */
  baseUrl: string;
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
  /** Supply your own key to make a call idempotent across process restarts. */
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
  feature: string;
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
  metadata: Metadata;
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
  cost: number;
  reservation: ReserveAllowed;
  commit: CommitResult;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The API answered with an error status. Notable codes: `invalid_api_key`
 * (401), `account_suspended` / `trial_expired` / `tenant_limit_reached` (403),
 * `rate_limited` / `monthly_quota_exceeded` (429).
 */
export class VaultApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  /** From the `Retry-After` header on 429 responses. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: unknown, retryAfterSeconds?: number) {
    const record = isRecord(body) ? body : {};
    const code = typeof record.error === "string" ? record.error : `http_${status}`;
    const detail = typeof record.message === "string" ? `: ${record.message}` : "";
    super(`TokenLedger API ${status} ${code}${detail}`);
    this.name = "VaultApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The tenant cannot cover the requested credits (HTTP 402). */
export class InsufficientCreditsError extends VaultApiError {
  readonly availableCredits: number;

  constructor(body: unknown) {
    super(402, body);
    this.name = "InsufficientCreditsError";
    const record = isRecord(body) ? body : {};
    this.availableCredits = typeof record.available_credits === "number" ? record.available_credits : 0;
  }
}

/** The request never produced an HTTP response (after all retries). */
export class VaultNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface RawResponse {
  status: number;
  body: Json;
}

export class VaultClient {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;

  constructor(options: VaultClientOptions) {
    if (!options.baseUrl) throw new TypeError("VaultClient: baseUrl is required");
    if (!options.apiKey) throw new TypeError("VaultClient: apiKey is required");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("VaultClient: no fetch implementation available; pass options.fetch");
    }
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#headers = { ...options.headers, authorization: `Bearer ${options.apiKey}` };
    this.#fetch = fetchImpl;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.#retryDelayMs = options.retryDelayMs ?? 200;
  }

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
        feature: params.feature,
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
    if (!reservation.allowed) {
      throw new InsufficientCreditsError({
        error: reservation.error,
        message: `tenant has ${reservation.availableCredits} credits, ${reservation.requestedCredits} requested`,
        available_credits: reservation.availableCredits,
        requested_credits: reservation.requestedCredits,
      });
    }

    const { reservationId } = reservation;
    const expiresAt = new Date(reservation.expiresAt);
    const expiry = new AbortController();
    // Not unref'd on purpose: it only lives while the callback runs, and a
    // callback that is just waiting on `hold.signal` must still see the abort.
    const timer = setTimeout(
      () => expiry.abort(new Error(`credit hold ${reservationId} expired`)),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );

    let outcome: HoldOutcome<T>;
    try {
      outcome = await callback({
        reservationId,
        tenantId: options.tenantId,
        feature: options.feature,
        estimateCredits: options.estimateCredits,
        expiresAt,
        signal: expiry.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      await this.#releaseQuietly(options.tenantId, reservationId, releaseReason ?? errorReason(error));
      throw error;
    }
    clearTimeout(timer);

    const normalized = typeof outcome === "number" ? { cost: outcome } : outcome;
    const cost = normalized?.cost;
    if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0) {
      await this.#releaseQuietly(options.tenantId, reservationId, "invalid_cost_reported");
      throw new TypeError(
        `withCreditHold: callback must return a non-negative integer cost, got ${String(cost)}`,
      );
    }

    const commit = await this.commit(
      {
        tenantId: options.tenantId,
        reservationId,
        actualCreditsUsed: cost,
        metadata: typeof outcome === "number" ? undefined : outcome.metadata,
      },
      { idempotencyKey: `${reservationId}:commit` },
    );
    return {
      result: typeof outcome === "number" ? undefined : outcome.result,
      cost,
      reservation,
      commit,
    };
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

  #post(path: string, payload: Json, options: RequestOptions, accept: number[] = []): Promise<RawResponse> {
    const key = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    return this.#request("POST", path, stripUndefined(payload), key, options.signal, accept);
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    payload: Json | undefined,
    idempotencyKey: string | undefined,
    signal: AbortSignal | undefined,
    accept: number[],
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { accept: "application/json", ...this.#headers };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error("request timed out")), this.#timeoutMs);
      const onAbort = () => timeout.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: timeout.signal,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < this.#maxRetries) {
          await this.#backoff(attempt, signal);
          continue;
        }
        throw new VaultNetworkError(`TokenLedger request failed: ${method} ${path}`, { cause: error });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      if (response.status >= 500 && attempt < this.#maxRetries) {
        await response.body?.cancel();
        await this.#backoff(attempt, signal);
        continue;
      }

      const text = await response.text();
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
      // Per-second rate limits clear quickly; monthly quotas do not.
      if (response.status === 429 && json.error === "rate_limited" && attempt < this.#maxRetries) {
        await this.#sleep(Math.min((retryAfter ?? 1) * 1000, 30_000), signal);
        continue;
      }
      if (response.status === 402) throw new InsufficientCreditsError(json);
      throw new VaultApiError(response.status, json, retryAfter);
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
