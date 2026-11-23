-- Workers AI neurons spent per UTC day, so pictures stay inside the free
-- daily allocation (worker/pictures.ts).
CREATE TABLE ai_budget (
  day     TEXT PRIMARY KEY,   -- YYYY-MM-DD, UTC
  neurons INTEGER NOT NULL
);
