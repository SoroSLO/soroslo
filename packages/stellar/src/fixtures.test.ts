import test from "node:test";
import assert from "node:assert/strict";
import { Networks } from "@stellar/stellar-sdk";
import {
  buildBoundedLargePayload,
  buildContractErrorSimulationResponse,
  buildMalformedRpcResponse,
  buildNetworkFixture,
  buildRetryableHttpError,
  buildSuccessfulSimulationResponse,
  buildTransportError
} from "./fixtures.js";

void test("builds deterministic successful simulation responses with field overrides", () => {
  const first = buildSuccessfulSimulationResponse();
  const second = buildSuccessfulSimulationResponse();

  assert.deepEqual(first, second);
  assert.equal(first.result?.retval.type, "scvU32");
  assert.equal(first.result?.retval.value, 42);
  assert.equal(buildSuccessfulSimulationResponse({ latestLedger: 7 }).latestLedger, 7);
});

void test("builds explicit contract error responses", () => {
  const response = buildContractErrorSimulationResponse({ error: "Error(Contract, #9)" });

  assert.equal(response.error, "Error(Contract, #9)");
  assert.equal(response.latestLedger, 1_000_000);
  assert.equal("result" in response, false);
});

void test("builds malformed, transport, retry, and bounded payload fixtures explicitly", () => {
  assert.equal(typeof buildMalformedRpcResponse(), "object");
  assert.deepEqual(buildMalformedRpcResponse({ id: "custom-malformed" }), {
    id: "custom-malformed",
    latestLedger: "not-a-ledger",
    events: null
  });
  assert.equal(buildTransportError().code, "ECONNRESET");
  assert.deepEqual(buildRetryableHttpError(429), { response: { status: 429 } });
  assert.throws(() => buildRetryableHttpError(400), /429 or a 5xx/);
  assert.equal(buildBoundedLargePayload(4).payload, "xxxx");
  assert.throws(() => buildBoundedLargePayload(-1), /non-negative integer/);
});

void test("builds network and health fixtures with independent overrides", () => {
  const fixture = buildNetworkFixture({
    passphrase: "custom",
    latestLedger: 200,
    ledgerRetentionWindow: 20
  });

  assert.deepEqual(fixture.network, { passphrase: "custom", protocolVersion: "23" });
  assert.deepEqual(fixture.health, {
    status: "healthy",
    latestLedger: 200,
    oldestLedger: 180,
    ledgerRetentionWindow: 20
  });
  assert.equal(buildNetworkFixture().network.passphrase, Networks.TESTNET);
});
