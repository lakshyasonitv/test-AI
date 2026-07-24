## Keyboard navigation
All interactive elements (links, buttons, form fields) must be reachable and operable via Tab/Shift+Tab and Enter/Space, without requiring a mouse.

## Focus visibility
When an element receives keyboard focus, there must be a visible focus indicator. Test that focus doesn't silently disappear (e.g., outline removed with no replacement).

## Form labels
Every input must have an associated label (via `<label for>`, `aria-label`, or `aria-labelledby`) so screen readers can announce its purpose.

## Alt text on meaningful images
Images conveying information need descriptive `alt` text; purely decorative images should have `alt=""` so screen readers skip them.

## Color contrast
Text and interactive elements need sufficient contrast against their background (WCAG AA: 4.5:1 for normal text, 3:1 for large text) to be readable by low-vision users.

## Error identification
Form validation errors must be programmatically associated with their field (e.g., `aria-describedby`) and not conveyed by color alone.