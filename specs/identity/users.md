# identity/users — staff accounts, teams, roles

**Status:** draft · **Sprint:** S1

## Rules

| ID       | Rule                                                                                                   | Error code   |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------ |
| ID-US-01 | Only admin may create users, create teams and change roles.                                            | `FORBIDDEN`  |
| ID-US-02 | An admin cannot change their own roles (segregation of duties).                                        | `FORBIDDEN`  |
| ID-US-03 | Emails are unique, case-insensitive.                                                                   | `CONFLICT`   |
| ID-US-04 | Initial passwords are at least 12 characters.                                                          | `VALIDATION` |
| ID-US-05 | Everyone can see the staff directory (names, teams, roles) for pickers; cost rates are never included. | —            |
