# hamoach-connector

Remote MCP server ("המוח") on Vercel. Reads and writes the private `hamoach-vault` repo through the GitHub API (one commit per write).

## Endpoints
- `/mcp` - MCP, Streamable HTTP, stateless. Bearer token required.
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token` - single-user OAuth (PKCE + dynamic client registration). The authorize page asks for `ACCESS_PASSWORD`.

## Environment variables (Vercel, never in the repo)
| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | Fine-grained token, only `hamoach-vault`, Contents: Read and write |
| `GITHUB_OWNER` | GitHub user name |
| `GITHUB_REPO` | `hamoach-vault` |
| `GITHUB_BRANCH` | `main` (optional) |
| `ACCESS_PASSWORD` | Personal password. Changing it disconnects every client. |
| `AUTH_SECRET` | Long random string |
| `SUPABASE_URL` | Outreach project URL (for `get_pipeline`) |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key of the outreach project. Only calls `pipeline_summary`, which is read-only and returns no contact details. |

## Tests
```
npm run typecheck
npx tsx test/run-tools.ts <copy-of-vault-dir>     # every tool, local folder
npx tsx test/run-tools.ts --github                # every tool, real repo (test project, cleaned up)
npx tsx test/oauth-flow.ts <copy-of-vault-dir>    # login flow + MCP over HTTP
npx tsx test/pipeline.ts <copy-of-vault-dir> <leads-count>   # get_pipeline (needs SUPABASE_* env)
```
