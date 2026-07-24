## Test independence
Each test should set up its own state and not depend on execution order or leftover data from a previous test. Avoid tests that only pass when run after another specific test.

## Explicit waits over fixed delays
Prefer waiting for a specific condition (element visible, network idle, URL change) over a fixed `sleep(ms)`. Fixed delays make suites slow and still flaky under load.

## Assert on user-visible outcomes
Prefer asserting what a user would see (text, URL, visible element) over internal implementation details (CSS class names, DOM structure) which change without breaking actual behavior.

## One behavior per test
A test should verify one behavior/scenario. Bundling multiple unrelated assertions into one test makes failures hard to diagnose — a single unrelated break masks all other results in that test.

## Realistic but disposable test data
Use randomized or timestamped values for anything requiring uniqueness (emails, usernames) so repeated runs don't collide with existing data from prior runs.

## Negative tests matter as much as positive ones
For every "happy path" case (valid input works), verify the corresponding failure mode (invalid input is rejected) with an appropriate error, not a silent success or a crash.