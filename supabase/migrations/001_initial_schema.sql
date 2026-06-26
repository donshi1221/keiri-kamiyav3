CREATE TABLE contractors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contractor_type TEXT NOT NULL DEFAULT 'daiko'
    CHECK (contractor_type IN ('daiko', 'video_editor')),
  email TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_person TEXT,
  billing_amount INTEGER NOT NULL DEFAULT 0,
  contract_start DATE,
  contract_months INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  role_name TEXT NOT NULL DEFAULT '撮影+台本',
  contractor_payout_amount INTEGER NOT NULL DEFAULT 0,
  spreadsheet_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE monthly_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  actual_payout_amount INTEGER,
  invoice_received_at TIMESTAMPTZ,
  contractor_paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(year, month, assignment_id)
);

CREATE TABLE monthly_client_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  invoice_sent_at TIMESTAMPTZ,
  payment_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(year, month, client_id)
);

CREATE TABLE monthly_global_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  expense_confirmed_at TIMESTAMPTZ,
  payment_report_confirmed_at TIMESTAMPTZ,
  withholding_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(year, month)
);

CREATE INDEX idx_monthly_records_year_month ON monthly_records(year, month);
CREATE INDEX idx_monthly_records_assignment ON monthly_records(assignment_id);
CREATE INDEX idx_assignments_active ON assignments(active);

ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_client_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_global_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all" ON contractors FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON clients FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON assignments FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON monthly_records FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON monthly_client_records FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON monthly_global_tasks FOR ALL TO anon USING (true) WITH CHECK (true);

-- 税務アドバイスAIチャット用テーブル
CREATE TABLE tax_advice_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('manual', 'file')),
  file_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tax_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '新しい会話',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tax_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES tax_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE tax_advice_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all" ON tax_advice_entries FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON tax_chat_sessions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON tax_chat_messages FOR ALL TO anon USING (true) WITH CHECK (true);
