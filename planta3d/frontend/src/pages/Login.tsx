import { useState } from "react";
import { api, auth, type User } from "../lib/api";

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>("/api/auth/login", { body: { email, password } });
      auth.token = r.token;
      onLogin(r.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <form className="card login" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 16, fontSize: "1.2rem" }}><img src="/icon.svg" alt="" /> Planta 3D</div>
        <p className="muted">Reconstrucción 3D de sectores industriales a partir de fotografías.</p>
        <label>Correo<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Ingresando…" : "Ingresar"}</button>
      </form>
    </div>
  );
}
