# Level Engine — Setup Sicuro

## Struttura del progetto

```
level-engine/
├── index.html                        ← il sito
├── netlify.toml                      ← configurazione Netlify + header sicurezza
└── netlify/
    └── functions/
        └── github-proxy.js           ← proxy sicuro (il token sta qui, lato server)
```

---

## 1. Preparare la repo GitHub

1. Crea una repo pubblica su GitHub (es: `mario/gem-games-storage`)
2. Aggiungi un file `games.json` con contenuto: `[]`
3. Aggiungi una cartella `games/` con un file `.gitkeep` vuoto dentro
4. Aggiungi una cartella `reports/` con un file `.gitkeep` vuoto dentro

---

## 2. Creare il token GitHub

- GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
- Clicca **Generate new token (classic)**
- Spunta solo la casella **`repo`**
- Copia il token (visibile solo una volta)

---

## 3. Modificare index.html

Apri `index.html` e trova le righe con la configurazione:

```js
const GITHUB_REPO     = 'UTENTE/nome-repo';        // ← metti il tuo utente/repo
const UPLOAD_PASSWORD = 'INSERISCI_PASSWORD_QUI';  // ← scegli una password
```

> ⚠️ La password è visibile nel sorgente pubblico della pagina — è normale e intenzionale.
> La verifica REALE avviene lato server nel proxy, che legge `UPLOAD_PASSWORD` dalle
> variabili d'ambiente Netlify. Il token GitHub non appare mai nel sorgente.

---

## 4. Attivare Google AdSense (opzionale)

Nel file `index.html`, cerca:

```js
s.src = 'https://pagead2.googlesyndication.com/...?client=ca-pub-XXXXXXXXXXXXXXXXX';
```

Sostituisci `ca-pub-XXXXXXXXXXXXXXXXX` con il tuo **Publisher ID** Google AdSense.
AdSense viene caricato **solo dopo consenso esplicito** dell'utente (GDPR compliant).

---

## 5. Attivare Ko-fi

Nel file `index.html`, cerca:

```html
<a href="https://ko-fi.com/TUOUSERNAME" ...>
```

Sostituisci `TUOUSERNAME` con il tuo username Ko-fi.

---

## 6. Caricare su Netlify

### Opzione A — Collegare GitHub (consigliata, deploy automatico)
1. Netlify → **Add new site** → **Import an existing project**
2. Collega GitHub e seleziona la repo dove hai messo questi file
3. Build settings: **Publish directory** = `.`  |  **Functions directory** = `netlify/functions`
4. Clicca **Deploy site**

### Opzione B — Drag & drop manuale
1. Netlify → il tuo sito → **Deploys** → trascina l'intera cartella

---

## 7. Impostare le variabili d'ambiente su Netlify ← FONDAMENTALE

Netlify → il tuo sito → **Site configuration** → **Environment variables** → **Add variable**

| Key               | Valore                              |
|-------------------|-------------------------------------|
| `GITHUB_TOKEN`    | il token copiato al passo 2         |
| `GITHUB_REPO`     | `tuoutente/nome-repo`               |
| `UPLOAD_PASSWORD` | la password scelta al passo 3       |
| `ALLOWED_ORIGIN`  | `https://tuosito.netlify.app` ← URL esatto del tuo sito Netlify (protegge il proxy da chiamate esterne) |

> ⚠️ Dopo aver aggiunto le variabili, vai su **Deploys** → **Trigger deploy** per riavviare.

---

## Come funziona la sicurezza

```
Browser  →  Netlify Function (server)  →  GitHub API
             (legge GITHUB_TOKEN
              dall'ambiente, mai
              visibile nel browser)
```

### Misure di sicurezza implementate

| Area | Misura |
|------|--------|
| **Token GitHub** | Mai nel sorgente — solo in env Netlify |
| **CORS** | Limitato al dominio Netlify via `ALLOWED_ORIGIN` (env var) |
| **Path traversal** | Whitelist stretta su GET e PUT nel proxy — nessun path arbitrario accettato |
| **Path PUT** | Voti → solo `games.json`; segnalazioni → solo `reports/`; upload → solo `games/` o `games.json` con password |
| **Content size** | Limite 5 MB lato proxy (non aggirabile via JS client) |
| **SHA Git** | Validato come hex 40 caratteri — injection impossibile |
| **Commit message** | Sanitizzato: caratteri di controllo rimossi, troncato a 200 caratteri |
| **GITHUB_REPO format** | Validato con regex `user/repo` — no injection nell'URL API |
| **Google Fonts** | Base legale: interesse legittimo (art. 6.1.f GDPR) — dichiarato nelle policy |
| **Google AdSense** | Caricato SOLO dopo consenso esplicito (art. 6.1.a GDPR) |
| **Consenso cookie** | Scadenza automatica 13 mesi con timestamp |
| **iframe giochi** | `sandbox` senza `allow-same-origin` — i giochi non accedono al localStorage del sito |
| **XSS gallery** | Rimossi tutti gli onclick inline con dati utente — sostituiti con `data-*` + event delegation |
| **`showPlayTab`** | Riceve il bottone come parametro esplicito — rimosso `event` globale implicito |
| **Content-Security-Policy** | Header HTTP completo in netlify.toml — tutti i domini AdSense inclusi |
| **HSTS** | Header HTTP — forza HTTPS per 1 anno con preload |
| **Rate limiting** | Max 10 voti/segnalazioni per IP ogni 15 minuti nel proxy |
| **Fingerprint voti** | Hash djb2 non reversibile — non identifica l'utente |
| **XSS rendering** | Funzione `esc()` su tutti i dati GitHub prima del rendering HTML |
| **Validazione upload** | Solo `.html`, max 5 MB client-side + max 5 MB server-side, password verificata lato server |
| **robots.txt** | `/.netlify/` escluso dall'indicizzazione |
| **Meta tag SEO** | Open Graph, Twitter Card, referrer policy |

### Note legali
- Privacy Policy conforme GDPR (Reg. UE 2016/679)
- Cookie Policy conforme Direttiva ePrivacy 2002/58/CE e Linee Guida Garante 2021
- Termini d'uso conformi al Digital Services Act (Reg. UE 2022/2065)
- Età minima: 16 anni (art. 8 GDPR, D.Lgs. 101/2018)
- Piattaforma ODR indicata nei termini per controversie consumer
