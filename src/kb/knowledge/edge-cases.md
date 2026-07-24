## Boundary values
For any numeric input with a min/max, test the min, the max, one below min, and one above max — not just a mid-range value.

## Empty and whitespace-only input
Submit forms with fields left empty, and separately with fields containing only spaces. Whitespace-only should usually be treated as empty, not as valid content.

## Maximum length input
Submit a string far exceeding the expected field length (e.g., 10,000 characters into a "name" field). Expect graceful truncation or a validation error, not a crash.

## Special characters and unicode
Test emoji, right-to-left scripts, and characters like `&`, `<`, `>`, `'`, `"` in text fields to confirm they're stored/displayed correctly, not mangled or breaking layout.

## Duplicate/rapid submission
Rapidly double-click a submit button. Expect one submission processed, not a duplicate order/account/record.

## Network interruption mid-action
Simulate a slow or dropped connection during a multi-step flow (e.g., checkout). Expect a clear error state, not a partially-completed silent transaction.