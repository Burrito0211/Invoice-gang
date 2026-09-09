# API samples

**This directory is empty on purpose, and that is the current state of
Milestone 0.**

Every field name in `../EINVOICE-API.md` is still tagged `[assumed]`. Nothing
in this repository has been tested against the live MOF API — the parameter
names and response shapes in `src/einvoice/` were written from documentation
knowledge, not from a successful call.

## What goes here

Raw, unedited JSON responses from three endpoints, captured with a real App ID
and a real carrier:

| File | Call | Why it matters |
|---|---|---|
| `qry-winning-list.json` | `qryWinningList` | Needs no carrier credentials — the cheapest possible proof the App ID and transport work at all |
| `carrier-inv-chk.json` | `carrierInvChk` for a known date range | Pins the header field names the whole sync reads |
| `carrier-inv-detail.json` | `carrierInvDetail` for one known invoice | Pins the detail row shape |
| `error-bad-date.json` | `carrierInvChk` with an invalid range | The error path is what the sync spends its life handling |
| `error-bad-encrypt.json` | `carrierInvChk` with a wrong verification code | **Scrub the credential out of this file before committing it** |

## Then

1. Update `../EINVOICE-API.md`, converting every `[assumed]` tag to a verified
   field name or correcting it.
2. Move the surviving spelling to the front of its candidate list in
   `src/einvoice/parse.ts`. That parser probes several plausible names per
   field precisely so this step is a reordering and not a rewrite.
3. Replace the hand-built fixtures in `test/helpers/fake-api.ts` with these
   captured responses run through `parse.ts`, so the invariant tests exercise
   the real field names.

Until step 1 is done, treat every claim about the API's shape in this repo as
unverified.
