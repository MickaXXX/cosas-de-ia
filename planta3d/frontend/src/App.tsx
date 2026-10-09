import { useEffect, useState } from "react";
import { api, auth, setUnauthorizedHandler, type User } from "./lib/api";
import { go, useHashRoute } from "./lib/hooks";
import Login from "./pages/Login";
import Projects from "./pages/Projects";
import ProjectPage from "./pages/ProjectPage";
import SectorPage from "./pages/SectorPage";
import ViewerPage from "./viewer/ViewerPage";

export default function App() {
  const route = useHashRoute();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!auth.token) { setUser(null); return; }
    api<User>("/api/auth/me").then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) return <div className="page"><p className="muted">Cargando…</p></div>;
  if (user === null) return <Login onLogin={(u) => { setUser(u); if (route[0] === "login") go("/"); }} />;

  const logout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ya vencida */ }
    auth.token = null;
    setUser(null);
  };

  if (route[0] === "s" && route[2] === "visor" && route[3]) {
    return <ViewerPage sectorId={route[1]} modelId={route[3]} />;
  }
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/"><img src="/icon.svg" alt="" /> Planta 3D</a>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: ".85rem" }}>{user.display_name}</span>
        <button className="btn sm ghost" onClick={logout}>Salir</button>
      </header>
      {route[0] === "p" && route[1] ? <ProjectPage projectId={route[1]} />
        : route[0] === "s" && route[1] ? <SectorPage sectorId={route[1]} tab={route[2]} />
        : <Projects />}
    </div>
  );
}
