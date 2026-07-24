## Valid registration
Register with unique, valid details; expect a success state (confirmation message, verification email prompt, or redirect).

## Duplicate email registration
Attempt registration with an already-registered email; expect a clear "already exists" error, not a silent overwrite or generic failure.

## Terms/consent checkbox enforcement
If a terms-of-service checkbox is required, verify submission is blocked until it's checked.

## Email verification flow
If the app requires email verification before full access, verify the account is genuinely restricted until verified, not just cosmetically flagged.