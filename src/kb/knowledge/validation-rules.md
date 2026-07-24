## Required field validation
Every field marked required should block submission when empty and surface a clear, field-specific error message.

## Email format validation
An email field should reject strings without an `@` and a domain (e.g., `test@`, `test.com`, `@test.com`) while accepting valid formats including `+` tags and subdomains.

## Password strength rules
If a password policy exists (min length, character variety), verify both that policy-violating passwords are rejected and that the exact error communicates which rule failed.

## Numeric range validation
Fields expecting a bounded number (age, quantity) should reject negative values, zero (if not allowed), non-numeric input, and decimals if only integers are valid.

## Date validation
Date fields should reject impossible dates (Feb 30), reject dates outside a sensible logical range (birthdate in the future), and handle format ambiguity (MM/DD vs DD/MM) consistently.

## Cross-field validation
Where one field's valid values depend on another (confirm-password matching password, end-date after start-date), verify the dependent check actually fires, not just each field individually.