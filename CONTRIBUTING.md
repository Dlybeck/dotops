# Contributing

Use the Node version in `.node-version` and the locked dependencies. Run
`npm ci --ignore-scripts` and `npm test`. Tests use isolated native fixtures; they
must not control live chats, restart services or alter native permissions.

Keep request acknowledgement, model completion, owned-operation closure and
new-start admission separate. Attribute work by exact accepted thread/turn/item/
process evidence. Preserve named unknowns instead of guessing ownership.

Include a regression for behavioral fixes and describe validation limits. Keep
private contexts, credentials, native identifiers, journals and transcripts out
of changes and public reports. Synthetic fixtures should preserve relationships
without copying private payloads or their fingerprints.

Source publication, npm publication and activation are separate actions. The
package remains `private: true` to prevent accidental npm publication. DotOps uses the MIT license. Public destination and release approval remain
separate from local preparation.
