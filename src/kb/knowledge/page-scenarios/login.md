## Valid login flow
Log in with correct credentials; expect navigation to the authenticated area and no error shown.

## Invalid password
Correct identifier, wrong password; expect a generic error (not revealing whether the identifier existed) and no session created.

## Account lockout behavior
After repeated failed attempts, expect either a lockout message, CAPTCHA, or delay — verify the app doesn't allow unlimited silent retries.

## Remember-me / persistent session
If a "remember me" option exists, verify the session persists across a browser restart when checked, and does not when unchecked.

## Forgot-password link
Verify the forgot-password link leads to a working recovery flow, not a dead link or unstyled page.