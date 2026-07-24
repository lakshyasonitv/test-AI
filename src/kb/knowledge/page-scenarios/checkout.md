## Complete purchase happy path
Add an item, proceed through checkout with valid shipping/payment details; expect an order confirmation with correct order details.

## Empty cart checkout attempt
Attempt to reach checkout with an empty cart; expect it blocked or redirected, not a broken/empty checkout form.

## Invalid or expired payment details
Submit an invalid card number or expired date; expect a clear payment error and no order created.

## Price/total consistency
Verify the total shown at checkout matches (item prices + tax + shipping) and matches what's charged/confirmed on the order confirmation.

## Address validation
Submit checkout with missing or malformed shipping address fields; expect field-level validation errors, not a generic failure.