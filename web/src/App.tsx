import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { supabase } from './supabase';
import SignIn from './pages/SignIn';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';

export default function App() {
  const { session, role, loading } = useAuth();

  if (loading) return <div className="center muted">Loading…</div>;
  if (!session) return <SignIn />;

  if (!role) {
    return (
      <div className="center">
        <div className="card narrow">
          <h1>Not on the staff list yet</h1>
          <p>
            You're signed in as <b>{session.user.email}</b>, but this account hasn't been added to the staff list, so
            no data is visible. Ask an admin to add you.
          </p>
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Athar Pipeline</span>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/projects">Projects</NavLink>
        </nav>
        <span className="user">
          {session.user.email} · {role}
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
