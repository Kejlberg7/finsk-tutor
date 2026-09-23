import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return (
    <main className="shell">
      <section className="card login">
        <div className="eyebrow">Finsk Tutor</div>
        <h1>Log ind</h1>
        <p className="intro">Dette er en privat testversion af din finske samtaletræner.</p>
        {params.error ? <p style={{ color: "var(--danger)" }}>Forkert kode.</p> : null}
        <form action={login}>
          <label htmlFor="password">Adgangskode</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <div className="controls"><button className="primary" type="submit">Fortsæt</button></div>
        </form>
      </section>
    </main>
  );
}
