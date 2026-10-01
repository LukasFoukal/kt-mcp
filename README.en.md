# kt-mcp

[🇨🇿 Česky](README.md) · **🇬🇧 English**

A self-hosted [MCP](https://modelcontextprotocol.io) server that connects an AI agent to your **kaloricketabulky.cz** food diary.

You say *"I ate 3 eggs and a banana"* — the agent searches the Czech food database, picks the right portion unit, and writes the entries into your real diary. The official app stays the source of truth, so premium features keep working.

Built and tested with **Claude** (desktop, mobile and web via a custom connector), but it speaks standard MCP over HTTPS with OAuth 2.1, so any agent that supports remote MCP servers can connect.

> ## Unofficial, and not affiliated with Dine4Fit
>
> kaloricketabulky.cz is operated by **Dine4Fit, a.s.**, who are not involved in
> this project and do not endorse it. There is no public API; the endpoints used
> here were read out of the site's own frontend JavaScript and may change or
> break without notice.
>
> Dine4Fit's terms grant a **personal, non-commercial** licence. This software is
> published so that you can automate access to **your own account** — which is
> what that licence permits. Running it as a paid or multi-tenant service, or
> redistributing the food data it returns, is a different matter and is on you.
> The database is Dine4Fit's and is protected by EU database rights.
>
> Keep the request rate human. Don't build a competing client on it.

## What you can do with it

Once connected, food logging stops being a chore of tapping through search screens. Some patterns that work well in practice:

- **Log by talking.** "I had a rohlík with ham and two eggs for breakfast." The agent searches, resolves natural portions (*kus (55 g)* instead of guessed grams), and logs each item into the right meal slot.

- **Automate your routine.** You drink two coffees with milk every day — why type it? If your agent supports scheduled tasks (Claude does), tell it once: *"Every day at 9:00, log two espressos with milk into my diary."* Your daily constants log themselves.

- **Photograph your plate.** Send the agent a photo of your lunch and ask what's on it. It identifies the foods, estimates real gram amounts from the picture, tells you the calories — and logs it when you confirm. Estimates are estimates, but for mixed plates it beats not logging at all.

- **Photograph a recipe.** Snap a recipe from a cookbook or a screenshot from the web and say *"save this as a meal"*. The agent reads the ingredients, finds each one in the database, and creates a reusable saved recipe — one entry to log next time you cook it. You can edit on the way in: *"swap the cream for white yogurt and halve the sugar."*

- **Log exercise and weight.** "I walked briskly for 40 minutes this morning" finds the activity and logs it; the site computes the calories from your weight. If your watch already told you the calories, those are logged as given. And "I weigh 82.4 today" records your weight.

- **Ask how your day is going.** "How many calories do I have left?" reads today's totals straight from the diary. And "how much protein am I still missing?" compares the day with the nutrient goals set on the site, so the agent can suggest what to eat to hit them.

## Tools

| Tool | Purpose |
|---|---|
| `search_food` | Find foods by Czech name or 13-digit EAN barcode. Returns the food id the other tools need. |
| `get_food_portions` | List a food's natural portion units (`kus (55 g)`, `velký kus (60 g)`) so "3 eggs" logs as three pieces rather than an estimated weight. |
| `get_food_nutrition` | Calories and macros for a quantity, scaled by the site itself. Read-only. |
| `log_food` | Write an eating record into the diary. |
| `get_day_summary` | Read back a day's totals. |
| `get_day_progress` | Compare a day with the goals set on the site: energy, protein, carbs, fat, fibre and every other tracked nutrient (sugar, salt…), drinks and weight — eaten, goal and remaining. |
| `create_meal` | Save a recipe built from existing foods. |
| `list_my_meals` | List saved recipes with their ids and total energy. |
| `log_meal` | Log a whole saved recipe into the diary as one entry. |
| `delete_meal` | Delete a saved recipe. |
| `search_activity` | Find an activity (walking, running, cycling…) in the Czech database. |
| `log_activity` | Log an activity for a number of minutes; the site computes the calories from your weight. |
| `log_custom_activity` | Log an activity with calories you already know, e.g. from a watch. |
| `get_day_entries` | List every entry of a day: foods by meal and activities, with ids, amounts and calories. |
| `delete_diary_entry` | Delete one food, recipe or activity entry, e.g. a mistake or a duplicate. |
| `edit_diary_entry` | Change a food's amount or unit, an activity's duration, or move a food to another meal. |
| `copy_meal` | Copy a meal (e.g. yesterday's breakfast) to another day or meal, whole or only selected foods. |
| `log_own_food` | Log something not in the database with your own values (e.g. from a label). Creates a diary entry only, not a new database food. |
| `add_note` | Add a note to the whole day or to one meal. |
| `get_usual_items` | List favourite and most used foods and activities. |
| `set_favorite` | Add a food or activity to favourites, or remove it. |
| `get_period_overview` | Overview of several days (a week by default): calories, target, activity, macros, tracked nutrients and drinks per day and on average, including averages against the nutrient goals. |
| `list_templates` / `create_template` | List saved day templates, or save a whole day as a new one. |
| `apply_template` / `delete_template` | Write a saved template into the diary on chosen dates, or delete it. |
| `log_weight` | Record your weight for a day (one value per day; logging again replaces it). |

### Recipes

The site calls a saved recipe a *meal*. `create_meal` composes one from
existing foods, so "3 eggs and 200 ml milk" becomes a single reusable item
rather than two entries typed out every time.

Quantities follow the same rule as `log_food`: `amount` counts **units**, not
grams. Omitting `unit_id` selects the food's own base unit, which is grams for
solids and millilitres for liquids — what recipes are normally written in. Pass
a `unit_id` from `get_food_portions` and the count multiplies it, so 2 of
`porce (250 ml)` is 500 ml. Getting this backwards is easy: an early test asked
for 100 of the `100 ml` unit and quietly created a recipe containing ten litres
of milk.

## How it works

kaloricketabulky.cz is a Spring MVC app where every route also answers JSON if you append `?format=json`, returning a `{code, data, message}` envelope. There is no official or documented API — these endpoints were recovered from the site's own frontend JavaScript. See `src/kt/client.ts` for the full map.

```
Agent  ──OAuth 2.1──►  kt-mcp  ──JSESSIONID──►  kaloricketabulky.cz
       ──MCP/HTTPS─►
```

Two credentials, doing different jobs:

| Secret | Guards |
|---|---|
| `MCP_AUTH_PASSWORD` | Who may connect this server to an agent. You type it once in a browser during the OAuth consent step. |
| `KT_PASSWORD` | The kaloricketabulky.cz account the tools write to. Never leaves the server. |

### What happens when you connect

You never create or copy a token by hand — OAuth does it for you:

1. You put your **kaloricketabulky.cz login** (`KT_EMAIL` / `KT_PASSWORD`) and a
   **passphrase you invent** (`MCP_AUTH_PASSWORD`) into the server's environment
   (`.env`). The kaloricketabulky.cz credentials stay on your server; the agent
   never sees them.
2. In your agent you add the connector URL, `https://<your-host>/mcp`. The agent
   registers itself with your server automatically (dynamic client registration).
3. A browser page opens — your server's consent screen. You type
   `MCP_AUTH_PASSWORD` once.
4. Your server mints a unique, random access token and hands it to the agent,
   which stores it and refreshes it automatically. From then on every tool call
   is authenticated with that token.

Because every person runs their own instance, every token is theirs alone: your
server knows only your diary and only mints tokens for whoever knows your
passphrase. Nothing is shared between installations, and there is no central
service.

## Local development

```bash
npm install
cp .env.example .env      # fill in your credentials
npm run build
npm test

set -a; source .env; set +a
PUBLIC_URL=https://localhost:8092 node dist/index.js
```

`GET /healthz` returns the resolved public MCP endpoint, which is the quickest way to confirm `PUBLIC_URL` is what you think it is.

## Self-hosting

> ⚠️ The server should run around the clock — on a PC that sleeps, scheduled
> logging fails. Details and recommendations in [HOSTING.md](HOSTING.md).

The reference deployment uses Docker, nginx, and a free Cloudflare Tunnel — no inbound port is opened on your host or router. Any other way of putting an HTTPS hostname in front of the container works too; the tunnel is just the cheapest safe default.

Request path:

```
Cloudflare → cloudflared (host network) → 127.0.0.1:80 → nginx → kt-mcp:8092
```

nginx publishes on the host loopback only and `cloudflared` dials out. The nginx config
(`deploy/nginx.conf.template`) disables proxy buffering, without which Server-Sent
Events would be held until the stream closed and tool calls would stall.

**1. Create the tunnel** (once), in the Cloudflare Zero Trust dashboard → Networks → Tunnels:

- Create a tunnel, copy the **tunnel token**.
- Add a public hostname with service **`HTTP`** → **`localhost:80`**. The
  stack's `cloudflared` runs in host network mode, so `localhost:80` is the
  nginx published on the host loopback. Plain `http`, because the tunnel
  terminates TLS.

The hostname you choose is referred to below as `<your-host>`; any domain on
your Cloudflare account works, and nothing in the code is tied to it.

**2. Build the image**, from this directory:

```bash
docker compose build
```

**3. Deploy the stack.** `deploy/stack.yml` is the runtime compose file (works standalone or as a Portainer stack); set these environment variables:

| Variable | Value |
|---|---|
| `KT_EMAIL` / `KT_PASSWORD` | Your kaloricketabulky.cz login |
| `MCP_HOSTNAME` | `<your-host>` — the bare hostname, no scheme. nginx renders it into its config at start-up |
| `MCP_AUTH_PASSWORD` | A long passphrase you choose (min 12 chars) |
| `PUBLIC_URL` | `https://<your-host>` — must match the tunnel hostname exactly |
| `TUNNEL_TOKEN` | From step 1 |

Keep `docker-compose.yml` and `deploy/stack.yml` in sync — the first builds the image, the second runs it.

**4. Check the deployment** before wiring it into an agent:

```bash
./scripts/verify-deployment.sh https://<your-host>
```

**5. Connect your agent.** In Claude: Settings → Connectors → Add custom connector → enter `https://<your-host>/mcp`. The agent registers itself, opens the consent page, and you enter `MCP_AUTH_PASSWORD` once. Other MCP clients follow their own "add remote MCP server" flow with the same URL.

### Changing the domain later

The hostname is not baked into the image — only `PUBLIC_URL` and the tunnel's
public hostname need to agree. To move:

1. Point the tunnel's public hostname at the new domain (or create a new tunnel
   and swap `TUNNEL_TOKEN`).
2. Update `PUBLIC_URL` on the stack and redeploy.
3. Re-run the verification script, then remove and re-add the connector in
   your agent.

Step 3 is required: `PUBLIC_URL` is the OAuth issuer and the RFC 8707 resource
identifier, so tokens issued under the old hostname are correctly rejected
after the move.

### Alternative: Azure Container Apps

If you would rather not look after a machine, `deploy/azure/` deploys the
server to Azure Container Apps. Azure terminates HTTPS, so there is no nginx
and no Cloudflare tunnel. All you need is the
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (2.53 or
newer) and `KT_EMAIL`, `KT_PASSWORD` and `MCP_AUTH_PASSWORD` in `.env` or in
the environment:

```bash
az login
./deploy/azure/deploy.sh
```

The script creates the resource group, registry, storage and environment,
builds the image inside Azure (`az acr build`, no local Docker needed), deploys
the app and runs `scripts/verify-deployment.sh`. It finishes by printing the
connector URL. Ship a new version by running the same command again.

What `deploy/azure/main.bicep` sets up, and why:

- **Exactly one replica, always on.** Tokens live in a single JSON file cached
  in process memory. A second replica would overwrite it, and scaling to zero
  would put a cold start in front of scheduled logging.
- **`/data` on Azure Files**, so a redeploy doesn't force reconnecting the
  connector. The share is mounted `0600` for the `node` user.
- **Secrets as Container App secrets.** They reach Azure through
  `main.bicepparam` from environment variables, never on a command line.
- **Rate limiting works unchanged.** The Container Apps ingress is one proxy
  hop and appends the real client IP to `X-Forwarded-For`, which is what
  `trust proxy 1` expects. Put another proxy in front (Front Door, say) and
  that setting has to change.

Optional variables: `AZURE_RESOURCE_GROUP` (default `kt-mcp`),
`AZURE_LOCATION` (`westeurope`), `AZURE_APP_NAME` (`kt-mcp`) and
`AZURE_PUBLIC_URL`. Expect a few dollars a month, most of it the Basic-tier
registry.

**Custom domain.** Without one the server runs at
`https://kt-mcp.<something>.<region>.azurecontainerapps.io`. For your own
domain, create the DNS records `az containerapp hostname add` prints, bind the
domain with a managed certificate, and redeploy with the new URL:

```bash
az containerapp hostname add -g kt-mcp -n kt-mcp --hostname kt.example.com
az containerapp hostname bind -g kt-mcp -n kt-mcp --hostname kt.example.com \
  --environment kt-mcp-env --validation-method CNAME
AZURE_PUBLIC_URL=https://kt.example.com ./deploy/azure/deploy.sh
```

As with the tunnel, remove and re-add the connector in your agent afterwards.

### Stuck, or nowhere to run it?

If you hit a wall self-hosting, open a [GitHub issue](../../issues) — happy to
help you get unstuck, that's what the issue tracker is for.

Self-hosting does need a machine that is always on (see
[HOSTING.md](HOSTING.md)) and a Cloudflare account. If you have no way to run
it at all, you can reach me at **kt-mcp@stanwhy.me** and we can figure
something out — just know that running a private instance means real server
costs, which would be yours to cover.

## Authentication

The server is its own OAuth 2.1 authorization server, implementing what the MCP spec requires of a protected resource:

- `/.well-known/oauth-protected-resource/mcp` — RFC 9728 discovery
- `/.well-known/oauth-authorization-server` — RFC 8414 discovery
- `/authorize`, `/token`, `/register`, `/revoke` — authorization code + PKCE, dynamic client registration, refresh-token rotation

Access tokens live 30 days and are persisted to `/data` on a volume, so redeploying does not force you to reconnect.

### What the passphrase protects

`MCP_AUTH_PASSWORD` is the only way to obtain a token. Every request to `/mcp`
requires a valid bearer token, and tokens are minted solely by the consent form
after a constant-time comparison against that passphrase. Verified by audit
(`scripts/security-audit.sh`): unauthenticated and forged-token calls are
rejected, fabricated authorization codes and refresh tokens are rejected, no
public endpoint exposes a credential, and no verb or path variation reaches the
tools without a token.

Two things are public by design and safe to be so: OAuth discovery documents
(the spec requires them) and dynamic client registration. Registering a client
gets an attacker no further — they still cannot obtain a token without the
passphrase.

Brute force is bounded by a 100-requests-per-15-minutes limit on `/authorize`.
That limiter keys on client IP, so nginx **overwrites** `X-Forwarded-For` with
Cloudflare's verified `CF-Connecting-IP` and the app trusts exactly one proxy
hop. Appending to a caller-supplied header instead — or setting
`trust proxy: true` — lets an attacker forge a fresh bucket per request and
removes the limit entirely.

Residual risks worth knowing: anyone holding the passphrase has full access;
tokens cannot be revoked individually short of deleting `/data/oauth-state.json`;
and because client registration is open, a phishing link to the consent page
could capture the passphrase if you typed it there — check the client name shown
on the form before authorizing.

## Caveats

- **Undocumented upstream.** Dine4Fit guarantees nothing here; a frontend refactor could change payload shapes without warning. The client throws on anything unexpected rather than guessing, so breakage surfaces as a loud error rather than a wrong calorie count.
- **`md5(password)` is password-equivalent.** The site hashes the password client-side, so the hash is as sensitive as the password. Treat `KT_PASSWORD` accordingly.
- **One account per instance.** The server logs into a single kaloricketabulky.cz account. Two people, two containers.
- **Personal use.** Automating entry into your own account is a far softer position than bulk scraping, but it is still outside anything Dine4Fit has sanctioned. Keep the request rate human, and don't build a competing client on it.
- **Reading a day's individual entries** is the least-verified endpoint; `get_day_summary` passes the site's response through unmodified because its shape isn't fully documented.
- **Partial portions of a recipe cannot be logged.** The meal-add form offers a `count` against portion, percent and gram pseudo-units, but the server ignores it and logs the whole recipe regardless — measured against a 249 kcal recipe, both 0.5 portions and half the total weight added the full 249. `log_meal` therefore takes no `portions` argument; log the ingredients individually with `log_food` when only part of a recipe was eaten.

## License

[MIT](LICENSE). The food database and the kaloricketabulky.cz service belong to Dine4Fit, a.s. — this licence covers only the code in this repository.
