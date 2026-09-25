# crm/clients — clients and contacts

**Status:** draft for PO sign-off · **Sprint:** S1 · **Quotation refs:** Q-01 ("Clients, contacts")

## Rules
| ID | Rule | Error code |
|---|---|---|
| CRM-CL-01 | A client has a name (EN, optional KM) and exactly one account lead who is an active user. | `VALIDATION` |
| CRM-CL-02 | Account leads may create and edit only clients they lead; ops_lead, director and ceo may manage any client. Reassigning a client to another lead needs `any` scope. | `FORBIDDEN` |
| CRM-CL-03 | Every internal role can view clients (so staff can find the client on their tasks). | — |
| CRM-CL-04 | Client search matches English or Khmer names, is case-insensitive, NFC-normalised and typo-tolerant (trigram). | — |
| CRM-CL-05 | A client has at most one primary contact; making another contact primary demotes the previous one. | — |
| CRM-CL-06 | Clients and contacts are archived, never deleted (the `app` role has no DELETE). Archived clients are hidden by default and cannot get new deals. | `VALIDATION` |
| CRM-CL-07 | Edits carry `expectedVersion`. | `STALE_VERSION` |
| CRM-CL-08 | New clients require a PO by default (`po_required = true`, INV-21); exemptions come in S3. | — |

## Commands and queries
| Name | Permission | exposeTo |
|---|---|---|
| `client.create`, `client.update`, `contact.create`, `contact.update` | `client.manage` | web, mcp |
| `client.list`, `client.get` | `client.view` | web, mcp |
