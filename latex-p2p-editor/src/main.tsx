import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { initTheme } from "./services/theme";
import { hideSplash } from "./services/splash";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);

// Fade the startup splash out once the first frame of the app is painted.
requestAnimationFrame(() => hideSplash());
