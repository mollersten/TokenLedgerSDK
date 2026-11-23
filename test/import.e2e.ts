// End-to-end checks of TokenLedgerClient.importTenants against a running TokenLedger,
// on a fresh free-plan account (120 requests/hour, 10/s), to show imports don't count.
// Start a local server on the local database (never the real one):
//   (cd ../backend && BIND_ADDR=127.0.0.1:8080 scripts/with-local-db.sh cargo run --bin backend)
// usage: TL_BASE_URL=http://127.0.0.1:8080 TL_KEY_FILE=path/to/key node test/import.e2e.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { TokenLedgerClient, type ImportTenant } from "../index.ts";

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
const run = Date.now().toString(36);
const client = new TokenLedgerClient({ baseUrl: process.env.TL_BASE_URL ?? "http://127.0.0.1:8080", apiKey });
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 250 customers: balances, some with an expiring allowance and a few purchases.
const expires = new Date(Date.now() + 20 * 86_400_000);
const customers: ImportTenant[] = Array.from({ length: 250 }, (_, i) => ({
  tenantId: `imp_${run}_${i}`,
  credits: i % 2 ? [{ amount: 100 + i }, { amount: 50, expiresAt: expires, reason: "allowance" }] : [{ amount: 100 + i }],
  purchases: i % 5 === 0 ? [{ itemKey: `email:${i}`, feature: "email_lookup", credits: 1 }] : undefined,
}));

await check("250 customers go out as 3 requests of at most 100", async () => {
  const progress: number[] = [];
  const r = await client.importTenants(customers, {
    importId: `migrate-${run}`,
    onProgress: (p) => progress.push(p.tenantsDone),
  });
  assert.deepEqual(progress, [100, 200, 250]);
  assert.equal(r.imported, 250);
  assert.equal(r.failed, 0);
  assert.equal(r.tenants[3]!.availableCredits, 153, "100 + 3 + 50 expiring");
  assert.equal(r.tenants[5]!.purchasesImported, 1);
});

await check("rerunning the same import replays it and grants nothing", async () => {
  const r = await client.importTenants(customers, { importId: `migrate-${run}` });
  assert.equal(r.replayed, 250);
  assert.equal(r.imported, 0);
  const w = await client.getWallet(customers[3]!.tenantId);
  assert.equal(w.availableCredits, 153);
  assert.equal(w.expiringCredits, 50);
});

const big = `imp_${run}_big`;
const bigPurchases = Array.from({ length: 12_000 }, (_, i) => ({ itemKey: `email:${i}`, feature: "email_lookup", credits: 1 }));

await check("a customer with 12 000 purchases is spread over follow-up requests", async () => {
  const r = await client.importTenants([{ tenantId: big, credits: [{ amount: 1_000 }], purchases: bigPurchases }], {
    importId: `migrate-big-${run}`,
  });
  assert.equal(r.imported, 1, JSON.stringify(r.tenants[0]));
  assert.equal(r.tenants[0]!.purchasesImported, 12_000);
  assert.equal(r.tenants[0]!.grantedCredits, 1_000, "credits granted once, not per part");
  const again = await client.importTenants([{ tenantId: big, credits: [{ amount: 1_000 }], purchases: bigPurchases }], {
    importId: `migrate-big-${run}`,
  });
  assert.equal(again.replayed, 1);
  assert.equal((await client.getWallet(big)).availableCredits, 1_000);
});

await check("chargeOnce treats imported purchases as paid, and charges the rest", async () => {
  const old = await client.chargeOnce({ tenantId: big, itemKey: "email:11999", feature: "email_lookup", credits: 1 }, () => "x");
  assert.equal(old.alreadyCharged, true);
  const fresh = await client.chargeOnce({ tenantId: big, itemKey: "email:12000", feature: "email_lookup", credits: 1 }, () => "y");
  assert.equal(fresh.charged, true);
});

await check("a balance cannot be imported twice; failures are reported, not thrown", async () => {
  const past = new Date(Date.now() - 86_400_000);
  const r = await client.importTenants(
    [
      { tenantId: customers[0]!.tenantId, credits: [{ amount: 999 }] },
      { tenantId: `imp_${run}_expired`, credits: [{ amount: 5, expiresAt: past }] },
      { tenantId: `imp_${run}_new`, credits: [{ amount: 7 }] },
    ],
    { importId: `second-${run}` },
  );
  assert.deepEqual(
    r.tenants.map((t) => [t.status, t.error]),
    [["failed", "credits_already_imported"], ["failed", "invalid_expires_at"], ["imported", undefined]],
  );
  assert.equal((await client.getWallet(customers[0]!.tenantId)).availableCredits, 100);
});

await check("bad input is refused before anything is sent", async () => {
  await assert.rejects(client.importTenants([{ tenantId: "x" }], { importId: "bad" }), TypeError);
  await assert.rejects(client.importTenants([{ tenantId: "x", credits: [{ amount: 0 }] }], { importId: "bad" }), TypeError);
  await assert.rejects(
    client.importTenants([{ tenantId: "x", credits: [{ amount: 1 }] }, { tenantId: "x", credits: [{ amount: 1 }] }], { importId: "bad" }),
    TypeError,
  );
  await assert.rejects(client.importTenants([{ tenantId: "x", credits: [{ amount: 1 }] }], { importId: "" }), TypeError);
});

await check("a customer the server refuses is reported, and the others are imported", async () => {
  const r = await client.importTenants(
    [
      { tenantId: `imp_${run}_ok`, credits: [{ amount: 3 }] },
      { tenantId: `imp_${run}_ctrl`, purchases: [{ itemKey: "bad\nkey", feature: "email_lookup", credits: 1 }] },
    ],
    { importId: `refused-${run}` },
  );
  assert.deepEqual(r.tenants.map((t) => [t.status, t.error]), [["imported", undefined], ["failed", "invalid_item_key"]]);
});

await check("a request that cannot reach the server is reported per customer, not thrown", async () => {
  const offline = new TokenLedgerClient({ baseUrl: "http://127.0.0.1:9", apiKey, maxRetries: 0 });
  const r = await offline.importTenants(customers.slice(0, 150), { importId: `offline-${run}` });
  assert.equal(r.failed, 150);
  assert.ok(r.tenants.every((t) => t.error === "network_error"));
});

await check("none of the import requests counted toward the free plan's 120/hour", async () => {
  // Counted so far: 3 getWallet calls + 2 chargeOnce (reserve + commit for
  // the fresh one, reserve only for the paid one) = 3 + 3 = 6, and this call.
  await client.getWallet(big);
  assert.equal(client.rateLimit?.limit, 120);
  assert.equal(client.rateLimit?.remaining, 120 - 7);
});

console.log(`\n${passed} checks passed`);
