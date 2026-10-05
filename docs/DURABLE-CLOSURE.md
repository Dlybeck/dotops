# Durable delegation closure

When complete ordered native history proves one unique delegation launch followed
by its matching receiver completion, retain that proof in the private owned-turn
ledger. A later native history response may omit those items. That omission alone
must not reopen the operation or require loading historical descendants.

The retained receipt binds the exact accepted root turn, launch item, completion
item and receiver. Typed launches additionally bind tool and sender identity; the
sender must match the owning root at evaluation. Only terminal model snapshots
with complete, valid ordered evidence can create these receipts. Receipts contain
ownership metadata, never prompts, tool arguments, outputs or agent messages.

A completion is consumed by its original launch. It cannot retire another launch
to the same receiver. Changed item type, target, launch kind, or tool identity
invalidates closure; failed typed launch status cannot retain its earlier proof.
Malformed or ambiguous evidence remains unknown. Duplicate completion claims are
invalid. The proof grants neither receiver-turn ownership nor child control.

Admission still checks current models, exact live process inventory, owned goal
continuations, queue policy, persistence and connection freshness. It evaluates
explicitly accepted root turns, rather than treating ancestry as ownership.
Supported bounded `thread/items/list` repair can establish new closure if it
returns exact receipts. Unsupported APIs or empty history cannot supply proof.

## Recovery limits

This prevents loss of previously proved closure; it does not reconstruct closure
that was never observed. Old journals with completed command status but no exit
receipt or exact process identity retain unknown results. Current admission is
separate after an established local lifetime ends; see RELEASE-CONTRACT.md. Model completion or empty unloaded-child history cannot supply those results.
A full host reboot ends ordinary local execution without supplying exit codes.
Actual execution-host/boot provenance is unavailable in the current native
protocol; workspace environment selection does not attest where a command ran.

The synthetic regression suite includes the legacy gap of 120 command and 19
delegation obligations, and a 17-turn root with two empty unloaded historical
children. These are structural fixtures with synthetic identifiers, not copies of
private histories. Missing current-lifetime proof stays blocked; an established
prior-boot local lifetime can permit new work while preserving unknown results.

The change is additive private ledger metadata. No migration clears unknowns or
rewrites native history. Rolling back to the baseline can conservatively reopen
retained delegation closure when native history omits items. Activation, service
restart and establishing the incident boot boundary for legacy dispatch bindings are
separate operator decisions; this candidate performs none of them.
