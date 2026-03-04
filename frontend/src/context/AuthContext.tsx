import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getToken } from "../api/client";

const USER_KEY = "user";
const TOKEN_KEY = "token";

export type AuthUser = {
  email?: string;
  username?: string;
  tenant_name?: string;
  role?: string;
  [key: string]: unknown;
};

type AuthContextType = {
  user: AuthUser | null;
  isSuperadmin: boolean;
  setUser: (user: AuthUser | null) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function readUserFromStorage(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUserState] = useState<AuthUser | null>(readUserFromStorage);

  useEffect(() => {
    const token = getToken();
    const stored = readUserFromStorage();
    if (!token && stored) {
      setUserState(null);
      localStorage.removeItem(USER_KEY);
    } else {
      setUserState(stored);
    }
  }, []);

  const setUser = useCallback((u: AuthUser | null) => {
    setUserState(u);
    if (u) {
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } else {
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(TOKEN_KEY);
    }
  }, []);

  const logout = useCallback(() => {
    setUserState(null);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }, []);

  const isSuperadmin = user?.role === "superadmin";

  const value: AuthContextType = {
    user,
    isSuperadmin: !!isSuperadmin,
    setUser,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
