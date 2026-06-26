declare global {
  /**
   * Second parameter for Next.js App Router route handlers with dynamic segments.
   * @example
   * export async function GET(_req: NextRequest, ctx: RouteContext<'/api/foo/[id]'>) {
   *   const { id } = await ctx.params
   * }
   */
  type RouteContext<_Path extends string> = {
    params: Promise<Record<string, string>>
  }
}

export {}
