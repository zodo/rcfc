import "./style.css";

const out = document.getElementById("health")!;

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => (out.textContent = JSON.stringify(h, null, 2)))
  .catch((e) => (out.textContent = `offline or API unreachable: ${e}`));
