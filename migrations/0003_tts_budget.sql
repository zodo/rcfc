-- Characters sent to Azure Speech per UTC month (worker/tts.ts), capped below its free tier.
CREATE TABLE tts_budget (
  month TEXT PRIMARY KEY, -- YYYY-MM, UTC
  chars INTEGER NOT NULL
);
