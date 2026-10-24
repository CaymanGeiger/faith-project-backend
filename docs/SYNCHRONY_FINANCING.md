# Synchrony financing content

The dealer Benefits screen and manager Support Resources screen include a
Synchrony Financing entry. They load `GET /benefits/financing` through the existing
authenticated API client. The endpoint retains the benefits controller's role
and account-access rules.

## Content required before activation

Obtain the destination and display copy approved by Nicole/the Hercules team.
No approved Synchrony destination or terms were found in the repository. Generic
financing examples in `DEALER_APP_CONTENT_PLAN.md` are not approved program terms.

Configure both server environment variables:

- `SYNCHRONY_FINANCING_URL`: the exact approved public HTTPS destination.
- `SYNCHRONY_FINANCING_DESCRIPTION`: the exact approved display text, including
  any necessary eligibility language or disclosures. Newlines are preserved.

Leave both blank until that content is supplied. Missing copy, a missing URL, or
a URL unsupported by the existing viewer returns `available: false` with null
copy and URL. The app shows a clear unavailable message without a link or rates.
This is a deployment configuration mechanism; it does not establish business
approval or infer eligibility/enrollment.

## Validation after content is supplied

1. Confirm the approved copy appears completely on both entry points.
2. Open the approved destination from iOS and Android. The shared in-app content
   viewer supplies navigation, retry, and its explicit system-browser fallback.
3. Verify the displayed partner program and terms match the supplied content.
4. Record approval, destination, test build, platform, and outcome in
   `Hercules.json` before marking HERC-006 complete.

Automated tests use synthetic `example.com` destinations only. They verify
configuration failure states, complete copy, safe link handling, retry, and
dispatch to the existing viewer. They do not establish that a real Synchrony
program or destination has been approved or validated.
