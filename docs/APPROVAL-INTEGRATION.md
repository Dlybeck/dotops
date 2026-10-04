# Native approval integration

Native approval requests and ordinary questions are separate. Model-supplied
text, booleans, preparation IDs and relayed transcripts are not trusted owner
consent. The connector does not expose a denied-action approval RPC or permission
response through ordinary model tool arguments.

[Native App Server documentation](https://learn.chatgpt.com/docs/app-server#approvals)
describes server-initiated command/file/permission requests, client decisions,
resolution and later item completion. [Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review#denials-and-failure-behavior)
describes a one-action override whose retry still undergoes review.

Local installed protocol evidence includes goal get/set/clear and
thread/approveGuardianDeniedAction carrying a serialized native denial event.
API shape alone does not prove an authenticated parent owner path. Earlier
read-only verification reported providerUnavailable. That finding applies to
that provider/build/account observation, not every possible platform route.

Earlier installed tunnel testing found legacy server-initiated push elicitation
failed, while modern input_required and continuation traversed transport.
All inputs were fixtures. A form arriving or returning does not itself establish
authenticated owner response provenance.

The standalone UI capability probe is unregistered in production. It has no native
client or execution authority and always reports authenticatedOwner:false,
executionAuthorized:false, nativeDispatches:0. The isolated owner-binding
prototype has test-only authentication and no native imports or registration.

A genuine parent integration needs a sanctioned client presentation/response
contract unavailable to model arguments, exact native request/event binding,
owner provenance, reject/cancel behavior, connection/replay/disconnect semantics,
and the supported native response or denied-action retry API. Preserve real native
events; do not reconstruct approval markers. Native acknowledgement, subsequent
review and execution are separate receipts.

Before claiming the coordinating-chat flow handles approvals, exercise actual
owner approve/reject/cancel through the actual parent UI, plus stale/replay and
disconnect tests. No transport or prototype test substitutes for this acceptance.
Any new registration, exposure or service cutover requires specific authorization.
