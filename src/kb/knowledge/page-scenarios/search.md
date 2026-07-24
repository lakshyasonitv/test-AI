## Valid query returns results
Search a term expected to match; expect relevant results displayed, not an empty or error state.

## No-results query
Search a term unlikely to match anything; expect a graceful "no results" message, not an error or blank page.

## Empty query submission
Submit search with no input; expect it handled gracefully (either blocked, or showing a default/all-items state) not a crash.

## Special-character query safety
Search with `<script>` or SQL-like input; expect it treated as literal search text, not executed or causing a server error.