## View own profile data
Verify the profile page displays the logged-in user's own correct data, not stale, cached, or another user's data.

## Edit and save profile fields
Update an editable field and save; verify the change persists after a page reload, not just in the current session's UI state.

## Email/username uniqueness on edit
If email or username can be changed, verify changing it to one already used by another account is rejected.

## Password change flow
If password change is available from the profile, verify it requires the current password and enforces the same strength rules as signup.