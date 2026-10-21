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
falder ud, forsøger browseren at genoprette den op til otte gange og sender et
kort udsnit af de seneste replikker med som kontekst. Vedvarende netværks- eller
mikrofonproblemer kan stadig kræve, at brugeren starter samtalen igen.

Løbende checkpoints og afsluttende analyse bruger ekstra OpenAI API-kald.

## Skrivebeskyttet API til samtaler og noter

`GET /api/assistant/context` giver de nyeste gemte transskripter, idéer/rettelser og fejlhændelser
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

Parametrene `sessions`, `notes` og `diagnostics` kan begrænses til henholdsvis
1–20, 1–100 og 1–500.
API'et svarer `401`, hvis tokenen mangler/er forkert, og returnerer aldrig data
uden gyldig autorisation. Når miljøvariablen tilføjes i Vercel, kræves et nyt
deployment, før endpointet er aktivt.

Tilføj `historyScope=this_week` (eller `recent_days`, `strong`, `due`, `all`) for
også at hente øvede udtryk med dateret evidens. `historyDays=7`,
`historyOffset=0` og `historyQuery=` afgrænser opslaget; hver side indeholder
højst otte udtryk. `practiceHistory.nextOffset` giver næste side. API'et er
fortsat skrivebeskyttet. Samtalerne inkluderer deres OpenAI Live-session-ID,
så en filterafbrydelse kan knyttes til den konkrete samtale og fejl-tidslinje.

## Historik og noter under samtalen

Live-modellen har en kort samtaleinstruktion og en Responses-backend med
`get_practice_history` og `save_feedback`. Browseren fuldfører funktionskaldene
via det loginbeskyttede `/api/session/tool` og returnerer alle resultater før
backendens `response.create`. Ingen API-nøgler sendes til browseren.

Historiklisten fastholdes under en gennemgang og følger med ved genoptagelse.
Nye vurderede øveforsøg gemmes pr. samtale i `practice_items`. For ældre
samtaler bruges bogstavelige transkriptmatch; de markeres særskilt og beviser
ikke korrekthed. Eftersigelse alene kan i nye vurderinger højst bygge en score
på 2/5; stærke udtryk kræver selvstændig genkaldelse på forskellige dage.

Noter opsamles både undervejs og fra det gemte transkript. Eksplicitte ønsker
kan desuden gemmes med backendværktøjet. Ens noter og gentagne forsøg gemmes
idempotent. Knappen “Find oversete noter” genlæser de seneste otte samtaler.

En filterfejl, der kun afbryder en replik, lukker ikke automatisk forbindelsen.
Hvis OpenAI afslutter med `reason=content`, gemmes kontekst og øvetid lokalt
til knappen “Genoptag samtale”; sikkerhedsafslutninger genstartes ikke
automatisk. Fejlloggen forbinder session-ID, backend-response-ID og placering
i det eksisterende transkript uden at kopiere taleindhold ind i fejlloggen.

Når samme token står i `.env.local`, kan den seneste kontekst hentes fra
terminalen uden at åbne browseren:

```bash
npm run tutor:context
```

## Fejldiagnostik

Når en samtale startes, får hvert forbindelsesforsøg et ID. Browseren registrerer
opstart, WebRTC- og datakanalens tilstand, Live-fejlkoder, ufuldstændige
baggrundssvar, afslutningsårsag, mikrofon-/afspilningsfejl, fejl ved gemning og
et livstegn hvert minut. Vigtige hændelser gemmes lokalt og sendes igen, hvis
netværket er væk. Appen gemmer **ikke** lyd, SDP eller rå Live-events i
fejlloggen. Fejlbeskeder begrænses og kendte nøgleformater skjules.

Afslutningsårsagen vises ved samtaledelen på forsiden og statistik-siden.
Detaljer kan læses via det eksisterende, skrivebeskyttede API eller i terminalen:

```bash
npm run tutor:diagnostics
npm run tutor:diagnostics -- 23  # kun samtaledel 23
```

Gamle samtaler får ikke en afslutningsårsag med tilbagevirkende kraft. Hvis
browseren lukkes brat, kan den sidste hændelse mangle; seneste livstegn og
forbindelsestilstand gør stadig forløbet nemmere at rekonstruere. Diagnostik
kan heller ikke afsløre OpenAI-sikkerhedsfilterets interne begrundelse.
