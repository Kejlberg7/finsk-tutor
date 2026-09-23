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

## Næste trin

- log sessioner og transskripter
- hent dagens ord og grammatik fra Postgres
- vurder gentagelser og opdater mastery
- tilføj spaced repetition
- test finsk udtale med flere stemmer og eventuelt særskilte TTS-klip
