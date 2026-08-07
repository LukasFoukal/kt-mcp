# Kde to provozovat / Where to run it

**🇨🇿 Česky** (English below)

## ⚠️ Server musí běžet 24/7

kt-mcp je server, ke kterému se váš agent připojuje, kdykoli chcete něco
zapsat — a naplánované úlohy („každé ráno zapiš dvě kávy") se spouštějí, i když
zrovna nesedíte u počítače. Když stroj, na kterém kt-mcp běží, spí nebo je
vypnutý, konektor je mrtvý: ruční zápisy selžou a naplánované se tiše
neprovedou.

**Doporučení:** provozujte ho na něčem, co běží nepřetržitě —

- malý **VPS** (nejlevnější instance kdekoli bohatě stačí; server je nenáročný),
- **domácí server**, NAS s Dockerem, nebo Raspberry Pi,
- jakýkoli stroj, který stejně nikdy nevypínáte.

Běžné **PC nebo notebook funguje také** — nic v projektu na tom nezávisí — jen
počítejte s tím, že konektor žije a umírá s tím strojem. Pokud PC na noc
uspáváte, naplánované ranní zápisy neproběhnou. Cloudflare tunel se po
probuzení stroje sám znovu připojí, takže výpadek je jen dočasný, ale u
jídelníčku, který má smysl hlavně tehdy, když je úplný, se vyplatí stroj,
který neusíná.

---

**🇬🇧 English**

## ⚠️ The server needs to run 24/7

kt-mcp is a server your agent connects to whenever you want to log something —
and scheduled tasks ("log two coffees every morning") fire even when you are
not at your computer. When the machine running kt-mcp is asleep or powered
off, the connector is dead: manual logging fails and scheduled runs silently
do nothing.

**Recommendation:** run it on something that is always on —

- a small **VPS** (the cheapest instance anywhere is plenty; the server is tiny),
- a **home server**, a NAS that runs Docker, or a Raspberry Pi,
- any machine you never switch off anyway.

A regular **PC or laptop works too** — nothing in the project depends on the
hardware — just understand the connector lives and dies with that machine. If
your PC sleeps overnight, your scheduled morning entries won't happen. The
Cloudflare tunnel reconnects by itself when the machine wakes, so outages are
only temporary, but for a food diary that is mostly useful when it is complete,
an always-on box is worth it.
