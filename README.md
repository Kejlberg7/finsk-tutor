# Finsk Tutor

En mobilvenlig finsk samtaletræner med GPT-Live. Første prototype bruger
engelsk som forklaringssprog og korte finske gentagelsesøvelser.

## Lokal kørsel

Kræver Node 20 og en OpenAI project API key med adgang til GPT-Live.

```bash
cp .env.example .env.local
# udfyld OPENAI_API_KEY, TUTOR_PASSWORD og SESSION_SECRET
npm install
npm run dev
```

Åbn `http://localhost:3000`. Mikrofonen kræver brugerens tilladelse.

## Vercel

Projektet er struktureret til Vercel. Sæt disse miljøvariabler i Vercel:

- `OPENAI_API_KEY`
- `TUTOR_PASSWORD`
- `SESSION_SECRET`
- `DATABASE_URL` (når læringsdatabasen tages i brug)

OpenAI-nøglen bruges kun i serverrouten `/api/session`. Browseren opretter en
WebRTC-offer, og serveren udveksler den med GPT-Live.

## Læringshukommelse

Når databasen er sat op, gemmer appen transskripter og vurderer tydelige
ordforsøg løbende i checkpoints cirka hvert 2½ minut. Kun afsluttede
elev/tutor-udvekslinger scores; resten vurderes, når samtalen stoppes og gemmes.
Derfor tælles de samme transkriptfragmenter ikke igen ved afslutningen.
Vurderingen bygger på transskript og tydelige rettelser, ikke en måling af accent.

Forsiden viser de seneste samtaler med transskript og en indbakke til idéer.
Under samtalen kan man sige “Notér idé: …” eller “Notér rettelse: …”.
Tydelige beskrivelser af app-problemer (fx gentagelser eller afbrudt gemning)
bliver også forsøgt gemt automatisk. Kun en eksplicit dikteret note bliver
bekræftet højt af tutoren; tjek listen bagefter, da transskription kan fejle.
Noterne bliver ikke automatisk implementeret; de kan markeres som klaret i
indbakken.

Checkpoints opdaterer ordstatus i baggrunden uden at sende nye talte
instruktioner til den igangværende samtale. Hvis Live-forbindelsen udløber eller
falder ud, forsøger browseren at genoprette den op til tre gange og sender et
kort udsnit af de seneste replikker med som kontekst. Vedvarende netværks- eller
mikrofonproblemer kan stadig kræve, at brugeren starter samtalen igen.

Løbende checkpoints og afsluttende analyse bruger ekstra OpenAI API-kald.

## Skrivebeskyttet API til samtaler og noter

`GET /api/assistant/context` giver de nyeste gemte transskripter og idéer/rettelser
som JSON. Det bruger en separat bearer-token — ikke browserens login-cookie — og
har kun læseadgang. Sæt `TUTOR_READ_API_TOKEN` (mindst 40 tegn) i Vercel for
Production. Generér en token med `openssl rand -hex 32`; gem samme værdi i dit
lokale `.env.local`, så et lokalt script eller en godkendt integration kan kalde
API'et. Tilføj ikke tokenen til Git.

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $TUTOR_READ_API_TOKEN" \
  "https://finsk-tutor.vercel.app/api/assistant/context?sessions=5&notes=50"
```

Parametrene `sessions` og `notes` kan begrænses til henholdsvis 1–20 og 1–100.
API'et svarer `401`, hvis tokenen mangler/er forkert, og returnerer aldrig data
uden gyldig autorisation. Når miljøvariablen tilføjes i Vercel, kræves et nyt
deployment, før endpointet er aktivt.

Når samme token står i `.env.local`, kan den seneste kontekst hentes fra
terminalen uden at åbne browseren:

```bash
npm run tutor:context
```
