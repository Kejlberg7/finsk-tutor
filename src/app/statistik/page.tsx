import type { Metadata } from "next";
import type { CSSProperties } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { formatDuration } from "@/lib/duration";
import { getLearningSnapshot } from "@/lib/learning";
import { getStatsData } from "@/lib/stats-server";
import type { WordProgress } from "@/lib/learning-types";
import "./stats.css";

export const metadata: Metadata = {
  title: "Din statistik · Finsk Tutor",
  description: "Et samlet overblik over dine finske øvesamtaler, ord og fremskridt.",
};

export default async function StatsPage() {
  if (!(await getSession())) redirect("/login");
  const [learning, data] = await Promise.all([getLearningSnapshot(), getStatsData()]);
  const words = learning.wordProgress;
  const secure = words.filter((word) => word.mastery >= 4);
  const building = words.filter((word) => word.mastery >= 2 && word.mastery < 4);
  const newWords = words.filter((word) => word.mastery < 2);
  const focusWords = [...words]
    .filter((word) => word.mastery < 4 && word.incorrectCount > 0)
    .sort((a, b) => (b.incorrectCount - a.incorrectCount) || (a.mastery - b.mastery))
    .slice(0, 5);
  const practicedGrammar = data.grammar
    .filter((skill) => skill.correctCount + skill.incorrectCount > 0)
    .sort((a, b) => (b.incorrectCount - a.incorrectCount) || (b.correctCount - a.correctCount));
  const recentWins = [...secure]
    .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
    .slice(0, 4);
  const nextGoal = [5, 20, 50, 100, 200].find((goal) => secure.length < goal)
    ?? Math.ceil((secure.length + 1) / 100) * 100;
  const goalProgress = Math.min(100, Math.round(secure.length / nextGoal * 100));
  const chartMax = Math.max(30 * 60, ...data.practice.recentDays.map((day) => day.seconds));
  const number = new Intl.NumberFormat("da-DK");
  const wordTotal = Math.max(1, words.length);

  return (
    <main className="insights-shell">
      <div className="insights-frame">
        <header className="insights-nav">
          <Link className="insights-brand" href="/" aria-label="Finsk Tutor – tilbage til samtalen">
            <span className="flag-mark" aria-hidden="true" />
            <span><strong>Finsk Tutor</strong><small>Din sprogrejse</small></span>
          </Link>
          <Link className="insights-back" href="/">← Til samtalen</Link>
        </header>

        <section className="insights-hero" aria-labelledby="insights-title">
          <div className="insights-hero-glow" aria-hidden="true" />
          <div className="insights-hero-copy">
            <span className="insights-eyebrow"><span aria-hidden="true">✳</span> DIT LÆRINGSKOMPAS</span>
            <h1 id="insights-title">Hver samtale <em>tæller.</em></h1>
            <p>Her er den finsk, du allerede har bygget op — og det, der er værd at øve næste gang.</p>
            <div className="insights-hero-chips">
              <span>{learning.level}</span>
              <span>{number.format(data.practice.activeDays)} aktive dage</span>
              <span>{data.practice.currentStreak > 0 ? `${data.practice.currentStreak} dage i træk` : "Klar til næste øvedag"}</span>
            </div>
          </div>
          <div className="insights-hero-ring" style={{ "--ring-progress": `${goalProgress}%` } as CSSProperties}
            role="progressbar" aria-label="Sikre ord mod næste milepæl" aria-valuenow={secure.length} aria-valuemin={0} aria-valuemax={nextGoal}>
            <div><span>NÆSTE MILEPÆL</span><strong>{secure.length}<small> / {nextGoal}</small></strong><span>sikre ord</span></div>
          </div>
        </section>

        {!data.available && <p className="insights-warning" role="status">Statistikdatabasen er ikke tilgængelig lige nu. Nogle tal kan derfor mangle.</p>}

        <section className="insights-kpis" aria-label="Dine nøgletal">
          <Metric symbol="◷" tone="green" value={formatDuration(data.practice.totalSeconds)} label="Registreret øvetid" note="Live-tid hvor tilgængelig; ellers klokketid" />
          <Metric symbol="◉" tone="blue" value={number.format(data.sessions.length)} label="Samtaledele" note="Afbrydelser kan dele en øvetur i flere" />
          <Metric symbol="✦" tone="lime" value={number.format(words.length)} label="Ord mødt" note={`${number.format(secure.length)} sikre · ${number.format(learning.dueWordCount)} til repetition`} />
          <Metric symbol="$" tone="amber" value={formatUsd(learning.estimatedApiCostUsd)} label="Estimeret API-forbrug" note="Taletid estimeret · øvrige kald registreret" />
        </section>

        <div className="insights-section-heading">
          <div><span className="insights-kicker">01 / DIN RYTME</span><h2>Små ture. Stor forskel.</h2></div>
          <p>Aktivitet regnes på den dag, samtalen begyndte. Tiderne vises i dansk tid.</p>
        </div>

        <div className="insights-activity-grid">
          <section className="insights-panel insights-trend" aria-labelledby="trend-title">
            <div className="insights-panel-head">
              <div><span className="insights-kicker">SENESTE 14 DAGE</span><h3 id="trend-title">Minutter på vejen</h3></div>
              <span className="insights-goal-pill">30 min dagsmål</span>
            </div>
            <div className="insights-bars-wrap">
              <div className="insights-goal-line" style={{ bottom: `${27 + 30 * 60 / chartMax * 170}px` }}><span>30 min</span></div>
              <ol className="insights-bars" aria-label="Øvetid dag for dag">
                {data.practice.recentDays.map((day) => (
                  <li key={day.date} title={`${formatCalendarDay(day.date)}: ${formatDuration(day.seconds)}`}
                    aria-label={`${formatCalendarDay(day.date)}: ${formatDuration(day.seconds)}`}>
                    <span className={day.seconds >= 30 * 60 ? "insights-bar reached" : "insights-bar"}
                      style={{ height: day.seconds ? `${Math.max(4, day.seconds / chartMax * 100)}%` : "3px" }} />
                    <span className="insights-bar-label">{day.date.slice(8)}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="insights-trend-foot"><span>Sidste 14 dage</span><span>{data.practice.recentDays.filter((day) => day.seconds >= 30 * 60).length} dage med mindst 30 min</span></div>
          </section>

          <section className="insights-panel insights-streak" aria-labelledby="streak-title">
            <span className="insights-kicker">KONTINUITET</span>
            <h3 id="streak-title">Din øverytme</h3>
            <div className="insights-streak-count"><strong>{data.practice.currentStreak}</strong><span>dage i træk lige nu</span></div>
            <div className="insights-streak-divider" />
            <div className="insights-streak-row"><span>Længste række</span><strong>{data.practice.longestStreak} dage</strong></div>
            <div className="insights-streak-row"><span>Dage over 30 minutter</span><strong>{data.practice.goalDays}</strong></div>
            <div className="insights-streak-row"><span>Længste samtaledel</span><strong>{formatDuration(data.practice.longestSessionSeconds)}</strong></div>
            <div className="insights-streak-row"><span>Gennemsnit pr. del</span><strong>{formatDuration(data.practice.averageSeconds)}</strong></div>
            {data.practice.bestDay && <p className="insights-best-day">Din længste øvedag: <strong>{formatCalendarDay(data.practice.bestDay.date)}</strong> · {formatDuration(data.practice.bestDay.seconds)}</p>}
          </section>
        </div>

        <section className="insights-panel insights-heatmap" aria-labelledby="heatmap-title">
          <div className="insights-panel-head">
            <div><span className="insights-kicker">DE SENESTE 12 UGER</span><h3 id="heatmap-title">Sporene du har sat</h3></div>
            <span className="insights-heatmap-total">{data.practice.activeDays} aktive dage i alt</span>
          </div>
          <div className="insights-heatmap-body">
            <div className="insights-weekdays" aria-hidden="true"><span>Man</span><span>Ons</span><span>Fre</span></div>
            <ol className="insights-heatmap-grid" aria-label="Øveaktivitet de seneste 12 uger">
              {data.practice.heatmap.map((day) => (
                <li key={day.date} className={`insights-heat-cell level-${activityLevel(day.seconds)}${day.date > data.practice.recentDays.at(-1)!.date ? " future" : ""}`}
                  title={`${formatCalendarDay(day.date)}: ${formatDuration(day.seconds)}`}
                  aria-label={`${formatCalendarDay(day.date)}: ${formatDuration(day.seconds)}`} />
              ))}
            </ol>
          </div>
          <div className="insights-heatmap-legend"><span>Mindre</span>{[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}<span>Mere</span></div>
        </section>

        <div className="insights-section-heading">
          <div><span className="insights-kicker">02 / DINE ORD</span><h2>Et ord ad gangen.</h2></div>
          <p>Øveniveauet er tutorens vurdering ud fra samtalerne — ikke en test eller en officiel sprogvurdering.</p>
        </div>

        <div className="insights-words-grid">
          <section className="insights-panel insights-wordscape" aria-labelledby="wordscape-title">
            <span className="insights-kicker">ORDFORRÅD LIGE NU</span>
            <h3 id="wordscape-title">Hvor ordene står</h3>
            <p className="insights-muted">{words.length ? `${number.format(words.length)} ord er registreret fra dine samtaler.` : "Når du har øvet ord i en samtale, vises de her."}</p>
            <div className="insights-wordstack" role="img" aria-label={`${newWords.length} nye ord, ${building.length} under opbygning, ${secure.length} sikre ord`}>
              {newWords.length > 0 && <span className="new" style={{ width: `${newWords.length / wordTotal * 100}%` }} />}
              {building.length > 0 && <span className="building" style={{ width: `${building.length / wordTotal * 100}%` }} />}
              {secure.length > 0 && <span className="secure" style={{ width: `${secure.length / wordTotal * 100}%` }} />}
            </div>
            <div className="insights-wordlegend">
              <span><i className="new" /> <strong>{newWords.length}</strong> netop mødt <small>0–1/5</small></span>
              <span><i className="building" /> <strong>{building.length}</strong> på vej <small>2–3/5</small></span>
              <span><i className="secure" /> <strong>{secure.length}</strong> sikre <small>4–5/5</small></span>
            </div>
            <div className="insights-review-callout"><span className="insights-review-icon">↺</span><div><strong>{learning.dueWordCount} ord er klar til repetition</strong><p>Også sikre ord kan dukke op igen, når det er tid til at holde dem ved lige.</p></div></div>
          </section>

          <section className="insights-panel insights-focus" aria-labelledby="focus-title">
            <div className="insights-panel-head"><div><span className="insights-kicker">ET GODT STED AT STARTE</span><h3 id="focus-title">Udtryk der blev rettet</h3></div><span className="insights-focus-spark" aria-hidden="true">✳</span></div>
            <p className="insights-muted">Tidligere forsøg fra samtalerne — ikke nødvendigvis korrekte mønstersætninger.</p>
            {focusWords.length ? <ol className="insights-focus-list">
              {focusWords.map((word) => <WordRow word={word} key={word.finnish} />)}
            </ol> : <p className="insights-muted">Ingen ord kræver ekstra fokus endnu. Start en samtale, så bygger vi listen sammen.</p>}
            <Link className="insights-text-link" href="/">Øv dem i næste samtale <span aria-hidden="true">↗</span></Link>
          </section>
        </div>

        <div className="insights-knowledge-grid">
          <section className="insights-panel insights-wins" aria-labelledby="wins-title">
            <span className="insights-kicker">DET SIDDER FAST</span>
            <h3 id="wins-title">Dine seneste sikre ord</h3>
            {recentWins.length ? <div className="insights-win-list">{recentWins.map((word) => (
              <div key={word.finnish}><strong lang="fi">{word.finnish}</strong><span>{word.danish || word.english}</span><small>{word.mastery}/5</small></div>
            ))}</div> : <p className="insights-muted">De første sikre ord dukker op her, når de er brugt rigtigt flere gange.</p>}
          </section>
          <section className="insights-panel insights-grammar" aria-labelledby="grammar-title">
            <span className="insights-kicker">OGSÅ GRAMMATIK TÆLLER</span>
            <h3 id="grammar-title">Grammatik i gang</h3>
            <p className="insights-muted">{data.grammar.length} emner registreret · {practicedGrammar.length} med vurderede forsøg</p>
            {practicedGrammar.length ? <div className="insights-grammar-list">{practicedGrammar.slice(0, 5).map((skill) => (
              <div key={skill.name} className="insights-grammar-item">
                <div><strong>{skill.name}</strong><span>{skill.mastery}/5</span></div>
                <span className="insights-grammar-track"><i style={{ width: `${Math.min(100, Math.max(0, skill.mastery * 20))}%` }} /></span>
              </div>
            ))}</div> : <p className="insights-muted">Ingen grammatikemner har vurderede forsøg endnu. Introducerede emner tæller ikke som mestrede.</p>}
            {practicedGrammar.length > 5 && <small className="insights-more">+ {practicedGrammar.length - 5} flere øvede emner</small>}
          </section>
        </div>

        <div className="insights-section-heading">
          <div><span className="insights-kicker">03 / SAMTALER & FORBRUG</span><h2>Din tid, helt konkret.</h2></div>
          <p>Priserne er appens estimat. Se OpenAI-faktureringen for det endelige beløb.</p>
        </div>

        <section className="insights-panel insights-sessions" aria-labelledby="sessions-title">
          <div className="insights-panel-head">
            <div><span className="insights-kicker">SENESTE SAMTALEDELE</span><h3 id="sessions-title">Dine øveture</h3></div>
            <span className="insights-session-total">{data.sessions.length} registreret</span>
          </div>
          {data.sessions.length ? <ol className="insights-session-list">{data.sessions.slice(0, 8).map((session, index) => (
            <li key={session.id}>
              <span className="insights-session-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="insights-session-date"><strong>{formatCalendarDay(session.startedAt)}</strong><span>kl. {formatClock(session.startedAt)}{session.status !== "completed" ? " · delvist gemt" : ""}</span></div>
              <div className="insights-session-meter"><span><i style={{ width: `${Math.min(100, Math.max(3, session.durationSeconds / (30 * 60) * 100))}%` }} /></span><small>{formatDuration(session.durationSeconds)}</small></div>
              <strong className="insights-session-cost">{formatUsd(session.estimatedCostUsd)}</strong>
            </li>
          ))}</ol> : <p className="insights-muted">Dine gemte samtaler vises her, så snart du har gennemført den første.</p>}
          <p className="insights-session-note">En afbrudt og genoptaget øvetur kan stå som flere dele. Øvetid og dagsmål lægger delene sammen for dagen.</p>
        </section>

        <footer className="insights-footer">
          <div><span className="insights-kicker">NÆSTE SKRIDT</span><strong>{learning.nextLesson}</strong><p>Din plan ændrer sig, efterhånden som du øver.</p></div>
          <Link href="/" className="insights-cta">Start en samtale <span aria-hidden="true">↗</span></Link>
        </footer>
      </div>
    </main>
  );
}

function Metric({ symbol, tone, value, label, note }: { symbol: string; tone: string; value: string; label: string; note: string }) {
  return <div className="insights-kpi"><span className={`insights-kpi-symbol ${tone}`} aria-hidden="true">{symbol}</span><strong>{value}</strong><span>{label}</span><small>{note}</small></div>;
}

function WordRow({ word }: { word: WordProgress }) {
  return <li><div><strong lang="fi">{word.finnish}</strong><span>{word.danish || word.english}</span><small>{word.incorrectCount} {word.incorrectCount === 1 ? "registreret rettelse" : "registrerede rettelser"}</small></div><span className="insights-word-score">{word.mastery}/5</span><span className="insights-word-row-track"><i style={{ width: `${Math.min(100, Math.max(0, word.mastery * 20))}%` }} /></span></li>;
}

function activityLevel(seconds: number): number {
  if (seconds <= 0) return 0;
  if (seconds < 10 * 60) return 1;
  if (seconds < 20 * 60) return 2;
  if (seconds < 30 * 60) return 3;
  return 4;
}

function formatCalendarDay(value: string): string {
  return new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", day: "numeric", month: "short", year: "numeric" }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatUsd(value: number): string {
  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}
