// End-to-end checks of the simple functions (addCredits, charge, getBalance,
// meter, chargeOnce(tenantId, ...), importCustomers) against a running
// TokenLedger. Start a local server on the local database (never the real one):
//   (cd ../backend && BIND_ADDR=127.0.0.1:8080 scripts/with-local-db.sh cargo run --bin backend)
// and give it a key for an account without request limits (admin create-account
// --plan paid --hourly-requests unlimited --monthly-requests unlimited --rate-limit unlimited).
// usage: TL_BASE_URL=http://127.0.0.1:8080 TL_KEY_FILE=path/to/key node test/simple.e2e.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { DEFAULT_FEATURE, InsufficientCreditsError, TokenLedgerClient, noCharge } from "../index.ts";

// These checks create data. Refuse anything but a local server unless told otherwise.
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
const ledger = client();
const run = Date.now().toString(36);
let n = 0;
const customer = () => `simple_${run}_${++n}`;

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- addCredits / getBalance -------------------------------------------------

await check("getBalance is 0 for a customer never given credits", async () => {
  assert.equal(await ledger.getBalance(customer()), 0);
});

await check("addCredits returns the new balance", async () => {
  const c = customer();
  assert.equal(await ledger.addCredits(c, 100), 100);
  assert.equal(await ledger.addCredits(c, 50), 150);
  assert.equal(await ledger.getBalance(c), 150);
});

await check("addCredits with an idempotencyKey adds once, even from a new client", async () => {
  const c = customer();
  assert.equal(await client().addCredits(c, 40, { idempotencyKey: `invoice:${c}` }), 40);
  assert.equal(await client().addCredits(c, 40, { idempotencyKey: `invoice:${c}` }), 40);
  assert.equal(await ledger.getBalance(c), 40);
});

await check("addCredits with expiresAt adds expiring credits", async () => {
  const c = customer();
  await ledger.addCredits(c, 30, { expiresAt: new Date(Date.now() + 86_400_000), reason: "monthly allowance" });
  const wallet = await ledger.getWallet(c);
  assert.equal(wallet.availableCredits, 30);
  assert.equal(wallet.expiringCredits, 30);
});

await check("addCredits refuses a credit amount that is not a positive whole number", async () => {
  await assert.rejects(ledger.addCredits(customer(), 0), TypeError);
  await assert.rejects(ledger.addCredits(customer(), 1.5), TypeError);
});

// --- charge ------------------------------------------------------------------

await check("charge returns the new balance and records the default feature", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  assert.equal(await ledger.charge(c, 5), 95);
  assert.equal(await ledger.charge(c, 10, { feature: "report" }), 85);
  const wallet = await ledger.getWallet(c);
  const commits = wallet.recentLedger.filter((e) => e.entryType === "COMMIT").map((e) => e.feature);
  assert.deepEqual(commits.sort(), [DEFAULT_FEATURE, "report"].sort());
  assert.equal(wallet.reservedCredits, 0, "no hold is left behind");
});

await check("charge throws InsufficientCreditsError and charges nothing when short", async () => {
  const c = customer();
  await ledger.addCredits(c, 3);
  await assert.rejects(ledger.charge(c, 5), (e: unknown) => e instanceof InsufficientCreditsError && e.availableCredits === 3);
  assert.equal(await ledger.getBalance(c), 3);
  await assert.rejects(ledger.charge(customer(), 1), InsufficientCreditsError, "a customer never given credits");
});

await check("charge with an idempotencyKey charges once, even from a new client", async () => {
  const c = customer();
  await ledger.addCredits(c, 20);
  assert.equal(await client().charge(c, 7, { idempotencyKey: `order:${c}` }), 13);
  assert.equal(await client().charge(c, 7, { idempotencyKey: `order:${c}` }), 13);
  assert.equal(await ledger.getBalance(c), 13);
});

// --- meter -------------------------------------------------------------------

await check("meter charges what use() reported and returns work's result", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  const result = await ledger.meter(c, 20, async (use) => {
    use(7);
    return { pages: 3 };
  });
  assert.deepEqual(result, { pages: 3 });
  assert.equal(await ledger.getBalance(c), 93);
});

await check("meter adds up several use() calls", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  await ledger.meter(c, 20, (use) => {
    use(3);
    use(4);
  });
  assert.equal(await ledger.getBalance(c), 93);
});

await check("meter charges maxCredits when use() is never called", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  await ledger.meter(c, 20, () => "done");
  assert.equal(await ledger.getBalance(c), 80);
});

await check("meter charges 0 when use(0) is called", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  await ledger.meter(c, 20, (use) => use(0));
  assert.equal(await ledger.getBalance(c), 100);
});

await check("meter charges nothing and rethrows when work throws", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  await assert.rejects(
    ledger.meter(c, 20, () => {
      throw new Error("upstream down");
    }),
    /upstream down/,
  );
  const wallet = await ledger.getWallet(c);
  assert.equal(wallet.availableCredits, 100);
  assert.equal(wallet.reservedCredits, 0);
});

