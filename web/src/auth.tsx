import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

type Role = 'admin' | 'screener' | 'interviewer' | 'viewer';
type Auth = { session: Session | null; role: Role | null; loading: boolean };

const AuthContext = createContext<Auth>({ session: null, role: null, loading: true });
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Auth>({ session: null, role: null, loading: true });

  useEffect(() => {
    // staff_role() is null for signed-in users who aren't in public.staff
    const load = async (session: Session | null) => {
      if (!session) return setState({ session: null, role: null, loading: false });
      const { data } = await supabase.rpc('staff_role');
      setState({ session, role: (data as Role | null) ?? null, loading: false });
    };
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      // Defer so the rpc doesn't run inside the auth callback
      setTimeout(() => load(session), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
