import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./theme.css";
import "./pages.css";
import "./product.css";
import "./design.css";
import "./site.css";
import "./app.css";
import "./network.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
