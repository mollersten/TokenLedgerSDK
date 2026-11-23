// End-to-end checks of TokenLedgerClient.chargeOnce against a running TokenLedger.
// Start a local server on the local database (never the real one):
//   (cd ../backend && BIND_ADDR=127.0.0.1:8080 scripts/with-local-db.sh cargo run --bin backend)
// and give it a key for an account without request limits (admin create-account
// --plan paid --hourly-requests unlimited --monthly-requests unlimited --rate-limit unlimited).
// usage: TL_BASE_URL=http://127.0.0.1:8080 TL_KEY_FILE=path/to/key node test/charge-once.e2e.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  InsufficientCreditsError,
  VaultClient,
  TokenLedgerApiError,
  TokenLedgerClient,
  noCharge,
} from "../index.ts";

// These checks create accounts' data. Refuse anything but a local server
// unless explicitly told otherwise.
{
  const host = new URL(process.env.TL_BASE_URL ?? "http://127.0.0.1:8080").hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) && process.env.TL_ALLOW_REMOTE !== "1") {
    console.error(`refusing to run against ${host}: point TL_BASE_URL at a local server (or set TL_ALLOW_REMOTE=1)`);
    process.exit(2);
  }
}

const apiKey = readFileSync(process.env.TL_KEY_FILE!, "utf8").trim();
const baseUrl = process.env.TL_BASE_URL ?? "http://127.0.0.1:8080";
const client = () => new TokenLedgerClient({ baseUrl, apiKey }); // a fresh client = a fresh process
const run = Date.now().toString(36);
const tenant = `e2e_${run}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const available = async (t = tenant) => (await client().getWallet(t)).availableCredits;

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await client().grant({ tenantId: tenant, amount: 100 });
const opts = (itemKey: string, extra = {}) => ({ tenantId: tenant, itemKey, feature: "email_lookup", credits: 5, ...extra });

await check("charges the first time", async () => {
  let sawAlreadyCharged: boolean | undefined;
  const r = await client().chargeOnce(opts("email:a"), (item) => {
    sawAlreadyCharged = item.alreadyCharged;
    return "a@example.test";
  });
  assert.equal(sawAlreadyCharged, false);
  assert.equal(r.charged, true);
  assert.equal(r.creditsCharged, 5);
  assert.equal(r.result, "a@example.test");
  assert.equal(await available(), 95);
});

await check("a new process asking again is not charged", async () => {
  const r = await client().chargeOnce(opts("email:a"), (item) => (item.alreadyCharged ? "from cache" : "fresh"));
  assert.equal(r.alreadyCharged, true);
  assert.equal(r.charged, false);
  assert.equal(r.creditsCharged, 0);
  assert.equal(r.result, "from cache");
  assert.equal(await available(), 95);
});

await check("a callback that throws charges nothing and the retry pays", async () => {
  await assert.rejects(
    client().chargeOnce(opts("email:b"), () => {
      throw new Error("upstream failed");
    }),
    /upstream failed/,
  );
  assert.equal(await available(), 95);
  const r = await client().chargeOnce(opts("email:b"), () => "b@example.test");
  assert.equal(r.charged, true, "a failed attempt must not unlock the item");
  assert.equal(await available(), 90);
});

await check("noCharge delivers without billing and leaves the item unpaid", async () => {
  const none = await client().chargeOnce(opts("email:c"), () => noCharge(null));
  assert.equal(none.charged, false);
  assert.equal(none.alreadyCharged, false);
  assert.equal(none.result, null);
  assert.equal(await available(), 90);
  const later = await client().chargeOnce(opts("email:c"), () => "c@example.test");
  assert.equal(later.charged, true, "noCharge must not mark the item paid");
  assert.equal(await available(), 85);
});

await check("10 racing requests for one item pay once", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      client().chargeOnce(opts("email:d"), async () => {
        await sleep(300);
        return "d@example.test";
      }),
    ),
  );
  assert.equal(results.filter((r) => r.charged).length, 1);
  assert.equal(results.filter((r) => r.alreadyCharged).length, 9);
  assert.ok(results.every((r) => r.result === "d@example.test"));
  assert.equal(await available(), 80);
});

await check("racing requests whose first attempt fails still pay once", async () => {
  let first = true;
  const settled = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      client().chargeOnce(opts("email:e"), async () => {
        await sleep(200);
        if (first) {
          first = false;
          throw new Error("first attempt fails");
        }
        return "e@example.test";
      }),
    ),
  );
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<any>).value);
  assert.equal(settled.filter((s) => s.status === "rejected").length, 1);
  assert.equal(ok.filter((r) => r.charged).length, 1, "exactly one of the others pays");
  assert.equal(ok.filter((r) => r.alreadyCharged).length, 3);
  assert.equal(await available(), 75);
});

await check("gives up with item_charge_in_progress after waitMs", async () => {
  const slow = client().chargeOnce(opts("email:f"), async () => {
    await sleep(1_500);
    return "f";
  });
  await sleep(100);
  await assert.rejects(
    client().chargeOnce(opts("email:f", { waitMs: 300 }), () => "f"),
    (e: unknown) => e instanceof TokenLedgerApiError && e.code === "item_charge_in_progress" && e.status === 409,
  );
  assert.equal((await slow).charged, true);
  assert.equal(await available(), 70);
});

await check("the same key under another feature is a different item, charged separately", async () => {
  const r = await client().chargeOnce({ ...opts("email:a"), feature: "phone_lookup", credits: 20 }, () => "phone");
  assert.equal(r.charged, true);
  assert.equal(r.creditsCharged, 20);
  assert.equal(await available(), 50);
  await client().grant({ tenantId: tenant, amount: 20 });
});

await check("work that outlives the hold is not delivered and not paid", async () => {
  let aborted = false;
  await assert.rejects(
    client().chargeOnce(opts("email:g", { ttlSeconds: 1 }), async (item) => {
      item.signal.addEventListener("abort", () => (aborted = true));
      await sleep(2_200);
      return "g";
    }),
    (e: unknown) => e instanceof TokenLedgerApiError && e.code === "reservation_not_pending",
  );
  assert.equal(aborted, true, "the callback's signal fires at the TTL");
  assert.equal(await available(), 70);
  const retry = await client().chargeOnce(opts("email:g"), () => "g");
  assert.equal(retry.charged, true);
  assert.equal(await available(), 65);
});

await check("another tenant pays for the same item", async () => {
  const other = `${tenant}_b`;
  await client().grant({ tenantId: other, amount: 10 });
  const r = await client().chargeOnce({ ...opts("email:a"), tenantId: other }, () => "a");
  assert.equal(r.charged, true);
  assert.equal(await available(other), 5);
});

await check("too few credits throws InsufficientCreditsError", async () => {
  const poor = `${tenant}_poor`;
  await client().grant({ tenantId: poor, amount: 2 });
  await assert.rejects(
    client().chargeOnce({ ...opts("email:h"), tenantId: poor }, () => "h"),
    (e: unknown) => e instanceof InsufficientCreditsError,
  );
  assert.equal(await available(poor), 2);
});

await check("credits must be a positive integer", async () => {
  for (const credits of [0, -1, 1.5]) {
    await assert.rejects(client().chargeOnce({ ...opts("email:z"), credits }, () => "z"), TypeError);
  }
});

await check("withCreditHold charges the hold when the balance can't cover the overage", async () => {
  const short = `${tenant}_short`;
  await client().grant({ tenantId: short, amount: 10 });
  const r = await client().withCreditHold({ tenantId: short, feature: "report", estimateCredits: 5 }, () => 50);
  assert.equal(r.cost, 50);
  assert.equal(r.uncoveredCredits, 45);
  assert.equal(r.commit.committedAmount, 5);
  assert.equal(await available(short), 5);
});

await check("updateSettings sets how long owned items last", async () => {
  assert.deepEqual(await client().getSettings(), { itemRetentionDays: null });
  assert.deepEqual(await client().updateSettings({ itemRetentionDays: 90 }), { itemRetentionDays: 90 });
  assert.deepEqual(await client().getSettings(), { itemRetentionDays: 90 });
  assert.deepEqual(await client().updateSettings({ itemRetentionDays: null }), { itemRetentionDays: null });
  await assert.rejects(client().updateSettings({ itemRetentionDays: 0 }), TypeError);
});

await check("the old Vault* names still work", async () => {
  const legacy = new VaultClient({ baseUrl, apiKey });
  assert.ok(legacy instanceof TokenLedgerClient);
  assert.equal((await legacy.getWallet(tenant)).tenantId, tenant);
});

const wallet = await client().getWallet(tenant);
assert.equal(wallet.reservedCredits, 0, "no holds left behind");
console.log(`\n${passed} checks passed; tenant ${tenant} ends with ${wallet.availableCredits} available`);
