# kt-mcp

**🇨🇿 Česky** · [🇬🇧 English](README.en.md)

Self-hosted [MCP](https://modelcontextprotocol.io) server, který propojí AI agenta s vaším jídelníčkem na **kaloricketabulky.cz**.

Řeknete *„snědl jsem 3 vejce a banán"* — agent prohledá českou databázi potravin, vybere správnou porci a zapíše záznamy do vašeho skutečného jídelníčku. Oficiální aplikace zůstává zdrojem pravdy, takže prémiové funkce fungují dál.

Postaveno a otestováno s **Claudem** (desktop, mobil i web přes custom connector), ale server mluví standardním MCP přes HTTPS s OAuth 2.1, takže se může připojit jakýkoli agent, který podporuje vzdálené MCP servery.

> ## Neoficiální projekt, bez vazby na Dine4Fit
>
> kaloricketabulky.cz provozuje společnost **Dine4Fit, a.s.**, která s tímto
> projektem nemá nic společného a nijak ho neschvaluje. Veřejné API neexistuje;
> zde použité endpointy byly vyčteny z frontendového JavaScriptu samotného webu
> a mohou se kdykoli bez varování změnit nebo rozbít.
>
> Podmínky Dine4Fit udělují **osobní, nekomerční** licenci. Tento software je
> zveřejněn proto, abyste si mohli zautomatizovat přístup ke **svému vlastnímu
> účtu** — což licence dovoluje. Provozovat ho jako placenou nebo víceuživatelskou
> službu, případně dál šířit potravinová data, která vrací, je jiná věc a jde
> na váš vrub. Databáze patří Dine4Fit a je chráněna evropskými databázovými právy.
>
> Držte frekvenci požadavků na lidské úrovni. Nestavte na tom konkurenčního klienta.

## Co s tím jde dělat

Jakmile je agent připojený, přestane být zapisování jídel otravným proklikáváním vyhledávání. Pár vzorů, které v praxi fungují dobře:

- **Zapisujte mluvením.** „K snídani jsem měl rohlík se šunkou a dvě vejce." Agent vyhledá potraviny, zvolí přirozené porce (*kus (55 g)* místo odhadovaných gramů) a zapíše každou položku do správného denního jídla.

- **Zautomatizujte rutinu.** Pijete každý den dvě kávy s mlékem — proč je vypisovat? Pokud váš agent umí naplánované úlohy (Claude umí), řekněte mu to jednou: *„Každý den v 9:00 mi zapiš do jídelníčku dvě espressa s mlékem."* Denní konstanty se zapisují samy.

- **Vyfoťte talíř.** Pošlete agentovi fotku oběda a zeptejte se, co na ní je. Rozpozná potraviny, odhadne reálné gramáže z obrázku, spočítá kalorie — a po potvrzení zaloguje. Odhad je odhad, ale u míchaných talířů je to lepší než nezapsat nic.

- **Vyfoťte recept.** Vyfoťte recept z kuchařky nebo screenshot z webu a řekněte *„ulož mi to jako jídlo"*. Agent přečte suroviny, každou najde v databázi a vytvoří uložený recept — příště zalogujete jedním záznamem. Cestou můžete upravovat: *„vyměň smetanu za bílý jogurt a dej poloviční cukr."*

- **Zapisujte pohyb a váhu.** „Ráno jsem šel 40 minut rychlou chůzí" vyhledá aktivitu a zapíše ji; kalorie spočítá web podle vaší váhy. Když znáte spálené kalorie z hodinek, zapíšou se přesně ty. A „dnes vážím 82,4" zapíše váhu k dnešku.

- **Ptejte se, jak vám jde den.** „Kolik kalorií mi dnes zbývá?" přečte denní součty přímo z jídelníčku. A „kolik bílkovin mi ještě chybí?" porovná den s cíli živin, které máte nastavené na webu — agent pak může navrhnout, co sníst, abyste je trefili.

## Nástroje

| Nástroj | Účel |
|---|---|
| `search_food` | Najde potraviny podle českého názvu nebo 13místného EAN kódu. Vrací id potraviny, které potřebují ostatní nástroje. |
| `get_food_portions` | Vypíše přirozené porce potraviny (`kus (55 g)`, `velký kus (60 g)`), takže „3 vejce" se zapíšou jako tři kusy, ne odhadnutá váha. |
| `get_food_nutrition` | Kalorie a makra pro dané množství, přepočítané samotným webem. Pouze čtení. |
| `log_food` | Zapíše záznam o jídle do jídelníčku. |
| `get_day_summary` | Přečte denní součty. |
| `get_day_progress` | Porovná den s denními cíli z webu: energie, bílkoviny, sacharidy, tuky, vláknina a všechny další sledované živiny (cukry, sůl…), pitný režim a váha — kolik je snědeno, kolik je cíl a kolik zbývá. |
| `create_meal` | Uloží recept složený z existujících potravin. |
| `list_my_meals` | Vypíše uložené recepty s jejich id a celkovou energií. |
| `log_meal` | Zaloguje celý uložený recept jako jeden záznam. |
| `delete_meal` | Smaže uložený recept. |
| `search_activity` | Najde aktivitu (chůze, běh, kolo…) v české databázi. |
| `log_activity` | Zapíše aktivitu na zadaný počet minut; kalorie spočítá web podle vaší váhy. |
| `log_custom_activity` | Zapíše aktivitu s kaloriemi, které znáte, třeba z hodinek. |
| `get_day_entries` | Vypíše všechny záznamy dne: jídla podle denních jídel i aktivity, s id, množstvím a kaloriemi. |
| `delete_diary_entry` | Smaže jeden záznam jídla, receptu nebo aktivity, třeba chybný nebo duplicitní. |
| `edit_diary_entry` | Změní množství nebo jednotku jídla, délku aktivity, nebo přesune jídlo do jiného denního jídla. |
| `copy_meal` | Zkopíruje jídlo (třeba včerejší snídani) na jiný den nebo do jiného denního jídla, celé nebo jen vybrané potraviny. |
| `log_own_food` | Zapíše jídlo, které v databázi není, s vlastními hodnotami (např. z etikety). Vytvoří jen záznam v deníku, ne novou potravinu v databázi. |
| `add_note` | Přidá poznámku k celému dni nebo k jednomu jídlu. |
| `get_usual_items` | Vypíše oblíbené a nejpoužívanější potraviny a aktivity. |
| `set_favorite` | Přidá potravinu nebo aktivitu do oblíbených, nebo ji z nich odebere. |
| `get_period_overview` | Přehled za více dní (výchozí týden): kalorie, cíl, aktivita, makra, sledované živiny a pitný režim po dnech i v průměru, včetně průměru vůči cílům živin. |
| `list_templates` / `create_template` | Vypíše uložené jídelníčky, nebo uloží celý den jako nový. |
| `apply_template` / `delete_template` | Zapíše uložený jídelníček na zvolené dny, nebo ho smaže. |
| `log_weight` | Zapíše váhu k danému dni (jedna hodnota na den, nový zápis ji přepíše). |

### Recepty

Web říká uloženému receptu *jídlo* (meal). `create_meal` ho složí
z existujících potravin, takže „3 vejce a 200 ml mléka" je jedna znovupoužitelná
položka místo dvou záznamů vypisovaných pokaždé znovu.

Množství se řídí stejným pravidlem jako `log_food`: `amount` počítá **jednotky**,
ne gramy. Vynecháte-li `unit_id`, použije se základní jednotka potraviny — gramy
u pevných potravin, mililitry u tekutin — tedy to, v čem se recepty běžně píší.
Když předáte `unit_id` z `get_food_portions`, počet ho násobí: 2 × `porce
(250 ml)` je 500 ml. Splést se je snadné: jeden raný test zadal 100 jednotek
`100 ml` a potichu vytvořil recept s deseti litry mléka.

## Jak to funguje

kaloricketabulky.cz je Spring MVC aplikace, kde každá routa odpoví i v JSON, když přidáte `?format=json` — vrací obálku `{code, data, message}`. Žádné oficiální ani dokumentované API neexistuje; endpointy byly zrekonstruovány z frontendového JavaScriptu webu. Úplná mapa je v `src/kt/client.ts`.

```
Agent  ──OAuth 2.1──►  kt-mcp  ──JSESSIONID──►  kaloricketabulky.cz
       ──MCP/HTTPS─►
```

Dvě hesla, každé hlídá něco jiného:

| Tajemství | Hlídá |
|---|---|
| `MCP_AUTH_PASSWORD` | Kdo smí tento server připojit k agentovi. Zadáváte ho jednou v prohlížeči při OAuth souhlasu. |
| `KT_PASSWORD` | Účet na kaloricketabulky.cz, do kterého nástroje zapisují. Nikdy neopouští server. |

### Co se stane při připojení

Žádný token ručně nevytváříte ani nekopírujete — OAuth to udělá za vás:

1. Do prostředí serveru (`.env`) vložíte svůj **login na kaloricketabulky.cz**
   (`KT_EMAIL` / `KT_PASSWORD`) a **přístupovou frázi, kterou si vymyslíte**
   (`MCP_AUTH_PASSWORD`). Přihlašovací údaje ke kalorickým tabulkám zůstávají
   na vašem serveru; agent je nikdy nevidí.
2. V agentovi přidáte URL konektoru, `https://<your-host>/mcp`. Agent se u
   vašeho serveru zaregistruje sám (dynamická registrace klientů).
3. Otevře se stránka v prohlížeči — obrazovka souhlasu vašeho serveru. Jednou
   zadáte `MCP_AUTH_PASSWORD`.
4. Váš server vygeneruje unikátní náhodný přístupový token a předá ho agentovi,
   který si ho uloží a automaticky obnovuje. Od té chvíle je každé volání
   nástroje ověřené tímto tokenem.

Protože si každý provozuje vlastní instanci, každý token patří jen jemu: váš
server zná jen váš jídelníček a tokeny vydává jen tomu, kdo zná vaši frázi.
Mezi instalacemi se nesdílí nic a žádná centrální služba neexistuje.

## Lokální vývoj

```bash
npm install
cp .env.example .env      # doplňte své údaje
npm run build
npm test

set -a; source .env; set +a
PUBLIC_URL=https://localhost:8092 node dist/index.js
```

`GET /healthz` vrací výsledný veřejný MCP endpoint — nejrychlejší způsob, jak ověřit, že `PUBLIC_URL` je opravdu to, co si myslíte.

## Vlastní hosting

> ⚠️ Server by měl běžet nepřetržitě — na uspávaném PC selžou naplánované
> zápisy. Podrobnosti a doporučení v [HOSTING.md](HOSTING.md).

Referenční nasazení používá Docker, nginx a Cloudflare Tunnel zdarma — na hostiteli ani routeru se neotvírá žádný příchozí port. Funguje ale cokoli jiného, co před kontejner postaví HTTPS hostname; tunel je jen nejlevnější bezpečná výchozí volba.

Cesta požadavku:

```
Cloudflare → cloudflared (host network) → 127.0.0.1:80 → nginx → kt-mcp:8092
```

nginx poslouchá jen na loopbacku hostitele a `cloudflared` se připojuje ven.
Konfigurace nginx (`deploy/nginx.conf.template`) vypíná proxy buffering — bez
toho by Server-Sent Events čekaly na konec streamu a volání nástrojů by se
zasekávala.

**1. Vytvořte tunel** (jednou), v Cloudflare Zero Trust dashboardu → Networks → Tunnels:

- Vytvořte tunel, zkopírujte **tunnel token**.
- Přidejte public hostname se službou **`HTTP`** → **`localhost:80`**.
  `cloudflared` ze stacku běží v host network módu, takže `localhost:80` je
  nginx publikovaný na loopbacku hostitele. Obyčejné `http`, protože TLS
  ukončuje tunel.

Zvolený hostname je dále označován `<your-host>`; funguje jakákoli doména na
vašem Cloudflare účtu a nic v kódu na ni není vázané.

**2. Sestavte image**, z tohoto adresáře:

```bash
docker compose build
```

**3. Nasaďte stack.** `deploy/stack.yml` je runtime compose soubor (funguje samostatně i jako Portainer stack); nastavte tyto proměnné prostředí:

| Proměnná | Hodnota |
|---|---|
| `KT_EMAIL` / `KT_PASSWORD` | Váš login na kaloricketabulky.cz |
| `MCP_HOSTNAME` | `<your-host>` — holý hostname bez schématu. nginx si ho při startu doplní do konfigurace |
| `MCP_AUTH_PASSWORD` | Dlouhá přístupová fráze, kterou si zvolíte (min. 12 znaků) |
| `PUBLIC_URL` | `https://<your-host>` — musí přesně odpovídat hostname tunelu |
| `TUNNEL_TOKEN` | Z kroku 1 |

Udržujte `docker-compose.yml` a `deploy/stack.yml` v souladu — první sestavuje image, druhý ho spouští.

**4. Ověřte nasazení**, než ho připojíte k agentovi:

```bash
./scripts/verify-deployment.sh https://<your-host>
```

**5. Připojte agenta.** V Claudovi: Settings → Connectors → Add custom connector → zadejte `https://<your-host>/mcp`. Agent se sám zaregistruje, otevře stránku souhlasu a vy jednou zadáte `MCP_AUTH_PASSWORD`. Ostatní MCP klienti mají vlastní postup „přidat vzdálený MCP server" se stejnou URL.

### Pozdější změna domény

Hostname není zapečený v image — shodovat se musí jen `PUBLIC_URL` a public
hostname tunelu. Přesun:

1. Přesměrujte public hostname tunelu na novou doménu (nebo vytvořte nový tunel
   a vyměňte `TUNNEL_TOKEN`).
2. Aktualizujte `PUBLIC_URL` na stacku a znovu nasaďte.
3. Znovu spusťte ověřovací skript, pak v agentovi konektor odeberte a přidejte
   znovu.

Krok 3 je nutný: `PUBLIC_URL` je OAuth issuer a identifikátor zdroje podle
RFC 8707, takže tokeny vydané pod starým hostname jsou po přesunu správně
odmítnuty.

### Alternativa: Azure Container Apps

Pokud nechcete spravovat vlastní stroj, `deploy/azure/` nasadí server do
Azure Container Apps. HTTPS zajistí Azure, takže odpadá nginx i Cloudflare
tunel. Potřebujete jen [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
(verze 2.53 nebo novější) a `KT_EMAIL`, `KT_PASSWORD` a `MCP_AUTH_PASSWORD`
v `.env` nebo v prostředí:

```bash
az login
./deploy/azure/deploy.sh
```

Skript vytvoří resource group, registr, úložiště a prostředí, sestaví image
přímo v Azure (`az acr build`, lokální Docker není potřeba), nasadí aplikaci
a spustí `scripts/verify-deployment.sh`. Na konci vypíše URL konektoru. Nová
verze se nasazuje stejným příkazem.

Co šablona `deploy/azure/main.bicep` nastavuje a proč:

- **Právě jedna replika, stále zapnutá.** Tokeny jsou v jednom JSON souboru
  drženém v paměti procesu. Druhá replika by ho přepisovala a škálování na nulu
  by zpomalilo naplánované zápisy studeným startem.
- **`/data` na Azure Files**, takže redeploy nevynutí nové připojení
  konektoru. Sdílení je připojené s právy `0600` pro uživatele `node`.
- **Tajné hodnoty jako secrets Container App.** Do Azure putují přes
  `main.bicepparam` z proměnných prostředí, nikdy přes příkazovou řádku.
- **Rate limiting funguje beze změny.** Ingress Container Apps je jeden proxy
  hop a skutečnou IP klienta přidává na konec `X-Forwarded-For`, což odpovídá
  `trust proxy 1`. Pokud před aplikaci přidáte další proxy (např. Front Door),
  musí se tohle nastavení upravit.

Volitelné proměnné: `AZURE_RESOURCE_GROUP` (výchozí `kt-mcp`),
`AZURE_LOCATION` (`westeurope`), `AZURE_APP_NAME` (`kt-mcp`) a
`AZURE_PUBLIC_URL`. Náklady jsou řádově jednotky dolarů měsíčně, většinu tvoří
registr (tier Basic).

**Vlastní doména.** Bez ní server běží na
`https://kt-mcp.<něco>.<region>.azurecontainerapps.io`. Pro vlastní doménu
vytvořte v DNS záznamy, které vypíše `az containerapp hostname add`, doménu
navažte se spravovaným certifikátem a nasaďte znovu s novou URL:

```bash
az containerapp hostname add -g kt-mcp -n kt-mcp --hostname kt.example.com
az containerapp hostname bind -g kt-mcp -n kt-mcp --hostname kt.example.com \
  --environment kt-mcp-env --validation-method CNAME
AZURE_PUBLIC_URL=https://kt.example.com ./deploy/azure/deploy.sh
```

Stejně jako u tunelu pak konektor v agentovi odeberte a přidejte znovu.

### Zaseklí, nebo nemáte kde hostovat?

Pokud při vlastním hostování narazíte, založte [GitHub issue](../../issues) —
rád pomůžu, od toho issue tracker je.

Vlastní hosting potřebuje stroj, který běží nepřetržitě (viz
[HOSTING.md](HOSTING.md)), a účet u Cloudflare. Pokud nemáte kde server
provozovat, ozvěte se na **kt-mcp@stanwhy.me** a něco vymyslíme — jen počítejte
s tím, že provoz privátní instance znamená reálné náklady na server, které by
šly za vámi.

## Autentizace

Server je sám sobě OAuth 2.1 autorizačním serverem a implementuje, co MCP specifikace od chráněného zdroje vyžaduje:

- `/.well-known/oauth-protected-resource/mcp` — RFC 9728 discovery
- `/.well-known/oauth-authorization-server` — RFC 8414 discovery
- `/authorize`, `/token`, `/register`, `/revoke` — authorization code + PKCE, dynamická registrace klientů, rotace refresh tokenů

Přístupové tokeny žijí 30 dní a persistují se do `/data` na volume, takže redeploy nevynutí nové připojení konektoru.

### Co chrání přístupová fráze

`MCP_AUTH_PASSWORD` je jediná cesta k získání tokenu. Každý požadavek na `/mcp`
vyžaduje platný bearer token a tokeny vydává výhradně formulář souhlasu po
porovnání s frází v konstantním čase. Ověřeno auditem
(`scripts/security-audit.sh`): neautentizovaná volání i volání s padělaným
tokenem jsou odmítnuta, vymyšlené autorizační kódy a refresh tokeny jsou
odmítnuty, žádný veřejný endpoint nevydává credential a žádná variace metody či
cesty se k nástrojům bez tokenu nedostane.

Dvě věci jsou veřejné záměrně a bezpečně: OAuth discovery dokumenty (vyžaduje je
specifikace) a dynamická registrace klientů. Registrace klienta útočníkovi nic
nedá — token bez fráze stále nezíská.

Hrubou sílu omezuje limit 100 požadavků za 15 minut na `/authorize`. Limiter
klíčuje podle IP klienta, proto nginx **přepisuje** `X-Forwarded-For` ověřenou
hlavičkou `CF-Connecting-IP` od Cloudflare a aplikace věří přesně jednomu proxy
hopu. Připojování k hlavičce od klienta — nebo `trust proxy: true` — by útočníkovi
dovolilo vyrobit si nový bucket pro každý požadavek a limit by přestal existovat.

Zbytková rizika, o kterých je dobré vědět: kdokoli s frází má plný přístup;
jednotlivé tokeny nelze odvolat jinak než smazáním `/data/oauth-state.json`;
a protože registrace klientů je otevřená, phishingový odkaz na stránku souhlasu
by mohl frázi zachytit, kdybyste ji tam zadali — před autorizací zkontrolujte
jméno klienta zobrazené ve formuláři.

## Omezení

- **Nedokumentovaný upstream.** Dine4Fit tu nic negarantuje; refactoring frontendu může bez varování změnit tvary odpovědí. Klient při čemkoli nečekaném vyhodí chybu místo hádání, takže se rozbití projeví hlasitou chybou, ne špatným počtem kalorií.
- **`md5(hesla)` je ekvivalent hesla.** Web hashuje heslo na klientovi, hash je tedy stejně citlivý jako heslo samotné. Podle toho s `KT_PASSWORD` zacházejte.
- **Jeden účet na instanci.** Server se přihlašuje k jedinému účtu kaloricketabulky.cz. Dva lidé, dva kontejnery.
- **Osobní použití.** Automatizace zápisů do vlastního účtu je mnohem měkčí pozice než hromadný scraping, ale pořád je mimo cokoli, co Dine4Fit posvětil. Držte frekvenci požadavků na lidské úrovni a nestavte na tom konkurenčního klienta.
- **Čtení jednotlivých záznamů dne** je nejméně ověřený endpoint; `get_day_summary` posílá odpověď webu beze změny dál, protože její tvar není plně zdokumentovaný.
- **Část porce receptu zalogovat nejde.** Formulář pro přidání jídla sice nabízí `count` proti pseudo-jednotkám porce, procenta a gramy, ale server ho ignoruje a zaloguje vždy celý recept — měřeno na receptu o 249 kcal přidalo 0,5 porce i polovina váhy plných 249. `log_meal` proto nemá argument `portions`; když snědená byla jen část receptu, zalogujte suroviny jednotlivě přes `log_food`.

## Licence

[MIT](LICENSE). Databáze potravin a služba kaloricketabulky.cz patří Dine4Fit, a.s. — tato licence pokrývá pouze kód v tomto repozitáři.
