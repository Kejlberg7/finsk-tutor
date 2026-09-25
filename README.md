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
Når noten er gemt i databasen, får live-tutoren besked om det. Noterne bliver
ikke automatisk implementeret; de kan markeres som klaret i indbakken.

Løbende checkpoints og afsluttende analyse bruger ekstra OpenAI API-kald.
