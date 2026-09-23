# Posting request file format (`*.posting.yaml`)

Source of truth: `docs/guide/requests.md` + `src/posting/collection.py`
(darrenburns/posting, verified Sep 2026). Keys outside this schema are ignored
or rejected — do not invent any.

## Full schema with defaults

```yaml
name: List things            # shown in collection tree; also seeds filename
description: ""              # variables allowed ($VAR/${VAR})
method: GET                  # GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS
url: https://api.example.com/things

path_params:                 # values for :placeholders in url; rows come from the URL
- name: postId
  value: '3'                 # variables allowed; literal ':' in path escapes as '::'

headers:                     # variables allowed in name and value
- name: Content-Type
  value: application/json
  enabled: true

params:                      # query parameters (?a=b)
- name: page
  value: '1'
  enabled: true

body:
  content: |-                # raw body (JSON/text/...); variables allowed
    {"key": "value"}
  # OR form data (urlencoded):
  # form_data:
  # - name: field
  #   value: $SOME_VAR
  #   enabled: true

auth:                        # exactly one type block must match `type`
  type: bearer_token          # basic | digest | bearer_token
  # basic:  {username: u, password: $BASIC_PASS}
  # digest: {username: u, password: $DIGEST_PASS}
  bearer_token: {token: $AUTH_TOKEN}

scripts:                     # paths RELATIVE to collection root
  setup: scripts/auth.py              # def setup(posting)
  on_request: scripts/auth.py:sign    # def sign(request, posting)
  on_response: scripts/auth.py:save   # def save(response, posting)

options:
  follow_redirects: true
  verify_ssl: true           # per-request SSL toggle (self-signed backends)
  attach_cookies: true
  proxy_url: ""              # variables allowed
  timeout: 5.0               # seconds

posting_version: 2.10.0      # written by Posting; keep on hand-written files too
```

Notes:

- `cookies` are session-only and **never persisted** — don't write a `cookies:` key.
- `enabled: false` keeps a header/param/form field in the file but excludes it at send time.
- Omit whole sections (`auth:`, `body:`, `scripts:`, `options:`) when unused; keep
  `posting_version` so future Posting versions can migrate the file.
- Quote values with leading zeros / `true`-like strings (`value: 'true'`) to keep them strings.

## Minimal examples

```yaml
# get-user.posting.yaml
name: Get user
method: GET
url: $BASE_URL/users/:id
path_params:
- name: id
  value: '1'
headers:
- name: Authorization
  value: Bearer $AUTH_TOKEN
posting_version: 2.10.0
```

```yaml
# create-user.posting.yaml
name: Create user
description: Adds a new user to the system.
method: POST
url: $BASE_URL/users
body:
  content: |-
    {
      "firstName": "John",
      "email": "john.doe@example.com"
    }
headers:
- name: Content-Type
  value: application/json
params:
- name: sendWelcomeEmail
  value: 'true'
posting_version: 2.10.0
```

## Companion `.env` example

```bash
# shared.env
API_PATH="/api/v1"
# dev.env
BASE_URL="https://dev.example.com/api/v1"
AUTH_TOKEN="dev-token-here"
```

Load: `posting --collection <dir> --env shared.env --env dev.env`
(later files win on conflicts; `posting.env` in cwd autoloads when `--env` is absent).