await check("meter throws InsufficientCreditsError without running work when short", async () => {
  const c = customer();
  await ledger.addCredits(c, 10);
  let ran = false;
  await assert.rejects(
    ledger.meter(c, 20, () => {
      ran = true;
    }),
    InsufficientCreditsError,
  );
  assert.equal(ran, false);
  assert.equal(await ledger.getBalance(c), 10);
});

await check("meter takes usage above maxCredits from the balance", async () => {
  const c = customer();
  await ledger.addCredits(c, 100);
  await ledger.meter(c, 5, (use) => use(8));
  assert.equal(await ledger.getBalance(c), 92);
});

// --- chargeOnce(tenantId, itemKey, credits, produce) ---------------------------

await check("chargeOnce charges the first time and returns produce's value", async () => {
  const c = customer();
  await ledger.addCredits(c, 10);
  const seen: boolean[] = [];
  const produce = (item: { alreadyCharged: boolean }) => {
    seen.push(item.alreadyCharged);
    return "ada@example.com";
  };
  assert.equal(await ledger.chargeOnce(c, "email:p_1", 3, produce), "ada@example.com");
  assert.equal(await ledger.getBalance(c), 7);
  assert.equal(await client().chargeOnce(c, "email:p_1", 3, produce), "ada@example.com");
  assert.equal(await ledger.getBalance(c), 7, "the second time is free");
  assert.deepEqual(seen, [false, true]);
});

await check("chargeOnce with noCharge delivers without billing, and charges next time", async () => {
  const c = customer();
  await ledger.addCredits(c, 10);
  assert.equal(await ledger.chargeOnce<string | null>(c, "email:p_2", 3, () => noCharge(null)), null);
  assert.equal(await ledger.getBalance(c), 10);
  assert.equal(await ledger.chargeOnce(c, "email:p_2", 3, () => "found"), "found");
  assert.equal(await ledger.getBalance(c), 7);
});

await check("chargeOnce with a feature is a different item than the default", async () => {
  const c = customer();
  await ledger.addCredits(c, 10);
  await ledger.chargeOnce(c, "p_3", 2, () => "default feature");
  await ledger.chargeOnce(c, "p_3", 2, () => "phone feature", { feature: "phone_lookup" });
  assert.equal(await ledger.getBalance(c), 6);
});

await check("chargeOnce throws InsufficientCreditsError without calling produce when short", async () => {
  const c = customer();
  await ledger.addCredits(c, 1);
  let ran = false;
  await assert.rejects(
    ledger.chargeOnce(c, "p_4", 3, () => {
      ran = true;
    }),
    InsufficientCreditsError,
  );
  assert.equal(ran, false);
});

await check("the options form of chargeOnce still works", async () => {
  const c = customer();
  await ledger.addCredits(c, 10);
  const result = await ledger.chargeOnce({ tenantId: c, itemKey: "p_5", credits: 2 }, () => "x");
  assert.equal(result.charged, true);
  assert.equal(result.result, "x");
  assert.equal(result.creditsCharged, 2);
});

// --- importCustomers ---------------------------------------------------------

const [a, b, empty] = [customer(), customer(), customer()];
const list = [
  { id: a, credits: 520, owns: ["email:p_981", { itemKey: "p_982", feature: "phone_lookup", credits: 4 }] },
  { id: b, credits: 100 },
  { id: empty },
];

await check("importCustomers imports balances and owned items, skipping empty customers", async () => {
  const result = await ledger.importCustomers(list);
  assert.deepEqual(result, { imported: 2, alreadyImported: 0, skipped: 1, failed: [] });
  assert.equal(await ledger.getBalance(a), 520);
  assert.equal(await ledger.getBalance(b), 100);
  assert.equal(await ledger.getBalance(empty), 0);
});

await check("owned items are free in chargeOnce, under the default feature or their own", async () => {
  assert.equal(await ledger.chargeOnce(a, "email:p_981", 5, () => "owned"), "owned");
  assert.equal(await ledger.chargeOnce(a, "p_982", 5, () => "owned", { feature: "phone_lookup" }), "owned");
  assert.equal(await ledger.getBalance(a), 520);
});

await check("running the same import again adds nothing", async () => {
  const result = await client().importCustomers(list);
  assert.deepEqual(result, { imported: 0, alreadyImported: 2, skipped: 1, failed: [] });
  assert.equal(await ledger.getBalance(a), 520);
});

await check("a later run with a new customer imports only the new one", async () => {
  const c = customer();
  const result = await ledger.importCustomers([...list, { id: c, credits: 7 }]);
  assert.deepEqual(result, { imported: 1, alreadyImported: 2, skipped: 1, failed: [] });
  assert.equal(await ledger.getBalance(c), 7);
});

await check("a changed balance for an imported customer is refused, not added", async () => {
  const result = await ledger.importCustomers([{ id: b, credits: 999 }]);
  assert.equal(result.imported, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.id, b);
  assert.equal(result.failed[0]!.error, "idempotency_key_mismatch");
  assert.equal(await ledger.getBalance(b), 100);
});

await check("importCustomers refuses negative credits before sending anything", async () => {
  const c = customer();
  await assert.rejects(ledger.importCustomers([{ id: c, credits: -5 }]), TypeError);
  assert.equal(await ledger.getBalance(c), 0);
});

console.log(`\n${passed} checks passed`);
