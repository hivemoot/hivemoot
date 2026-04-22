---
name: test-advocate
description: >
  Enforces testing discipline when implementing and reviewing code.
  Ensures test coverage for new code paths, checks test quality and
  isolation, and flags missing edge case coverage. Language-agnostic —
  applies to any test framework and any language.
---

## Skill: Test Advocate

You are running with the test-advocate skill active. Ensure every code
change has adequate test coverage and that tests are meaningful.

### When Implementing

**Write or update tests before marking work complete.** No PR should ship
new code without corresponding test coverage.

- Cover the happy path first, then edge cases, then error paths
- Test behavior, not implementation — tests should survive refactoring
- Test boundary conditions: empty input, max values, nil/null/undefined, type mismatches
- Test failure modes: what happens when the external service is down, the file
  is missing, the input is malformed?
- Each test should verify one thing — if it fails, the name tells you what broke

**General testing patterns** (apply regardless of language):
- Co-locate tests with source when the project convention supports it
- Use descriptive test names that read as specifications
- Mock external dependencies (network, filesystem, time), not internal logic
- Prefer value equality assertions over identity checks where semantics differ
- Clean up test fixtures in teardown — don't leave side effects for other tests

**Shell testing patterns** (for bash/shell scripts):
- Use structured test functions with clear names: `test_feature_does_x()`
- Assert expected output, exit codes, and side effects explicitly
- Use `mktemp` for test fixtures, clean up in teardown
- Test both success and failure paths of every function

### When Reviewing

Check that the PR's tests actually add value:

#### Coverage gaps

- New branches (if/else, switch/match cases) without corresponding test cases
- New functions or methods with no test at all
- Changed behavior with no updated test assertions

#### Test quality problems

- Tests that test the framework, not the business logic
- Assertions so broad they'd pass for wrong reasons (e.g., only checking truthiness)
- Tests coupled to implementation details (will break on any refactor)
- Shared mutable state between tests (ordering-dependent, flaky)

#### Missing categories

- Error path tests: does the code handle failures correctly?
- Boundary tests: off-by-one, empty collections, maximum values
- Integration tests for changes that cross module boundaries

### Rationalizations to Reject

| Excuse | Why it's wrong | Required action |
|--------|---------------|-----------------|
| "It's too simple to test" | Simple code accretes complexity; tests catch regressions | Write a minimal test now |
| "I'll add tests later" | Later never comes; untested code gets modified first | Tests ship with the code |
| "The existing tests cover this" | Verify, don't assume — read the tests | Point to the specific test |
| "It's just a refactor" | Refactors break invariants; tests prove they didn't | Run tests, verify green |
| "Manual testing confirmed it works" | Manual tests don't persist or run in CI | Automate what you verified |

### When NOT to Apply

- Documentation-only changes
- Config/data changes with no logic
- Pure dependency version bumps
- Formatting/linting-only changes

### Quality Checklist

Before finishing implementation or review:
- [ ] Every new function/method has at least one test
- [ ] Edge cases identified and covered
- [ ] Error paths tested
- [ ] Tests pass locally (or CI confirms)
- [ ] No test-only shortcuts (`skip`, `only`, `pending`) left in committed code
