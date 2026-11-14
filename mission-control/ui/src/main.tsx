import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MissionControl from "./components/MissionControl";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MissionControl />
  </StrictMode>,
);
