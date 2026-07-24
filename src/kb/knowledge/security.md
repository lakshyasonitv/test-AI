## SQL injection
Test inputs like `' OR '1'='1` or `'; DROP TABLE users;--` in any field that might reach a query. Expect rejection or safe escaping, never authentication bypass or a DB error leaking to the UI.

## Cross-site scripting (XSS)
Submit `<script>alert(1)</script>` or `"><img src=x onerror=alert(1)>` into text inputs, search boxes, and comment fields. Expect the payload rendered as inert text, never executed.

## Authentication bypass via direct URL access
Attempt to navigate directly to an authenticated-only URL (e.g., `/dashboard`, `/admin`) without logging in. Expect a redirect to login, not the protected content.

## Session handling after logout
After logging out, use the browser back button or a saved authenticated URL. Expect the session to be invalid — no access to previously-authenticated pages.

## Rate limiting / brute force
Attempt several rapid failed logins. A well-secured app should throttle, lock, or CAPTCHA-gate after a threshold, rather than allow unlimited attempts.

## Sensitive data exposure
Check that passwords are masked in password fields, not present in URL query params, and not visible in client-side error messages or console logs.