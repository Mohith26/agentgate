# AgentGate

I kept reading about LLM agents being wired into CRM systems and I could not
find a good answer to a fairly boring question: when an agent decides to change
a record, who checked that the person it is acting for was allowed to see that
record in the first place?

So I built the boring part. AgentGate is a small runtime that sits between an
agent's plan and a CRM-shaped datastore. It validates the parameters, resolves
who can see what, charges the work against a per-request budget, and unwinds
everything if a step blows up halfway through.

There is no model in here. The planner is whatever produces the list of actions.
This project is only the layer that decides whether those actions are allowed to
happen and what to do when one of them fails.

## The access model

Five things can grant a user access to a row, and if none of them fire the row
simply does not exist as far as that user is concerned:

1. being an administrator
2. owning the row
3. the object's org wide default (`private`, `read`, `readWrite`)
4. sitting above the row's owner in the role hierarchy
5. a criteria based sharing rule, or an explicit one off share

Detail objects are a special case. `Contact` and `Case` are configured as
controlled by their parent `Account`, so they are exactly as visible as the
account they hang off, never more. That turned out to be the rule that is
easiest to get subtly wrong, which is why there is a test that walks 60 cases
and asserts the child decision equals the parent decision every time.

## Proving the resolver is right

The optimized resolver precomputes role ancestor sets, expands each sharing rule
into the concrete set of users it grants to, and caches criteria evaluations per
record. All of that is an opportunity to be wrong in a way that quietly leaks
data.

So there are two implementations. `resolve` is the fast one. `resolveNaive` is a
deliberately slow reference that recomputes the role hierarchy and rescans every
rule and every share on each call. The test suite runs both across every user
and every record in the seeded org and fails if they ever disagree:

```
120,000 user x record decisions
0 disagreements
0 over permissive decisions
0 under permissive decisions
```

The direction matters more than the count. An under permissive bug is an annoyed
user. An over permissive bug is a data leak, so it is counted and asserted
separately.

## The bug this actually caught

The first time I ran the benchmark, the differential sweep failed with 1,295
over permissive and 520 under permissive decisions out of 120,000. Checking out
the commit before the fix reproduces those exact counts. Not a race, not a
rounding issue: the criteria cache had no invalidation. A rule like "grant read on accounts in the technology
industry" was evaluated once per record and then cached forever, so once the
benchmark mutated a few thousand rows, accounts that had stopped matching their
rule stayed visible to everyone the rule had ever granted.

The fix was to give the store a change feed and have the sharing model drop its
cached criteria results for any row that changes. `test/test-sharing.js` now
covers both directions of that: access withdrawn when a row stops matching, and
access granted when a row starts matching, with 6,000 further comparisons
against the reference resolver after a bulk mutation pass.

I left the sweep in the benchmark rather than only in the tests, because the
benchmark mutates thousands of rows first and that is what exposed it.

## Rollback

Every mutating action ships with a compensating action. If step four of a five
step plan throws, the runtime walks the completed steps in reverse and undoes
them. To check that this actually works rather than merely appearing to, the
store can produce an FNV-1a fingerprint of its entire contents, and the runtime
compares the fingerprint before the plan against the fingerprint after the
rollback.

The test injects a failure at each position in a five step plan, one position at
a time, and asserts the fingerprint comes back identical in all five cases.

Fingerprinting the whole store on every plan is obviously not free, so it is a
constructor flag. It defaults on, and the benchmark turns it off. That single
flag is worth more than three orders of magnitude on plan throughput, which is a
useful reminder that the audit path and the hot path want different defaults.

## Governor limits

One tenant should not be able to starve the rest, so each plan runs against a
budget covering rows scanned, queries issued, DML statements, DML rows, actions
executed, and nesting depth. Going over throws a `LimitExceeded` that names the
limit, the usage and the cap.

The interesting part is that a plan cut off by a limit is treated as a failure
like any other, so it unwinds. There is a test that caps a six action plan at
three actions and asserts the store fingerprint is unchanged afterwards.

## Idempotency

Retries are normal and double charging a customer is not. Plans submitted with
an idempotency key are hashed together with the plan body and recorded in a
ledger. Resubmitting the same key with the same body returns the recorded
result. Resubmitting the same key with a different body is treated as a new
request, because the key alone is not the request.

The test submits the same plan 200 more times after the first and asserts the
underlying value was written exactly once.

## Numbers

Measured on Apple Silicon arm64, single threaded, from `results/results.json`.
Regenerate with `node test/run-all.js`.

| What | Result |
| --- | --- |
| Tests | 40 tests, 1,160 assertions, 0 failures |
| Differential sweep | 120,000 pairs, 0 disagreements, 0 over permissive |
| Post mutation sweep | 6,000 pairs, 0 disagreements |
| Access decisions | 5,005,927/sec optimized vs 1,782,624/sec reference (2.81x) |
| Visibility filtered queries | 4,291 queries/sec over 240,000 scanned rows |
| Plan execution | 573,872 plans/sec, p50 0.0009 ms, p95 0.0017 ms, p99 0.0025 ms |
| Rollback | 5 injected failure positions, 5 clean fingerprint restorations |
| Idempotency | 200 duplicate submissions, 0 re-executions |
| Unauthorized attempts | 1,000 attempted, 1,000 denied, 0 allowed |

The correctness numbers are identical on every run because the org is generated
from a seeded PRNG. The throughput numbers move around by up to about twenty
five percent between runs, so treat them as an order of magnitude rather than a
score.

## Dataset

Entirely synthetic and generated from a fixed seed: 30 users across a 17 role
hierarchy, 500 accounts, 1,500 contacts, 1,200 opportunities, 800 cases, 4
criteria based sharing rules and 65 one off shares. No real data of any kind is
used or included.

The role hierarchy is deliberately two disconnected trees, a sales tree and a
support tree, so there is a population of users who can only ever reach a record
through a sharing rule or an explicit share. Without that, hierarchy access
covers up bugs in everything else.

## Running it

```
node test/run-all.js    # tests, then the benchmark, writes results/results.json
node bench/bench.js     # benchmark only, prints JSON
```

No dependencies and no build step. Node 18 or newer.

## Layout

```
src/store.js      tables, hash indexes, change feed, state fingerprint
src/query.js      predicate AST, index selection, joins, aggregates
src/sharing.js    the access model, plus the naive reference resolver
src/limits.js     per request budgets
src/actions.js    action registry and parameter validation
src/runtime.js    permission gate, idempotency ledger, compensation
src/telemetry.js  spans, counters, latency percentiles
src/seed.js       synthetic org and the CRM action set
```

## What I left out

Field level security, so a user either sees a whole row or none of it. Sharing
groups, since roles plus manual shares covered the cases I wanted to test.
Persistence, because the whole point was the decision logic. Concurrency, which
would make the idempotency ledger considerably more interesting than a Map.

## License

MIT
