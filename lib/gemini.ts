import 'server-only'
import { GoogleGenerativeAI } from '@google/generative-ai'

let client: GoogleGenerativeAI | null = null

export function getGeminiClient(): GoogleGenerativeAI {
  if (!client) {
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  }
  return client
}
