-- pgTAP for the B-7 approval functions (dev DB only â€” NOT production).
-- Covers role gating, TTL validation, cross-tenant rejection, single-use
-- (replay), revocation, and per-argument scoping.
BEGIN;
SELECT plan(12);

-- role_gated(): record/revoke raise for a non-owner/admin.
SELECT throws_ok(
  $$SELECT record_tool_approval('<org-b>', '<conn>', 'external.write', repeat('a', 64), 60)$$,
  '42501', 'non-owner record is refused');
SELECT throws_ok(
  $$SELECT revoke_tool_approval('<org-b>', '<conn>', 'external.write', repeat('a', 64))$$,
  '42501', 'non-owner revoke is refused');

-- ttl_validation(): zero/negative and >3600 are refused.
SELECT throws_ok(
  $$SELECT record_tool_approval('<org>', '<conn>', 'external.write', repeat('a', 64), 0)$$,
  '22023', 'zero TTL is refused');
SELECT throws_ok(
  $$SELECT record_tool_approval('<org>', '<conn>', 'external.write', repeat('a', 64), 9999)$$,
  '22023', 'oversized TTL is refused');

-- arguments_scoping(): a different argument hash is not claimed.
SELECT is(
  claim_tool_approval('<org>', '<conn>', 'external.write', repeat('b', 64)),
  false, 'different arguments are not claimed');

-- cross_tenant(): membership check rejects a foreign org.
SELECT is(
  claim_tool_approval('<org-b>', '<conn>', 'external.write', repeat('a', 64)),
  false, 'cross-tenant claim is refused');

-- single_use(): one approval, claimed once.
SELECT is(
  claim_tool_approval('<org>', '<conn>', 'external.write', repeat('a', 64)),
  true, 'an unused approval is claimed once');
SELECT is(
  claim_tool_approval('<org>', '<conn>', 'external.write', repeat('a', 64)),
  false, 'a consumed approval cannot be claimed again');

-- revocation(): a revoked approval cannot be claimed.
SELECT is(
  revoke_tool_approval('<org>', '<conn>', 'external.write', repeat('c', 64)),
  false, 'revoking a non-existent approval returns false');
SELECT is(
  claim_tool_approval('<org>', '<conn>', 'external.write', repeat('c', 64)),
  false, 'a revoked approval cannot be claimed');

-- multiple_approvals(): distinct explicit authorizations are independently claimable.
SELECT lives_ok(
  $$SELECT record_tool_approval('<org>', '<conn>', 'external.write', repeat('d', 64), 60)$$,
  'first explicit approval');
SELECT lives_ok(
  $$SELECT record_tool_approval('<org>', '<conn>', 'external.write', repeat('d', 64), 60)$$,
  'second explicit approval');

SELECT * FROM finish();
ROLLBACK;
