import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function showFatalError(msg: string) {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<div style="padding:2rem;font-family:sans-serif;max-width:600px;color:#111"><h1 style="color:#b91c1c">Failed to load app</h1><pre style="background:#fef2f2;padding:1rem;overflow:auto;color:#111;white-space:pre-wrap">${String(msg).replace(/</g, "&lt;")}</pre></div>`;
  }
}

async function loadAndRender() {
  const root = document.getElementById("root");
  if (!root) {
    showFatalError("Root element #root not found.");
    return;
  }
  try {
    await import("./index.css");
    await import("swiper/swiper-bundle.css");
    await import("flatpickr/dist/flatpickr.css");
    const { default: App } = await import("./App.tsx");
    const { AppWrapper } = await import("./components/common/PageMeta.tsx");
    const { ThemeProvider } = await import("./context/ThemeContext.tsx");
    const { AuthProvider } = await import("./context/AuthContext.tsx");
    const { ErrorBoundary } = await import("./components/common/ErrorBoundary.tsx");

    createRoot(root).render(
      <StrictMode>
        <ErrorBoundary>
          <ThemeProvider>
            <AuthProvider>
              <AppWrapper>
                <App />
              </AppWrapper>
            </AuthProvider>
          </ThemeProvider>
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showFatalError(msg);
    console.error(err);
  }
}

loadAndRender();
