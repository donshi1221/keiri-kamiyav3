import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Nav from './components/nav'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: '経理管理 v3',
  description: '月次経理業務チェックリスト',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50">
        <Nav />
        <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 pb-20 md:pb-6">{children}</main>
      </body>
    </html>
  )
}
