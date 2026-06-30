CREATE TABLE IF NOT EXISTS moneyforward_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moneyforward_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount INTEGER NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (year, month)
);
