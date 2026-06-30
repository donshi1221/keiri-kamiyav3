export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      contractors: {
        Row: {
          id: string
          name: string
          contractor_type: 'daiko' | 'video_editor'
          email: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          contractor_type?: 'daiko' | 'video_editor'
          email?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          name?: string
          contractor_type?: 'daiko' | 'video_editor'
          email?: string | null
          notes?: string | null
        }
        Relationships: []
      }
      clients: {
        Row: {
          id: string
          name: string
          contact_person: string | null
          billing_amount: number
          contract_start: string | null
          contract_months: number | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          contact_person?: string | null
          billing_amount?: number
          contract_start?: string | null
          contract_months?: number | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          name?: string
          contact_person?: string | null
          billing_amount?: number
          contract_start?: string | null
          contract_months?: number | null
          notes?: string | null
        }
        Relationships: []
      }
      assignments: {
        Row: {
          id: string
          contractor_id: string
          client_id: string
          role_name: string
          contractor_payout_amount: number
          spreadsheet_url: string | null
          active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          contractor_id: string
          client_id: string
          role_name?: string
          contractor_payout_amount?: number
          spreadsheet_url?: string | null
          active?: boolean
          created_at?: string
        }
        Update: {
          contractor_id?: string
          client_id?: string
          role_name?: string
          contractor_payout_amount?: number
          spreadsheet_url?: string | null
          active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'assignments_contractor_id_fkey'
            columns: ['contractor_id']
            isOneToOne: false
            referencedRelation: 'contractors'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'assignments_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          }
        ]
      }
      monthly_records: {
        Row: {
          id: string
          year: number
          month: number
          assignment_id: string
          actual_payout_amount: number | null
          invoice_received_at: string | null
          contractor_paid_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          year: number
          month: number
          assignment_id: string
          actual_payout_amount?: number | null
          invoice_received_at?: string | null
          contractor_paid_at?: string | null
          created_at?: string
        }
        Update: {
          actual_payout_amount?: number | null
          invoice_received_at?: string | null
          contractor_paid_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'monthly_records_assignment_id_fkey'
            columns: ['assignment_id']
            isOneToOne: false
            referencedRelation: 'assignments'
            referencedColumns: ['id']
          }
        ]
      }
      monthly_client_records: {
        Row: {
          id: string
          year: number
          month: number
          client_id: string
          invoice_sent_at: string | null
          payment_confirmed_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          year: number
          month: number
          client_id: string
          invoice_sent_at?: string | null
          payment_confirmed_at?: string | null
          created_at?: string
        }
        Update: {
          invoice_sent_at?: string | null
          payment_confirmed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'monthly_client_records_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          }
        ]
      }
      monthly_global_tasks: {
        Row: {
          id: string
          year: number
          month: number
          expense_confirmed_at: string | null
          payment_report_confirmed_at: string | null
          withholding_confirmed_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          year: number
          month: number
          expense_confirmed_at?: string | null
          payment_report_confirmed_at?: string | null
          withholding_confirmed_at?: string | null
          created_at?: string
        }
        Update: {
          expense_confirmed_at?: string | null
          payment_report_confirmed_at?: string | null
          withholding_confirmed_at?: string | null
        }
        Relationships: []
      }
      tax_advice_entries: {
        Row: {
          id: string
          title: string
          body: string
          source_type: 'manual' | 'file'
          file_name: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          title: string
          body: string
          source_type?: 'manual' | 'file'
          file_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          title?: string
          body?: string
          source_type?: 'manual' | 'file'
          file_name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tax_chat_sessions: {
        Row: {
          id: string
          title: string
          created_at: string
        }
        Insert: {
          id?: string
          title?: string
          created_at?: string
        }
        Update: {
          title?: string
        }
        Relationships: []
      }
      tax_chat_messages: {
        Row: {
          id: string
          session_id: string
          role: 'user' | 'assistant'
          content: string
          created_at: string
        }
        Insert: {
          id?: string
          session_id: string
          role: 'user' | 'assistant'
          content: string
          created_at?: string
        }
        Update: never
        Relationships: [
          {
            foreignKeyName: 'tax_chat_messages_session_id_fkey'
            columns: ['session_id']
            isOneToOne: false
            referencedRelation: 'tax_chat_sessions'
            referencedColumns: ['id']
          }
        ]
      }
      moneyforward_tokens: {
        Row: {
          id: string
          access_token: string
          refresh_token: string
          expires_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          access_token: string
          refresh_token: string
          expires_at: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          refresh_token?: string
          expires_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      moneyforward_expenses: {
        Row: {
          id: string
          year: number
          month: number
          amount: number
          synced_at: string
        }
        Insert: {
          id?: string
          year: number
          month: number
          amount: number
          synced_at?: string
        }
        Update: {
          amount?: number
          synced_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}

export type Contractor = Database['public']['Tables']['contractors']['Row']
export type Client = Database['public']['Tables']['clients']['Row']
export type Assignment = Database['public']['Tables']['assignments']['Row']
export type MonthlyRecord = Database['public']['Tables']['monthly_records']['Row']
export type MonthlyClientRecord = Database['public']['Tables']['monthly_client_records']['Row']
export type MonthlyGlobalTask = Database['public']['Tables']['monthly_global_tasks']['Row']
export type TaxAdviceEntry = Database['public']['Tables']['tax_advice_entries']['Row']
export type TaxChatSession = Database['public']['Tables']['tax_chat_sessions']['Row']
export type TaxChatMessage = Database['public']['Tables']['tax_chat_messages']['Row']

export interface CustomGlobalTask {
  id: string
  title: string
  months: number[]
  completed_months: number[]
  created_at: string
}
